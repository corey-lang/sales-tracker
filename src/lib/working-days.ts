import { addDays, format, parseISO, startOfWeek } from "date-fns";

// Working-day adjustments — pure availability + pace math.
//
// The app assumes 5 available working days (Mon-Fri) per AE per week. Admins
// can mark days unavailable (holiday = global, PTO/travel = individual) via the
// working_day_adjustments table. This module turns those rows into:
//   * an AE's available-day COUNT for a week (for the "X Available Days" line)
//   * an expected-to-date PACE percent (for the on-pace indicator)
//
// It is intentionally dependency-light (date-fns only) so BOTH the browser
// (dashboard, reports) and the server (leaderboard, scorecard) compute pace
// from the exact same logic. Weekly GOALS are never touched here.

export const DEFAULT_WORKING_DAYS = 5;
/** An AE always has at least one available day — pace never divides by zero
 *  and "0 available days" would read as a goal of nothing. */
export const MIN_AVAILABLE_DAYS = 1;

/** One row of the working_day_adjustments table. */
export type WorkingDayAdjustment = {
  id: string;
  /** yyyy-MM-dd. */
  adjustment_date: string;
  /** null when applies_to_all = true. */
  salesperson_id: string | null;
  applies_to_all: boolean;
  /** 1.0 = full day off, 0.5 = half day. */
  day_value: number;
  reason: string;
  note: string | null;
  created_by?: string | null;
  created_at?: string;
};

/** The 5 Mon-Fri calendar dates (yyyy-MM-dd) of the business week whose Monday
 *  is `weekStart`. `weekStart` is expected to already be a Monday (the app's
 *  week boundary everywhere). */
export function businessDaysOfWeek(weekStart: string): string[] {
  const monday = parseISO(weekStart);
  const out: string[] = [];
  for (let i = 0; i < DEFAULT_WORKING_DAYS; i += 1) {
    out.push(format(addDays(monday, i), "yyyy-MM-dd"));
  }
  return out;
}

/** Does this adjustment affect the given AE — a global holiday, or their own
 *  individual row? */
function appliesTo(adj: WorkingDayAdjustment, salespersonId: string): boolean {
  return adj.applies_to_all || adj.salesperson_id === salespersonId;
}

/** Total day-off value for ONE day for ONE AE, capped at a full day (1.0).
 *  Capping matters: a global holiday AND an individual PTO on the SAME day
 *  must not subtract 2 — the AE only loses that one day. */
function dayOffValue(
  adjustments: WorkingDayAdjustment[],
  date: string,
  salespersonId: string,
): number {
  let off = 0;
  for (const a of adjustments) {
    if (a.adjustment_date === date && appliesTo(a, salespersonId)) {
      off += Number(a.day_value) || 0;
    }
  }
  return Math.min(1, off);
}

export type WeekAvailability = {
  /** Total available working days for the week, clamped to >= 1. */
  availableDays: number;
  /** Expected-to-date pace %: the share of available days completed strictly
   *  before `today` (0 when `today` not supplied). For a fully-elapsed past
   *  week this is 100. Compare an AE's achievement % against this to judge
   *  "on pace" without touching the weekly goal. */
  expectedPercent: number;
  /** True when a GLOBAL (applies_to_all) adjustment lands in the week — used
   *  for the "Holiday Week" label. Individual PTO alone is not a holiday week. */
  isHolidayWeek: boolean;
  /** Distinct reasons affecting this AE this week (for tooltips/labels). */
  reasons: string[];
};

/** Computes an AE's available days + pace for a week from the adjustment rows
 *  overlapping that week. Pure — caller supplies the rows. */
export function weekAvailability(opts: {
  weekStart: string;
  salespersonId: string;
  adjustments: WorkingDayAdjustment[];
  /** yyyy-MM-dd "today"; days strictly before it count as elapsed for pace. */
  today?: string;
}): WeekAvailability {
  const { weekStart, salespersonId, adjustments, today } = opts;
  const days = businessDaysOfWeek(weekStart);

  let totalRaw = 0;
  let elapsed = 0;
  for (const d of days) {
    const available = 1 - dayOffValue(adjustments, d, salespersonId);
    totalRaw += available;
    if (today && d < today) elapsed += available;
  }

  const availableDays = Math.max(MIN_AVAILABLE_DAYS, totalRaw);
  const expectedPercent =
    availableDays > 0
      ? Math.round((Math.min(elapsed, availableDays) / availableDays) * 100)
      : 0;

  const relevant = adjustments.filter(
    (a) => appliesTo(a, salespersonId) && days.includes(a.adjustment_date),
  );
  const isHolidayWeek = relevant.some((a) => a.applies_to_all);
  const reasons = Array.from(new Set(relevant.map((a) => a.reason)));

  return { availableDays, expectedPercent, isHolidayWeek, reasons };
}

/** Just the available-day count for an AE in a week (the helper shape the
 *  spec calls getAvailableDaysForWeek). See weekAvailability for pace too. */
export function availableDaysForWeek(
  weekStart: string,
  salespersonId: string,
  adjustments: WorkingDayAdjustment[],
): number {
  return weekAvailability({ weekStart, salespersonId, adjustments }).availableDays;
}

/** Formats an available-day count for display: "5", "4", "4.5". */
export function formatAvailableDays(days: number): string {
  return Number.isInteger(days) ? String(days) : days.toFixed(1);
}

/**
 * Adjusts ONE activity goal for a week's available days:
 *
 *   adjusted = round(original × availableDays / 5)
 *
 * Approved time off reduces that week's KPI target proportionally — a holiday
 * Monday (4 of 5 days) scales every goal to 80%; 4.5 days → 90%. The original
 * goal in the DB is never mutated; this is a runtime computation.
 *
 * Rules:
 *   * Whole-number targets (round to nearest).
 *   * A positive original goal never drops below 1, even on a 1-day week.
 *   * A 0 (disabled) goal stays 0.
 *   * availableDays of 5 (a normal week) returns the original unchanged.
 */
export function adjustGoalValue(
  originalGoal: number,
  availableDays: number,
): number {
  if (originalGoal <= 0) return 0;
  const factor = availableDays / DEFAULT_WORKING_DAYS;
  const adjusted = Math.round(originalGoal * factor);
  return Math.max(1, adjusted);
}

export type PaceVerdict = "ahead" | "on_pace" | "behind" | "none";

/** Neutral pace verdict for admin surfaces (leaderboard/scorecard/reports):
 *  compares an AE's achievement % against their expected-to-date %. Mirrors
 *  the AE-facing momentum bands (±15 / −10) so both read consistently.
 *  Returns "none" when there's no goal (percent null). */
export function paceVerdict(
  percent: number | null,
  expectedPercent: number,
): PaceVerdict {
  if (percent === null) return "none";
  if (percent >= 100 || percent >= expectedPercent + 15) return "ahead";
  if (percent >= expectedPercent - 10) return "on_pace";
  return "behind";
}

/** Short human label for a pace verdict. */
export function paceVerdictLabel(verdict: PaceVerdict): string {
  switch (verdict) {
    case "ahead":
      return "Ahead";
    case "on_pace":
      return "On pace";
    case "behind":
      return "Behind";
    default:
      return "—";
  }
}

/** The AE-facing informational line, or null when nothing is reduced (a full
 *  5-day week shows no banner). Examples:
 *    "Holiday Week • 4 Available Days"
 *    "4 Available Days This Week" */
export function availableDaysLabel(avail: WeekAvailability): string | null {
  if (avail.availableDays >= DEFAULT_WORKING_DAYS) return null;
  const count = `${formatAvailableDays(avail.availableDays)} Available Days`;
  return avail.isHolidayWeek ? `Holiday Week • ${count}` : `${count} This Week`;
}

// ---------------------------------------------------------------------------
// Range support — powering the shared Range Goal Engine (src/lib/range-targets).
// A date range is split into business weeks; each week is prorated to the
// business days that actually fall inside the range, then reduced for that
// week's holiday/PTO. These helpers only handle the DAY math; the goal scaling
// lives in range-targets.ts.
// ---------------------------------------------------------------------------

/** The Monday (yyyy-MM-dd) of every business week that overlaps the inclusive
 *  range [startDate, endDate]. The first/last weeks may be partial — callers
 *  intersect each week with the range via rangeWeekAvailability. */
export function businessWeeksInRange(
  startDate: string,
  endDate: string,
): string[] {
  const start = parseISO(startDate);
  const end = parseISO(endDate);
  if (end < start) return [];
  const lastMonday = startOfWeek(end, { weekStartsOn: 1 });
  const out: string[] = [];
  let monday = startOfWeek(start, { weekStartsOn: 1 });
  // Guard against any pathological loop (max ~53 weeks/yr; cap generously).
  for (let i = 0; i < 366 && monday <= lastMonday; i += 1) {
    out.push(format(monday, "yyyy-MM-dd"));
    monday = addDays(monday, 7);
  }
  return out;
}

export type RangeWeekAvailability = {
  /** Mon-Fri days of this week that fall inside the range (0..5). */
  businessDaysInRange: number;
  /** Those in-range days minus holiday/PTO (0..5, may be fractional via
   *  half-days). This is what the week's goal is scaled by. */
  availableDaysInRange: number;
  /** A GLOBAL holiday lands on an in-range day of this week. */
  isHolidayWeek: boolean;
  /** First / last in-range business day (yyyy-MM-dd), or null when the week
   *  contributes no business days to the range. `lastInRangeDay` is the
   *  as-of date for resolving that week's goal. */
  firstInRangeDay: string | null;
  lastInRangeDay: string | null;
};

/** For one week and one AE, intersect the week's Mon-Fri days with the range
 *  and subtract holiday/PTO. Reuses the same per-day off math (`dayOffValue`)
 *  as weekAvailability — no duplicated adjustment logic. */
export function rangeWeekAvailability(opts: {
  weekStart: string;
  salespersonId: string;
  adjustments: WorkingDayAdjustment[];
  rangeStart: string;
  rangeEnd: string;
}): RangeWeekAvailability {
  const { weekStart, salespersonId, adjustments, rangeStart, rangeEnd } = opts;
  let businessDaysInRange = 0;
  let availableDaysInRange = 0;
  let isHolidayWeek = false;
  let firstInRangeDay: string | null = null;
  let lastInRangeDay: string | null = null;

  for (const d of businessDaysOfWeek(weekStart)) {
    if (d < rangeStart || d > rangeEnd) continue;
    businessDaysInRange += 1;
    if (firstInRangeDay === null) firstInRangeDay = d;
    lastInRangeDay = d;
    availableDaysInRange += 1 - dayOffValue(adjustments, d, salespersonId);
    if (adjustments.some((a) => a.adjustment_date === d && a.applies_to_all)) {
      isHolidayWeek = true;
    }
  }

  return {
    businessDaysInRange,
    availableDaysInRange,
    isHolidayWeek,
    firstInRangeDay,
    lastInRangeDay,
  };
}
