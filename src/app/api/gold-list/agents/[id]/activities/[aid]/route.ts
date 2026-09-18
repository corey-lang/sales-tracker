import {
  activityNoteSchema,
  descriptionSchema,
  dateSchema,
} from "@/lib/gold-list-validation";
import { requireGoldListAccess } from "@/lib/server/gold-list";
import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import { ApiError, handleApiError, parseBody } from "@/lib/server/auth";
import {
  ACTIVITY_COLUMNS,
  isUniqueViolation,
  requireOwnedActivity,
  requireOwnedAgent,
} from "@/lib/server/gold-list";
import {
  GOLD_LIST_ACTIVITIES_TABLE,
  GOLD_LIST_ACTIVITY_TYPE_KEYS,
  OUTCOME_NOTE_MAX_LENGTH,
  type GoldListActivity,
} from "@/lib/gold-list";

// One activity on one Gold List agent.
//   PATCH /api/gold-list/agents/:id/activities/:aid
//     body: { status?, outcome_note?, description?, scheduled_for? }
//
// WHAT THIS ENDPOINT IS FOR
//   * Complete it        — { status: "completed", outcome_note?: "…" }
//   * Edit/reschedule it — { scheduled_for: "2026-10-02", description?: …,
//                           activity_note?: … }
//   * Cancel it          — { status: "cancelled" }
//   Finished activities cannot be reopened or edited.
//
//   The outcome note is OPTIONAL on completion — most completions are a tap.
//
// COMPLETING DOES NOT SCHEDULE THE NEXT ONE
//   The next activity is a separate POST to
//   /api/gold-list/agents/:id/activities, so the completed row stays in
//   history untouched. After completion the UI offers scheduling or skipping
//   the next activity; a later failure cannot undo the saved completion.
//
// OWNERSHIP
//   Owner-only, pinned on BOTH the parent agent and the activity row
//   (`requireOwnedActivity` filters by id + agent_id + salesperson_id), so a
//   mismatched agent segment in the URL 404s instead of updating a row that
//   belongs to a different agent.
//
// completed_at
//   Set to NOW() on completion and cleared on any other status, matching the
//   DB CHECK that keeps `status` and `completed_at` from disagreeing.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const scheduledForSchema = dateSchema;

const UpdateActivitySchema = z.object({
  status: z.enum(["scheduled", "completed", "cancelled"]).optional(),
  /** Optional outcome captured on completion; null clears a previous note. */
  outcome_note: z.string().trim().max(OUTCOME_NOTE_MAX_LENGTH).nullish(),
  /** The scheduled activity's plan note. Editable only while the activity is
   *  still scheduled — the guard below and the DB's
   *  `protect_gold_list_activity_history` trigger both refuse a finished row,
   *  so a completed activity's note is as immutable as its outcome. */
  activity_note: activityNoteSchema,
  activity_type: z.enum(GOLD_LIST_ACTIVITY_TYPE_KEYS).optional(),
  description: descriptionSchema.optional(),
  scheduled_for: scheduledForSchema.optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; aid: string }> },
) {
  try {
    const me = await requireGoldListAccess(req);
    const { id, aid } = await params;
    const body = await parseBody(req, UpdateActivitySchema);
    const supabase = getServerSupabase();

    // Ownership of the parent first, so a bad agent id reads as "not found"
    // before we look at the activity at all.
    const parent = await requireOwnedAgent(supabase, id, me);
    if (parent.archived_at)
      throw new ApiError(409, "Restore this agent before changing activities.");
    const current = await requireOwnedActivity(supabase, id, aid, me);
    if (current.status !== "scheduled") {
      throw new ApiError(
        409,
        "This activity is already finished. Refresh to see its preserved history.",
      );
    }

    const patch: Record<string, unknown> = {};
    if (body.description !== undefined) patch.description = body.description;
    if (body.activity_note !== undefined) {
      patch.activity_note = body.activity_note || null;
    }
    if (body.activity_type !== undefined) {
      patch.activity_type = body.activity_type;
    }
    if (body.scheduled_for !== undefined) {
      patch.scheduled_for = body.scheduled_for;
    }
    if (body.outcome_note !== undefined) {
      patch.outcome_note = body.outcome_note || null;
    }
    if (body.status !== undefined) {
      patch.status = body.status;
      // Kept consistent with gold_list_activities_completed_at_matches_status.
      patch.completed_at =
        body.status === "completed" ? new Date().toISOString() : null;
    }
    if (Object.keys(patch).length === 0) {
      return Response.json({ error: "No fields to update." }, { status: 400 });
    }

    const res = await supabase
      .from(GOLD_LIST_ACTIVITIES_TABLE)
      .update(patch)
      .eq("id", aid)
      .eq("agent_id", id)
      .eq("salesperson_id", me.id)
      .eq("status", "scheduled")
      .select(ACTIVITY_COLUMNS)
      .maybeSingle();

    if (res.error) {
      if (res.error.code === "23514")
        throw new ApiError(
          409,
          "This agent or activity changed. Refresh before trying again.",
        );
      // A concurrent scheduled-activity write violated the one-open rule.
      if (isUniqueViolation(res.error)) {
        throw new ApiError(
          409,
          "This agent already has an activity scheduled. Complete or reschedule that one first.",
        );
      }
      console.warn(
        `[gold-list] activity update failed activity_id=${aid} caller=${me.id} code=${res.error.code ?? "?"} msg=${res.error.message}`,
      );
      throw new ApiError(500, "Could not update that activity.");
    }
    if (!res.data)
      throw new ApiError(
        409,
        "This activity changed. Refresh to see its preserved history.",
      );

    return Response.json({ activity: res.data as GoldListActivity });
  } catch (err) {
    return handleApiError(err);
  }
}
