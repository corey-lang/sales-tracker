import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  badRequest,
  handleApiError,
  notFound,
  requireOfficeImporter,
} from "@/lib/server/auth";
import {
  OFFICES_TABLE,
  OFFICE_VISITS_TABLE,
  OFFICE_VISITS_DETAIL_LIMIT,
  type OfficeDetail,
  type OfficeRow,
  type OfficeVisitRow,
} from "@/lib/offices";

// GET /api/admin/offices/[id]
//
// Returns the aggregate "open this office" payload — the office row
// itself (including persistent `office_notes` + `next_action`), the
// visit log newest-first, the most-recent visit timestamp, and an
// authoritative visit count.
//
// AUDIENCE
//   Foundation for the upcoming office-detail surface (no UI yet).
//   `requireOfficeImporter` gates access — same admin / `can_import_offices`
//   gate as the import route. AE-facing reads (the eventual map +
//   per-AE office list) will land later with their own permission
//   model; this endpoint exists so the importer-side can verify what
//   was loaded and so the future detail page has a real shape to
//   render against.
//
// SANDBOX SCOPING
//   Both the office read AND the visits read are pinned to
//   `environment = "test"`. The office import route is currently
//   hard-coded to write only test rows, but a future production-mode
//   flip on imports must NOT silently expose production offices
//   through this surface. The wrong-environment case returns the
//   same opaque 404 ("Office not found.") as a truly-missing id so
//   the response doesn't leak whether a production office exists.
//
// SHAPE
//   200  { detail: OfficeDetail }
//   400  invalid uuid
//   401  no session token
//   403  caller is missing the office-import permission
//   404  office id doesn't exist in the test environment
//
// CAPPING
//   The visits array is capped at OFFICE_VISITS_DETAIL_LIMIT (200) and
//   newest-first; `visit_count` is the AUTHORITATIVE total via COUNT(*),
//   so the UI can render "27 visits" even when the inline array would
//   need to ship more than the cap. A future paginated route can
//   serve older history when the UI needs it.
//
// ERROR HANDLING
//   Raw Supabase/provider error text is NEVER returned to the caller.
//   Failures log to console with the `[offices-detail]` prefix and
//   the route returns sanitized admin-safe reasons. Matches the
//   posture already in place for /api/admin/offices/import.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UuidSchema = z.uuid();

const OFFICE_COLUMNS =
  "id, salesperson_id, import_batch_id, name, street, city, state, zip, " +
  "latitude, longitude, source, dedupe_key, environment, " +
  "office_notes, next_action, created_at, updated_at";

const VISIT_COLUMNS =
  "id, office_id, salesperson_id, note, visited_at, environment, created_at";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireOfficeImporter(req);
    const { id } = await params;

    // UUID parse up front so a malformed id never reaches the DB.
    const parsed = UuidSchema.safeParse(id);
    if (!parsed.success) {
      throw badRequest("Invalid office id.");
    }

    const supabase = getServerSupabase();

    // Two reads in parallel: office row + visit list w/ exact count.
    // Both reads are pinned to `environment = "test"` — see SANDBOX
    // SCOPING in the header. `count: "exact"` makes Supabase issue a
    // Postgres `count(*) over()`, returning the true total alongside
    // the page slice — so a visit_count of 27 + a visits.length of 27
    // is the same fast call as a count of 412 + a visits.length of 200.
    const [officeRes, visitsRes] = await Promise.all([
      supabase
        .from(OFFICES_TABLE)
        .select(OFFICE_COLUMNS)
        .eq("id", id)
        .eq("environment", "test")
        .maybeSingle(),
      supabase
        .from(OFFICE_VISITS_TABLE)
        .select(VISIT_COLUMNS, { count: "exact" })
        .eq("office_id", id)
        .eq("environment", "test")
        .order("visited_at", { ascending: false })
        .limit(OFFICE_VISITS_DETAIL_LIMIT),
    ]);

    // Sanitize all DB error paths. Raw provider message goes to function
    // logs with batch/route context; caller gets a stable admin-safe
    // string. Matches the import route's posture so the office surfaces
    // share an error-handling contract.
    if (officeRes.error) {
      console.warn(
        `[offices-detail] office lookup failed office_id=${id} code=${officeRes.error.code ?? "?"} msg=${officeRes.error.message}`,
      );
      throw new ApiError(500, "Could not load office detail.");
    }
    if (!officeRes.data) {
      // Real-not-found AND wrong-environment collapse here — the
      // response never confirms whether a production office with this
      // id exists.
      throw notFound("Office not found.");
    }
    if (visitsRes.error) {
      console.warn(
        `[offices-detail] visits lookup failed office_id=${id} code=${visitsRes.error.code ?? "?"} msg=${visitsRes.error.message}`,
      );
      throw new ApiError(500, "Could not load office visit history.");
    }

    // Dynamic select strings defeat Supabase's type inference; cast via
    // unknown to apply the column-level row shapes we own.
    const office = officeRes.data as unknown as OfficeRow;
    const visits = (visitsRes.data ?? []) as unknown as OfficeVisitRow[];

    const detail: OfficeDetail = {
      office,
      visits,
      // `visited_at` is NOT NULL in the schema, but use ?? null defensively
      // so a future nullable migration doesn't break the response shape.
      last_visit_at: visits[0]?.visited_at ?? null,
      // Prefer the authoritative COUNT(*) from PostgREST. Fall back to the
      // returned array length only if the count header was missing for any
      // reason (it should always be present with count: "exact").
      visit_count:
        typeof visitsRes.count === "number"
          ? visitsRes.count
          : visits.length,
    };

    // `private, no-store` matches /api/offices/[id] + /api/me/permissions
    // — office detail can mutate at any moment (notes edits, fresh
    // visits) and the response is per-caller, so neither shared caches
    // nor the browser should keep a copy.
    return Response.json(
      { detail },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
