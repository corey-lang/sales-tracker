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
  OFFICE_VISITS_TABLE,
  type OfficeVisitRow,
} from "@/lib/offices";

// PATCH /api/offices/[id]/visits/[vid]
//
// Phase 1A — test-only visit edit.
//
// Lets the calling test AE correct the `visited_at` timestamp and / or
// the `note` on a visit they previously logged. The common case is
// "I logged this visit when I got home that night; let me back-date
// it to when I actually walked in" or "I forgot to write what
// happened — add a note."
//
// AUDIENCE / IDENTITY
//   `requireTestAccount` — same gate as POST. Ownership is enforced
//   by the UPDATE predicate: the row must match `id = :vid`,
//   `office_id = :officeId`, `salesperson_id = me.id`,
//   `environment = 'test'`. A miss on any of these collapses to a
//   404 so the response never leaks whether a production visit, a
//   teammate's visit, or a no-longer-existent visit lives at that id.
//
// FIELDS
//   * `visited_at` — optional ISO 8601 timestamp. Range-checked the
//     same way the POST route does (no future, no absurd past). When
//     omitted the column is untouched.
//   * `visit_note` — optional. Empty/whitespace-only clears the
//     column (stored as NULL). When omitted the column is untouched.
//
// At least one of the two must be present — sending an empty body is
// a 400 (no-op UPDATEs would still re-render the row).
//
// SHAPE
//   200  { visit: OfficeVisitRow }
//   400  invalid uuid / body / out-of-range visited_at
//   401  no session
//   403  not the test account / juice_box_only / no `is_test` flag
//   404  visit doesn't exist, wrong office, wrong env, wrong owner
//
// ERRORS
//   Raw DB errors logged with `[office-visit]` prefix; caller gets a
//   sanitized admin-safe reason. Mirrors POST + the detail PATCH.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UuidSchema = z.uuid();

const VISIT_NOTE_MAX = 4000;
const VISITED_AT_FUTURE_SKEW_MS = 60 * 60 * 1000; // 1 hour
const VISITED_AT_PAST_FLOOR_MS =
  Date.now() - 10 * 365 * 24 * 60 * 60 * 1000;

const visitedAtSchema = z
  .string()
  .refine(
    (v) => !Number.isNaN(Date.parse(v)),
    "visited_at must be a valid ISO 8601 timestamp.",
  );

const PatchVisitSchema = z
  .object({
    visit_note: z.string().max(VISIT_NOTE_MAX).nullable().optional(),
    visited_at: visitedAtSchema.optional(),
  })
  .refine(
    (body) =>
      body.visit_note !== undefined || body.visited_at !== undefined,
    {
      message: "Provide visit_note and/or visited_at.",
      path: ["visit_note"],
    },
  );

const VISIT_COLUMNS =
  "id, office_id, salesperson_id, note, visited_at, environment, created_at";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; vid: string }> },
) {
  try {
    const me = await requireTestAccount(req);
    const { id: officeId, vid } = await params;

    if (!UuidSchema.safeParse(officeId).success) {
      throw badRequest("Invalid office id.");
    }
    if (!UuidSchema.safeParse(vid).success) {
      throw badRequest("Invalid visit id.");
    }

    const body = await parseBody(req, PatchVisitSchema);

    // Build the update payload from the supplied fields only. Mirrors
    // the office PATCH route's "undefined skips, null clears" model.
    const update: { note?: string | null; visited_at?: string } = {};

    if (body.visit_note !== undefined) {
      if (body.visit_note === null) {
        update.note = null;
      } else {
        const trimmed = body.visit_note.trim();
        update.note = trimmed.length > 0 ? trimmed : null;
      }
    }

    if (body.visited_at !== undefined) {
      const ts = Date.parse(body.visited_at);
      if (ts > Date.now() + VISITED_AT_FUTURE_SKEW_MS) {
        throw badRequest(
          "visited_at can't be in the future. Use Next Action for follow-ups.",
        );
      }
      if (ts < VISITED_AT_PAST_FLOOR_MS) {
        throw badRequest("visited_at is too far in the past.");
      }
      update.visited_at = new Date(ts).toISOString();
    }

    // Defense in depth — the Zod refine should have caught an empty
    // body, but if both ended up `undefined` for any reason, bail
    // rather than issue a no-op UPDATE.
    if (update.note === undefined && update.visited_at === undefined) {
      throw badRequest("Provide visit_note and/or visited_at.");
    }

    const supabase = getServerSupabase();

    // Ownership AND scope are enforced by the predicate. A row count of
    // zero means: visit doesn't exist, belongs to a different office,
    // belongs to a different AE, or is in a different environment.
    // All four collapse to a 404 so the response never confirms which.
    const updRes = await supabase
      .from(OFFICE_VISITS_TABLE)
      .update(update)
      .eq("id", vid)
      .eq("office_id", officeId)
      .eq("environment", "test")
      .eq("salesperson_id", me.id)
      .select(VISIT_COLUMNS)
      .maybeSingle();

    if (updRes.error) {
      console.warn(
        `[office-visit] patch failed visit_id=${vid} office_id=${officeId} ae=${me.id} code=${updRes.error.code ?? "?"} msg=${updRes.error.message}`,
      );
      throw new ApiError(500, "Could not update this visit.");
    }
    if (!updRes.data) {
      throw notFound("Visit not found.");
    }

    const visit = updRes.data as unknown as OfficeVisitRow;

    return Response.json(
      { visit },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
