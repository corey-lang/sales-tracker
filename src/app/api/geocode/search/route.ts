import { z } from "zod";

import {
  ApiError,
  badRequest,
  handleApiError,
  requireTestAccount,
} from "@/lib/server/auth";
import {
  GEOCODE_MAX_RESULTS,
  GEOCODE_MIN_QUERY_LENGTH,
  type GeocodeResult,
} from "@/lib/geocode";

// GET /api/geocode/search?q=<query>
//
// Server-side proxy in front of OpenStreetMap's Nominatim geocoder.
// Powers the address autocomplete on the Add Office modal.
//
// WHY A PROXY (and not a direct browser fetch)
//   * Nominatim's usage policy REQUIRES a custom User-Agent that
//     identifies the application — browsers don't let JS set that
//     header. A server fetch can.
//   * Avoids exposing internal request shape / future provider
//     swaps to the client.
//   * Lets us cache + sanitize the response (the upstream JSON
//     carries a lot of fields we don't need + occasional HTML in
//     `display_name` we don't want rendered verbatim).
//
// PROVIDER CHOICE — OpenStreetMap / Nominatim
//   * Free, no API key.
//   * Usage policy: max ~1 req/s, identifying User-Agent, cache
//     results. We're well under that for an 11-person internal team
//     when paired with the client's 500 ms debounce + 4-char min
//     query gate (see src/lib/geocode.ts).
//   * Falls back gracefully: 502 on upstream failure / parse error
//     so the UI can show "Couldn't load suggestions." and let the
//     user fall back to manual address entry.
//
// AUDIENCE
//   `requireTestAccount` — same gate as the rest of the office
//   surface. The autocomplete is only reachable from the Add Office
//   modal (test-account only), so the gate keeps the proxy from
//   being a generic anonymous service.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  q: z.string().trim().min(GEOCODE_MIN_QUERY_LENGTH).max(200),
});

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

/** Identifies the app to Nominatim per their usage policy. They block
 *  generic User-Agents (the default ones HTTP libraries set). The
 *  contact URL is intentional even though it's a sample — the policy
 *  wants something a sysadmin could look up. */
const USER_AGENT =
  "ElevateSalesTracker/1.0 (https://elevatehs.com; internal office CRM)";

/** Shape of one Nominatim search result (only the fields we read).
 *  Defined locally so we don't import @types for an external API
 *  with a sprawling response surface. */
type NominatimItem = {
  display_name?: unknown;
  lat?: unknown;
  lon?: unknown;
  address?: {
    house_number?: unknown;
    road?: unknown;
    pedestrian?: unknown;
    cycleway?: unknown;
    footway?: unknown;
    city?: unknown;
    town?: unknown;
    village?: unknown;
    hamlet?: unknown;
    suburb?: unknown;
    state?: unknown;
    postcode?: unknown;
  };
};

/** Reads + trims an `unknown` string field; returns null when the
 *  field is missing, non-string, or empty after trim. Strips any
 *  embedded HTML tags as defense-in-depth — Nominatim shouldn't
 *  return HTML in these fields, but we treat the upstream as
 *  untrusted text. */
function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/<[^>]*>/g, "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Translates one upstream item into our normalized shape. Returns
 *  null when essential fields are missing/malformed so the caller
 *  can skip it. Address sub-fields fall back through aliases — OSM
 *  cities are sometimes labeled `town` or `village` instead. */
function normalizeResult(item: NominatimItem): GeocodeResult | null {
  const lat = Number(item.lat);
  const lng = Number(item.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  const formatted = readString(item.display_name);
  if (!formatted) return null;

  const addr = item.address ?? {};
  const houseNumber = readString(addr.house_number);
  const road =
    readString(addr.road) ??
    readString(addr.pedestrian) ??
    readString(addr.cycleway) ??
    readString(addr.footway);
  const street =
    houseNumber && road ? `${houseNumber} ${road}` : (road ?? null);

  const city =
    readString(addr.city) ??
    readString(addr.town) ??
    readString(addr.village) ??
    readString(addr.hamlet) ??
    readString(addr.suburb);

  const state = readString(addr.state);
  const zip = readString(addr.postcode);

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
    // Keep the proxy gated on the same audience that can reach the
    // Add Office modal — prevents the route from becoming a generic
    // unauthenticated proxy that could be abused for rate-limit
    // farming or attribution-fraud.
    await requireTestAccount(req);

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

    const upstream = new URL(NOMINATIM_URL);
    upstream.searchParams.set("q", q);
    upstream.searchParams.set("format", "json");
    upstream.searchParams.set("addressdetails", "1");
    upstream.searchParams.set("limit", String(GEOCODE_MAX_RESULTS));
    // Slight regional bias for the test team's primary market without
    // hard-restricting (the policy lets us pass country hints). Drop
    // this when the product goes international.
    upstream.searchParams.set("countrycodes", "us,ca");

    let res: Response;
    try {
      res = await fetch(upstream.toString(), {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
        // Cache identical queries on Next's runtime for 60 s — matches
        // Nominatim's "cache results" guidance and absorbs the common
        // case of two people typing the same office.
        next: { revalidate: 60 },
      });
    } catch (err) {
      console.warn(
        `[geocode] upstream fetch failed q_len=${q.length} err=${String(err)}`,
      );
      throw new ApiError(502, "Address lookup is temporarily unavailable.");
    }

    if (!res.ok) {
      console.warn(
        `[geocode] upstream non-200 q_len=${q.length} status=${res.status}`,
      );
      throw new ApiError(502, "Address lookup is temporarily unavailable.");
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

    if (!Array.isArray(raw)) {
      console.warn(`[geocode] upstream returned non-array q_len=${q.length}`);
      throw new ApiError(502, "Address lookup returned an unexpected response.");
    }

    const results: GeocodeResult[] = [];
    for (const item of raw.slice(0, GEOCODE_MAX_RESULTS)) {
      const normalized = normalizeResult(item as NominatimItem);
      if (normalized) results.push(normalized);
    }

    return Response.json(
      { results },
      {
        headers: {
          // Browser-side caching of identical queries. `private` so a
          // shared cache (e.g. corporate proxy) doesn't pool results
          // across users; max-age=60 mirrors the Next revalidate
          // window above.
          "Cache-Control": "private, max-age=60",
        },
      },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
