import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  badRequest,
  handleApiError,
  requireTestAccount,
} from "@/lib/server/auth";
import {
  NEARBY_RADIUS_OPTIONS,
  NEARBY_RESULT_LIMIT,
  OFFICES_TABLE,
  OFFICE_VISITS_TABLE,
  type NearbyOfficeItem,
  type NearbyRadius,
} from "@/lib/offices";
import { boundingBox, haversineMiles } from "@/lib/geo";

// GET /api/offices/nearby?lat=<lat>&lng=<lng>&radius=<5|10|25>
//
// "Find me offices within R miles of (lat, lng)" — the data half of
// the /offices/nearby page (Map + List). Same audience + visibility
// model as the rest of the office surface: requireTestAccount +
// per-AE scoping + environment=test.
//
// PIPELINE
//   1. Bounding-box pre-filter in Postgres so we only pull candidate
//      rows whose lat/lng could be within `radius` miles. The box is
//      a square in degrees (cheap, indexable); the true radius is a
//      circle in miles, so the box overshoots slightly.
//   2. Page through EVERY candidate that survives the box (see
//      "DENSE-TERRITORY CORRECTNESS" below).
//   3. Haversine distance per candidate in JS, then drop anything
//      outside the actual circle.
//   4. Sort by distance ascending; cap to NEARBY_RESULT_LIMIT (100).
//   5. Annotate each result with last_visit_at via a single
//      `office_visits` lookup keyed by the surviving office ids.
//
// Offices without coordinates are EXCLUDED (the `NOT NULL` filters
// below). The UI surfaces a hint when this is likely impacting
// results; the route stays focused on returning what's mappable.
//
// DENSE-TERRITORY CORRECTNESS
//   Older versions of this route applied a single
//   `.limit(BBOX_CANDIDATE_LIMIT)` against the bounding-box query
//   to bound response time. That was UNSAFE for AEs whose sandbox
//   has thousands of offices inside the bbox: PostgREST returns
//   rows in implementation-dependent order, so the closest 100
//   could land outside the first 1,000 rows and be silently
//   excluded from the response.
//
//   We now page through ALL bbox candidates (range + stable ORDER
//   BY id) so the Haversine refinement sees the full candidate set.
//   The defensive cap (CANDIDATE_HARD_CEILING) is set far above any
//   realistic per-AE workload — even a dense metro like NYC tops
//   out around a few thousand offices per AE — and any breach is
//   logged loudly so the issue can be diagnosed instead of silently
//   producing wrong nearest results.
//
//   See supabase/offices_nearby_index.sql for the recommended
//   partial index that speeds the bbox query for high-density
//   territories. Correctness does NOT depend on the index; it only
//   affects latency.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Coerce `?lat=…` / `?lng=…` / `?radius=…` strings to numbers
 *  and validate ranges + the closed radius set. */
const QuerySchema = z.object({
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  radius: z
    .number()
    .int()
    .refine(
      (r) => (NEARBY_RADIUS_OPTIONS as readonly number[]).includes(r),
      `radius must be one of ${NEARBY_RADIUS_OPTIONS.join(", ")} miles.`,
    ),
});

/** Page size for the candidate fetch loop. Matches the conventional
 *  PostgREST default max-rows; one fetch returns up to PAGE_SIZE
 *  rows and the loop pages forward until a short page (= no more
 *  data). 1,000 is large enough to keep typical fetches single-
 *  round-trip; small enough that the loop terminates predictably
 *  on dense data. */
const PAGE_SIZE = 1000;

/** Defensive ceiling on the total bounding-box candidate set. Set far
 *  above any realistic per-AE workload (the densest team-known
 *  sandbox is a few thousand offices; this is ~10x that). If a
 *  fetch ever exceeds this cap, the result is logged as a server-
 *  side anomaly and we return what we have — but unlike the prior
 *  `.limit(1000)` we have NOT silently dropped closer offices in
 *  the typical 5k-and-below range, where the loop terminates with
 *  the full candidate set before this ceiling is hit.
 *
 *  If real-world data ever pushes against this number, that's the
 *  signal to introduce PostGIS (`ST_DWithin` against a `geography`
 *  column) — at which point the bounding-box pre-filter goes away
 *  entirely. Until then this cap is the wide safety net the route
 *  needs to be predictable. */
const CANDIDATE_HARD_CEILING = 50_000;

const MAX_PAGES = Math.ceil(CANDIDATE_HARD_CEILING / PAGE_SIZE);

type OfficeCandidateRow = {
  id: string;
  name: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  latitude: number;
  longitude: number;
  next_action: string | null;
  next_action_due_date: string | null;
};

export async function GET(req: Request) {
  try {
    const me = await requireTestAccount(req);

    const url = new URL(req.url);
    // Number("") === 0, which would silently look like a valid lat
    // of 0. Force a presence check first so the user gets a clear
    // 400 instead of an "everything within 10 miles of equator"
    // shaped response.
    const rawLat = url.searchParams.get("lat");
    const rawLng = url.searchParams.get("lng");
    const rawRadius = url.searchParams.get("radius");
    if (rawLat === null || rawLng === null || rawRadius === null) {
      throw badRequest("lat, lng, and radius are required.");
    }
    const parsed = QuerySchema.safeParse({
      lat: Number(rawLat),
      lng: Number(rawLng),
      radius: Number(rawRadius),
    });
    if (!parsed.success) {
      throw badRequest("Invalid lat / lng / radius.");
    }
    const { lat, lng, radius } = parsed.data;
    const radiusMiles = radius as NearbyRadius;

    const supabase = getServerSupabase();
    const box = boundingBox(lat, lng, radiusMiles);

    // Paged bounding-box fetch. Pulls EVERY office whose lat/lng
    // could be within the search radius — closer offices can never
    // be excluded by paging the way a single `.limit()` would.
    //
    // Ordering by `id` keeps each page deterministic so consecutive
    // `.range()` slices don't overlap or skip rows (PostgREST is
    // free to return arbitrary order without an ORDER BY, which is
    // exactly the trap the prior `.limit(1000)` design fell into).
    // The id is also covered by the table's primary-key index, so
    // the sort is free.
    //
    // The `.not("col", "is", null)` calls translate to `col IS NOT
    // NULL` in PostgREST so offices without coordinates are pre-
    // filtered out at the database layer.
    const candidates: OfficeCandidateRow[] = [];
    let candidatesTruncated = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      const pageRes = await supabase
        .from(OFFICES_TABLE)
        .select(
          "id, name, street, city, state, zip, latitude, longitude, next_action, next_action_due_date",
        )
        .eq("salesperson_id", me.id)
        .eq("environment", "test")
        // Hide archived offices from the map. Same filter as the
        // List + detail routes; see offices_archived_at.sql for
        // why archive (not hard delete) is the right model.
        .is("archived_at", null)
        .not("latitude", "is", null)
        .not("longitude", "is", null)
        .gte("latitude", box.minLat)
        .lte("latitude", box.maxLat)
        .gte("longitude", box.minLng)
        .lte("longitude", box.maxLng)
        .order("id", { ascending: true })
        .range(from, to);

      if (pageRes.error) {
        // Raw provider error stays server-side; the caller sees a
        // sanitized 500. Matches the other office routes.
        console.warn(
          `[offices-nearby] candidate fetch failed ae=${me.id} page=${page} code=${pageRes.error.code ?? "?"} msg=${pageRes.error.message}`,
        );
        throw new ApiError(500, "Could not load nearby offices.");
      }

      const batch = (pageRes.data ?? []) as OfficeCandidateRow[];
      candidates.push(...batch);

      // Short page (< PAGE_SIZE) means we've drained the bbox set.
      // Bail out of the loop; everything below is exact.
      if (batch.length < PAGE_SIZE) break;

      // Hit MAX_PAGES with a full final batch → the bbox set is
      // larger than CANDIDATE_HARD_CEILING. Anomalous for current
      // scale; log loudly + flag the response so a future spike
      // can be diagnosed instead of silently returning "wrong"
      // nearests.
      if (page === MAX_PAGES - 1) {
        candidatesTruncated = true;
        console.warn(
          `[offices-nearby] candidate ceiling reached ae=${me.id} ceiling=${CANDIDATE_HARD_CEILING} radius=${radiusMiles} — consider PostGIS migration if this recurs`,
        );
      }
    }

    // Haversine refinement. Compute once per candidate; filter to the
    // true circle; sort ascending so closest-first is authoritative
    // from the server (the UI doesn't re-sort).
    const withDistance = candidates
      .map((o) => ({
        ...o,
        distance_miles: haversineMiles(lat, lng, o.latitude, o.longitude),
      }))
      .filter((o) => o.distance_miles <= radiusMiles)
      .sort((a, b) => a.distance_miles - b.distance_miles);

    const totalInRange = withDistance.length;
    const visible = withDistance.slice(0, NEARBY_RESULT_LIMIT);
    const truncated = totalInRange > NEARBY_RESULT_LIMIT;

    // Annotate with each office's most-recent visit (per-AE).
    // Skip the lookup when there's nothing to annotate.
    const lastByOffice = new Map<string, string>();
    if (visible.length > 0) {
      const ids = visible.map((o) => o.id);
      const visitsRes = await supabase
        .from(OFFICE_VISITS_TABLE)
        .select("office_id, visited_at")
        .eq("salesperson_id", me.id)
        .eq("environment", "test")
        .in("office_id", ids);
      if (visitsRes.error) {
        console.warn(
          `[offices-nearby] visits fetch failed ae=${me.id} office_count=${ids.length} code=${visitsRes.error.code ?? "?"} msg=${visitsRes.error.message}`,
        );
        throw new ApiError(500, "Could not load visit history.");
      }
      for (const v of (visitsRes.data ?? []) as Array<{
        office_id: string;
        visited_at: string;
      }>) {
        const existing = lastByOffice.get(v.office_id);
        if (!existing || v.visited_at > existing) {
          lastByOffice.set(v.office_id, v.visited_at);
        }
      }
    }

    const nearby: NearbyOfficeItem[] = visible.map((o) => ({
      id: o.id,
      name: o.name,
      street: o.street,
      city: o.city,
      state: o.state,
      zip: o.zip,
      latitude: o.latitude,
      longitude: o.longitude,
      distance_miles: o.distance_miles,
      next_action: o.next_action,
      next_action_due_date: o.next_action_due_date,
      last_visit_at: lastByOffice.get(o.id) ?? null,
    }));

    return Response.json(
      {
        nearby,
        total_in_range: totalInRange,
        truncated,
        // `candidates_truncated` is true only when the bbox set
        // itself was capped by CANDIDATE_HARD_CEILING — i.e. the
        // request pulled the maximum number of pages and the final
        // page was full. In normal operation this is always false;
        // surfacing it lets a future debug surface flag the rare
        // anomaly without changing UX for the typical case.
        candidates_truncated: candidatesTruncated,
        radius_miles: radiusMiles,
        searched_at: { lat, lng },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
