import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import { ApiError, handleApiError, requireAeToolAccess } from "@/lib/server/auth";
import {
  MAP_ALL_RESULT_LIMIT,
  officeEnvironmentFor,
  OFFICES_TABLE,
  OFFICE_VISITS_TABLE,
  type OfficeMapItem,
} from "@/lib/offices";
import { haversineMiles } from "@/lib/geo";

// GET /api/offices/map?lat=<optional>&lng=<optional>
//
// "Every office assigned to me, unbounded by distance" — the data source
// for the Map tab's default "All My Offices" scope
// (src/app/offices/page.tsx). Distinct from /api/offices/nearby, which
// stays radius-scoped and untouched: the product requirement here is that
// geolocation must never gate which pins load by default. `lat`/`lng` are
// OPTIONAL and, when present, are used ONLY to annotate each office with
// `distance_miles` for display — never to filter the result set. Selecting
// an optional 5/10/25-mile radius filter in the UI still goes through
// /api/offices/nearby, unchanged.
//
// AUDIENCE / SCOPE — identical posture to the rest of the office surface:
//   * requireAeToolAccess (every signed-in salesperson except juice_box_only)
//   * salesperson_id = me.id, hard-pinned server-side — never accepted from
//     the client.
//   * environment = officeEnvironmentFor(me), derived server-side — never
//     accepted from the client. Real AEs get "production"; the seeded test
//     account gets "test".
//   * archived_at IS NULL — archived offices are hidden everywhere else on
//     the office surface; same rule here.
//   * latitude/longitude IS NOT NULL — offices without coordinates can't be
//     placed on a map. They remain visible in the List view.
//
// CAP
//   MAP_ALL_RESULT_LIMIT (2,000) is a generous backstop, not a working
//   limit — this endpoint's entire point is "load everything assigned."
//   Hitting it would be an anomaly for an 11-person team; it's logged
//   loudly and flagged via `truncated` rather than silently dropping
//   offices from the map.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OptionalCenterSchema = z.object({
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
});

/**
 * Best-effort optional center for distance annotation. Returns null on any
 * missing/invalid input rather than erroring — lat/lng are a display-only
 * enhancement on this route, never a requirement (that's the whole point
 * of "all" scope).
 */
function parseOptionalCenter(url: URL): { lat: number; lng: number } | null {
  const rawLat = url.searchParams.get("lat");
  const rawLng = url.searchParams.get("lng");
  if (rawLat === null || rawLng === null) return null;
  const parsed = OptionalCenterSchema.safeParse({
    lat: Number(rawLat),
    lng: Number(rawLng),
  });
  return parsed.success ? parsed.data : null;
}

type OfficeMapRow = {
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

/** Chunk size for the visits IN() lookup. Mirrors /api/offices' rationale:
 *  200 UUIDs (~7.5KB) stays well under proxy header/URL budgets (Cloudflare
 *  ~8KB headers, Vercel ~16KB total) even at this route's larger scale. */
const VISITS_IN_CHUNK = 200;

export async function GET(req: Request) {
  try {
    const me = await requireAeToolAccess(req);
    const environment = officeEnvironmentFor(me);
    const center = parseOptionalCenter(new URL(req.url));

    const supabase = getServerSupabase();

    // Every assigned, non-archived, mappable office — no distance filter.
    // Fetch one row past the cap so `truncated` can be computed without a
    // separate COUNT query.
    const officesRes = await supabase
      .from(OFFICES_TABLE)
      .select(
        "id, name, street, city, state, zip, latitude, longitude, next_action, next_action_due_date",
      )
      .eq("salesperson_id", me.id)
      .eq("environment", environment)
      .is("archived_at", null)
      .not("latitude", "is", null)
      .not("longitude", "is", null)
      .order("name", { ascending: true })
      .limit(MAP_ALL_RESULT_LIMIT + 1);

    if (officesRes.error) {
      console.warn(
        `[offices-map] offices fetch failed ae=${me.id} code=${officesRes.error.code ?? "?"} msg=${officesRes.error.message}`,
      );
      throw new ApiError(500, "Could not load your offices.");
    }

    const allRows = (officesRes.data ?? []) as OfficeMapRow[];
    const truncated = allRows.length > MAP_ALL_RESULT_LIMIT;
    if (truncated) {
      console.warn(
        `[offices-map] result cap reached ae=${me.id} cap=${MAP_ALL_RESULT_LIMIT} — territory may be larger than expected`,
      );
    }
    const rows = truncated ? allRows.slice(0, MAP_ALL_RESULT_LIMIT) : allRows;

    // Annotate with each office's most-recent visit (per-AE). FAILS
    // CLOSED, same rationale as /api/offices/nearby: this feeds the
    // 30/60/90/Never/Custom visit-age filters directly, so a silent
    // last_visit_at=null on failure would make every office look "never
    // visited" — wrong, not just degraded. Chunked IN() so a large
    // territory can't overflow the proxy's header/URL budget.
    const lastByOffice = new Map<string, string>();
    if (rows.length > 0) {
      const ids = rows.map((o) => o.id);
      for (let i = 0; i < ids.length; i += VISITS_IN_CHUNK) {
        const chunk = ids.slice(i, i + VISITS_IN_CHUNK);
        const chunkStartedAt = Date.now();
        let visitsRes;
        try {
          visitsRes = await supabase
            .from(OFFICE_VISITS_TABLE)
            .select("office_id, visited_at")
            .eq("salesperson_id", me.id)
            .eq("environment", environment)
            .in("office_id", chunk);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[offices-map] visits chunk threw ae=${me.id} chunk_start=${i} chunk_size=${chunk.length} elapsed_ms=${Date.now() - chunkStartedAt} err=${msg}`,
          );
          throw new ApiError(
            502,
            "Couldn't load office visit history. Map filters are unavailable right now.",
          );
        }
        if (visitsRes.error) {
          console.warn(
            `[offices-map] visits chunk failed ae=${me.id} chunk_start=${i} chunk_size=${chunk.length} elapsed_ms=${Date.now() - chunkStartedAt} code=${visitsRes.error.code ?? "?"} msg=${visitsRes.error.message}`,
          );
          throw new ApiError(
            502,
            "Couldn't load office visit history. Map filters are unavailable right now.",
          );
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
    }

    const offices: OfficeMapItem[] = rows.map((o) => ({
      id: o.id,
      name: o.name,
      street: o.street,
      city: o.city,
      state: o.state,
      zip: o.zip,
      latitude: o.latitude,
      longitude: o.longitude,
      distance_miles: center
        ? haversineMiles(center.lat, center.lng, o.latitude, o.longitude)
        : null,
      next_action: o.next_action,
      next_action_due_date: o.next_action_due_date,
      last_visit_at: lastByOffice.get(o.id) ?? null,
    }));

    return Response.json(
      { offices, total: offices.length, truncated },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
