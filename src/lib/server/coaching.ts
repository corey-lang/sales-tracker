import { addDays, format, startOfWeek } from "date-fns";
import type { SupabaseClient } from "@supabase/supabase-js";

import { appTimezoneMidnightUtc, todayInAppTimezone } from "@/lib/dates";
import { GOAL_ACTIVITY_KEYS, ZERO_GOAL_VALUES } from "@/lib/goal-activities";
import { businessWeekToDateRange, mondayOfWeek } from "@/lib/goals";
import { ApiError, notFound } from "@/lib/server/auth";
import { computeStandings } from "@/lib/server/leaderboard-standings";
import type {
  CoachingAeSummary,
  CoachingSnapshot,
  CurrentWeeklyGoal,
  NextWeekGoalOverride,
  WeeklyFocus,
  WeeklyGoalRow,
  WeeklyGoalValues,
} from "@/lib/one-on-ones";
import {
  WEEKLY_FOCUS_TABLE,
  WEEKLY_FOCUS_COMMITMENTS_TABLE,
} from "@/lib/one-on-ones";

/** Pulls the numeric goal values off a row, defaulting nulls to 0. */
function pickGoalValues(row: WeeklyGoalRow): WeeklyGoalValues {
  const out: WeeklyGoalValues = { ...ZERO_GOAL_VALUES };
  for (const a of GOAL_ACTIVITY_KEYS) {
    out[a.key] = Number(row[a.key] ?? 0);
  }
  return out;
}

/** Monday (YYYY-MM-DD) of the NEXT Denver business week. */
export function nextMondayOfBusinessWeek(
  asOf: Date = todayInAppTimezone(),
): string {
  const monday = startOfWeek(asOf, { weekStartsOn: 1 });
  return format(addDays(monday, 7), "yyyy-MM-dd");
}

/**
 * Resolves the current and next-week goal state for ONE AE in a single
 * roundtrip. Reuses the same personal-then-global precedence the
 * leaderboard's `computeStandings` applies.
 *
 *   * `current` — the goal that's active for the AE today: most recent
 *     per-AE row with effective_from <= today, falling back to the most
 *     recent global (`salesperson_id IS NULL`) row.
 *   * `nextOverride` — the per-AE override row whose `effective_from`
 *     equals next Monday. ABSENT means "next week inherits whatever
 *     goal is active that day" — the UI presents that as the
 *     "Keep same goals as this week" checked state.
 */
export async function fetchAeWeeklyGoals(
  supabase: SupabaseClient,
  aeId: string,
  asOf: Date = todayInAppTimezone(),
): Promise<{
  current: CurrentWeeklyGoal;
  nextOverride: NextWeekGoalOverride | null;
  nextMonday: string;
}> {
  const today = format(asOf, "yyyy-MM-dd");
  const nextMonday = nextMondayOfBusinessWeek(asOf);

  // One read covers both lookups: the personal/global resolution for
  // "current" AND the per-AE override scan for next Monday.
  const res = await supabase
    .from("weekly_goals")
    .select(
      [
        "id",
        "salesperson_id",
        "effective_from",
        ...GOAL_ACTIVITY_KEYS.map((a) => a.key),
      ].join(","),
    )
    .or(`salesperson_id.eq.${aeId},salesperson_id.is.null`)
    .order("effective_from", { ascending: false })
    .order("created_at", { ascending: false });

  if (res.error) {
    throw new ApiError(500, `Weekly goal lookup failed: ${res.error.message}`);
  }
  const rows = (res.data ?? []) as unknown as WeeklyGoalRow[];

  // Personal first, then global — both filtered to effective_from <= today.
  // The DB-side ordering above already sorted by recency, so [0] is newest.
  const personal = rows.find(
    (g) => g.salesperson_id === aeId && g.effective_from <= today,
  );
  const global = rows.find(
    (g) => g.salesperson_id === null && g.effective_from <= today,
  );
  const activeRow = personal ?? global ?? null;

  const current: CurrentWeeklyGoal = activeRow
    ? {
        values: pickGoalValues(activeRow),
        source: personal ? "personal" : "global",
        id: activeRow.id,
        effective_from: activeRow.effective_from,
      }
    : {
        values: { ...ZERO_GOAL_VALUES },
        source: "none",
        id: null,
        effective_from: null,
      };

  // Next-week override: ONLY a per-AE row anchored exactly at next
  // Monday. We deliberately do not promote a global row at next Monday
  // into "the AE's next-week goal" — a global goal change affects the
  // whole team and is set elsewhere on the admin Goals card.
  const nextRow =
    rows.find(
      (g) => g.salesperson_id === aeId && g.effective_from === nextMonday,
    ) ?? null;
  const nextOverride: NextWeekGoalOverride | null = nextRow
    ? {
        id: nextRow.id,
        effective_from: nextRow.effective_from,
        values: pickGoalValues(nextRow),
      }
    : null;

  return { current, nextOverride, nextMonday };
}

/**
 * Role allow-list for the coaching domain.
 *
 * Only `'ae'` is coachable. Admins/assistants don't get 1:1s with
 * themselves; juice_box_only guests (Travis, Rizz, …) are chat-only and
 * have no AE workflow. Centralizing the rule here keeps a future role
 * (e.g. an intern role) from accidentally leaking into the coaching
 * surface — every coaching read and mutation funnels through
 * `buildAeSummaries` or `requireCoachableAe`.
 */
const COACHABLE_ROLE = "ae" as const;

/**
 * Ensures a Weekly Focus row exists for `aeId` and the current business
 * week, returning the row (existing or freshly created). Idempotent — a
 * second call in the same week is a no-op insert that hits the unique
 * `(ae_id, week_start)` constraint and falls through to a SELECT.
 *
 * This replaces the manual "Start new 1:1" flow: the manager simply opens
 * the AE's coaching surface, and the GET route calls this to guarantee a
 * current-week row is present for the UI to render against.
 *
 * The optional `managerId` is stamped on the FIRST creation only — we
 * never overwrite an existing row's manager (rotations preserve
 * provenance). The legacy `meeting_date` column is set to today on first
 * create so the existing history index continues to render a date label.
 */
export async function ensureCurrentWeeklyFocus(
  supabase: SupabaseClient,
  aeId: string,
  managerId: string | null = null,
  asOf: Date = todayInAppTimezone(),
): Promise<WeeklyFocus> {
  const weekStart = mondayOfWeek(asOf);
  const today = format(asOf, "yyyy-MM-dd");

  // Try to insert; ON CONFLICT means a row already exists for this week.
  // We can't use Postgres `RETURNING` semantics through PostgREST in a
  // single call cleanly, so we attempt insert then read.
  const insertRes = await supabase
    .from(WEEKLY_FOCUS_TABLE)
    .insert({
      ae_id: aeId,
      manager_id: managerId,
      week_start: weekStart,
      meeting_date: today,
    })
    .select("*")
    .maybeSingle();

  if (insertRes.data) return insertRes.data as WeeklyFocus;

  // Insert failed — almost certainly the unique constraint (row already
  // exists for this week). Fall through to a select. If the failure was
  // something else (permissions, network), the select will surface its
  // own error. We deliberately do not pre-check existence to keep this
  // single-roundtrip on the common new-week path.
  const selectRes = await supabase
    .from(WEEKLY_FOCUS_TABLE)
    .select("*")
    .eq("ae_id", aeId)
    .eq("week_start", weekStart)
    .maybeSingle();

  if (selectRes.error) {
    throw new ApiError(
      500,
      `Could not load this week's focus: ${selectRes.error.message}`,
    );
  }
  if (!selectRes.data) {
    // We couldn't insert AND nothing exists. The original insert error is
    // the most informative thing to surface.
    throw new ApiError(
      500,
      `Could not open this week's focus: ${
        insertRes.error?.message ?? "unknown error"
      }`,
    );
  }
  return selectRes.data as WeeklyFocus;
}

/**
 * Resolves a salesperson by id and asserts they are a coachable AE
 * (role === 'ae'). Throws 404 (`notFound`) when the row doesn't exist
 * OR exists but isn't an AE — the two cases are intentionally
 * indistinguishable so a caller can't probe roles by id.
 *
 * Use this in every coaching route that pulls `ae_id` from the URL,
 * before any insert/update/select that depends on the AE.
 */
export async function requireCoachableAe(
  supabase: SupabaseClient,
  aeId: string,
): Promise<{ id: string; first_name: string }> {
  const res = await supabase
    .from("salespeople")
    .select("id, first_name, role")
    .eq("id", aeId)
    .maybeSingle();
  if (res.error) {
    throw new ApiError(500, `AE lookup failed: ${res.error.message}`);
  }
  if (!res.data) throw notFound("AE not found.");
  const row = res.data as { id: string; first_name: string; role: string };
  if (row.role !== COACHABLE_ROLE) throw notFound("AE not found.");
  return { id: row.id, first_name: row.first_name };
}

// Server-side coaching helpers.
//
// SCOPE
//   * Pulls the per-AE snapshot used in the manager 1:1 surface (current
//     week %, rank, week activity totals, business-card count, and the
//     past N weeks' percent for the trend strip).
//   * Builds the per-AE summary used on the coaching index (AE picker).
//
// Reused by:
//   * GET /api/admin/coaching            -> list of AE summaries
//   * GET /api/admin/coaching/[ae_id]    -> single AE detail snapshot
//
// SHARED MATH
//   We deliberately go through `computeStandings` so the manager view
//   uses the SAME diminishing-returns / goal-resolution logic as the AE
//   leaderboard. The snapshot percent is just the AE's row of the
//   current-week standings — there is no separate scoring branch.

/** Number of past Mon-Fri weeks (inclusive of the current week) to ship in the trend. */
export const TREND_WEEKS = 4;

/**
 * Returns Mon-Fri ranges for the last N weeks (oldest -> newest). Each
 * entry is `{ since, through, weekStart, goalAsOf }`:
 *   * since/through    — DATE strings (YYYY-MM-DD) for the activity_entries
 *                        range filter
 *   * weekStart        — DATE string of Monday (used as the trend point
 *                        label, also as goalAsOf for that week)
 */
export function recentWeekRanges(
  asOf: Date = todayInAppTimezone(),
  weeks = TREND_WEEKS,
): Array<{
  since: string;
  through: string;
  week_start: string;
  goalAsOf: string;
}> {
  const out: Array<{
    since: string;
    through: string;
    week_start: string;
    goalAsOf: string;
  }> = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const dayInWeek = addDays(asOf, -7 * i);
    const { since, through } = businessWeekToDateRange(dayInWeek);
    out.push({
      since,
      through,
      week_start: since,
      // Resolve each AE's weekly goal AS OF that week's Monday so a
      // mid-year goal change doesn't retroactively rewrite history.
      goalAsOf: since,
    });
  }
  return out;
}

/**
 * Pulls business-card-scan counts per AE for a Mon-Fri date range.
 * Returns a Map<ae_id, count> for the AEs we asked about. Counts only
 * real (non-test) scans — `is_test_data = false`. Best-effort: on
 * error returns an empty map (callers degrade to "0 cards" rather than
 * sinking the whole snapshot).
 */
export async function businessCardCountsByAe(
  supabase: SupabaseClient,
  aeIds: readonly string[],
  since: string,
  through: string,
): Promise<Map<string, number>> {
  if (aeIds.length === 0) return new Map();
  // Build half-open [Mon-00:00, NextMon-00:00) bounds in APP_TIMEZONE.
  // `since`/`through` are Denver-local DATE strings (YYYY-MM-DD); the
  // `business_card_scans.created_at` column is a timestamptz, so the
  // bound has to be the UTC instant of those Denver midnights — NOT
  // `${date}T00:00:00Z`, which would point at UTC midnight (6–7h before
  // Denver midnight) and miscount evening scans on either Friday or
  // Sunday depending on DST.
  const dayAfterThrough = format(
    addDays(new Date(`${through}T12:00:00Z`), 1),
    "yyyy-MM-dd",
  );
  const startStamp = appTimezoneMidnightUtc(since);
  const endStamp = appTimezoneMidnightUtc(dayAfterThrough);
  const res = await supabase
    .from("business_card_scans")
    .select("salesperson_id")
    .in("salesperson_id", aeIds as string[])
    .eq("is_test_data", false)
    .gte("created_at", startStamp)
    .lt("created_at", endStamp);
  if (res.error || !res.data) return new Map();
  const counts = new Map<string, number>();
  for (const row of res.data as Array<{ salesperson_id: string }>) {
    counts.set(row.salesperson_id, (counts.get(row.salesperson_id) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Snapshot — one row per AE
// ---------------------------------------------------------------------------

/**
 * Builds {ae_id -> CoachingSnapshot} for `aeIds` as of `asOf`. Does all
 * computeStandings calls and the business-card count query in parallel.
 *
 * Cost: ~`TREND_WEEKS` standings computations plus one business-card
 * count. For a team of ~11 this resolves in a few hundred ms.
 */
export async function buildSnapshots(
  supabase: SupabaseClient,
  aeIds: readonly string[],
  asOf: Date = todayInAppTimezone(),
): Promise<Map<string, CoachingSnapshot>> {
  if (aeIds.length === 0) return new Map();
  const weeks = recentWeekRanges(asOf);
  const currentWeek = weeks[weeks.length - 1];

  const [trendResults, cardCounts] = await Promise.all([
    Promise.all(
      weeks.map((w) =>
        computeStandings(supabase, w.since, w.through, w.goalAsOf),
      ),
    ),
    businessCardCountsByAe(
      supabase,
      aeIds,
      currentWeek.since,
      currentWeek.through,
    ),
  ]);

  // The most recent week's standings doubles as the "current" snapshot.
  const current = trendResults[trendResults.length - 1].standings;
  // Rank = position in the percent-desc sort, percent === null pushed last.
  const sorted = [...current]
    .sort((a, b) => {
      if (a.percent === null && b.percent === null) return 0;
      if (a.percent === null) return 1;
      if (b.percent === null) return -1;
      return b.percent - a.percent;
    });
  const totalRanked = sorted.filter((s) => s.percent !== null).length;
  const rankById = new Map<string, number>();
  let r = 0;
  for (const s of sorted) {
    r += 1;
    if (s.percent !== null) rankById.set(s.id, r);
  }

  const snapshots = new Map<string, CoachingSnapshot>();
  for (const aeId of aeIds) {
    const row = current.find((s) => s.id === aeId);
    snapshots.set(aeId, {
      percent: row?.percent ?? null,
      rank: rankById.get(aeId) ?? null,
      total_ranked: totalRanked,
      week_totals: {
        office_visits: row?.totals.office_visits ?? 0,
        service_requests: row?.totals.service_requests ?? 0,
        ones_scheduled: row?.totals.ones_scheduled ?? 0,
        ones_held: row?.totals.ones_held ?? 0,
        presentations: row?.totals.presentations ?? 0,
        impressions: row?.totals.impressions ?? 0,
        team_meetings: row?.totals.team_meetings ?? 0,
        gold_list_touches: row?.totals.gold_list_touches ?? 0,
        business_cards: cardCounts.get(aeId) ?? 0,
      },
      trend: trendResults.map((res, i) => ({
        week_start: weeks[i].week_start,
        percent: res.standings.find((s) => s.id === aeId)?.percent ?? null,
      })),
    });
  }
  return snapshots;
}

// ---------------------------------------------------------------------------
// AE list summary — for the /admin/coaching index page
// ---------------------------------------------------------------------------

/**
 * Builds the index-page summary list:
 *   * one row per non-admin, non-assistant, non-test AE
 *   * sorted by percent desc (null last), name as tiebreaker
 *   * each row carries percent, rank, latest 1:1 date, open-commitment count
 */
export async function buildAeSummaries(
  supabase: SupabaseClient,
  asOf: Date = todayInAppTimezone(),
): Promise<{ summaries: CoachingAeSummary[]; error: string | null }> {
  // Coaching surface is AE-only. Filtering on `role = 'ae'` directly
  // (rather than excluding known non-AE roles) means a future role
  // can't accidentally leak in. is_admin / is_test are kept in the
  // predicate as belt-and-suspenders against a misconfigured row.
  const peopleRes = await supabase
    .from("salespeople")
    .select("id, first_name")
    .eq("role", COACHABLE_ROLE)
    .eq("is_admin", false)
    .eq("is_test", false)
    .order("first_name", { ascending: true });
  if (peopleRes.error) return { summaries: [], error: peopleRes.error.message };
  const people = (peopleRes.data ?? []) as Array<{
    id: string;
    first_name: string;
  }>;
  if (people.length === 0) return { summaries: [], error: null };

  const aeIds = people.map((p) => p.id);

  // Anchor open/carried buckets to the CURRENT business week (Monday) —
  // NOT to the AE's latest row. Otherwise an AE the manager hasn't
  // opened in two weeks would have last-week's open items show as
  // "current open" until they tap in. We want the index to be accurate
  // before anyone opens a detail page.
  const currentWeekStart = mondayOfWeek(asOf);

  // Pull every focus row + every open commitment for these AEs. We need
  // the focus rows only to translate `one_on_one_id -> week_start` on
  // each commitment; the bucket math itself just compares week_start to
  // currentWeekStart.
  const [focusRowsRes, snapshots, openCommitmentsRes] = await Promise.all([
    supabase
      .from(WEEKLY_FOCUS_TABLE)
      .select("id, ae_id, week_start")
      .in("ae_id", aeIds),
    buildSnapshots(supabase, aeIds, asOf),
    supabase
      .from(WEEKLY_FOCUS_COMMITMENTS_TABLE)
      .select("ae_id, one_on_one_id")
      .in("ae_id", aeIds)
      .eq("status", "open"),
  ]);

  // Latest week_start per AE (for the index's "Week of …" label).
  const latestWeekByAe = new Map<string, string>();
  // Map of focus_row_id -> week_start, for bucketing commitments.
  const weekStartById = new Map<string, string>();
  if (!focusRowsRes.error && focusRowsRes.data) {
    for (const row of focusRowsRes.data as Array<{
      id: string;
      ae_id: string;
      week_start: string;
    }>) {
      weekStartById.set(row.id, row.week_start);
      const current = latestWeekByAe.get(row.ae_id);
      if (!current || row.week_start > current) {
        latestWeekByAe.set(row.ae_id, row.week_start);
      }
    }
  }

  // Open commitments: classify by whether the commitment's PARENT week
  // is the current business week. If the AE has no current-week row yet,
  // every open commitment is carryover by definition.
  const openByAe = new Map<string, number>();
  const carriedByAe = new Map<string, number>();
  if (!openCommitmentsRes.error && openCommitmentsRes.data) {
    for (const row of openCommitmentsRes.data as Array<{
      ae_id: string;
      one_on_one_id: string;
    }>) {
      const weekStart = weekStartById.get(row.one_on_one_id);
      if (weekStart === currentWeekStart) {
        openByAe.set(row.ae_id, (openByAe.get(row.ae_id) ?? 0) + 1);
      } else {
        carriedByAe.set(row.ae_id, (carriedByAe.get(row.ae_id) ?? 0) + 1);
      }
    }
  }

  const summaries: CoachingAeSummary[] = people.map((p) => {
    const snap = snapshots.get(p.id);
    return {
      id: p.id,
      first_name: p.first_name,
      percent: snap?.percent ?? null,
      rank: snap?.rank ?? null,
      latest_week_start: latestWeekByAe.get(p.id) ?? null,
      open_commitments: openByAe.get(p.id) ?? 0,
      carried_commitments: carriedByAe.get(p.id) ?? 0,
    };
  });

  summaries.sort((a, b) => {
    if (a.percent === null && b.percent === null)
      return a.first_name.localeCompare(b.first_name);
    if (a.percent === null) return 1;
    if (b.percent === null) return -1;
    return (
      b.percent - a.percent || a.first_name.localeCompare(b.first_name)
    );
  });

  return { summaries, error: null };
}
