/**
 * Coverage Intelligence — brochure URL safety (SSRF hardening).
 *
 * Server-only. The brochure fetch pulls an admin-supplied URL, so it is a
 * classic SSRF surface. This module enforces:
 *   - https only (no http/file/ftp/data/etc.)
 *   - an explicit host ALLOWLIST of Elevate brochure sources
 *   - no embedded credentials, default https port only
 *   - DNS resolution that rejects loopback / private / link-local / metadata IPs
 * Used for the initial URL AND every redirect hop (see ingest.ts).
 */

import { lookup } from "dns/promises";
import { isIP } from "net";

import { ApiError } from "@/lib/server/auth";

/**
 * Trusted Elevate brochure hosts. Exact hostname match (case-insensitive).
 * Extend deliberately — adding a host here widens the SSRF surface.
 *   - *.elevateh.com: app/test-app are the integration hosts already used in
 *     the repo (src/lib/server/cogent.ts, AGENTIC_AI_CHAT_URL).
 *   - elevatehomescriptions.com: the marketing/brand domain.
 *   - *.blob.core.windows.net / datocms-assets.com: common CDN backends for
 *     brochure assets.
 */
export const ALLOWED_BROCHURE_HOSTS: ReadonlySet<string> = new Set([
  "elevatehomescriptions.com",
  "www.elevatehomescriptions.com",
  "elevateh.com",
  "www.elevateh.com",
  "app.elevateh.com",
  "test-app.elevateh.com",
  "elevateh.blob.core.windows.net",
  "datocms-assets.com",
  "www.datocms-assets.com",
]);

/** True if an IPv4 literal falls in a blocked (loopback/private/link-local/...) range. */
function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed → block
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. 169.254.169.254 metadata)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

/** True if an IPv6 literal is loopback / unique-local / link-local (or maps to a blocked v4). */
function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isBlockedIpv4(mapped[1]); // IPv4-mapped
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 link-local
  return false;
}

/** True if an IP literal must not be connected to. Unknown formats are blocked. */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true;
}

/**
 * Synchronous structural checks (no DNS): https, allowlisted host, no
 * credentials, default port. Throws ApiError(400) on any violation. Returns the
 * parsed URL. Safe to use at registration time for fast feedback.
 */
export function validateBrochureUrlSync(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ApiError(400, "Brochure URL is not a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new ApiError(400, "Brochure URL must use https.");
  }
  if (url.username || url.password) {
    throw new ApiError(400, "Brochure URL must not contain credentials.");
  }
  if (url.port && url.port !== "443") {
    throw new ApiError(400, "Brochure URL must use the default https port.");
  }
  if (!ALLOWED_BROCHURE_HOSTS.has(url.hostname.toLowerCase())) {
    throw new ApiError(400, "Brochure host is not on the allowed list.");
  }
  return url;
}

/**
 * Full validation: the sync checks PLUS DNS resolution with every resolved IP
 * checked against the blocked ranges (defense-in-depth against a trusted host
 * resolving to an internal address). Throws ApiError on any violation.
 */
export async function assertSafeBrochureUrl(rawUrl: string): Promise<URL> {
  const url = validateBrochureUrlSync(rawUrl);

  let addresses: { address: string }[];
  try {
    addresses = await lookup(url.hostname, { all: true });
  } catch {
    throw new ApiError(502, "Could not resolve the brochure host.");
  }
  if (addresses.length === 0) {
    throw new ApiError(502, "Could not resolve the brochure host.");
  }
  for (const a of addresses) {
    if (isBlockedIp(a.address)) {
      // Don't echo the resolved IP to the client.
      console.warn(
        `[coverage] brochure host resolved to a blocked address host=${url.hostname}`,
      );
      throw new ApiError(400, "Brochure host resolves to a disallowed address.");
    }
  }
  return url;
}
