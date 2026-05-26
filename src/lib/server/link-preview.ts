import * as http from "node:http";
import * as https from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Server-only link-preview fetcher used by /api/link-preview.
 *
 * MVP design:
 *   * Accepts http(s) only; embedded credentials stripped from any URL
 *     we see.
 *   * Resolves the hostname ourselves, picks ONE public IP, then PINS
 *     the socket connection to that IP using node:http(s) `lookup`
 *     override. The URL hostname is preserved so TLS SNI and cert
 *     validation still go against the original host — closing the DNS
 *     rebind window that an unpinned `fetch(parsed)` would leave open.
 *   * Caps redirects (3 hops); each `Location` re-parsed, the new
 *     hostname re-resolved, and the new connection re-pinned.
 *   * 5-second total request timeout via AbortController (covers the
 *     whole redirect chain, not per-hop).
 *   * 512 KB response-body cap. <head> typically lives in the first few
 *     KB, so this is plenty and bounds malicious mega-page abuse.
 *   * Requires text/html (or application/xhtml+xml) Content-Type —
 *     refuses to read binaries into our HTML parser.
 *   * Returns null on ANY failure (network error, timeout, blocked
 *     host, non-HTML, missing metadata). The route then 404s — the UI
 *     hides the preview slot quietly.
 *
 * Returns derived metadata only; the upstream HTML is not persisted.
 */

/** Shape returned to the API caller. All fields are server-derived. */
export type LinkPreview = {
  /** Canonical URL — og:url when present and public, else the final post-redirect URL. */
  url: string;
  /** Best title — og:title > twitter:title > <title> > domain. */
  title: string;
  /** Best description — og:description > twitter:description, else null. */
  description: string | null;
  /** Absolute image URL — og:image > twitter:image, else null. */
  image: string | null;
  /** Hostname for the "from {domain}" line. */
  domain: string;
};

const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_BYTES = 512 * 1024;
const USER_AGENT =
  "ElevateAE-LinkPreview/1.0 (+https://github.com/anthropics/claude-code)";

// ---------------------------------------------------------------------------
// IP allow-list / private-range rejection
// ---------------------------------------------------------------------------

/**
 * IPv4 ranges that must never be reachable from a server-side preview
 * fetch. Enumerated rather than CIDR-parsed to avoid pulling in a dep
 * for the MVP. Treat any unparseable address as blocked (fail closed).
 */
function isBlockedIPv4(addr: string): boolean {
  const parts = addr.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 — "this network"
  if (a === 10) return true; // 10.0.0.0/8 — RFC 1918
  if (a === 127) return true; // 127.0.0.0/8 — loopback
  // 169.254.0.0/16 — link-local + cloud metadata endpoint
  // (169.254.169.254 across AWS, GCP, Azure, DigitalOcean, Oracle).
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0) return true; // 192.0.0.0/24, 192.0.2.0/24 TEST-NET
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast + future
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

/** Conservative IPv6 block-list — loopback, link-local, ULA, IPv4-mapped. */
function isBlockedIPv6(addr: string): boolean {
  const lower = addr.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return true; // fc00::/7 ULA
  if (/^fe[89ab][0-9a-f]?:/i.test(lower)) return true; // fe80::/10 link-local
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIPv4(mapped[1]);
  return false;
}

/** A specific resolved IP we'll pin a single hop's connection to. */
type ResolvedAddress = { address: string; family: 4 | 6 };

/**
 * Resolves `hostname` to a public IP we're willing to connect to. We
 * pick the first non-blocked address from the DNS reply and return that
 * specific IP — the caller pins the actual socket connection to it, so
 * there's no second `getaddrinfo` between our check and the connect.
 *
 * IP-literal hostnames skip DNS but still get range-checked.
 */
async function resolvePublicAddress(
  hostname: string,
): Promise<ResolvedAddress | null> {
  const ipKind = isIP(hostname);
  if (ipKind === 4) {
    return isBlockedIPv4(hostname)
      ? null
      : { address: hostname, family: 4 };
  }
  if (ipKind === 6) {
    return isBlockedIPv6(hostname)
      ? null
      : { address: hostname, family: 6 };
  }

  // String hostnames: reject obviously-internal names before DNS even
  // gets a chance. Belt-and-braces — DNS could legitimately resolve
  // "localhost" to ::1 too, but the short-circuit is cheaper and clearer.
  const lower = hostname.toLowerCase();
  if (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal") ||
    lower.endsWith(".lan")
  ) {
    return null;
  }

  try {
    const all = await dnsLookup(hostname, { all: true });
    for (const r of all) {
      if (r.family === 4 && !isBlockedIPv4(r.address)) {
        return { address: r.address, family: 4 };
      }
      if (r.family === 6 && !isBlockedIPv6(r.address)) {
        return { address: r.address, family: 6 };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

/**
 * Parses `raw`, requires http(s), strips embedded credentials. Does NOT
 * do DNS — DNS happens immediately before each connect so the validated
 * IP and the connection IP are the same value.
 */
function parseAndAccept(raw: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  parsed.username = "";
  parsed.password = "";
  if (!parsed.hostname) return null;
  return parsed;
}

// ---------------------------------------------------------------------------
// IP-pinned HTTPS request
// ---------------------------------------------------------------------------

type PinnedResponse = {
  status: number;
  headers: Map<string, string>;
  body: NodeJS.ReadableStream;
};

/**
 * Issues a single HTTP(S) GET pinned to `pin.address`. The URL's
 * hostname is preserved for SNI / cert validation / the Host header —
 * Node's `http.request` / `https.request` accept a `lookup` override
 * that intercepts the underlying `getaddrinfo` call and forces our
 * pinned IP regardless of DNS state at connect time.
 *
 * Resolves to `null` on network error or abort.
 */
function requestPinned(
  url: URL,
  pin: ResolvedAddress,
  signal: AbortSignal,
): Promise<PinnedResponse | null> {
  return new Promise((resolve) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port
          ? Number(url.port)
          : url.protocol === "https:"
            ? 443
            : 80,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        signal,
        // Force the socket to connect to our validated IP, full stop.
        // The hostname above still drives SNI + the Host header + cert
        // validation, so TLS still authenticates the original host name.
        lookup: (_hostname, _opts, callback) => {
          // Node's LookupOneCallback expects (err, address, family).
          callback(null, pin.address, pin.family);
        },
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
      (res) => {
        const headers = new Map<string, string>();
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === "string") headers.set(k.toLowerCase(), v);
          else if (Array.isArray(v) && v.length > 0) {
            headers.set(k.toLowerCase(), v[0]);
          }
        }
        resolve({
          status: res.statusCode ?? 0,
          headers,
          body: res,
        });
      },
    );
    req.on("error", () => resolve(null));
    req.end();
  });
}

/** Best-effort destroy of a Node readable so the socket can free up. */
function drain(stream: NodeJS.ReadableStream): void {
  try {
    const maybeDestroy = (stream as { destroy?: () => void }).destroy;
    if (typeof maybeDestroy === "function") {
      maybeDestroy.call(stream);
    } else {
      stream.resume();
    }
  } catch {
    // Ignore — stream may already be closed.
  }
}

/**
 * Follow redirects manually so every hop is independently re-resolved
 * and re-pinned. A single AbortController bounds the whole chain at
 * REQUEST_TIMEOUT_MS so a redirect loop can't multiply the budget.
 */
async function fetchAndFollow(initial: URL): Promise<
  | {
      finalUrl: URL;
      headers: Map<string, string>;
      body: NodeJS.ReadableStream;
    }
  | null
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let current = initial;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const pin = await resolvePublicAddress(current.hostname);
      if (!pin) return null;
      const res = await requestPinned(current, pin, controller.signal);
      if (!res) return null;

      // Redirect — re-validate the destination before following.
      if (res.status >= 300 && res.status < 400) {
        drain(res.body);
        if (hop === MAX_REDIRECTS) return null;
        const loc = res.headers.get("location");
        if (!loc) return null;
        let next: URL;
        try {
          next = new URL(loc, current);
        } catch {
          return null;
        }
        const accepted = parseAndAccept(next.toString());
        if (!accepted) return null;
        current = accepted;
        continue;
      }

      if (res.status < 200 || res.status >= 300) {
        drain(res.body);
        return null;
      }

      return { finalUrl: current, headers: res.headers, body: res.body };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads up to MAX_BYTES of the response body as UTF-8. Breaking out of
 * the for-await closes the iterator, which destroys the stream and lets
 * Node free the socket — no need to manually call destroy().
 */
async function readBoundedBody(
  body: NodeJS.ReadableStream,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of body) {
      const buf = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as Uint8Array | string);
      chunks.push(buf);
      total += buf.byteLength;
      if (total >= MAX_BYTES) break;
    }
  } catch {
    // Stream error — return whatever we got so far.
  }
  if (chunks.length === 0) return "";
  return Buffer.concat(chunks, Math.min(total, MAX_BYTES)).toString("utf-8");
}

// ---------------------------------------------------------------------------
// HTML metadata extraction
// ---------------------------------------------------------------------------

/** Lowercases all attribute names while preserving values verbatim. */
function findMeta(head: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<meta\b([^>]*?)\/?\s*>/gi;
  for (const m of head.matchAll(re)) {
    const tag = m[1];
    const key = readAttr(tag, "property") ?? readAttr(tag, "name");
    const value = readAttr(tag, "content");
    if (!key || value === null) continue;
    const lk = key.toLowerCase();
    if (!out.has(lk)) out.set(lk, value);
  }
  return out;
}

/** Reads a single attribute value (single, double, or unquoted). */
function readAttr(tagInner: string, name: string): string | null {
  const re = new RegExp(
    `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s/>]+))`,
    "i",
  );
  const m = tagInner.match(re);
  if (!m) return null;
  return decodeHtmlEntities(m[1] ?? m[2] ?? m[3] ?? "");
}

/** Decodes the small set of entities OG content commonly contains. */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    // Hex numeric entities first so the more-specific pattern wins.
    // The previous combined `&#x?([0-9a-fA-F]+);` regex captured the
    // digits but not the `x`, so `&#x27;` was being parsed as decimal
    // 27 (ESC) instead of hex 0x27 (apostrophe). Splitting into two
    // replaces makes the radix unambiguous.
    .replace(/&#x([0-9a-fA-F]+);/gi, (_m, code: string) => {
      const n = parseInt(code, 16);
      return Number.isFinite(n) && n > 0 && n < 0x110000
        ? String.fromCodePoint(n)
        : "";
    })
    .replace(/&#(\d+);/g, (_m, code: string) => {
      const n = parseInt(code, 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000
        ? String.fromCodePoint(n)
        : "";
    });
}

/** Extracts <title>…</title> content if present. */
function findTitleTag(head: string): string | null {
  const m = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeHtmlEntities(m[1].trim()) : null;
}

/** Trims and length-caps a metadata string. */
function clamp(s: string | null | undefined, max: number): string | null {
  if (typeof s !== "string") return null;
  const trimmed = s.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? trimmed.slice(0, max).trimEnd() + "…" : trimmed;
}

/**
 * Resolves a possibly-relative image URL against `base`. Image URLs are
 * rendered by the recipient's browser, not fetched by our server, so
 * SSRF defenses don't apply — we only need to make sure it parses and
 * uses http(s). Returns null on failure.
 */
function resolveImageUrl(raw: string | null, base: URL): string | null {
  if (!raw) return null;
  try {
    const abs = new URL(raw, base);
    if (abs.protocol !== "http:" && abs.protocol !== "https:") return null;
    return abs.toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Fetches a URL and returns derived link-preview metadata, or null on
 * any failure (timeout, blocked host, non-HTML, missing fields, etc.).
 * Never throws.
 */
export async function fetchLinkPreview(
  rawUrl: string,
): Promise<LinkPreview | null> {
  const initial = parseAndAccept(rawUrl);
  if (!initial) return null;

  const fetched = await fetchAndFollow(initial);
  if (!fetched) return null;
  const { finalUrl, headers, body } = fetched;

  // Content-Type gate — we only parse HTML.
  const ct = (headers.get("content-type") ?? "text/html").toLowerCase();
  if (!ct.startsWith("text/html") && !ct.startsWith("application/xhtml+xml")) {
    drain(body);
    return null;
  }

  const text = await readBoundedBody(body);
  if (text.length === 0) return null;

  // <head> typically lives in the first 50KB. Working off `head` (when
  // we can find the closing tag) avoids matching og-shaped strings
  // inside article bodies.
  const headEnd = text.search(/<\/head>/i);
  const head = headEnd === -1 ? text : text.slice(0, headEnd);

  const meta = findMeta(head);
  const titleTag = findTitleTag(head);

  // Title precedence: og > twitter > <title> > hostname.
  const title =
    clamp(meta.get("og:title"), 200) ??
    clamp(meta.get("twitter:title"), 200) ??
    clamp(titleTag, 200) ??
    clamp(finalUrl.hostname, 200) ??
    finalUrl.hostname;

  const description =
    clamp(meta.get("og:description"), 300) ??
    clamp(meta.get("twitter:description"), 300) ??
    clamp(meta.get("description"), 300);

  const image = resolveImageUrl(
    meta.get("og:image") ??
      meta.get("og:image:url") ??
      meta.get("twitter:image") ??
      meta.get("twitter:image:src") ??
      null,
    finalUrl,
  );

  // Canonical URL — og:url overrides the post-redirect URL when present
  // and parseable as http(s). No DNS check here: og:url is rendered by
  // the client browser as the <a href>, never re-fetched server-side.
  let canonical = finalUrl.toString();
  const rawCanonical = meta.get("og:url");
  if (rawCanonical) {
    try {
      const u = new URL(rawCanonical, finalUrl);
      if (u.protocol === "http:" || u.protocol === "https:") {
        u.username = "";
        u.password = "";
        canonical = u.toString();
      }
    } catch {
      // Keep the post-redirect URL.
    }
  }

  return {
    url: canonical,
    title,
    description,
    image,
    domain: finalUrl.hostname.replace(/^www\./i, ""),
  };
}
