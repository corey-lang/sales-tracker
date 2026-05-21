import { addDays, format } from "date-fns";
import type { SupabaseClient } from "@supabase/supabase-js";

import { businessWeekToDateRange } from "@/lib/goals";
import { ApiError, notFound } from "@/lib/server/auth";
import { computeStandings } from "@/lib/server/leaderboard-standings";
import type {
  CoachingAeSummary,
  CoachingSnapshot,
} from "@/lib/one-on-ones";
import {
  ONE_ON_ONES_TABLE,
  ONE_ON_ONE_COMMITMENTS_TABLE,
} from "@/lib/one-on-ones";

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
  asOf = new Date(),
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
  // Use Mon 00:00:00 ... Fri 23:59:59 in the server's tz. created_at is
  // a timestamptz so the bound needs to be a timestamp, not a DATE — we
  // pass the start of Monday and the start of the day AFTER Friday.
  const startStamp = `${since}T00:00:00Z`;
  const endStamp = `${format(addDays(new Date(through), 1), "yyyy-MM-dd")}T00:00:00Z`;
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
  asOf = new Date(),
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
  asOf = new Date(),
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

  // Latest meeting per AE — drives both the "Last 1:1" date AND the scope
  // for the open-commitments count below. We deliberately do NOT count
  // historical open commitments across every past 1:1 — that inflates the
  // manager's worklist and breaks trust in the index. The count should
  // reflect only what's still open from the current cycle.
  const [latestMeetingsRes, snapshots] = await Promise.all([
    supabase
      .from(ONE_ON_ONES_TABLE)
      .select("id, ae_id, meeting_date, created_at")
      .in("ae_id", aeIds)
      // Tiebreak on created_at so two 1:1s on the same date resolve
      // deterministically (most-recently-created wins).
      .order("meeting_date", { ascending: false })
      .order("created_at", { ascending: false }),
    buildSnapshots(supabase, aeIds, asOf),
  ]);

  const latestByAe = new Map<string, { id: string; meeting_date: string }>();
  if (!latestMeetingsRes.error && latestMeetingsRes.data) {
    for (const row of latestMeetingsRes.data as Array<{
      id: string;
      ae_id: string;
      meeting_date: string;
    }>) {
      // First occurrence wins because we ordered DESC.
      if (!latestByAe.has(row.ae_id)) {
        latestByAe.set(row.ae_id, { id: row.id, meeting_date: row.meeting_date });
      }
    }
  }

  // Second pass: open commitments scoped to each AE's latest 1:1 only.
  const latestIds = Array.from(latestByAe.values()).map((m) => m.id);
  const openByAe = new Map<string, number>();
  if (latestIds.length > 0) {
    const openRes = await supabase
      .from(ONE_ON_ONE_COMMITMENTS_TABLE)
      .select("ae_id, one_on_one_id")
      .in("one_on_one_id", latestIds)
      .eq("completed", false);
    if (!openRes.error && openRes.data) {
      for (const row of openRes.data as Array<{ ae_id: string }>) {
        openByAe.set(row.ae_id, (openByAe.get(row.ae_id) ?? 0) + 1);
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
      latest_meeting_date: latestByAe.get(p.id)?.meeting_date ?? null,
      open_commitments: openByAe.get(p.id) ?? 0,
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
