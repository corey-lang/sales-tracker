import {
  ZERO_ACTIVITY,
  type ActivityKey,
  type ActivityValues,
} from "@/lib/activities";
import {
  resolveActiveGoal,
  weeklyTargetsFrom,
  type WeeklyGoal,
} from "@/lib/goals";
import {
  businessWeeksInRange,
  rangeWeekAvailability,
  type WorkingDayAdjustment,
} from "@/lib/working-days";

// ===========================================================================
// Range Goal Engine — the shared way every "totals over a date range" surface
// computes its target.
//
// THE RULE (do NOT compare a multi-week total against a single weekly goal):
//   1. Split the range into business weeks.
//   2. For each week, resolve the AE's weekly goal (as of that week).
//   3. Prorate it to the business days of that week that fall in the range,
//      then reduce it for that week's holiday/PTO:
//         weekTarget = round(weeklyGoal × availableDaysInRange / 5)
//      (availableDaysInRange already nets out off-days; a full untouched week
//       in range = 5 → the goal unchanged; a holiday week = 4 → 80%; a 3-day
//       partial week = 3 → 60%.)
//   4. Sum the per-week targets across the range.
//   5. Surfaces score actual ÷ summed adjusted target.
//
// `originalTargets` mirrors this but WITHOUT the off-day reduction (prorated to
// in-range business days only), so a surface can show "Adjusted 76 · Original
// 80" — the gap is exactly the approved time off.
//
// Pure: callers pass pre-fetched goals + adjustments (so a route can fetch once
// and score many AEs). The DB goal rows are never mutated. The per-day off math
// is reused from working-days.ts — no duplicated adjustment logic.
// ===========================================================================

const ACTIVITY_KEYS = Object.keys(ZERO_ACTIVITY) as ActivityKey[];

/** weeklyGoal × days / 5, rounded per activity. No min-1 clamp: across summed
 *  partial weeks a zero-contribution week must contribute zero (the single-week
 *  display clamp in adjustGoalValue would over-count here). */
function scaleTargets(weekly: ActivityValues, days: number): ActivityValues {
  const out = { ...ZERO_ACTIVITY };
  for (const k of ACTIVITY_KEYS) {
    out[k] = Math.round((weekly[k] * days) / 5);
  }
  return out;
}

function addInto(acc: ActivityValues, add: ActivityValues): void {
  for (const k of ACTIVITY_KEYS) acc[k] += add[k];
}

export type RangeWeekBreakdown = {
  weekStart: string;
  /** First/last in-range business day of this week (yyyy-MM-dd). */
  rangeStart: string;
  rangeEnd: string;
  businessDaysInRange: number;
  availableDays: number;
  isHolidayWeek: boolean;
  /** Prorated-to-range weekly goal WITHOUT off-day reduction. */
  originalTargets: ActivityValues;
  /** Prorated-to-range weekly goal WITH holiday/PTO reduction. */
  adjustedTargets: ActivityValues;
};

export type RangeTargets = {
  /** Total available business days across the range (off-days removed). */
  availableDays: number;
  /** Total business days across the range (before off-days). */
  businessDaysInRange: number;
  /** Any GLOBAL holiday fell on an in-range day. */
  isHolidayWeek: boolean;
  /** Summed prorated weekly goals WITHOUT time-off reduction. */
  originalTargets: ActivityValues;
  /** Summed prorated, time-off-adjusted weekly goals — the range goal AEs are
   *  scored against. */
  adjustedTargets: ActivityValues;
  weekBreakdown: RangeWeekBreakdown[];
};

/**
 * The Range Goal Engine for ONE AE over [startDate, endDate]. Callers supply
 * the full weekly_goals list and the adjustment rows overlapping the range.
 */
export function buildRangeTargets(opts: {
  salespersonId: string;
  startDate: string;
  endDate: string;
  goals: WeeklyGoal[];
  adjustments: WorkingDayAdjustment[];
}): RangeTargets {
  const { salespersonId, startDate, endDate, goals, adjustments } = opts;

  const originalTargets = { ...ZERO_ACTIVITY };
  const adjustedTargets = { ...ZERO_ACTIVITY };
  let totalAvailable = 0;
  let totalBusiness = 0;
  let isHolidayWeek = false;
  const weekBreakdown: RangeWeekBreakdown[] = [];

  for (const weekStart of businessWeeksInRange(startDate, endDate)) {
    const wk = rangeWeekAvailability({
      weekStart,
      salespersonId,
      adjustments,
      rangeStart: startDate,
      rangeEnd: endDate,
    });
    // A week with no in-range business days contributes nothing.
    if (wk.businessDaysInRange === 0 || !wk.lastInRangeDay) continue;

    // The weekly goal in effect during that week (resolved as of its last
    // in-range day, mirroring the leaderboard's goal-as-of resolution).
    const weekly = weeklyTargetsFrom(
      resolveActiveGoal(salespersonId, goals, wk.lastInRangeDay),
    );

    const wkOriginal = scaleTargets(weekly, wk.businessDaysInRange);
    const wkAdjusted = scaleTargets(weekly, wk.availableDaysInRange);

    addInto(originalTargets, wkOriginal);
    addInto(adjustedTargets, wkAdjusted);
    totalAvailable += wk.availableDaysInRange;
    totalBusiness += wk.businessDaysInRange;
    if (wk.isHolidayWeek) isHolidayWeek = true;

    weekBreakdown.push({
      weekStart,
      rangeStart: wk.firstInRangeDay ?? weekStart,
      rangeEnd: wk.lastInRangeDay,
      businessDaysInRange: wk.businessDaysInRange,
      availableDays: wk.availableDaysInRange,
      isHolidayWeek: wk.isHolidayWeek,
      originalTargets: wkOriginal,
      adjustedTargets: wkAdjusted,
    });
  }

  return {
    availableDays: totalAvailable,
    businessDaysInRange: totalBusiness,
    isHolidayWeek,
    originalTargets,
    adjustedTargets,
    weekBreakdown,
  };
}
