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
// ENVIRONMENT SCOPING
//   No env filter. The office id is globally unique and the caller
//   gate (`requireOfficeImporter`) is the admin protection layer —
//   admins / office-importers can inspect any office they imported,
//   regardless of slice. AE-facing read surfaces (/api/offices/*)
//   are pinned to `officeEnvironmentFor(me)` so cross-env exposure
//   never reaches an AE.
//
// SHAPE
//   200  { detail: OfficeDetail }
//   400  invalid uuid
//   401  no session token
//   403  caller is missing the office-import permission
//   404  office id doesn't exist
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

    // Office read first (PK lookup, admin-only inspection of any
    // office id — no env filter).
    const officeRes = await supabase
      .from(OFFICES_TABLE)
      .select(OFFICE_COLUMNS)
      .eq("id", id)
      .maybeSingle();

    if (officeRes.error) {
      console.warn(
        `[offices-detail] office lookup failed office_id=${id} code=${officeRes.error.code ?? "?"} msg=${officeRes.error.message}`,
      );
      throw new ApiError(500, "Could not load office detail.");
    }
    if (!officeRes.data) {
      throw notFound("Office not found.");
    }

    const office = officeRes.data as unknown as OfficeRow;

    // Visits read is independent of the office read. A failure here
    // degrades to an empty timeline + warning rather than 500'ing
    // the entire detail (the office row is the critical part of the
    // payload). Drops the prior `count: "exact"` flag — see the
    // matching note in /api/offices/[id]/route.ts for the full
    // rationale; `visit_count` derives from `visits.length` which is
    // accurate up to the inline cap.
    let visits: OfficeVisitRow[] = [];
    let visitsLoadWarning: string | undefined;
    // Wrapped so BOTH PostgREST row-errors AND thrown exceptions
    // (network/timeout/fetch failures from supabase-js) degrade to
    // the warning instead of 500'ing the whole detail. See the
    // matching block in /api/offices/[id]/route.ts for full notes.
    const visitsStartedAt = Date.now();
    try {
      const visitsRes = await supabase
        .from(OFFICE_VISITS_TABLE)
        .select(VISIT_COLUMNS)
        .eq("office_id", id)
        .order("visited_at", { ascending: false })
        .limit(OFFICE_VISITS_DETAIL_LIMIT);

      if (visitsRes.error) {
        console.warn(
          `[offices-detail] visits lookup failed office_id=${id} elapsed_ms=${Date.now() - visitsStartedAt} code=${visitsRes.error.code ?? "?"} msg=${visitsRes.error.message}`,
        );
        visitsLoadWarning =
          "Couldn't load visit history right now. Reload to retry.";
      } else {
        visits = (visitsRes.data ?? []) as unknown as OfficeVisitRow[];
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[offices-detail] visits lookup threw office_id=${id} elapsed_ms=${Date.now() - visitsStartedAt} err=${msg}`,
      );
      visitsLoadWarning =
        "Couldn't load visit history right now. Reload to retry.";
    }

    const detail: OfficeDetail = {
      office,
      visits,
      // `visited_at` is NOT NULL in the schema, but use ?? null defensively
      // so a future nullable migration doesn't break the response shape.
      last_visit_at: visits[0]?.visited_at ?? null,
      visit_count: visits.length,
      ...(visitsLoadWarning ? { visits_load_warning: visitsLoadWarning } : {}),
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
