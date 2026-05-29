import { addDays, format } from "date-fns";
import type { SupabaseClient } from "@supabase/supabase-js";

import { appTimezoneMidnightUtc } from "@/lib/dates";
import { computeStandings } from "@/lib/server/leaderboard-standings";

// Admin AE Scorecard aggregation — one row per AE for a Mon-Fri week.
//
// Reuses computeStandings for score % + manual visit count (which already
// resolves the AE list, applies the goal-as-of, and runs the diminishing-
// returns scoring). Everything else is one grouped query per source table,
// merged in JS — no per-AE loops.
//
// `last_active_at` deliberately ignores the week filter: it answers
// "when did this AE last touch the app at all", which is a coaching
// signal independent of the selected week's totals.

/** Bucket the week's KPIs alongside name + score %. */
export type ScorecardRow = {
  id: string;
  first_name: string;
  /** Weekly goal score % — same math as the leaderboard. null when no goal. */
  percent: number | null;
  /** activity_entries.office_visits for the week (rep-reported daily count). */
  manual_visits: number;
  /** Count of office_visits rows for the week (production environment only). */
  crm_visits: number;
  /** business_card_scans in the week (excludes is_test_data=true). */
  cards_scanned: number;
  /** business_card_contacts whose approved_at fell in the week, attributed
   *  to the AE who SCANNED the card (contacts.salesperson_id) — NOT the
   *  admin/assistant who clicked approve (approved_by is a display-name
   *  TEXT field, not a UUID). The scorecard is measuring AE activity, so
   *  the scanner is the right attribution anyway. */
  cards_approved: number;
  /** ae_tasks created during the week. */
  todos_created: number;
  /** ae_tasks marked done with completed_at in the week. */
  todos_completed: number;
  /** Production offices created during the week. */
  offices_added: number;
  /** Most recent activity timestamp across activity entries / visits /
   *  to-do completions / card scans. ISO string, or null if never active. */
  last_active_at: string | null;
};

const PRODUCTION_ENV = "production" as const;

// The offices feature was rolled out to production AEs (commit b6f0af5);
// the scorecard reports on production data only so sandbox imports / test
// visits don't pollute the manager view.

/**
 * Builds the per-AE scorecard rows for the Mon-Fri window [`since`, `through`],
 * scoring goals as of `goalAsOf`. Requires a service-role client (admin
 * route gates the call).
 */
export async function buildScorecard(
  supabase: SupabaseClient,
  since: string,
  through: string,
  goalAsOf: string,
): Promise<{ rows: ScorecardRow[]; error: string | null }> {
  // Standings gives us the AE roster + score % + manual visit totals in
  // one shot (it already filters to role='ae', is_test=false).
  const standings = await computeStandings(supabase, since, through, goalAsOf);
  if (standings.error) {
    return { rows: [], error: standings.error };
  }
  if (standings.standings.length === 0) {
    return { rows: [], error: null };
  }

  const aeIds = standings.standings.map((s) => s.id);

  // Half-open [Mon 00:00 Denver, NextMon 00:00 Denver) bounds for the
  // timestamptz columns — same pattern as businessCardCountsByAe so the
  // window matches the leaderboard's Mon-Fri DATE range across DST.
  const dayAfterThrough = format(
    addDays(new Date(`${through}T12:00:00Z`), 1),
    "yyyy-MM-dd",
  );
  const startStamp = appTimezoneMidnightUtc(since);
  const endStamp = appTimezoneMidnightUtc(dayAfterThrough);

  const [
    crmVisits,
    cardsScanned,
    cardsApproved,
    todosCreated,
    todosCompleted,
    officesAdded,
    lastActive,
  ] = await Promise.all([
    countTimestampedByAe(
      supabase,
      "office_visits",
      "visited_at",
      aeIds,
      startStamp,
      endStamp,
      { environment: PRODUCTION_ENV },
    ),
    countTimestampedByAe(
      supabase,
      "business_card_scans",
      "created_at",
      aeIds,
      startStamp,
      endStamp,
      { is_test_data: false },
    ),
    countTimestampedByAe(
      supabase,
      "business_card_contacts",
      "approved_at",
      aeIds,
      startStamp,
      endStamp,
    ),
    countTimestampedByAe(
      supabase,
      "ae_tasks",
      "created_at",
      aeIds,
      startStamp,
      endStamp,
    ),
    countTimestampedByAe(
      supabase,
      "ae_tasks",
      "completed_at",
      aeIds,
      startStamp,
      endStamp,
      { status: "done" },
    ),
    countTimestampedByAe(
      supabase,
      "offices",
      "created_at",
      aeIds,
      startStamp,
      endStamp,
      { environment: PRODUCTION_ENV },
    ),
    lastActiveByAe(supabase, aeIds),
  ]);

  const rows: ScorecardRow[] = standings.standings.map((s) => ({
    id: s.id,
    first_name: s.first_name,
    percent: s.percent,
    manual_visits: s.totals.office_visits,
    crm_visits: crmVisits.get(s.id) ?? 0,
    cards_scanned: cardsScanned.get(s.id) ?? 0,
    cards_approved: cardsApproved.get(s.id) ?? 0,
    todos_created: todosCreated.get(s.id) ?? 0,
    todos_completed: todosCompleted.get(s.id) ?? 0,
    offices_added: officesAdded.get(s.id) ?? 0,
    last_active_at: lastActive.get(s.id) ?? null,
  }));

  return { rows, error: null };
}

/**
 * Counts rows in `table` whose `timestampColumn` lies in
 * [`startStamp`, `endStamp`), grouped by `salesperson_id`. Returns a Map
 * keyed on AE id. Best-effort: on error returns an empty map so the
 * column shows 0 rather than failing the whole scorecard.
 *
 * Pulls only the `salesperson_id` column (timestamps stay in the WHERE
 * clause) so the wire payload is one ID per matching row — small for an
 * 11-AE team over a 5-day window.
 */
async function countTimestampedByAe(
  supabase: SupabaseClient,
  table: string,
  timestampColumn: string,
  aeIds: readonly string[],
  startStamp: string,
  endStamp: string,
  eqFilters: Record<string, string | boolean> = {},
): Promise<Map<string, number>> {
  if (aeIds.length === 0) return new Map();
  let query = supabase
    .from(table)
    .select("salesperson_id")
    .in("salesperson_id", aeIds as string[])
    .gte(timestampColumn, startStamp)
    .lt(timestampColumn, endStamp);
  for (const [k, v] of Object.entries(eqFilters)) {
    query = query.eq(k, v);
  }
  const res = await query;
  if (res.error || !res.data) return new Map();
  const counts = new Map<string, number>();
  for (const row of res.data as Array<{ salesperson_id: string }>) {
    counts.set(row.salesperson_id, (counts.get(row.salesperson_id) ?? 0) + 1);
  }
  return counts;
}

// Per-AE rows pulled from each source table to derive "last active".
// Capped at 500 rows per table — at 11 AEs that's ~45 rows per AE, more
// than enough to include each AE's most recent row in any realistic
// activity profile. If the team grows or activity spikes, switch this
// to a SQL function returning MAX(...) GROUP BY salesperson_id.
const LAST_ACTIVE_ROW_CAP = 500;

/**
 * Most recent activity timestamp per AE across activity entries, office
 * visits, completed to-dos, and (non-test) business-card scans. Returns
 * Map<ae_id, ISO timestamp>; AEs with no activity at all are absent.
 *
 * NOTE: `activity_entries.updated_at` has DEFAULT NOW() but no UPDATE
 * trigger (see CLAUDE.md), so it reflects when an entry was first written,
 * not when it was last edited. Still the best activity-entries signal we
 * have without a schema change.
 */
async function lastActiveByAe(
  supabase: SupabaseClient,
  aeIds: readonly string[],
): Promise<Map<string, string>> {
  if (aeIds.length === 0) return new Map();
  const [entriesRes, visitsRes, todosRes, scansRes] = await Promise.all([
    supabase
      .from("activity_entries")
      .select("salesperson_id, updated_at")
      .in("salesperson_id", aeIds as string[])
      .order("updated_at", { ascending: false })
      .limit(LAST_ACTIVE_ROW_CAP),
    supabase
      .from("office_visits")
      .select("salesperson_id, visited_at")
      .in("salesperson_id", aeIds as string[])
      .order("visited_at", { ascending: false })
      .limit(LAST_ACTIVE_ROW_CAP),
    supabase
      .from("ae_tasks")
      .select("salesperson_id, completed_at")
      .in("salesperson_id", aeIds as string[])
      .eq("status", "done")
      .not("completed_at", "is", null)
      .order("completed_at", { ascending: false })
      .limit(LAST_ACTIVE_ROW_CAP),
    supabase
      .from("business_card_scans")
      .select("salesperson_id, created_at")
      .in("salesperson_id", aeIds as string[])
      .eq("is_test_data", false)
      .order("created_at", { ascending: false })
      .limit(LAST_ACTIVE_ROW_CAP),
  ]);

  const latest = new Map<string, string>();
  const consider = (
    rows: ReadonlyArray<Record<string, unknown>> | null,
    timestampKey: string,
  ) => {
    if (!rows) return;
    for (const row of rows) {
      const id = row.salesperson_id as string | undefined;
      const ts = row[timestampKey] as string | null | undefined;
      if (!id || !ts) continue;
      const cur = latest.get(id);
      if (!cur || ts > cur) latest.set(id, ts);
    }
  };

  if (!entriesRes.error) consider(entriesRes.data ?? null, "updated_at");
  if (!visitsRes.error) consider(visitsRes.data ?? null, "visited_at");
  if (!todosRes.error) consider(todosRes.data ?? null, "completed_at");
  if (!scansRes.error) consider(scansRes.data ?? null, "created_at");

  return latest;
}
