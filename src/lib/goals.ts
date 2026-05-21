import { addDays, format, isWeekend, startOfWeek, subWeeks } from "date-fns";

import { supabase } from "@/lib/supabase/client";
import type { ActivityKey, ActivityValues } from "@/lib/activities";
import { ZERO_ACTIVITY } from "@/lib/activities";
import { formatDateMDY, todayInAppTimezone } from "@/lib/dates";

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
// Powers the AE "Edit or backfill week" selector, the admin leaderboard
// week picker, and the activity-report week picker. No future weeks — this
// is for editing/backfilling, and the rest of the app only reports up to
// today.
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

// Returns the goal that should apply to this salesperson today.
// Prefers a per-person row, falls back to the global (null salesperson_id).
// Both filtered to effective_from <= today.
export async function fetchActiveGoalFor(salespersonId: string): Promise<{
  data: WeeklyGoal | null;
  error: { message: string } | null;
}> {
  // Denver business date — keeps the "effective_from <= today" cutoff
  // aligned with everything else that asks "which week is now". A raw
  // UTC slice would briefly flip to the next day's goal in late Denver
  // evening, before the Denver-aware leaderboard / Weekly Focus does.
  const today = format(todayInAppTimezone(), "yyyy-MM-dd");
  const [personal, global] = await Promise.all([
    supabase
      .from("weekly_goals")
      .select("*")
      .eq("salesperson_id", salespersonId)
      .lte("effective_from", today)
      .order("effective_from", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("weekly_goals")
      .select("*")
      .is("salesperson_id", null)
      .lte("effective_from", today)
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
