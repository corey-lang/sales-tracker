import type { SupabaseClient } from "@supabase/supabase-js";

import {
  ACTIVITIES,
  ZERO_ACTIVITY,
  type ActivityKey,
  type ActivityValues,
} from "@/lib/activities";
import {
  adjustedTargetsFrom,
  averagePercent,
  resolveActiveGoal,
  weeklyTargetsFrom,
  type WeeklyGoal,
} from "@/lib/goals";
import { weekAvailability } from "@/lib/working-days";
import { fetchWeekAdjustments } from "@/lib/server/working-days";

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

/**
 * Builds the per-AE activity report for the Mon-Fri window [`since`, `through`].
 * `since` is the week's Monday (also the weekStart for available-day math),
 * `goalAsOf` resolves each AE's goal as of the week, and `today` is the real
 * Denver date for pace. FAILS CLOSED — any read error (including adjustments)
 * returns a user-safe `error`, never a silently-empty result.
 */
export async function buildActivityReport(
  supabase: SupabaseClient,
  since: string,
  through: string,
  goalAsOf: string,
  today: string,
): Promise<{ rows: ActivityReportRow[]; error: string | null }> {
  const [peopleRes, entriesRes, goalsRes, adjustmentsRes] = await Promise.all([
    supabase
      .from("salespeople")
      .select("id, first_name")
      .eq("role", "ae")
      .eq("is_test", false)
      .order("first_name", { ascending: true }),
    supabase
      .from("activity_entries")
      .select(["salesperson_id", ...ACTIVITY_KEYS].join(","))
      .gte("entry_date", since)
      .lte("entry_date", through),
    supabase.from("weekly_goals").select("*"),
    fetchWeekAdjustments(supabase, since),
  ]);

  if (peopleRes.error ?? entriesRes.error ?? goalsRes.error) {
    const provider = peopleRes.error ?? entriesRes.error ?? goalsRes.error;
    console.warn(
      `[activity-report] read failed since=${since} code=${provider?.code ?? "?"} msg=${provider?.message ?? "?"}`,
    );
    return { rows: [], error: REPORT_READ_ERROR };
  }
  // Fail closed on adjustment errors — never report as if no PTO/holiday.
  if (adjustmentsRes.error) {
    return { rows: [], error: adjustmentsRes.error };
  }
  const adjustments = adjustmentsRes.adjustments;

  const people = (peopleRes.data ?? []) as Array<{
    id: string;
    first_name: string;
  }>;
  const entries = (entriesRes.data ?? []) as unknown as Array<
    Partial<ActivityValues> & { salesperson_id: string }
  >;
  const goals = (goalsRes.data ?? []) as WeeklyGoal[];

  const totals = new Map<string, ActivityValues>();
  for (const p of people) totals.set(p.id, { ...ZERO_ACTIVITY });
  for (const e of entries) {
    const bucket = totals.get(e.salesperson_id);
    if (!bucket) continue;
    for (const k of ACTIVITY_KEYS) bucket[k] += Number(e[k] ?? 0);
  }

  const rows: ActivityReportRow[] = people.map((p) => {
    const actual = totals.get(p.id) ?? { ...ZERO_ACTIVITY };
    const resolvedGoal = resolveActiveGoal(p.id, goals, goalAsOf);
    const avail = weekAvailability({
      weekStart: since,
      salespersonId: p.id,
      adjustments,
      today,
    });
    // Original targets (DB, never mutated) and the time-off-adjusted targets
    // the AE is actually scored against this week.
    const originalTargets = weeklyTargetsFrom(resolvedGoal);
    const adjustedTargets = adjustedTargetsFrom(
      resolvedGoal,
      avail.availableDays,
    );
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
      // Score uses the ADJUSTED targets — achievement % reflects the reduced
      // week.
      score: averagePercent(actual, adjustedTargets, ACTIVITY_KEYS),
      available_days: avail.availableDays,
      expected_percent: avail.expectedPercent,
      is_holiday_week: avail.isHolidayWeek,
    };
  });

  return { rows, error: null };
}
