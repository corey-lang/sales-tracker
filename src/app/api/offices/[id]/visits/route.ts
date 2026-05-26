import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  badRequest,
  handleApiError,
  notFound,
  parseBody,
  requireTestAccount,
} from "@/lib/server/auth";
import {
  OFFICES_TABLE,
  OFFICE_VISITS_TABLE,
  type OfficeVisitRow,
} from "@/lib/offices";

// POST /api/offices/[id]/visits
//
// Phase 1A — test-only visit logging.
//
// Inserts one office_visits row for the calling test AE against the
// office in the URL. `visited_at` defaults to NOW() (the schema's
// default) — this endpoint is for in-the-moment "I just visited here"
// logging; backdating lives in a future surface.
//
// AUDIENCE / IDENTITY
//   `requireTestAccount` — same gate as the GET/PATCH detail route.
//   `salesperson_id` is the caller's id; never trust a client-supplied
//   value. Ownership is enforced by a pre-check against `offices`:
//   the office must exist, be in `environment = "test"`, AND belong
//   to the caller. The DB trigger
//   (`trg_office_visits_env_from_office`) overrides `environment` from
//   the parent office, so a caller can't smuggle in a 'production'
//   tag even if the route trusted them — but the explicit check here
//   keeps a wrong-owner write from succeeding silently.
//
// FIELDS
//   `visit_note` — optional, free-form ("Dropped off donuts"). Stored
//   as `office_visits.note`. Empty / whitespace-only → null. Capped
//   to keep a runaway paste from filling the column.
//
// SHAPE
//   201  { visit: OfficeVisitRow }
//   400  invalid uuid or body
//   401  no session
//   403  not the test account / juice_box_only / no `is_test` flag
//   404  office doesn't exist, wrong env, or belongs to a different AE
//
// ERRORS
//   Raw DB errors are logged with `[office-visit]` prefix; the caller
//   receives sanitized admin-safe text. Mirrors the detail route.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UuidSchema = z.uuid();

const VISIT_NOTE_MAX = 4000;

const VisitSchema = z.object({
  /** Optional free-text — empty/whitespace-only is normalized to null. */
  visit_note: z.string().max(VISIT_NOTE_MAX).nullable().optional(),
});

const VISIT_COLUMNS =
  "id, office_id, salesperson_id, note, visited_at, environment, created_at";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireTestAccount(req);
    const { id: officeId } = await params;

    const parsedId = UuidSchema.safeParse(officeId);
    if (!parsedId.success) {
      throw badRequest("Invalid office id.");
    }

    const body = await parseBody(req, VisitSchema);

    // Normalize the visit_note up front so the insert sees a clean value.
    // Empty / whitespace-only → null. Trimmed text is stored as-is.
    let note: string | null = null;
    if (typeof body.visit_note === "string") {
      const trimmed = body.visit_note.trim();
      if (trimmed.length > 0) note = trimmed;
    }

    const supabase = getServerSupabase();

    // Ownership pre-check. Filtering by id + env + owner means wrong-env,
    // wrong-owner, and missing all collapse to the same 404 — the
    // response never leaks whether a production or other-AE office
    // exists at this id.
    const officeRes = await supabase
      .from(OFFICES_TABLE)
      .select("id")
      .eq("id", officeId)
      .eq("environment", "test")
      .eq("salesperson_id", me.id)
      .maybeSingle();

    if (officeRes.error) {
      console.warn(
        `[office-visit] office lookup failed office_id=${officeId} ae=${me.id} code=${officeRes.error.code ?? "?"} msg=${officeRes.error.message}`,
      );
      throw new ApiError(500, "Could not record this visit.");
    }
    if (!officeRes.data) {
      throw notFound("Office not found.");
    }

    // The DB trigger derives `environment` from the parent office, so
    // passing "test" here is informational — even a malicious "production"
    // value would be overwritten before the row hits storage. Including
    // it keeps the intent obvious at the call site.
    const insertRes = await supabase
      .from(OFFICE_VISITS_TABLE)
      .insert({
        office_id: officeId,
        salesperson_id: me.id,
        note,
        environment: "test",
      })
      .select(VISIT_COLUMNS)
      .single();

    if (insertRes.error || !insertRes.data) {
      console.warn(
        `[office-visit] insert failed office_id=${officeId} ae=${me.id} code=${insertRes.error?.code ?? "?"} msg=${insertRes.error?.message ?? "no data"}`,
      );
      throw new ApiError(500, "Could not record this visit.");
    }

    const visit = insertRes.data as unknown as OfficeVisitRow;

    return Response.json(
      { visit },
      {
        status: 201,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
