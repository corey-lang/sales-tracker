import {
  addDays,
  format,
  isWeekend,
  parseISO,
  startOfWeek,
  subWeeks,
} from "date-fns";

import { supabase } from "@/lib/supabase/client";
import type { ActivityKey, ActivityValues } from "@/lib/activities";
import { ZERO_ACTIVITY } from "@/lib/activities";
import { formatDateMDY, todayInAppTimezone } from "@/lib/dates";
import { adjustGoalValue } from "@/lib/working-days";

// The `weekly_goals` table stores Monday-Friday weekly targets.
// `salesperson_id IS NULL` = global default; a UUID = per-person override.
// Every activity in ACTIVITIES (including gold_list_touches) is a column here.
export type WeeklyGoal = ActivityValues & {
  id: string;
  effective_from: string;
  salesperson_id: string | null;
  created_at?: string;
};

export const WORK_DAYS_PER_WEEK = 5;

export function weeklyTargetsFrom(goal: WeeklyGoal | null): ActivityValues {
  if (!goal) return ZERO_ACTIVITY;
  const out = { ...ZERO_ACTIVITY };
  for (const key of Object.keys(ZERO_ACTIVITY) as ActivityKey[]) {
    out[key] = Number(goal[key] ?? 0);
  }
  return out;
}

/**
 * The week's targets after reducing each goal for approved unavailable days:
 * `adjusted = round(original × availableDays / 5)`. The DB goal row is never
 * touched — this is computed at read time everywhere a target/score is shown.
 * `availableDays = 5` (normal week) returns the original targets unchanged.
 */
export function adjustedTargetsFrom(
  goal: WeeklyGoal | null,
  availableDays: number,
): ActivityValues {
  const raw = weeklyTargetsFrom(goal);
  const out = { ...ZERO_ACTIVITY };
  for (const key of Object.keys(ZERO_ACTIVITY) as ActivityKey[]) {
    out[key] = adjustGoalValue(raw[key], availableDays);
  }
  return out;
}

// Default `today` for week-boundary functions: the current calendar day in
// the app's business timezone (America/Denver), NOT raw `new Date()`. This
// keeps the leaderboard's "this week" and the Weekly Focus row's week_start
// aligned with the team's local calendar regardless of where the Vercel
// function physically runs (typically UTC).
export function businessWeekToDateRange(
  today: Date = todayInAppTimezone(),
): {
  since: string;
  through: string;
  isBusinessDay: boolean;
} {
  const monday = startOfWeek(today, { weekStartsOn: 1 });
  const friday = addDays(monday, WORK_DAYS_PER_WEEK - 1);
  const through = today > friday ? friday : today;

  return {
    since: format(monday, "yyyy-MM-dd"),
    through: format(through, "yyyy-MM-dd"),
    isBusinessDay: !isWeekend(today),
  };
}

// Sunday-through-Saturday range for the ACTIVITY week. Sunday STARTS the
// activity week; Saturday CLOSES it. This is the canonical window for ACTIVITY
// TOTALS / numerators / progress / pacing — Saturday and Sunday logging count
// toward the week. (Distinct from businessWeekToDateRange, Mon-Fri, which is
// only the TARGET side: available days, PTO/holiday, adjusted goals, and pace
// stay anchored to the Monday-Friday working-day week.)
//
// activity week = Sun-Sat (what was logged) · business week = Mon-Fri (targets).
//
// This helper is the CLIENT-side Sun-Sat range used directly by the AE display
// surfaces (DailyEntryForm, MyWeekCard, TodayTotalsCard, ActivityWeekContext).
// Server-side weekly readers (leaderboard, scorecard, coaching trend, admin
// activity report) compute the SAME Sun-Sat numerator window from a business
// Monday via activityWindowForBusinessWeek; the AE "Edit activity week" card and
// the admin week pickers enumerate Sun-Sat weeks via recentActivityWeeks. Do NOT
// use this for the TARGET/availability/PTO/holiday/pace math — that is Mon-Fri.
//
// `through` is capped at today (never future) so a mid-week view doesn't query
// past the current day. Default `today` is the Denver business calendar date,
// matching every other week-boundary helper here.
export function activityWeekToDateRange(
  today: Date = todayInAppTimezone(),
): {
  since: string;
  through: string;
} {
  const sunday = startOfWeek(today, { weekStartsOn: 0 });
  const saturday = addDays(sunday, 6);
  const through = today > saturday ? saturday : today;

  return {
    since: format(sunday, "yyyy-MM-dd"),
    through: format(through, "yyyy-MM-dd"),
  };
}

// THE bridge between the two week definitions. Given a Mon-Fri BUSINESS week
// (identified by its Monday), returns the Sun-Sat ACTIVITY numerator window for
// that same week. The activity week that CONTAINS business-Monday M runs from
// Sunday (M-1) through Saturday (M+5).
//
//   activity week  = Sun-Sat   → numerators / "what was logged this week"
//   business week  = Mon-Fri   → targets, available days, PTO, pace
//
// Server-side weekly readers (leaderboard, scorecard, admin activity report,
// coaching trend) call this so the ACTIVITY total counts the full Sun-Sat week
// (including that week's Sunday and Saturday) while availability / adjusted
// goals / pace stay anchored to the Mon-Fri week via `businessMonday`. This is
// the intentional split: weekend activity counts toward the numerator, but it
// never changes working-day target/pace math.
//
// `through` is capped at `today` so a current/partial week never counts future
// days; a fully-past week returns the whole Sunday…Saturday span. Pass the REAL
// current Denver date as `today` (NOT a Mon-Fri-clamped value) or a past week's
// Saturday would be dropped.
export function activityWindowForBusinessWeek(
  businessMonday: string, // yyyy-MM-dd, a Monday
  today: string, // yyyy-MM-dd, real current Denver date
): { since: string; through: string } {
  const monday = parseISO(businessMonday);
  const since = format(addDays(monday, -1), "yyyy-MM-dd"); // Sunday (M-1)
  const saturday = format(addDays(monday, 5), "yyyy-MM-dd"); // Saturday (M+5)
  const through = today < saturday ? today : saturday;
  return { since, through };
}

// The business Monday PAIRED with the activity week containing `dayInWeek`.
// The activity week rolls on SUNDAY (weekStartsOn:0); its inner Mon-Fri starts
// the next day. So: Sunday S → Monday S+1.
//
// Use this — NOT businessWeekToDateRange — to anchor a LIVE or SELECTED "this
// week" activity surface. The difference shows up only on a SUNDAY:
//   * businessWeekToDateRange(Sunday) → the PRIOR Monday (Sunday is the tail of
//     the Mon-Sun week), so a week keyed off it would still roll on Monday.
//   * pairedBusinessMonday(Sunday)    → the UPCOMING Monday, because Sunday
//     already starts the new activity week — today's Sunday activity counts now.
// Feeding the result into computeStandings / activityWindowForBusinessWeek
// yields the current Sun-Sat numerator window with the right Mon-Fri week for
// availability/pace. Robust to a legacy Monday input (maps to the same week).
export function pairedBusinessMonday(
  dayInWeek: Date = todayInAppTimezone(),
): string {
  const sunday = startOfWeek(dayInWeek, { weekStartsOn: 0 });
  return format(addDays(sunday, 1), "yyyy-MM-dd");
}

// Monday (YYYY-MM-DD) of the business week that contains `today`. Single
// source of truth for the Weekly Focus row's `week_start` so the API,
// server helpers, and UI all key off the same Monday — picks Monday via
// `weekStartsOn: 1`, matching businessWeekToDateRange.
//
// Default `today` is the current calendar date in `APP_TIMEZONE`
// (America/Denver) so the week boundary is anchored to the team's local
// calendar, not the server's clock.
export function mondayOfWeek(today: Date = todayInAppTimezone()): string {
  return format(startOfWeek(today, { weekStartsOn: 1 }), "yyyy-MM-dd");
}

// One Monday-Friday business week, identified by its Monday (`weekStart`).
// Matches businessWeekToDateRange / weekStartsOn:1 used everywhere else, so
// the week boundary is Monday 00:00 — a Sunday still belongs to the week that
// began the prior Monday.
export type WeekOption = {
  weekStart: string; // Monday, yyyy-MM-dd
  friday: string; // Friday, yyyy-MM-dd
  label: string; // "MM-dd-yyyy – MM-dd-yyyy"
  isCurrent: boolean;
};

// The current Mon-Fri week plus the prior `count - 1` weeks, newest first.
// Powers the Mon-Fri business/reporting week pickers — the admin leaderboard
// week picker, the admin scorecard week picker, and the activity-report week
// picker. (The AE "Edit activity week" card uses recentActivityWeeks for its
// Sun-Sat boundary.) No future weeks — this is for editing/reporting, and the
// rest of the app only reports up to today.
//
// Default `today` is the current calendar date in `APP_TIMEZONE`
// (America/Denver) so the "current" week here agrees with
// `businessWeekToDateRange` / `mondayOfWeek` / `ensureCurrentWeeklyFocus`.
// Pre-fix, this defaulted to raw `new Date()` and could disagree across
// Sunday-night-Denver / Monday-morning-Denver boundaries depending on the
// browser's clock.
export function recentBusinessWeeks(
  count = 12,
  today: Date = todayInAppTimezone(),
): WeekOption[] {
  const currentMonday = startOfWeek(today, { weekStartsOn: 1 });
  const out: WeekOption[] = [];
  for (let i = 0; i < count; i += 1) {
    const monday = subWeeks(currentMonday, i);
    const friday = addDays(monday, WORK_DAYS_PER_WEEK - 1);
    out.push({
      weekStart: format(monday, "yyyy-MM-dd"),
      friday: format(friday, "yyyy-MM-dd"),
      label: `${formatDateMDY(monday)} – ${formatDateMDY(friday)}`,
      isCurrent: i === 0,
    });
  }
  return out;
}

// One Sunday-Saturday ACTIVITY week, identified by its Sunday (`weekStart`).
// Mirrors activityWeekToDateRange's weekStartsOn:0 boundary so the AE
// "Edit activity week" card lines up with the dashboard's Sun-Sat display and
// with the Sun-Sat numerators every weekly-activity reader uses.
//
// `monday`/`friday` expose the INNER Mon-Fri business week for reference (the
// business week this activity week pairs with — see activityWindowForBusinessWeek).
// Targets, available days, PTO, and pace are all anchored to that Mon-Fri week;
// the activity totals themselves are the full Sun-Sat span.
//
// NOTE: a Sun-Sat activity week straddles two Mon-Fri business weeks — its
// Sunday is the tail of the PRIOR business week, while Mon-Sat belong to the
// next one. The pairing used everywhere is: business-Monday M ↔ activity week
// Sun(M-1)…Sat(M+5).
export type ActivityWeekOption = {
  weekStart: string; // Sunday, yyyy-MM-dd — activity week start (canonical save row)
  weekEnd: string; // Saturday, yyyy-MM-dd — activity week end
  monday: string; // Monday, yyyy-MM-dd — paired Mon-Fri business week start
  friday: string; // Friday, yyyy-MM-dd — paired Mon-Fri business week end
  label: string; // "MM-dd-yyyy – MM-dd-yyyy" (Sun – Sat)
  isCurrent: boolean;
};

// The current Sun-Sat activity week plus the prior `count - 1` weeks, newest
// first. Powers every Sun-Sat activity-week SELECTOR: the AE "Edit activity
// week" card and the admin leaderboard / scorecard / activity-report week
// pickers (all of which show activity totals over the selected Sun-Sat week).
// Default `today` is the Denver business calendar date so "current" agrees with
// activityWeekToDateRange and the dashboard activity surfaces — on a Sunday the
// current week is the NEW Sun-Sat week that begins that Sunday (Sunday starts
// the activity week). Target/availability/PTO for a selected week stay Mon-Fri
// via the paired business week (`monday`/`friday`).
export function recentActivityWeeks(
  count = 12,
  today: Date = todayInAppTimezone(),
): ActivityWeekOption[] {
  const currentSunday = startOfWeek(today, { weekStartsOn: 0 });
  const out: ActivityWeekOption[] = [];
  for (let i = 0; i < count; i += 1) {
    const sunday = subWeeks(currentSunday, i);
    const saturday = addDays(sunday, 6);
    out.push({
      weekStart: format(sunday, "yyyy-MM-dd"),
      weekEnd: format(saturday, "yyyy-MM-dd"),
      monday: format(addDays(sunday, 1), "yyyy-MM-dd"),
      friday: format(addDays(sunday, 5), "yyyy-MM-dd"),
      label: `${formatDateMDY(sunday)} – ${formatDateMDY(saturday)}`,
      isCurrent: i === 0,
    });
  }
  return out;
}

// Picks the goal in effect for a person as of `asOf` (yyyy-MM-dd): the most
// recent per-person row, else the most recent global (null) row — both with
// effective_from <= asOf. Pure: operates on an already-fetched goal list, so
// callers can resolve goals for any week (not just today). Mirrors the goal
// resolution in /api/leaderboard and fetchActiveGoalFor.
export function resolveActiveGoal(
  personId: string,
  goals: WeeklyGoal[],
  asOf: string,
): WeeklyGoal | null {
  const byRecency = (a: WeeklyGoal, b: WeeklyGoal) => {
    const eff = b.effective_from.localeCompare(a.effective_from);
    if (eff !== 0) return eff;
    return (b.created_at ?? "").localeCompare(a.created_at ?? "");
  };
  const personal = goals
    .filter((g) => g.salesperson_id === personId && g.effective_from <= asOf)
    .sort(byRecency);
  if (personal[0]) return personal[0];
  const global = goals
    .filter((g) => g.salesperson_id === null && g.effective_from <= asOf)
    .sort(byRecency);
  return global[0] ?? null;
}

// Score = unweighted average of per-activity completion percents
// (actual / target × 100). Activities with target ≤ 0 are skipped so they
// don't drag the average toward 0. Returns null when no activity has a
// positive target. This intentionally treats each activity equally rather
// than summing raw counts, so high-volume activities (e.g. impressions)
// don't dominate lower-volume ones (e.g. office visits).
//
// Overachievement gets diminishing returns: anything past 100% only counts
// at 20% of its excess (150% → 110%, 200% → 120%). This keeps blowout days
// on one activity from masking misses on others.
function diminishOverachievement(percent: number): number {
  if (percent <= 100) return percent;
  return 100 + (percent - 100) * 0.2;
}

export function averagePercent<K extends string>(
  actuals: Partial<Record<K, number>>,
  targets: Partial<Record<K, number>>,
  keys: readonly K[],
): number | null {
  let sum = 0;
  let count = 0;
  for (const k of keys) {
    const target = Number(targets[k] ?? 0);
    if (target <= 0) continue;
    const actual = Number(actuals[k] ?? 0);
    sum += diminishOverachievement((actual / target) * 100);
    count += 1;
  }
  if (count === 0) return null;
  return Math.round(sum / count);
}

/** All activity keys, derived from the canonical ZERO_ACTIVITY shape. */
const ALL_ACTIVITY_KEYS = Object.keys(ZERO_ACTIVITY) as ActivityKey[];

/**
 * THE single source of truth for an AE's weekly achievement % against
 * time-off-adjusted goals. Every scoring surface (leaderboard standings AND
 * the activity report) MUST call this so they can never drift apart:
 *
 *   adjustedTargets = round(original × availableDays / 5)   per activity
 *   percent         = averagePercent(actuals, adjustedTargets)
 *
 * Returns both the percent and the adjusted targets, so a consumer that also
 * needs per-activity targets (the report) shows the exact numbers the score
 * was computed from. The DB goal row is never mutated.
 */
export function adjustedWeekScore(
  actuals: Partial<ActivityValues>,
  goal: WeeklyGoal | null,
  availableDays: number,
): { percent: number | null; adjustedTargets: ActivityValues } {
  const adjustedTargets = adjustedTargetsFrom(goal, availableDays);
  const percent = averagePercent(actuals, adjustedTargets, ALL_ACTIVITY_KEYS);
  return { percent, adjustedTargets };
}

export function progressColor(percent: number): {
  bar: string;
  text: string;
} {
  if (percent >= 100) {
    return { bar: "bg-green-500", text: "text-green-600 dark:text-green-400" };
  }
  if (percent >= 50) {
    return {
      bar: "bg-yellow-500",
      text: "text-yellow-600 dark:text-yellow-400",
    };
  }
  return { bar: "bg-red-500", text: "text-red-600 dark:text-red-400" };
}

// Returns the goal that should apply to this salesperson as of `asOf`.
// Prefers a per-person row, falls back to the global (null salesperson_id).
// Both filtered to effective_from <= asOf.
//
// `asOf` defaults to the Denver business date (today). AE activity surfaces
// pass `pairedBusinessMonday()` instead, so the goal resolves for the Mon-Fri
// week paired with the CURRENT Sun-Sat activity week — on a Sunday that's the
// upcoming Monday, so a Monday-effective goal change applies to the new week
// the AE is already logging into (no comparing new-week activity to the prior
// week's goal).
export async function fetchActiveGoalFor(
  salespersonId: string,
  asOf: string = format(todayInAppTimezone(), "yyyy-MM-dd"),
): Promise<{
  data: WeeklyGoal | null;
  error: { message: string } | null;
}> {
  const [personal, global] = await Promise.all([
    supabase
      .from("weekly_goals")
      .select("*")
      .eq("salesperson_id", salespersonId)
      .lte("effective_from", asOf)
      .order("effective_from", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("weekly_goals")
      .select("*")
      .is("salesperson_id", null)
      .lte("effective_from", asOf)
      .order("effective_from", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const error = personal.error ?? global.error;
  if (error) return { data: null, error };
  return {
    data: (personal.data ?? global.data) as WeeklyGoal | null,
    error: null,
  };
}

// Returns the currently effective goal for a given scope.
// scope === null  → Global default only (no per-person fallback to anything,
//                   since Global IS the top of the chain).
// scope: string   → Per-person with Global fallback (delegates to
//                   fetchActiveGoalFor, which already does that).
export async function fetchActiveGoalForScope(
  scope: string | null,
): Promise<{
  data: WeeklyGoal | null;
  error: { message: string } | null;
}> {
  if (scope !== null) return fetchActiveGoalFor(scope);
  // Denver business date — keeps the "effective_from <= today" cutoff
  // aligned with everything else that asks "which week is now". A raw
  // UTC slice would briefly flip to the next day's goal in late Denver
  // evening, before the Denver-aware leaderboard / Weekly Focus does.
  const today = format(todayInAppTimezone(), "yyyy-MM-dd");
  const { data, error } = await supabase
    .from("weekly_goals")
    .select("*")
    .is("salesperson_id", null)
    .lte("effective_from", today)
    .order("effective_from", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return { data: null, error };
  return { data: data as WeeklyGoal | null, error: null };
}
