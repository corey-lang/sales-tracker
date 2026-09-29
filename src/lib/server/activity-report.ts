import type { SupabaseClient } from "@supabase/supabase-js";

import {
  ACTIVITIES,
  ZERO_ACTIVITY,
  type ActivityKey,
  type ActivityValues,
} from "@/lib/activities";
import {
  activityWindowForBusinessWeek,
  adjustedWeekScore,
  resolveActiveGoal,
  weeklyTargetsFrom,
  type WeeklyGoal,
} from "@/lib/goals";
import { weekAvailability } from "@/lib/working-days";
import { fetchWeekAdjustments } from "@/lib/server/working-days";
import {
  goalScopeOr,
  selectAllPages,
  selectAllPagesForIds,
} from "@/lib/server/paginate";

// Admin Activity Report aggregation — per-AE progress toward weekly goals for
// one Mon-Fri week, computed SERVER-SIDE with the service-role client behind
// the admin-gated /api/admin/reports/activity route.
//
// This previously ran in the browser, which meant every AE's weekly_goals,
// activity_entries, and working_day_adjustments (incl. PTO) were readable with
// the anon key by anyone. Now the raw rows never leave the server; only the
// aggregated, admin-verified report does. Score math is unchanged (the shared
// averagePercent diminishing-returns helper); available days affect pace only.

const ACTIVITY_KEYS = ACTIVITIES.map((a) => a.key);

export type ActivityReportCell = {
  actual: number;
  /** The ADJUSTED weekly target (original × availableDays / 5, rounded).
   *  Equals `original_goal` on a normal 5-day week. */
  goal: number;
  /** The unadjusted weekly goal from the DB, for "16 / 20" context. */
  original_goal: number;
  /** actual ÷ adjusted goal × 100. */
  percent: number | null;
};

export type ActivityReportRow = {
  id: string;
  first_name: string;
  cells: Record<ActivityKey, ActivityReportCell>;
  /** Weekly goal score % — UNCHANGED by available days. */
  score: number | null;
  available_days: number;
  expected_percent: number;
  is_holiday_week: boolean;
};

/** A user-safe error for any underlying data-read failure. Raw provider
 *  messages are logged server-side, never returned. */
const REPORT_READ_ERROR = "Could not load the activity report.";

function appDateOnly(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "01";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * THE per-AE weekly scoring, shared by the team report below and the
 * single-AE reader (buildSingleAeActivityWeek). Pure: given one AE's Sun-Sat
 * actuals, the goal rows, and the week's working-day adjustments, it resolves
 * the goal AS OF `goalAsOf`, applies availability (PTO/holidays), and scores
 * with adjustedWeekScore() — the same helpers the leaderboard uses.
 */
export function scoreActivityWeek(input: {
  salesperson: { id: string; first_name: string };
  actual: ActivityValues;
  goals: WeeklyGoal[];
  adjustments: Awaited<ReturnType<typeof fetchWeekAdjustments>>["adjustments"];
  since: string;
  goalAsOf: string;
  today: string;
}): ActivityReportRow {
  const { salesperson: p, actual, goals, adjustments, since, goalAsOf, today } = input;
  const resolvedGoal = resolveActiveGoal(p.id, goals, goalAsOf);
  const avail = weekAvailability({
    weekStart: since,
    salespersonId: p.id,
    adjustments,
    today,
  });
  // Score + adjusted targets from the SHARED helper — the same call the
  // leaderboard makes, so the report % and leaderboard % are identical.
  const { percent, adjustedTargets } = adjustedWeekScore(
    actual,
    resolvedGoal,
    avail.availableDays,
  );
  // Original targets (DB, never mutated) for the "16 / 20" context.
  const originalTargets = weeklyTargetsFrom(resolvedGoal);
  const cells = {} as Record<ActivityKey, ActivityReportCell>;
  for (const k of ACTIVITY_KEYS) {
    const goal = adjustedTargets[k];
    cells[k] = {
      actual: actual[k],
      goal,
      original_goal: originalTargets[k],
      percent: goal > 0 ? Math.round((actual[k] / goal) * 100) : null,
    };
  }
  return {
    id: p.id,
    first_name: p.first_name,
    cells,
    score: percent,
    available_days: avail.availableDays,
    expected_percent: avail.expectedPercent,
    is_holiday_week: avail.isHolidayWeek,
  };
}

/**
 * ONE AE's row of the activity report, for any AE — including a test
 * account, which the team report (and every team aggregate) deliberately
 * excludes. Same numerator window, goal resolution, availability and scoring
 * (scoreActivityWeek); it just reads only this AE's entries and returns only
 * this AE's row, so a test account's numbers can be shown on its own pages
 * without ever entering a team calculation. FAILS CLOSED like the team
 * report.
 */
export async function buildSingleAeActivityWeek(
  supabase: SupabaseClient,
  salesperson: { id: string; first_name: string },
  since: string,
  through: string,
  goalAsOf: string,
  today: string,
): Promise<{ row: ActivityReportRow | null; error: string | null }> {
  const activity = activityWindowForBusinessWeek(since, today);
  // Only this AE's rows, filtered in the query and paged — so another
  // account's volume (e.g. a test account's) can never displace them.
  const [entriesRes, goalsRes, adjustmentsRes] = await Promise.all([
    selectAllPages<Partial<ActivityValues>>(() =>
      supabase
        .from("activity_entries")
        .select(["id", "salesperson_id", ...ACTIVITY_KEYS].join(","))
        .eq("salesperson_id", salesperson.id)
        .gte("entry_date", activity.since)
        .lte("entry_date", activity.through)
        .order("id"),
    ),
    selectAllPages<WeeklyGoal>(() =>
      supabase.from("weekly_goals").select("*").or(goalScopeOr([salesperson.id])).order("id"),
    ),
    fetchWeekAdjustments(supabase, since, [salesperson.id]),
  ]);
  if (entriesRes.error ?? goalsRes.error) {
    const provider = entriesRes.error ?? goalsRes.error;
    console.warn(
      `[activity-report] single-AE read failed ae=${salesperson.id} business=[${since}..${through}] code=${provider?.code ?? "?"} msg=${provider?.message ?? "?"}`,
    );
    return { row: null, error: REPORT_READ_ERROR };
  }
  if (adjustmentsRes.error) return { row: null, error: adjustmentsRes.error };
  const actual = { ...ZERO_ACTIVITY };
  for (const e of entriesRes.data) {
    for (const k of ACTIVITY_KEYS) actual[k] += Number(e[k] ?? 0);
  }
  return {
    row: scoreActivityWeek({
      salesperson,
      actual,
      goals: goalsRes.data,
      adjustments: adjustmentsRes.adjustments,
      since,
      goalAsOf,
      today,
    }),
    error: null,
  };
}

/**
 * Builds the per-AE activity report for one week. `since` is the week's Monday
 * (the weekStart for available-day math AND goal resolution), `through` its
 * Mon-Fri end, `goalAsOf` resolves each AE's goal as of the week, and `today`
 * is the real Denver date for pace.
 *
 * The ACTIVITY total (numerator) is summed over the Sun-Sat ACTIVITY week that
 * contains this business week — weekend logging counts — while targets,
 * available days, and pace stay Mon-Fri (activityWindowForBusinessWeek). FAILS
 * CLOSED — any read error (including adjustments) returns a user-safe `error`,
 * never a silently-empty result.
 */
export async function buildActivityReport(
  supabase: SupabaseClient,
  since: string,
  through: string,
  goalAsOf: string,
  today: string,
): Promise<{ rows: ActivityReportRow[]; error: string | null }> {
  // Numerator window = Sun-Sat activity week (weekend entries included).
  const activity = activityWindowForBusinessWeek(since, today);
  // 1) The REPORTING roster first (real AEs only). This report can render
  // prior weeks, so unlike the live roster cards we keep deactivated AEs in
  // the base query and filter by the selected week's date window below. That
  // preserves historical rows without putting former AEs back on
  // current-only selectors elsewhere.
  const peopleRes = await supabase
    .from("salespeople")
    .select("id, first_name, deactivated_at")
    .eq("role", "ae")
    .eq("is_test", false)
    .order("first_name", { ascending: true });
  if (peopleRes.error) {
    console.warn(
      `[activity-report] roster read failed business=[${since}..${through}] code=${peopleRes.error.code ?? "?"} msg=${peopleRes.error.message}`,
    );
    return { rows: [], error: REPORT_READ_ERROR };
  }
  const people = (peopleRes.data ?? []) as Array<{
    id: string;
    first_name: string;
    deactivated_at: string | null;
  }>;
  const rosterIds = people.map((p) => p.id);

  // 2) Only the roster's rows, filtered in the query and paged to completion.
  const [entriesRes, goalsRes, adjustmentsRes] = await Promise.all([
    selectAllPagesForIds<Partial<ActivityValues> & { salesperson_id: string }>(
      rosterIds,
      (chunk) =>
        supabase
          .from("activity_entries")
          .select(["id", "salesperson_id", ...ACTIVITY_KEYS].join(","))
          .in("salesperson_id", chunk)
          .gte("entry_date", activity.since)
          .lte("entry_date", activity.through)
          .order("id"),
    ),
    selectAllPages<WeeklyGoal>(() =>
      supabase.from("weekly_goals").select("*").or(goalScopeOr(rosterIds)).order("id"),
    ),
    fetchWeekAdjustments(supabase, since, rosterIds),
  ]);

  if (entriesRes.error ?? goalsRes.error) {
    const provider = entriesRes.error ?? goalsRes.error;
    console.warn(
      `[activity-report] read failed business=[${since}..${through}] activity=[${activity.since}..${activity.through}] code=${provider?.code ?? "?"} msg=${provider?.message ?? "?"}`,
    );
    return { rows: [], error: REPORT_READ_ERROR };
  }
  // Fail closed on adjustment errors — never report as if no PTO/holiday.
  if (adjustmentsRes.error) {
    return { rows: [], error: adjustmentsRes.error };
  }
  const adjustments = adjustmentsRes.adjustments;
  const entries = entriesRes.data;
  const goals = goalsRes.data;

  const totals = new Map<string, ActivityValues>();
  for (const p of people) totals.set(p.id, { ...ZERO_ACTIVITY });
  for (const e of entries) {
    const bucket = totals.get(e.salesperson_id);
    if (!bucket) continue;
    for (const k of ACTIVITY_KEYS) bucket[k] += Number(e[k] ?? 0);
  }

  const rows: ActivityReportRow[] = people
    .filter((p) => {
      if (p.deactivated_at == null) return true;
      // Live-roster filters should not erase HISTORY: if the selected
      // activity week overlaps the AE's final active day, keep their row so
      // past reports still render correctly after offboarding.
      return appDateOnly(p.deactivated_at) >= activity.since;
    })
    .map((p) =>
      scoreActivityWeek({
        salesperson: p,
        actual: totals.get(p.id) ?? { ...ZERO_ACTIVITY },
        goals,
        adjustments,
        since,
        goalAsOf,
        today,
      }),
    );

  return { rows, error: null };
}
