import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  handleApiError,
  parseBody,
  requireAeToolAccess,
} from "@/lib/server/auth";
import { ACTIVITIES } from "@/lib/activities";
import { activityWeekToDateRange } from "@/lib/goals";
import {
  fetchActivityWeekTotals,
  fetchResolvedGoal,
  parseActivityWeekStart,
} from "@/lib/server/activity-week";

// The SIGNED-IN AE's own Sun-Sat activity week.
//
//   GET /api/me/activity/week[?week_start=YYYY-MM-DD]  (default: this week)
//     → { week_start, week_end, business_monday, totals, entry_count, goal }
//   PUT /api/me/activity/week   body { week_start, values }
//     → replaces that week's totals; returns the re-read week
//
// WHY THIS ROUTE EXISTS
//   DailyEntryForm / MyWeekCard / EditWeekCard used to read `activity_entries`
//   (and call the `replace_activity_week` RPC) directly from the browser with
//   the anon key, scoped by a `salespersonId` prop sourced from localStorage.
//   Since `activity_entries` has no RLS, that meant the AE boundary was purely
//   client-side: a `juice_box_only` guest could edit their stored role, load
//   the dashboard, and read or overwrite ANY AE's week by swapping one id.
//
// IDENTITY / AUTHORIZATION
//   * requireAeToolAccess → verifies the signed session token, RE-READS the
//     `salespeople` row (so role changes and `deactivated_at` take effect
//     immediately), and 403s `juice_box_only` callers. A deactivated person
//     (e.g. an offboarded AE holding an old token) 401s inside
//     requireSalesperson.
//   * The salesperson is ALWAYS `me.id`. There is no salesperson parameter on
//     either verb — an extra id in the body is rejected by the strict schema,
//     and even a matching one would be ignored. One AE therefore cannot read
//     or modify another AE's activity, and admins get their OWN week here (the
//     admin cross-AE surfaces live under /api/admin/*).
//   * The week bounds are DERIVED server-side from `week_start`
//     (parseActivityWeekStart: must be a past-or-current Sunday), so a caller
//     can't widen the range it writes to.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Per-activity totals for a whole week. Non-negative integers only, with a
 *  sane upper bound so a typo (or a tampered payload) can't write a nonsense
 *  week. `.strict()` rejects unknown keys — including any attempt to smuggle
 *  a `salesperson_id` into the values object. */
const ValuesSchema = z
  .object(
    Object.fromEntries(
      ACTIVITIES.map((a) => [a.key, z.number().int().min(0).max(100000)]),
    ) as Record<
      (typeof ACTIVITIES)[number]["key"],
      z.ZodNumber
    >,
  )
  .strict();

const PutSchema = z
  .object({
    week_start: z.string(),
    values: ValuesSchema,
  })
  .strict();

export async function GET(req: Request) {
  try {
    const me = await requireAeToolAccess(req);

    // `week_start` is optional: live surfaces (the Log activity counters, the
    // weekly tracker) want "this week" and shouldn't have to send a date the
    // server would only re-validate. Omitted → the current Sun-Sat week from
    // the Denver business calendar.
    const url = new URL(req.url);
    const bounds = parseActivityWeekStart(
      url.searchParams.get("week_start") ?? activityWeekToDateRange().since,
    );

    const supabase = getServerSupabase();
    const [week, goal] = await Promise.all([
      fetchActivityWeekTotals(supabase, me.id, bounds),
      fetchResolvedGoal(supabase, me.id, bounds.businessMonday),
    ]);

    return Response.json(
      {
        week_start: bounds.weekStart,
        week_end: bounds.weekEnd,
        business_monday: bounds.businessMonday,
        totals: week.totals,
        entry_count: week.entryCount,
        goal,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PUT(req: Request) {
  try {
    const me = await requireAeToolAccess(req);
    const body = await parseBody(req, PutSchema);
    const bounds = parseActivityWeekStart(body.week_start);

    const supabase = getServerSupabase();

    // Replacing a week is TWO steps (write the total onto the week's Sunday
    // row, clear Mon-Sat) and they MUST be atomic or the week can end up
    // double-counted. The `replace_activity_week` RPC does both in one
    // transaction — see supabase/replace_activity_week.sql. It is called here
    // with the SESSION's salesperson id; the browser no longer calls it at all.
    const rpc = await supabase.rpc("replace_activity_week", {
      p_salesperson_id: me.id,
      p_week_start: bounds.weekStart,
      p_week_end: bounds.weekEnd,
      p_values: body.values,
    });
    if (rpc.error) {
      console.warn(
        `[my-activity-week] replace failed sub=${me.id} week=${bounds.weekStart} code=${rpc.error.code ?? "?"} msg=${rpc.error.message}`,
      );
      throw new ApiError(500, "Could not save that activity week.");
    }

    // Re-read so the client renders server truth rather than its own input.
    const week = await fetchActivityWeekTotals(supabase, me.id, bounds);

    return Response.json(
      {
        week_start: bounds.weekStart,
        week_end: bounds.weekEnd,
        totals: week.totals,
        entry_count: week.entryCount,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
