import type { SupabaseClient } from "@supabase/supabase-js";

import {
  ACTIVITIES,
  ZERO_ACTIVITY,
  type ActivityKey,
  type ActivityValues,
} from "@/lib/activities";
import { averagePercent } from "@/lib/goals";
import { weekAvailability } from "@/lib/working-days";
import { fetchWeekAdjustments } from "@/lib/server/working-days";

// Shared leaderboard aggregation — used by GET /api/leaderboard (current week,
// AE-facing) and GET /api/admin/leaderboard (prior weeks, admin-only).
//
// Keeping the math here means BOTH routes score identically (the same
// averagePercent diminishing-returns logic, the same goal resolution) and
// neither ever returns goal targets — only leaderboard-safe standings.

type Person = { id: string; first_name: string };

type GoalRow = ActivityValues & {
  id: string;
  salesperson_id: string | null;
  effective_from: string;
  created_at?: string;
};

export type LeaderboardStanding = {
  id: string;
  first_name: string;
  total: number;
  totals: ActivityValues;
  /** Weekly achievement % (actual ÷ weekly goal). UNCHANGED by working-day
   *  adjustments — weekly goals are never reduced. */
  percent: number | null;
  /** Available working days this week for this AE (5 minus holiday/PTO,
   *  clamped to >= 1). Informational + powers the pace indicator. */
  availableDays: number;
  /** Expected-to-date pace % derived from available days elapsed. Compare
   *  against `percent` to judge "on pace" without touching the goal. */
  expectedPercent: number;
  /** True when a global holiday falls in this week. */
  isHolidayWeek: boolean;
};

const ACTIVITY_KEYS = ACTIVITIES.map((a) => a.key);

// Goal resolution — identical to the prior client-side logic.
function sortGoalsByRecency(a: GoalRow, b: GoalRow) {
  const eff = b.effective_from.localeCompare(a.effective_from);
  if (eff !== 0) return eff;
  return (b.created_at ?? "").localeCompare(a.created_at ?? "");
}

function activeGoalFor(
  personId: string,
  allGoals: GoalRow[],
  asOf: string,
): GoalRow | null {
  const personal = allGoals
    .filter((g) => g.salesperson_id === personId && g.effective_from <= asOf)
    .sort(sortGoalsByRecency);
  if (personal[0]) return personal[0];
  const global = allGoals
    .filter((g) => g.salesperson_id === null && g.effective_from <= asOf)
    .sort(sortGoalsByRecency);
  return global[0] ?? null;
}

/**
 * Computes leaderboard standings for the Mon-Fri range [`since`, `through`],
 * resolving each AE's weekly goal as of `goalAsOf`. Requires a service-role
 * Supabase client. Returns ONLY standings (id, name, raw totals, percent) —
 * goal targets never leave this function.
 */
export async function computeStandings(
  supabase: SupabaseClient,
  since: string,
  through: string,
  goalAsOf: string,
  // The real current Denver date (yyyy-MM-dd). Pace counts available days
  // strictly before this as "elapsed", so a fully-past week reads 100%
  // expected and the current week reads its true to-date pace. Defaults to
  // `through` for callers that don't distinguish (current-week case).
  today: string = through,
): Promise<{ standings: LeaderboardStanding[]; error: string | null }> {
  const [peopleRes, entriesRes, goalsRes, adjustmentsRes] = await Promise.all([
    // Only true AEs compete. Filtering positively on `role = 'ae'` (vs.
    // excluding known non-AE roles) keeps juice_box_only guests (Travis,
    // Rizz, …) off every leaderboard surface and means any future role
    // can't accidentally leak in. is_test stays as belt-and-suspenders
    // against the seeded test account leaking into team standings.
    supabase
      .from("salespeople")
      .select("id, first_name")
      .eq("role", "ae")
      .eq("is_test", false),
    supabase
      .from("activity_entries")
      .select(["salesperson_id", ...ACTIVITY_KEYS].join(","))
      .gte("entry_date", since)
      .lte("entry_date", through),
    supabase.from("weekly_goals").select("*"),
    // `since` is the week's Monday everywhere this is called, so it doubles
    // as the weekStart for available-day math. Fetched once, reused per AE.
    fetchWeekAdjustments(supabase, since),
  ]);

  // FAIL CLOSED on any read error — never compute pace as if there were no
  // adjustments. Raw provider text is logged server-side ONLY; callers receive
  // a safe, generic, application-level message.
  const provider = peopleRes.error ?? entriesRes.error ?? goalsRes.error;
  if (provider) {
    console.error(
      `[leaderboard] standings read failed since=${since} through=${through} code=${provider.code ?? "?"} msg=${provider.message}`,
    );
    return { standings: [], error: "Could not load leaderboard right now." };
  }
  if (adjustmentsRes.error) {
    // Already a user-safe string (raw provider text was logged inside
    // fetchWeekAdjustments).
    return { standings: [], error: adjustmentsRes.error };
  }
  const adjustments = adjustmentsRes.adjustments;

  const people = (peopleRes.data ?? []) as Person[];
  const entries = (entriesRes.data ?? []) as unknown as Array<
    Partial<ActivityValues> & { salesperson_id: string }
  >;
  const allGoals = (goalsRes.data ?? []) as GoalRow[];

  const totalsByPerson = new Map<string, ActivityValues>();
  for (const p of people) totalsByPerson.set(p.id, { ...ZERO_ACTIVITY });
  for (const e of entries) {
    const bucket = totalsByPerson.get(e.salesperson_id);
    if (!bucket) continue;
    for (const a of ACTIVITIES) {
      bucket[a.key] += Number(e[a.key as ActivityKey] ?? 0);
    }
  }

  const standings: LeaderboardStanding[] = people.map((p) => {
    const totals = totalsByPerson.get(p.id) ?? { ...ZERO_ACTIVITY };
    const total = (Object.keys(totals) as ActivityKey[]).reduce(
      (sum, k) => sum + totals[k],
      0,
    );
    const goal = activeGoalFor(p.id, allGoals, goalAsOf);
    const weeklyTargets = { ...ZERO_ACTIVITY };
    if (goal) {
      for (const a of ACTIVITIES) {
        weeklyTargets[a.key] = Number(goal[a.key as ActivityKey] ?? 0);
      }
    }
    const percent = averagePercent(totals, weeklyTargets, ACTIVITY_KEYS);
    const avail = weekAvailability({
      weekStart: since,
      salespersonId: p.id,
      adjustments,
      today,
    });
    return {
      id: p.id,
      first_name: p.first_name,
      total,
      totals,
      percent,
      availableDays: avail.availableDays,
      expectedPercent: avail.expectedPercent,
      isHolidayWeek: avail.isHolidayWeek,
    };
  });

  return { standings, error: null };
}
