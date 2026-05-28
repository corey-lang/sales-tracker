import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  badRequest,
  forbidden,
  handleApiError,
  notFound,
  parseBody,
  requireAeToolAccess,
} from "@/lib/server/auth";
import {
  buildOfficeDedupeKey,
  officeEnvironmentFor,
  OFFICES_TABLE,
  OFFICE_VISITS_TABLE,
  OFFICE_VISITS_DETAIL_LIMIT,
  type OfficeDetail,
  type OfficeRow,
  type OfficeVisitRow,
} from "@/lib/offices";

// /api/offices/[id]
//
// AE office-detail surface.
//
// GET    → aggregate OfficeDetail (office row + visit history + counts).
// PATCH  → updates office identity (name/street/city/state/zip/lat/lng/
//          phone/email) and / or persistent memory (office_notes /
//          next_action / next_action_due_date).
// DELETE → archives (soft-delete) the office; visit history + ae_tasks
//          back-links are preserved.
//
// AUDIENCE
//   `requireAeToolAccess` — every signed-in salesperson except
//   juice_box_only reaches their own office detail. Server-trusted
//   identity comes from the signed session token; we never accept a
//   salesperson_id from the caller.
//
// ENVIRONMENT
//   Every read and write pins `environment = officeEnvironmentFor(me)`
//   — `"test"` for the test account, `"production"` for real AEs.
//   Wrong-env reads collapse to a 404 ("Office not found.") so the
//   response never confirms whether a parallel-env office with this
//   id exists; this also keeps test data invisible to production
//   AEs and vice-versa.
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
    const me = await requireAeToolAccess(req);
    const environment = officeEnvironmentFor(me);
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
        .eq("environment", environment)
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
        .eq("environment", environment)
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

// PATCH accepts three classes of fields, all independently optional
// — sending an empty body is a 400 so a no-op write doesn't fire
// the updated_at trigger.
//
//   1. "Office memory" (existing): office_notes, next_action,
//      next_action_due_date. AE-authored persistent state.
//   2. "Office identity" (added for Edit Office): name, street,
//      city, state, zip, latitude, longitude. The shape an AE
//      reaches for when they want to fix a Badger import typo or
//      record that an office has relocated.
//   3. "Contact" (added for Edit Office): office_phone,
//      office_email. Factual contact info.
//
// Strings are trimmed; empty/whitespace-only payloads on nullable
// fields clear the column (stored as NULL). Caps mirror the
// import route's persistent-text caps.
//
// DEDUPE KEY RECOMPUTATION
//   When name OR street OR zip is in the body, the route fetches
//   the existing row first, merges supplied + existing values, and
//   recomputes `dedupe_key` so the unique index stays consistent
//   with the new identity. A collision (another active office of
//   the same AE already has this name + address) surfaces as a
//   friendly 409 — same UX as POST /api/offices.
const OFFICE_NOTES_MAX = 4000;
const NEXT_ACTION_MAX = 500;
const NAME_MAX = 200;
const STREET_MAX = 500;
const CITY_MAX = 100;
const STATE_MAX = 64;
const ZIP_MAX = 20;
const OFFICE_PHONE_MAX = 64;
const OFFICE_EMAIL_MAX = 254;

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
    // Office memory (existing).
    office_notes: z.string().max(OFFICE_NOTES_MAX).nullable().optional(),
    next_action: z.string().max(NEXT_ACTION_MAX).nullable().optional(),
    next_action_due_date: dueDateSchema.nullable().optional(),
    // Office identity. Name + street are NOT NULL on the table, so
    // when they're in the body they must be present-and-non-empty
    // after trim; an explicit `null` would be a 400.
    name: z.string().trim().min(1).max(NAME_MAX).optional(),
    street: z.string().trim().min(1).max(STREET_MAX).optional(),
    city: z.string().trim().max(CITY_MAX).nullable().optional(),
    state: z.string().trim().max(STATE_MAX).nullable().optional(),
    zip: z.string().trim().max(ZIP_MAX).nullable().optional(),
    latitude: z.number().gte(-90).lte(90).nullable().optional(),
    longitude: z.number().gte(-180).lte(180).nullable().optional(),
    // Contact.
    office_phone: z.string().trim().max(OFFICE_PHONE_MAX).nullable().optional(),
    office_email: z.string().trim().max(OFFICE_EMAIL_MAX).nullable().optional(),
  })
  .refine(
    (body) =>
      // At least one settable field must be present. The refine fires
      // when the caller sends `{}` or only sends fields that are
      // somehow all `undefined` — defensive in case Zod's optional
      // handling drifts.
      body.office_notes !== undefined ||
      body.next_action !== undefined ||
      body.next_action_due_date !== undefined ||
      body.name !== undefined ||
      body.street !== undefined ||
      body.city !== undefined ||
      body.state !== undefined ||
      body.zip !== undefined ||
      body.latitude !== undefined ||
      body.longitude !== undefined ||
      body.office_phone !== undefined ||
      body.office_email !== undefined,
    {
      message: "Provide at least one field to update.",
      path: ["office_notes"],
    },
  );

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireAeToolAccess(req);
    const environment = officeEnvironmentFor(me);
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
      name?: string;
      street?: string;
      city?: string | null;
      state?: string | null;
      zip?: string | null;
      latitude?: number | null;
      longitude?: number | null;
      office_phone?: string | null;
      office_email?: string | null;
      dedupe_key?: string;
    } = {};

    // --- Office memory (existing) ---
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
    if (body.next_action_due_date !== undefined) {
      update.next_action_due_date = body.next_action_due_date;
    }

    // --- Office identity (Edit Office flow) ---
    // Name + street are NOT NULL on the table; Zod already enforced
    // min(1) after trim, so a present value is guaranteed safe to
    // write. Pass straight through.
    if (body.name !== undefined) update.name = body.name;
    if (body.street !== undefined) update.street = body.street;
    // city / state / zip use the existing PATCH text helper — trims,
    // converts empty to null, enforces max length.
    const city = normalizePatchField(body.city, CITY_MAX, "city");
    const state = normalizePatchField(body.state, STATE_MAX, "state");
    const zip = normalizePatchField(body.zip, ZIP_MAX, "zip");
    if (city !== undefined) update.city = city;
    if (state !== undefined) update.state = state;
    if (zip !== undefined) update.zip = zip;
    if (body.latitude !== undefined) update.latitude = body.latitude;
    if (body.longitude !== undefined) update.longitude = body.longitude;

    // --- Contact ---
    const phone = normalizePatchField(
      body.office_phone,
      OFFICE_PHONE_MAX,
      "office_phone",
    );
    const email = normalizePatchField(
      body.office_email,
      OFFICE_EMAIL_MAX,
      "office_email",
    );
    if (phone !== undefined) update.office_phone = phone;
    if (email !== undefined) update.office_email = email;

    // Defense in depth: bail rather than firing a no-op UPDATE that
    // would still bump updated_at.
    if (Object.keys(update).length === 0) {
      throw badRequest("Provide at least one field to update.");
    }

    const supabase = getServerSupabase();

    // Dedupe-key recomputation. The partial UNIQUE index on
    // (salesperson_id, environment, dedupe_key) keys off
    // normalize(name) + normalize(street) + normalize(zip) (see
    // buildOfficeDedupeKey + offices.sql). When any of those three
    // is touched by this PATCH we have to fetch the existing values,
    // merge with the supplied changes, recompute the key, and write
    // it alongside the rest of the update. Otherwise the index
    // would point at the OLD identity and a future re-import (or
    // another edit) couldn't find/dedupe it.
    const dedupeAffectingChange =
      update.name !== undefined ||
      update.street !== undefined ||
      update.zip !== undefined;

    if (dedupeAffectingChange) {
      const existingRes = await supabase
        .from(OFFICES_TABLE)
        .select("name, street, zip")
        .eq("id", id)
        .eq("environment", environment)
        .eq("salesperson_id", me.id)
        .is("archived_at", null)
        .maybeSingle();
      if (existingRes.error) {
        console.warn(
          `[office-detail] dedupe lookup failed office_id=${id} ae=${me.id} code=${existingRes.error.code ?? "?"} msg=${existingRes.error.message}`,
        );
        throw new ApiError(500, "Could not update this office.");
      }
      if (!existingRes.data) {
        throw notFound("Office not found.");
      }
      const merged = {
        name: update.name ?? existingRes.data.name,
        street: update.street ?? existingRes.data.street,
        zip:
          update.zip !== undefined ? update.zip : existingRes.data.zip,
      };
      update.dedupe_key = buildOfficeDedupeKey({
        name: merged.name,
        street: merged.street,
        zip: merged.zip,
      });
    }

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
      .eq("environment", environment)
      .eq("salesperson_id", me.id)
      // PATCH only succeeds against active rows. An archived office
      // appears as 404 to the caller, same as a wrong-owner or wrong-
      // env miss — uniform "Office not found." response.
      .is("archived_at", null)
      .select(OFFICE_COLUMNS)
      .maybeSingle();

    if (updRes.error) {
      // 23505 = duplicate against `uq_offices_dedupe_per_env`. Edit
      // Office can hit this when the AE edits this office's name +
      // address to match another active office they already own.
      // Translate to a friendly 409 (same UX as POST /api/offices'
      // dedupe collision).
      if (updRes.error.code === "23505") {
        return Response.json(
          {
            error:
              "Another office in your list already has this name and address.",
          },
          { status: 409 },
        );
      }
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
    if (office.environment !== environment || office.salesperson_id !== me.id) {
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
// `environment = officeEnvironmentFor(me)` AND `archived_at IS NULL`. A miss on any of
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
//   403  juice_box_only caller (AE office tools not available)
//   404  office doesn't exist / wrong owner / wrong env / already archived
//   500  sanitized — raw DB error logged with the `[office-archive]` prefix

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireAeToolAccess(req);
    const environment = officeEnvironmentFor(me);
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
      .eq("environment", environment)
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
