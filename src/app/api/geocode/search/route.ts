import { z } from "zod";

import {
  ApiError,
  badRequest,
  handleApiError,
  requireAeToolAccess,
} from "@/lib/server/auth";
import {
  GEOCODE_MAX_RESULTS,
  GEOCODE_MIN_QUERY_LENGTH,
  type GeocodeResult,
} from "@/lib/geocode";

// GET /api/geocode/search?q=<query>
//
// Server-side proxy in front of Geoapify's Address Autocomplete API.
// Powers the address autocomplete on the Add Office modal at
// /offices. The client only knows about this route's URL + the
// `GeocodeResult` response shape — it doesn't know (or care) which
// upstream provider answered.
//
// WHY GEOAPIFY
//   * Purpose-built autocomplete ranking. The `/autocomplete`
//     endpoint ranks for incremental typing, so "Smith Realty
//     Provo" surfaces office-shaped POIs before street fragments.
//     Suggestion quality for real-estate office discovery is the
//     reason this surface exists.
//   * Dependable free-tier rate limits (3,000 req/day, 5 req/s) —
//     comfortably above the realistic AE usage for an internal
//     team, and the client-side debounce + server cache leave
//     plenty of headroom.
//   * Structured address payload (`housenumber` / `street` / `city`
//     / `state` / `postcode`) maps cleanly onto our `GeocodeResult`
//     without province/town/village fallback chains.
//
// WHY A PROXY (still required)
//   * Keeps the API key server-side. The browser bundle never sees
//     `GEOAPIFY_API_KEY` — losing the key wouldn't let an attacker
//     burn through quota from a leaked NEXT_PUBLIC_ var.
//   * Lets us cache + normalize + sanitize the upstream response.
//   * Lets us 502 cleanly if the provider has a hiccup so the
//     client can fall back to the manual-address path.
//
// AUDIENCE
//   `requireAeToolAccess` — same gate as the rest of the office
//   surface. The autocomplete is only reachable from the Add Office
//   modal (AE office tools), so the gate keeps the proxy from
//   being a generic anonymous service abused by other clients.
//   juice_box_only callers are rejected outright.
//
// MISSING KEY HANDLING
//   When `GEOAPIFY_API_KEY` is unset (forgot to set the env in a
//   deploy, key rotated, etc.) the route returns the same sanitized
//   502 it returns for any other upstream issue — so the modal's
//   "Couldn't load suggestions. Try again or enter the address
//   manually." UX kicks in and the AE can still add the office
//   without coords. The server-side warning line names the env var
//   for the admin debugging it.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  q: z.string().trim().min(GEOCODE_MIN_QUERY_LENGTH).max(200),
});

const GEOAPIFY_AUTOCOMPLETE_URL =
  "https://api.geoapify.com/v1/geocode/autocomplete";

/** Sanitized "the address lookup didn't work" message — single
 *  source of truth so every failure branch surfaces the same copy. */
const UNAVAILABLE_MESSAGE = "Address lookup is temporarily unavailable.";

/** Shape of one feature in the Geoapify GeoJSON response (only the
 *  fields we read). Defined locally so we don't import @types for
 *  the provider's full type surface. Every field is `unknown` and
 *  re-validated at use — the upstream is treated as untrusted. */
type GeoapifyFeature = {
  geometry?: {
    coordinates?: unknown;
  };
  properties?: {
    formatted?: unknown;
    address_line1?: unknown;
    lat?: unknown;
    lon?: unknown;
    housenumber?: unknown;
    street?: unknown;
    city?: unknown;
    state?: unknown;
    state_code?: unknown;
    postcode?: unknown;
  };
};

/** Reads + trims an `unknown` string field; returns null when the
 *  field is missing, non-string, or empty after trim. Strips any
 *  embedded HTML tags as defense-in-depth — Geoapify shouldn't
 *  return HTML in these fields, but we treat upstream as untrusted. */
function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/<[^>]*>/g, "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Translates one Geoapify feature into our normalized shape.
 *  Returns null when essential fields are missing or malformed so
 *  the caller can skip it. */
function normalizeResult(feature: GeoapifyFeature): GeocodeResult | null {
  const props = feature.properties ?? {};

  // Prefer `properties.lat/lon` (the provider documents these as
  // canonical WGS84 decimals). Fall back to GeoJSON
  // `geometry.coordinates: [lng, lat]` for defensive parity if the
  // properties ever lose them.
  let lat = Number(props.lat);
  let lng = Number(props.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    const coords = feature.geometry?.coordinates;
    if (Array.isArray(coords) && coords.length >= 2) {
      const [c0, c1] = coords;
      if (typeof c0 === "number" && typeof c1 === "number") {
        // GeoJSON convention: [lng, lat].
        lng = c0;
        lat = c1;
      }
    }
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  // `formatted` is the single-line display string the user picks
  // from the dropdown. Fall back to `address_line1` when the
  // provider omits the formatted variant (rare).
  const formatted =
    readString(props.formatted) ?? readString(props.address_line1);
  if (!formatted) return null;

  const housenumber = readString(props.housenumber);
  const road = readString(props.street);
  // Compose "12 Main Street" when both parts are present; otherwise
  // use whichever half came back. Some Geoapify result types
  // (street-level matches without a house number) lack the number.
  const street =
    housenumber && road ? `${housenumber} ${road}` : (road ?? housenumber);

  const city = readString(props.city);
  // Prefer the spelled-out state ("Utah") over the abbreviation
  // ("UT") since the Office Detail page renders this field
  // verbatim; the abbreviation falls back when the full name
  // wasn't returned.
  const state = readString(props.state) ?? readString(props.state_code);
  const zip = readString(props.postcode);

  return {
    formatted,
    latitude: lat,
    longitude: lng,
    street,
    city,
    state,
    zip,
  };
}

export async function GET(req: Request) {
  try {
    await requireAeToolAccess(req);

    const url = new URL(req.url);
    const parsed = QuerySchema.safeParse({
      q: url.searchParams.get("q") ?? "",
    });
    if (!parsed.success) {
      throw badRequest(
        `Query must be at least ${GEOCODE_MIN_QUERY_LENGTH} characters.`,
      );
    }
    const q = parsed.data.q;

    const apiKey = process.env.GEOAPIFY_API_KEY?.trim();
    if (!apiKey) {
      // The env var name is in the log so an admin can spot the
      // misconfiguration; the client gets the same sanitized 502
      // it gets for any other upstream issue, so the modal's
      // "Couldn't load suggestions… manual entry" UX kicks in
      // and the AE isn't blocked.
      console.warn(
        "[geocode] GEOAPIFY_API_KEY is not set; address autocomplete is disabled until it's configured",
      );
      throw new ApiError(502, UNAVAILABLE_MESSAGE);
    }

    const upstream = new URL(GEOAPIFY_AUTOCOMPLETE_URL);
    upstream.searchParams.set("text", q);
    upstream.searchParams.set("limit", String(GEOCODE_MAX_RESULTS));
    upstream.searchParams.set("format", "geojson");
    // Slight regional bias for the test team's primary market
    // without hard-restricting. Drop this when the product goes
    // international.
    upstream.searchParams.set("filter", "countrycode:us,ca");
    upstream.searchParams.set("apiKey", apiKey);

    let res: Response;
    try {
      res = await fetch(upstream.toString(), {
        headers: { Accept: "application/json" },
        // Cache identical queries on Next's runtime for 60 s —
        // absorbs the common case of two people typing the same
        // office and protects our daily Geoapify quota.
        next: { revalidate: 60 },
      });
    } catch (err) {
      console.warn(
        `[geocode] upstream fetch failed q_len=${q.length} err=${String(err)}`,
      );
      throw new ApiError(502, UNAVAILABLE_MESSAGE);
    }

    if (!res.ok) {
      console.warn(
        `[geocode] upstream non-200 q_len=${q.length} status=${res.status}`,
      );
      throw new ApiError(502, UNAVAILABLE_MESSAGE);
    }

    let raw: unknown;
    try {
      raw = await res.json();
    } catch (err) {
      console.warn(
        `[geocode] upstream parse failed q_len=${q.length} err=${String(err)}`,
      );
      throw new ApiError(502, "Address lookup returned an unexpected response.");
    }

    // Geoapify GeoJSON: `{ type: "FeatureCollection", features: [...] }`.
    // We validate the `features` shape defensively — provider
    // changes shouldn't crash the route.
    if (!raw || typeof raw !== "object") {
      console.warn(
        `[geocode] upstream returned non-object q_len=${q.length}`,
      );
      throw new ApiError(502, "Address lookup returned an unexpected response.");
    }
    const features = (raw as { features?: unknown }).features;
    if (!Array.isArray(features)) {
      console.warn(
        `[geocode] upstream missing features q_len=${q.length}`,
      );
      throw new ApiError(502, "Address lookup returned an unexpected response.");
    }

    const results: GeocodeResult[] = [];
    for (const feature of features.slice(0, GEOCODE_MAX_RESULTS)) {
      const normalized = normalizeResult(feature as GeoapifyFeature);
      if (normalized) results.push(normalized);
    }

    return Response.json(
      { results },
      {
        headers: {
          // Browser-side caching of identical queries. `private` so
          // a shared cache (e.g. corporate proxy) doesn't pool
          // results across users; `max-age=60` mirrors the Next
          // revalidate window above.
          "Cache-Control": "private, max-age=60",
        },
      },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
