import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  badRequest,
  forbidden,
  handleApiError,
  notFound,
  parseBody,
  requireTestAccount,
} from "@/lib/server/auth";
import {
  OFFICES_TABLE,
  OFFICE_VISITS_TABLE,
  OFFICE_VISITS_DETAIL_LIMIT,
  type OfficeDetail,
  type OfficeRow,
  type OfficeVisitRow,
} from "@/lib/offices";

// /api/offices/[id]
//
// Phase 1A office-detail surface — test-only.
//
// GET    → aggregate OfficeDetail (office row + visit history + counts).
// PATCH  → updates persistent `office_notes` / `next_action`.
//
// AUDIENCE
//   `requireTestAccount` — the seeded test salesperson row (and admins
//   who sign in as that account to test). Real AEs, real admins, and
//   juice_box_only are rejected. Server-trusted identity comes from
//   the signed session token; we never accept a salesperson_id from
//   the caller.
//
// SANDBOX SCOPING
//   Every read and write pins `environment = "test"`. Wrong-env reads
//   collapse to a 404 ("Office not found.") so the response never
//   confirms whether a production office with this id exists.
//
// OWNERSHIP
//   The caller must own the office: `offices.salesperson_id === me.id`.
//   The ownership check is performed via the row read itself — a
//   miss (wrong env, wrong owner, or truly missing) returns the same
//   opaque 404 so we don't leak which offices belong to which AE.
//
// ERROR HANDLING
//   Raw provider error text never reaches the caller. Failures log
//   server-side with the `[office-detail]` prefix and return sanitized
//   admin-safe reasons. Matches the import + admin-detail routes.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UuidSchema = z.uuid();

const OFFICE_COLUMNS =
  "id, salesperson_id, import_batch_id, name, street, city, state, zip, " +
  "latitude, longitude, source, dedupe_key, environment, " +
  "office_notes, next_action, next_action_due_date, " +
  "office_phone, office_email, external_badger_id, archived_at, " +
  "created_at, updated_at";

const VISIT_COLUMNS =
  "id, office_id, salesperson_id, note, visited_at, environment, created_at";

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireTestAccount(req);
    const { id } = await params;

    const parsed = UuidSchema.safeParse(id);
    if (!parsed.success) {
      throw badRequest("Invalid office id.");
    }

    const supabase = getServerSupabase();

    // Office read includes ownership (`salesperson_id = me.id`) and
    // environment in the predicate — wrong env, wrong owner, and not-
    // found all collapse to the same 404 so the response is uniform.
    //
    // Visits read uses `count: "exact"` so `visit_count` is authoritative
    // even when the inline array would be capped by OFFICE_VISITS_DETAIL_LIMIT.
    // Both reads are issued in parallel — the visits query also pins
    // `salesperson_id = me.id` for ownership symmetry / defense-in-depth.
    // The office read above would already 404 a stranger's id, but
    // duplicating the predicate here means a future refactor that
    // splits these reads apart can't accidentally surface another AE's
    // visits for an office they happen to know the id of.
    const [officeRes, visitsRes] = await Promise.all([
      supabase
        .from(OFFICES_TABLE)
        .select(OFFICE_COLUMNS)
        .eq("id", id)
        .eq("environment", "test")
        .eq("salesperson_id", me.id)
        // Archived offices disappear from every read surface so the
        // soft-delete on the detail page hides the row from List,
        // Map, and follow-up detail visits alike. See
        // offices_archived_at.sql for why archive is preferred over
        // hard delete (preserves visit history + task FK targets).
        .is("archived_at", null)
        .maybeSingle(),
      supabase
        .from(OFFICE_VISITS_TABLE)
        .select(VISIT_COLUMNS, { count: "exact" })
        .eq("office_id", id)
        .eq("environment", "test")
        .eq("salesperson_id", me.id)
        .order("visited_at", { ascending: false })
        .limit(OFFICE_VISITS_DETAIL_LIMIT),
    ]);

    if (officeRes.error) {
      console.warn(
        `[office-detail] office lookup failed office_id=${id} ae=${me.id} code=${officeRes.error.code ?? "?"} msg=${officeRes.error.message}`,
      );
      throw new ApiError(500, "Could not load office detail.");
    }
    if (!officeRes.data) {
      throw notFound("Office not found.");
    }
    if (visitsRes.error) {
      console.warn(
        `[office-detail] visits lookup failed office_id=${id} ae=${me.id} code=${visitsRes.error.code ?? "?"} msg=${visitsRes.error.message}`,
      );
      throw new ApiError(500, "Could not load office visit history.");
    }

    const office = officeRes.data as unknown as OfficeRow;
    const visits = (visitsRes.data ?? []) as unknown as OfficeVisitRow[];

    const detail: OfficeDetail = {
      office,
      visits,
      last_visit_at: visits[0]?.visited_at ?? null,
      visit_count:
        typeof visitsRes.count === "number"
          ? visitsRes.count
          : visits.length,
    };

    return Response.json(
      { detail },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

// office_notes, next_action, and next_action_due_date are all
// independently optional. A PATCH request must include AT LEAST one
// of them — sending an empty body is a 400 (no-op writes are
// pointless and obscure real bugs). Strings are trimmed;
// empty/whitespace-only payloads clear the column (stored as NULL).
// Caps mirror the import route's persistent-text caps.
const OFFICE_NOTES_MAX = 4000;
const NEXT_ACTION_MAX = 500;

// Helper: trim a possibly-null/undefined string to text-or-null.
// Returns `undefined` when the field wasn't supplied (so we can skip
// writing it), `null` when explicitly cleared, or the trimmed string.
function normalizePatchField(
  value: string | null | undefined,
  max: number,
  field: string,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) {
    throw badRequest(
      `${field} is too long — max ${max} characters.`,
    );
  }
  return trimmed;
}

/** YYYY-MM-DD date strings only. Real calendar dates required. */
const dueDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "next_action_due_date must be in YYYY-MM-DD format.")
  .refine(
    (v) => !Number.isNaN(Date.parse(v)),
    "next_action_due_date is not a real date.",
  );

const PatchSchema = z
  .object({
    office_notes: z.string().max(OFFICE_NOTES_MAX).nullable().optional(),
    next_action: z.string().max(NEXT_ACTION_MAX).nullable().optional(),
    next_action_due_date: dueDateSchema.nullable().optional(),
  })
  .refine(
    (body) =>
      body.office_notes !== undefined ||
      body.next_action !== undefined ||
      body.next_action_due_date !== undefined,
    {
      message:
        "Provide office_notes, next_action, and/or next_action_due_date.",
      path: ["office_notes"],
    },
  );

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireTestAccount(req);
    const { id } = await params;

    const parsedId = UuidSchema.safeParse(id);
    if (!parsedId.success) {
      throw badRequest("Invalid office id.");
    }

    const body = await parseBody(req, PatchSchema);

    // Build the update payload from only the fields the caller supplied.
    // `undefined` means "don't touch this column"; `null` means "clear it";
    // a trimmed non-empty string / valid date is stored as-is.
    const update: {
      office_notes?: string | null;
      next_action?: string | null;
      next_action_due_date?: string | null;
    } = {};
    const notes = normalizePatchField(
      body.office_notes,
      OFFICE_NOTES_MAX,
      "office_notes",
    );
    const nextAction = normalizePatchField(
      body.next_action,
      NEXT_ACTION_MAX,
      "next_action",
    );
    if (notes !== undefined) update.office_notes = notes;
    if (nextAction !== undefined) update.next_action = nextAction;
    // `next_action_due_date` is a YYYY-MM-DD string or null — Zod has
    // already validated the shape. We pass it straight through so the
    // route stays uniform with the other PATCH fields.
    if (body.next_action_due_date !== undefined) {
      update.next_action_due_date = body.next_action_due_date;
    }

    // Defense in depth: if all three ended up undefined (shouldn't
    // happen given the Zod refine above) bail rather than issuing a
    // no-op UPDATE that fires the updated_at trigger.
    if (
      update.office_notes === undefined &&
      update.next_action === undefined &&
      update.next_action_due_date === undefined
    ) {
      throw badRequest(
        "Provide office_notes, next_action, and/or next_action_due_date.",
      );
    }

    const supabase = getServerSupabase();

    // The UPDATE filters by id + environment + ownership, mirroring the
    // GET. A row count of 0 means the office doesn't exist, is in the
    // wrong environment, or belongs to a different AE — all three
    // collapse to a 404 so the response never confirms which.
    //
    // RETURNING gives us the fresh row to send back to the UI so the
    // detail surface can update in place without a follow-up GET.
    const updRes = await supabase
      .from(OFFICES_TABLE)
      .update(update)
      .eq("id", id)
      .eq("environment", "test")
      .eq("salesperson_id", me.id)
      // PATCH only succeeds against active rows. An archived office
      // appears as 404 to the caller, same as a wrong-owner or wrong-
      // env miss — uniform "Office not found." response.
      .is("archived_at", null)
      .select(OFFICE_COLUMNS)
      .maybeSingle();

    if (updRes.error) {
      console.warn(
        `[office-detail] patch failed office_id=${id} ae=${me.id} code=${updRes.error.code ?? "?"} msg=${updRes.error.message}`,
      );
      throw new ApiError(500, "Could not update this office.");
    }
    if (!updRes.data) {
      throw notFound("Office not found.");
    }

    const office = updRes.data as unknown as OfficeRow;

    // Belt-and-braces — the update predicate already enforces these,
    // but a future refactor that loosens the predicate must not silently
    // mutate the wrong row.
    if (office.environment !== "test" || office.salesperson_id !== me.id) {
      console.warn(
        `[office-detail] patch returned wrong row office_id=${id} ae=${me.id} env=${office.environment} owner=${office.salesperson_id}`,
      );
      throw forbidden("You can only edit your own offices.");
    }

    return Response.json(
      { office },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}

// ---------------------------------------------------------------------------
// DELETE — archive (soft delete) an office for the calling AE.
// ---------------------------------------------------------------------------
//
// Archive (set `archived_at = NOW()`), not hard delete. Visit history
// + ae_tasks back-links stay intact; the office just disappears from
// the AE's active read surfaces (List, Map, detail, /api/tasks
// office-name enrichment). See offices_archived_at.sql for the full
// rationale.
//
// Owner-only: the UPDATE predicate pins `salesperson_id = me.id` AND
// `environment = "test"` AND `archived_at IS NULL`. A miss on any of
// those collapses to 404 — the response never reveals which case it
// was (wrong owner, wrong env, missing, or already archived).
//
// Idempotent at the UI level: tapping Remove again on a no-longer-
// listed office would 404 cleanly because the predicate already
// excludes archived rows.
//
// SHAPE
//   200  { archived_at: string }
//   400  invalid uuid
//   401  no session
//   403  not the test account / juice_box_only / no `is_test` flag
//   404  office doesn't exist / wrong owner / wrong env / already archived
//   500  sanitized — raw DB error logged with the `[office-archive]` prefix

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireTestAccount(req);
    const { id } = await params;

    const parsed = UuidSchema.safeParse(id);
    if (!parsed.success) {
      throw badRequest("Invalid office id.");
    }

    const supabase = getServerSupabase();
    const archivedAt = new Date().toISOString();

    const updRes = await supabase
      .from(OFFICES_TABLE)
      .update({ archived_at: archivedAt })
      .eq("id", id)
      .eq("environment", "test")
      .eq("salesperson_id", me.id)
      .is("archived_at", null)
      .select("id, archived_at")
      .maybeSingle();

    if (updRes.error) {
      console.warn(
        `[office-archive] failed office_id=${id} ae=${me.id} code=${updRes.error.code ?? "?"} msg=${updRes.error.message}`,
      );
      throw new ApiError(500, "Could not remove this office.");
    }
    if (!updRes.data) {
      throw notFound("Office not found.");
    }

    return Response.json(
      { archived_at: archivedAt },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
