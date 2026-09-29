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
  type WeeklyGoal,
} from "@/lib/goals";
import { weekAvailability } from "@/lib/working-days";
import { fetchWeekAdjustments } from "@/lib/server/working-days";
import {
  goalScopeOr,
  selectAllPages,
  selectAllPagesForIds,
} from "@/lib/server/paginate";

// Shared leaderboard aggregation — used by GET /api/leaderboard (current week,
// AE-facing) and GET /api/admin/leaderboard (prior weeks, admin-only).
//
// SCORING is delegated to goals.adjustedWeekScore() and goal resolution to
// goals.resolveActiveGoal() — the EXACT same helpers the admin activity report
// uses — so the leaderboard % and the report % share one adjusted-goal
// denominator and can never drift. Neither route ever returns goal targets,
// only leaderboard-safe standings.

type Person = { id: string; first_name: string };

type GoalRow = WeeklyGoal;

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

/**
 * Computes leaderboard standings. The week is identified by its Monday
 * (`since`) and Mon-Fri end (`through`), which anchor the BUSINESS-week math:
 * available days, goal resolution (`goalAsOf`), and pace.
 *
 * ACTIVITY TOTALS (the numerator), however, are summed over the Sun-Sat
 * ACTIVITY week that contains this business week — so weekend logging counts
 * toward "what was achieved" while targets/availability/pace stay Mon-Fri. See
 * activityWindowForBusinessWeek.
 *
 *   activity week  = Sun-Sat (numerator)
 *   business week  = Mon-Fri (targets / available days / pace)
 *
 * Requires a service-role Supabase client. Returns ONLY standings (id, name,
 * raw totals, percent) — goal targets never leave this function. `today` MUST
 * be the real current Denver date so a past week's Saturday isn't dropped.
 */
export async function computeStandings(
  supabase: SupabaseClient,
  since: string,
  through: string,
  goalAsOf: string,
  // The real current Denver date (yyyy-MM-dd). Pace counts available days
  // strictly before this as "elapsed"; it also caps the Sun-Sat activity
  // window so the current week never counts future days.
  today: string,
): Promise<{ standings: LeaderboardStanding[]; error: string | null }> {
  // Numerator window = the Sun-Sat activity week containing this Mon-Fri week.
  const activity = activityWindowForBusinessWeek(since, today);
  // 1) The REPORTING roster first. Only true AEs compete. Filtering
  // positively on `role = 'ae'` (vs. excluding known non-AE roles) keeps
  // juice_box_only guests (Travis, Rizz, …) off every leaderboard surface and
  // means any future role can't accidentally leak in. `is_test = false`
  // keeps test accounts (private sandboxes) out for EVERY viewer.
  // `deactivated_at IS NULL` drops people who have left the company — they
  // no longer compete, but their historical entries are untouched.
  const peopleRes = await supabase
    .from("salespeople")
    .select("id, first_name")
    .eq("role", "ae")
    .eq("is_test", false)
    .is("deactivated_at", null);
  if (peopleRes.error) {
    console.error(
      `[leaderboard] standings roster read failed since=${since} through=${through} code=${peopleRes.error.code ?? "?"} msg=${peopleRes.error.message}`,
    );
    return { standings: [], error: "Could not load leaderboard right now." };
  }
  const rosterIds = ((peopleRes.data ?? []) as Person[]).map((p) => p.id);

  // 2) Everything else is fetched ONLY for those ids and paged to
  // completion, so no volume of test (or other non-roster) rows can push a
  // real row out of a capped response, and a large real dataset is never
  // truncated either.
  const [entriesRes, goalsRes, adjustmentsRes] = await Promise.all([
    // Activity numerator: Sun-Sat window (weekend entries included), NOT the
    // Mon-Fri [since, through]. Targets/availability below stay Mon-Fri.
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
    // Goal rows that can apply to the roster: global + their own.
    selectAllPages<GoalRow>(() =>
      supabase
        .from("weekly_goals")
        .select("*")
        .or(goalScopeOr(rosterIds))
        .order("id"),
    ),
    // `since` is the week's Monday everywhere this is called, so it doubles
    // as the weekStart for available-day math. Fetched once, reused per AE.
    fetchWeekAdjustments(supabase, since, rosterIds),
  ]);

  // FAIL CLOSED on any read error — never compute pace as if there were no
  // adjustments. Raw provider text is logged server-side ONLY; callers receive
  // a safe, generic, application-level message.
  const provider = entriesRes.error ?? goalsRes.error;
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
  const entries = entriesRes.data;
  const allGoals = goalsRes.data;

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
    const goal = resolveActiveGoal(p.id, allGoals, goalAsOf);
    const avail = weekAvailability({
      weekStart: since,
      salespersonId: p.id,
      adjustments,
      today,
    });
    // Score against TIME-OFF-ADJUSTED goals via the shared helper — the exact
    // same math the admin activity report uses, so the two never diverge. The
    // DB goal row is never mutated.
    const { percent } = adjustedWeekScore(totals, goal, avail.availableDays);
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
