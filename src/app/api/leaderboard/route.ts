import { format } from "date-fns";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  ACTIVITIES,
  ZERO_ACTIVITY,
  type ActivityKey,
  type ActivityValues,
} from "@/lib/activities";
import { averagePercent, businessWeekToDateRange } from "@/lib/goals";

// GET /api/leaderboard
//
// Server-side leaderboard standings for AE-facing views (the full /leaderboard
// page and the dashboard mini card).
//
// WHY THIS EXISTS
//   The browser used to run `weekly_goals.select("*")` directly to compute
//   leaderboard percentages. That shipped EVERY rep's raw goal targets —
//   including per-person overrides — to every AE's browser, even though the UI
//   only ever renders percentages. An AE could read other AEs' raw goals
//   straight out of the network response. This route reads weekly_goals with
//   the service-role key, does the percentage math here, and returns ONLY
//   leaderboard-safe data: id, first_name, raw activity totals (already shown
//   on the full leaderboard), and the percent score. Goal targets never cross
//   the wire.
//
// SCORING / RANKING ARE UNCHANGED
//   Percentages come from the shared averagePercent() — the same
//   diminishing-returns / per-activity-average logic the client used. Goal
//   resolution (per-person row, else global default; newest effective row)
//   mirrors the prior client code exactly. `percent` is returned as
//   `number | null` so each consumer keeps applying its own existing sort.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

// Goal resolution — identical to the prior client-side logic that lived in
// leaderboard/page.tsx and mini-leaderboard-card.tsx.
function sortGoalsByRecency(a: GoalRow, b: GoalRow) {
  const eff = b.effective_from.localeCompare(a.effective_from);
  if (eff !== 0) return eff;
  return (b.created_at ?? "").localeCompare(a.created_at ?? "");
}

function activeGoalFor(
  personId: string,
  allGoals: GoalRow[],
  todayStr: string,
): GoalRow | null {
  const personal = allGoals
    .filter(
      (g) => g.salesperson_id === personId && g.effective_from <= todayStr,
    )
    .sort(sortGoalsByRecency);
  if (personal[0]) return personal[0];
  const global = allGoals
    .filter((g) => g.salesperson_id === null && g.effective_from <= todayStr)
    .sort(sortGoalsByRecency);
  return global[0] ?? null;
}

export async function GET() {
  const supabase = getServerSupabase();
  const now = new Date();
  const todayStr = format(now, "yyyy-MM-dd");
  const { since, through } = businessWeekToDateRange(now);

  const [peopleRes, entriesRes, goalsRes] = await Promise.all([
    // Admins (is_admin=true), assistants (role='assistant'), and test accounts
    // (is_test=true) don't compete — same filter the client leaderboard used.
    supabase
      .from("salespeople")
      .select("id, first_name")
      .eq("is_admin", false)
      .eq("is_test", false)
      .neq("role", "assistant"),
    supabase
      .from("activity_entries")
      .select(["salesperson_id", ...ACTIVITY_KEYS].join(","))
      .gte("entry_date", since)
      .lte("entry_date", through),
    supabase.from("weekly_goals").select("*"),
  ]);

  const firstErr = peopleRes.error ?? entriesRes.error ?? goalsRes.error;
  if (firstErr) {
    return Response.json({ error: firstErr.message }, { status: 500 });
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
    const goal = activeGoalFor(p.id, allGoals, todayStr);
    const weeklyTargets = { ...ZERO_ACTIVITY };
    if (goal) {
      for (const a of ACTIVITIES) {
        weeklyTargets[a.key] = Number(goal[a.key as ActivityKey] ?? 0);
      }
    }
    const percent = averagePercent(totals, weeklyTargets, ACTIVITY_KEYS);
    return { id: p.id, first_name: p.first_name, total, totals, percent };
  });

  // Only `standings` leaves the server — `allGoals` / `weeklyTargets` stay
  // here. Sorting is intentionally left to each consumer so the full page and
  // the mini card each keep their own existing ranking behavior.
  return Response.json(
    { standings },
    { headers: { "Cache-Control": "no-store" } },
  );
}
