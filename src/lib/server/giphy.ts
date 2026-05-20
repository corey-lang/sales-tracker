import type { GifResult } from "@/lib/team-messages";

// Server-only GIPHY v1 client helpers. Used by:
//   * /api/juice-box/gifs        — picker search/trending
//   * /api/team-messages (POST)  — re-fetch a GIPHY result by id before
//                                  trusting a GIF post
//
// PROVIDER CHOICE
//   GIPHY replaces Tenor here because Tenor stopped onboarding new API
//   clients. The wire shape exposed to the client (GifResult) stays
//   provider-neutral so future swaps are localized to this file.
//
// SECURITY MODEL
//   The GIPHY API key never leaves the server. All metadata (URL, thumb,
//   dimensions, alt text) persisted for a GIF post is derived from a
//   fresh upstream fetch keyed by GIPHY result id — clients cannot
//   smuggle arbitrary hostnames, formats, or rating tiers in by
//   hand-crafting a media_url.

const GIPHY_BASE = "https://api.giphy.com/v1/gifs";

// Family-friendly default. GIPHY ratings: y, g, pg, pg-13, r — pg keeps
// reaction-style humor but excludes adult content.
const GIPHY_RATING = "pg";

// Hostnames considered "GIPHY-hosted." GIPHY's GIF asset URLs are
// served from the sharded media[0-4].giphy.com CDN family — no other
// subdomain is legitimately used by `images.original` / `fixed_width`
// in the API response. This allowlist is intentionally stricter than
// "*.giphy.com" so we never accept a hot-link from giphy.com (the
// marketing site), api.giphy.com, support.giphy.com, etc., even if
// GIPHY ever started returning such hosts on accident.
const ALLOWED_GIPHY_HOSTS = new Set([
  "media.giphy.com",
  "media0.giphy.com",
  "media1.giphy.com",
  "media2.giphy.com",
  "media3.giphy.com",
  "media4.giphy.com",
]);

export function isGiphyHost(host: string): boolean {
  return ALLOWED_GIPHY_HOSTS.has(host);
}

// Subset of the GIPHY JSON shape we read. Everything else (mp4 variants,
// upload metadata, social analytics, etc.) is ignored.
type GiphyImage = {
  url?: string;
  width?: string;
  height?: string;
};
type GiphyRow = {
  id?: string;
  title?: string;
  alt_text?: string;
  images?: Record<string, GiphyImage | undefined>;
};
type GiphySearchResponse = { data?: GiphyRow[] };
type GiphyByIdResponse = { data?: GiphyRow | GiphyRow[] };

function parseDim(s: string | undefined): number {
  if (!s) return 0;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Normalizes one GIPHY row into a GifResult. Returns null when the row
 * is missing required fields (id, original url, dimensions) — the
 * caller filters those out so we never persist a half-empty GIF record.
 *
 * Format picks:
 *   * full_url   → images.original (the GIF the user sees in lightbox)
 *   * preview_url → images.fixed_width (~200 px wide thumbnail; used
 *                   for the picker grid and the in-feed render via
 *                   media_thumb_url, which saves bandwidth)
 */
export function formatGifResult(row: GiphyRow): GifResult | null {
  if (!row?.id) return null;
  const images = row.images ?? {};
  const original = images.original;
  const preview = images.fixed_width ?? images.downsized ?? original;
  if (!original?.url || !preview?.url) return null;
  const width = parseDim(original.width);
  const height = parseDim(original.height);
  if (!width || !height) return null;
  return {
    id: row.id,
    alt: row.alt_text ?? row.title ?? "GIF",
    full_url: original.url,
    preview_url: preview.url,
    width,
    height,
  };
}

/**
 * Hits /search or /trending depending on whether a query is provided.
 * Returns null when GIPHY_API_KEY isn't configured so the picker route
 * can render a friendly "not configured" state instead of erroring.
 * Throws when the upstream call itself fails (5xx, network).
 */
export async function searchGiphy(opts: {
  q: string;
  limit: number;
}): Promise<GifResult[] | null> {
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey) return null;

  const params = new URLSearchParams({
    api_key: apiKey,
    limit: String(opts.limit),
    rating: GIPHY_RATING,
  });
  const trimmed = opts.q.trim();
  if (trimmed.length > 0) params.set("q", trimmed);

  const endpoint =
    trimmed.length > 0
      ? `${GIPHY_BASE}/search?${params.toString()}`
      : `${GIPHY_BASE}/trending?${params.toString()}`;

  const res = await fetch(endpoint, {
    // GIPHY's CDN is highly cacheable; opt into Next's data cache for a
    // short window so back-to-back searches with the same query don't
    // keep round-tripping.
    next: { revalidate: 60 },
  });
  if (!res.ok) throw new Error(`GIPHY responded ${res.status}.`);

  const json = (await res.json()) as GiphySearchResponse;
  return (json.data ?? [])
    .map(formatGifResult)
    .filter((r): r is GifResult => r !== null);
}

/**
 * Re-fetches a specific GIPHY result by id. The create-message route
 * uses this to verify a GIF post: the client only sends `gif_id`, and
 * the server pulls the authoritative URL/thumb/dims/alt straight from
 * GIPHY before persisting.
 *
 * Returns null when:
 *   - GIPHY_API_KEY is unset (route then rejects the post),
 *   - GIPHY responds non-2xx (e.g., 404 for a deleted asset),
 *   - the result is missing required image formats.
 */
export async function fetchGiphyById(id: string): Promise<GifResult | null> {
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey) return null;

  const params = new URLSearchParams({ api_key: apiKey });
  const res = await fetch(`${GIPHY_BASE}/${encodeURIComponent(id)}?${params.toString()}`, {
    // Don't cache cross-user — each post intends to attach a specific
    // current asset, so we want a live verification.
    cache: "no-store",
  });
  if (!res.ok) return null;

  const json = (await res.json()) as GiphyByIdResponse;
  // GIPHY's single-id response shape is `{ data: {...} }` (object), but
  // the API is occasionally returned as an array. Handle both.
  const row = Array.isArray(json.data) ? json.data[0] : json.data;
  if (!row) return null;
  return formatGifResult(row);
}
