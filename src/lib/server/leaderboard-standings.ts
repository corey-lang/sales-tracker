import type { SupabaseClient } from "@supabase/supabase-js";

import {
  ACTIVITIES,
  ZERO_ACTIVITY,
  type ActivityKey,
  type ActivityValues,
} from "@/lib/activities";
import { averagePercent } from "@/lib/goals";

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
  percent: number | null;
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
): Promise<{ standings: LeaderboardStanding[]; error: string | null }> {
  const [peopleRes, entriesRes, goalsRes] = await Promise.all([
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
  ]);

  const firstErr = peopleRes.error ?? entriesRes.error ?? goalsRes.error;
  if (firstErr) {
    return { standings: [], error: firstErr.message };
  }

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
    return { id: p.id, first_name: p.first_name, total, totals, percent };
  });

  return { standings, error: null };
}
