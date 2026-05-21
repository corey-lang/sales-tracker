import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  handleApiError,
  parseBody,
  requireAdmin,
} from "@/lib/server/auth";
import {
  fetchAeWeeklyGoals,
  nextMondayOfBusinessWeek,
  requireCoachableAe,
} from "@/lib/server/coaching";
import {
  WEEKLY_GOAL_MAX_VALUE,
  type CurrentWeeklyGoal,
  type NextWeekGoalOverride,
} from "@/lib/one-on-ones";

// PUT /api/admin/coaching/[ae_id]/next-week-goals
//
// Admin-only. Sets or clears the per-AE override row for NEXT business
// week. Two modes:
//
//   { keep_same: true }
//     -> No custom goal next week. Any existing per-AE override row at
//        effective_from = next_monday is deleted, so the AE inherits
//        whatever goal is active that day. The UI presents this as the
//        "Keep same goals as this week" checkbox.
//
//   { keep_same: false, values: { office_visits, ... } }
//     -> Custom next-week goal. Each value is a non-negative integer up
//        to WEEKLY_GOAL_MAX_VALUE. If an override already exists at
//        (salesperson_id = ae_id, effective_from = next_monday) we
//        UPDATE that row in place; otherwise we INSERT one. This
//        prevents duplicate rows accumulating per save.
//
// SECURITY
//   requireAdmin() rejects non-admins outright. requireCoachableAe()
//   gates on the AE's role so an admin can't accidentally set goal
//   overrides on an assistant / juice_box_only / admin row.

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

const RequestSchema = z.discriminatedUnion("keep_same", [
  z.object({ keep_same: z.literal(true) }),
  z.object({ keep_same: z.literal(false), values: GoalValuesSchema }),
]);

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ ae_id: string }> },
) {
  try {
    const me = await requireAdmin(req);
    const { ae_id } = await params;
    const body = await parseBody(req, RequestSchema);

    const supabase = getServerSupabase();
    await requireCoachableAe(supabase, ae_id);

    const nextMonday = nextMondayOfBusinessWeek();

    if (body.keep_same) {
      // Drop any per-AE override at next Monday so the AE inherits the
      // active goal that day. Safe to run when no row exists — DELETE
      // with no match is a no-op and returns 0 rows.
      const delRes = await supabase
        .from("weekly_goals")
        .delete()
        .eq("salesperson_id", ae_id)
        .eq("effective_from", nextMonday);
      if (delRes.error) {
        throw new ApiError(
          500,
          `Could not clear next-week goal: ${delRes.error.message}`,
        );
      }
    } else {
      // Find the existing override (if any) so we UPDATE in place
      // instead of stacking duplicate rows on every save.
      const existing = await supabase
        .from("weekly_goals")
        .select("id")
        .eq("salesperson_id", ae_id)
        .eq("effective_from", nextMonday)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existing.error) {
        throw new ApiError(
          500,
          `Could not load next-week goal: ${existing.error.message}`,
        );
      }

      const payload = {
        salesperson_id: ae_id,
        effective_from: nextMonday,
        created_by: me.id,
        ...body.values,
      };

      if (existing.data) {
        const updRes = await supabase
          .from("weekly_goals")
          .update(payload)
          .eq("id", (existing.data as { id: string }).id);
        if (updRes.error) {
          throw new ApiError(
            500,
            `Could not update next-week goal: ${updRes.error.message}`,
          );
        }
      } else {
        const insRes = await supabase.from("weekly_goals").insert(payload);
        if (insRes.error) {
          // 23505 = unique_violation. With the partial UNIQUE index added
          // by supabase/weekly_goals_lockdown.sql, a concurrent admin
          // save can race ours; surface that as a clean 409 instead of
          // a 500. The client can refetch and re-decide.
          if (insRes.error.code === "23505") {
            throw new ApiError(
              409,
              "Another save just landed for this week. Reload and try again.",
            );
          }
          throw new ApiError(
            500,
            `Could not save next-week goal: ${insRes.error.message}`,
          );
        }
      }
    }

    // Round-trip the resolved state so the client can sync without a
    // follow-up GET.
    const after = await fetchAeWeeklyGoals(supabase, ae_id);
    return Response.json({
      weekly_goal_current: after.current as CurrentWeeklyGoal,
      weekly_goal_next_override: after.nextOverride as NextWeekGoalOverride | null,
      next_week_start: after.nextMonday,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
