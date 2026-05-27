/**
 * Shared types + constants for the Add Office address-lookup flow.
 *
 * Safe to import from both client components and server routes — no
 * server-only imports. The actual provider call lives in
 * `/api/geocode/search` (server-side proxy so the provider's
 * User-Agent requirement is met without bundling it client-side).
 */

/**
 * One normalized geocode result the client renders + persists. The
 * server proxy translates the upstream provider's shape into this
 * stable, provider-neutral shape so a future swap (Mapbox, Google,
 * etc.) only touches the route, not the UI.
 *
 * Field guarantees:
 *   * `latitude` / `longitude` are finite numbers.
 *   * `formatted` is the single-line "12 Main St, Orem, UT 84057, USA"
 *     style string the user picked.
 *   * `street`, `city`, `state`, `zip` are best-effort splits from the
 *     provider's structured address breakdown. Null when the provider
 *     didn't return that component — coverage outside dense metros
 *     can be patchy, especially for `zip`.
 */
export type GeocodeResult = {
  formatted: string;
  latitude: number;
  longitude: number;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
};

/** Minimum input length before the proxy will hit the provider. Mirrors
 *  the client-side debounce gate so a typed-and-cleared 3-char query
 *  never wastes a round-trip. */
export const GEOCODE_MIN_QUERY_LENGTH = 4;

/** Max suggestions returned to the client + asked of the provider.
 *  Five fits comfortably in a mobile dropdown without scrolling. */
export const GEOCODE_MAX_RESULTS = 5;

/** Client-side debounce window before firing /api/geocode/search.
 *  500 ms keeps request volume well under the upstream Geoapify
 *  free-tier rate limit (5 req/s, 3,000 req/day) even when the
 *  user types fast, while still feeling responsive once they pause.
 *  Pairs with the 60 s server + browser cache on identical queries
 *  to keep daily quota usage low for a small internal team. */
export const GEOCODE_DEBOUNCE_MS = 500;
