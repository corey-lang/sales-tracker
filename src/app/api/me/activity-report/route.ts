import { isWeekend, parseISO } from "date-fns";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  badRequest,
  handleApiError,
  requireAeToolAccess,
} from "@/lib/server/auth";
import {
  ACTIVITIES,
  ZERO_ACTIVITY,
  type ActivityValues,
} from "@/lib/activities";
import { averagePercent } from "@/lib/goals";
import { calculateRangeTargets } from "@/lib/server/range-targets";

// GET /api/me/activity-report?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// The SIGNED-IN AE's own activity report for a date range, scored with the
// shared Range Goal Engine (same math as the admin Activity Totals).
//
// IDENTITY: the AE is taken ONLY from the signed session (requireAeToolAccess).
// Any client-supplied salesperson_id is ignored — there is no such param and
// the activity query is hard-scoped to `me.id`, so one AE can never read
// another's data by tampering. working_day_adjustments stays server-only.
//
// FAILS CLOSED: calculateRangeTargets throws a user-safe error if goals or
// adjustments can't be read, so we never return a report scored against
// unadjusted targets. Raw provider text is logged server-side only.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIVITY_KEYS = ACTIVITIES.map((a) => a.key);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  try {
    // Identity comes from the session — never from a request param.
    const me = await requireAeToolAccess(req);

    const url = new URL(req.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!from || !DATE_RE.test(from) || !to || !DATE_RE.test(to)) {
      throw badRequest("from and to are required (YYYY-MM-DD).");
    }
    if (from > to) {
      throw badRequest("from must not be after to.");
    }

    const supabase = getServerSupabase();

    // Hard-scoped to the caller. range = the Range Goal Engine result (sum of
    // each week's prorated, time-off-adjusted weekly goal). It throws a safe
    // error on read failure → fail closed.
    const [entriesRes, range] = await Promise.all([
      supabase
        .from("activity_entries")
        .select(["entry_date", ...ACTIVITY_KEYS].join(","))
        .eq("salesperson_id", me.id)
        .gte("entry_date", from)
        .lte("entry_date", to),
      calculateRangeTargets(supabase, me.id, from, to),
    ]);

    if (entriesRes.error) {
      console.error(
        `[my-activity] entries read failed sub=${me.id} code=${entriesRes.error.code ?? "?"} msg=${entriesRes.error.message}`,
      );
      throw new ApiError(500, "Could not load your activity report.");
    }

    // Sum WEEKDAY activity over the range (targets are business-day based).
    const actuals: ActivityValues = { ...ZERO_ACTIVITY };
    for (const e of (entriesRes.data ?? []) as unknown as Array<
      Partial<ActivityValues> & { entry_date: string }
    >) {
      if (isWeekend(parseISO(e.entry_date))) continue;
      for (const k of ACTIVITY_KEYS) actuals[k] += Number(e[k] ?? 0);
    }

    const activities = ACTIVITIES.map((a) => {
      const actual = actuals[a.key];
      const target = range.adjustedTargets[a.key];
      return {
        key: a.key,
        actual,
        target,
        // Raw per-activity completion; null when no target.
        percent: target > 0 ? Math.round((actual / target) * 100) : null,
      };
    });

    const totalActual = ACTIVITY_KEYS.reduce((s, k) => s + actuals[k], 0);

    return Response.json(
      {
        from,
        to,
        isHolidayWeek: range.isHolidayWeek,
        anyAdjusted: range.availableDays < range.businessDaysInRange,
        availableDays: range.availableDays,
        businessDays: range.businessDaysInRange,
        totalActual,
        overallPercent: averagePercent(
          actuals,
          range.adjustedTargets,
          ACTIVITY_KEYS,
        ),
        activities,
        weekBreakdown: range.weekBreakdown.map((w) => ({
          weekStart: w.weekStart,
          rangeStart: w.rangeStart,
          rangeEnd: w.rangeEnd,
          businessDaysInRange: w.businessDaysInRange,
          availableDays: w.availableDays,
          isHolidayWeek: w.isHolidayWeek,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
