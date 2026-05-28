import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  badRequest,
  handleApiError,
  notFound,
  parseBody,
  requireAeToolAccess,
} from "@/lib/server/auth";
import {
  officeEnvironmentFor,
  OFFICES_TABLE,
  OFFICE_VISITS_TABLE,
  type OfficeVisitRow,
} from "@/lib/offices";

// POST /api/offices/[id]/visits
//
// AE visit logging.
//
// Inserts one office_visits row for the calling AE against the
// office in the URL. `visited_at` defaults to NOW() (the schema's
// default) — the in-the-moment "I just visited here" path doesn't
// need to send it. Callers MAY send a `visited_at` ISO timestamp to
// log a visit at a different time (e.g. the AE logs it later that
// night and adjusts the time before saving). Future-dated values are
// rejected — a visit you haven't taken yet is a follow-up, not a
// visit.
//
// AUDIENCE / IDENTITY
//   `requireAeToolAccess` — same gate as the GET/PATCH detail route.
//   `salesperson_id` is the caller's id; never trust a client-supplied
//   value. Ownership is enforced by a pre-check against `offices`:
//   the office must exist, be in `environment = officeEnvironmentFor(me)`,
//   AND belong to the caller. The DB trigger
//   (`trg_office_visits_env_from_office`) overrides `environment` from
//   the parent office, so a caller can't smuggle in a different-env
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
//   403  juice_box_only caller (AE office tools not available)
//   404  office doesn't exist, wrong env, or belongs to a different AE
//
// ERRORS
//   Raw DB errors are logged with `[office-visit]` prefix; the caller
//   receives sanitized admin-safe text. Mirrors the detail route.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UuidSchema = z.uuid();

const VISIT_NOTE_MAX = 4000;

/**
 * Generous future-tolerance window for client/server clock skew (and
 * for the user adjusting a "now" datetime by a minute or two while
 * filling out the form). A `visited_at` more than this far ahead is
 * almost certainly a typo or a misuse of the field for a follow-up.
 */
const VISITED_AT_FUTURE_SKEW_MS = 60 * 60 * 1000; // 1 hour

/** Sanity floor — visits before this date are almost certainly typos
 *  (mis-keying 2026 as 1026, etc.). 10 years ago is comfortably
 *  earlier than any real backfill scenario for this team. */
const VISITED_AT_PAST_FLOOR_MS = Date.now() - 10 * 365 * 24 * 60 * 60 * 1000;

const visitedAtSchema = z
  .string()
  .refine(
    (v) => !Number.isNaN(Date.parse(v)),
    "visited_at must be a valid ISO 8601 timestamp.",
  );

const VisitSchema = z.object({
  /** Optional free-text — empty/whitespace-only is normalized to null. */
  visit_note: z.string().max(VISIT_NOTE_MAX).nullable().optional(),
  /** Optional ISO timestamp. Omitted → defaults to NOW() at insert.
   *  Captured client-side from a datetime-local input (interpreted in
   *  the user's local TZ then serialized to UTC). */
  visited_at: visitedAtSchema.optional(),
});

const VISIT_COLUMNS =
  "id, office_id, salesperson_id, note, visited_at, environment, created_at";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireAeToolAccess(req);
    const environment = officeEnvironmentFor(me);
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

    // Range-check `visited_at` if supplied. The Zod schema already
    // guarantees parse-ability; here we reject obviously-wrong values
    // (far past or future) so a typo doesn't silently corrupt the
    // visit history.
    let visitedAt: string | undefined;
    if (typeof body.visited_at === "string") {
      const ts = Date.parse(body.visited_at);
      if (ts > Date.now() + VISITED_AT_FUTURE_SKEW_MS) {
        throw badRequest(
          "visited_at can't be in the future. Use Next Action for follow-ups.",
        );
      }
      if (ts < VISITED_AT_PAST_FLOOR_MS) {
        throw badRequest("visited_at is too far in the past.");
      }
      // Normalize to ISO so the row stores a consistent format.
      visitedAt = new Date(ts).toISOString();
    }

    const supabase = getServerSupabase();

    // Ownership pre-check. Filtering by id + env + owner + active
    // means wrong-env, wrong-owner, missing, and archived all
    // collapse to the same 404 — the response never leaks which
    // case it was. Archived offices can't accept new visits (the
    // detail page hides them too, so this is mostly defense-in-
    // depth against a stale client trying to log against an office
    // they just archived).
    const officeRes = await supabase
      .from(OFFICES_TABLE)
      .select("id")
      .eq("id", officeId)
      .eq("environment", environment)
      .eq("salesperson_id", me.id)
      .is("archived_at", null)
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
    // passing the caller's slice here is informational — even a
    // malicious mismatched value would be overwritten before the
    // row hits storage. Including it keeps the intent obvious at
    // the call site.
    //
    // `visited_at` is conditionally included so omitting it falls
    // through to the column DEFAULT NOW() — the in-the-moment path.
    const insertPayload: {
      office_id: string;
      salesperson_id: string;
      note: string | null;
      environment: typeof environment;
      visited_at?: string;
    } = {
      office_id: officeId,
      salesperson_id: me.id,
      note,
      environment,
    };
    if (visitedAt !== undefined) insertPayload.visited_at = visitedAt;

    const insertRes = await supabase
      .from(OFFICE_VISITS_TABLE)
      .insert(insertPayload)
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
