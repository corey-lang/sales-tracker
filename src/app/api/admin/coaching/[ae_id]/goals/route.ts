import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  handleApiError,
  notFound,
  parseBody,
  requireAdmin,
} from "@/lib/server/auth";
import {
  assertInProgress,
  requireMeeting,
  updateGoalInMeeting,
} from "@/lib/server/one-on-one-meetings";
import {
  fetchAeWeeklyGoals,
  nextMondayOfBusinessWeek,
  requireCoachableAe,
} from "@/lib/server/coaching";
import { mondayOfWeek } from "@/lib/goals";
import {
  WEEKLY_GOAL_MAX_VALUE,
  type CurrentWeeklyGoal,
  type NextWeekGoalOverride,
} from "@/lib/one-on-ones";

// PUT /api/admin/coaching/[ae_id]/goals
//
// Admin-only. Writes a per-AE weekly_goals row at one of two Monday
// effective_from anchors, replacing the AE's active goals from that
// Monday onward:
//
//   { start: "this_week", values: { ... } }
//     -> effective_from = mondayOfWeek(today). The new goal applies
//        retroactively to the current Mon-Fri week (leaderboard and
//        tracker re-resolve immediately) and remains in effect until
//        another later goal change is made.
//
//   { start: "next_week", values: { ... } }
//     -> effective_from = nextMondayOfBusinessWeek(). This week is
//        untouched; the new goal takes effect Monday and remains until
//        another later goal change is made.
//
// PRODUCT MODEL — ONGOING, NOT ONE-WEEK
//   This is NOT a one-week override. Every later week with no row of its
//   own picks up the latest row whose effective_from <= that week. So
//   "Start Next Week" persists every week thereafter until the manager
//   writes another goal change.
//
//   If a scheduled change already exists for a future Monday (e.g. an
//   override saved by an earlier UI iteration), it remains in effect:
//   the resolver picks the latest effective_from <= the week being
//   viewed. The UI surfaces this so the manager isn't surprised.
//
// IDEMPOTENCY
//   The (salesperson_id, effective_from) partial unique index from
//   `supabase/weekly_goals_lockdown.sql` ensures at most one per-AE row
//   per Monday. The route looks up the existing row at the target
//   Monday and UPDATEs in place; otherwise INSERTs. Concurrent saves
//   that race past the lookup surface as a 409.
//
// SECURITY
//   requireAdmin() rejects non-admins outright. requireCoachableAe()
//   gates on the AE's role so an admin can't accidentally write goals
//   onto an assistant / juice_box_only / admin row.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const goalValueField = z
  .number()
  .int("Goals must be whole numbers.")
  .min(0, "Goals must be 0 or greater.")
  .max(
    WEEKLY_GOAL_MAX_VALUE,
    `Goals must be ${WEEKLY_GOAL_MAX_VALUE} or less.`,
  );

const GoalValuesSchema = z.object({
  office_visits: goalValueField,
  service_requests: goalValueField,
  ones_scheduled: goalValueField,
  ones_held: goalValueField,
  presentations: goalValueField,
  impressions: goalValueField,
  team_meetings: goalValueField,
  gold_list_touches: goalValueField,
});

/**
 * Selector telling the route which Monday to anchor the new goal row to.
 *   * "this_week" — current Mon's date (retroactive to start of week).
 *   * "next_week" — next Mon's date (takes effect Monday).
 */
const RequestSchema = z.object({
  start: z.enum(["this_week", "next_week"]),
  values: GoalValuesSchema,
  /**
   * OPTIONAL: the in-progress 1:1 this change is made from. When present the
   * live goal write and the meeting's goal-change history are ONE database
   * transaction taken under the meeting lock (update_weekly_goal_in_one_on_one):
   * both commit, or — if the meeting is completing / completed / not this AE's
   * — NEITHER does and the request fails with a 409/404. It never answers 200
   * for a change that didn't become part of the 1:1.
   */
  meeting_id: z.string().uuid().optional(),
});

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ ae_id: string }> },
) {
  try {
    const me = await requireAdmin(req);
    const { ae_id } = await params;
    const body = await parseBody(req, RequestSchema);

    const supabase = getServerSupabase();
    await requireCoachableAe(supabase, ae_id, me);

    // Validate the 1:1 BEFORE writing anything: it must be this AE's, visible
    // to the caller (a private test AE's meeting is a 404 to others), and
    // still in progress.
    if (body.meeting_id) {
      const meeting = await requireMeeting(supabase, body.meeting_id, me);
      if (meeting.ae_id !== ae_id) throw notFound("1:1 not found.");
      assertInProgress(meeting);
    }

    // Both helpers anchor on the Denver business calendar so a write at
    // 11pm Denver doesn't drift to the wrong Monday in UTC.
    const effectiveFrom =
      body.start === "this_week"
        ? mondayOfWeek()
        : nextMondayOfBusinessWeek();

    if (body.meeting_id) {
      // Atomic with the meeting's history and serialized with completion.
      // Throws (409/404) on any refusal; the transaction has rolled back, so
      // the live goal is untouched.
      await updateGoalInMeeting(supabase, {
        meetingId: body.meeting_id,
        aeId: ae_id,
        start: body.start,
        effectiveFrom,
        values: body.values,
        createdBy: me.id,
      });
    } else {
      await writeGoalOutsideMeeting(supabase, ae_id, effectiveFrom, me.id, body.values);
    }

    // Round-trip the resolved state so the client can re-sync without
    // a follow-up GET. The shape is unchanged from the prior route so
    // existing callers/types keep compiling.
    const after = await fetchAeWeeklyGoals(supabase, ae_id);
    return Response.json({
      // Reaching here with a meeting_id means the RPC committed the goal AND
      // its history together; without one there is nothing to record.
      recorded_in_meeting: Boolean(body.meeting_id),
      weekly_goal_current: after.current as CurrentWeeklyGoal,
      weekly_goal_next_override:
        after.nextOverride as NextWeekGoalOverride | null,
      next_week_start: after.nextMonday,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

/**
 * The plain (no-1:1) goal write — behavior unchanged from before the 1:1
 * workspace: look up this Monday's row and UPDATE in place, else INSERT.
 */
async function writeGoalOutsideMeeting(
  supabase: ReturnType<typeof getServerSupabase>,
  aeId: string,
  effectiveFrom: string,
  createdBy: string,
  values: z.infer<typeof GoalValuesSchema>,
): Promise<void> {
  // Look up the existing row (if any) at the chosen Monday so we
  // UPDATE in place rather than relying on the unique index to
  // bounce a duplicate INSERT — keeps the success path quiet.
  const existing = await supabase
    .from("weekly_goals")
    .select("id")
    .eq("salesperson_id", aeId)
    .eq("effective_from", effectiveFrom)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing.error) {
    throw new ApiError(
      500,
      `Could not load existing goal: ${existing.error.message}`,
    );
  }

  const payload = {
    salesperson_id: aeId,
    effective_from: effectiveFrom,
    created_by: createdBy,
    ...values,
  };

  if (existing.data) {
    const updRes = await supabase
      .from("weekly_goals")
      .update(payload)
      .eq("id", (existing.data as { id: string }).id);
    if (updRes.error) {
      throw new ApiError(
        500,
        `Could not update goals: ${updRes.error.message}`,
      );
    }
    return;
  }
  const insRes = await supabase.from("weekly_goals").insert(payload);
  if (insRes.error) {
    // 23505 = unique_violation. With the partial UNIQUE index on
    // (salesperson_id, effective_from), a concurrent admin save
    // can race ours; surface that as a clean 409 instead of a 500.
    // The client can refetch and re-decide.
    if (insRes.error.code === "23505") {
      throw new ApiError(
        409,
        "Another save just landed for this week. Reload and try again.",
      );
    }
    throw new ApiError(500, `Could not save goals: ${insRes.error.message}`);
  }
}
