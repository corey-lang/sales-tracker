// Road to 10,000 — server side: the total SOURCE, the holiday set, the view the
// card and page render, and the one write.
//
// Layers (see lib/road-to-10000.ts): source -> math -> UI. This file holds the
// only source V1 has, `manualTotalSource` (a hand-entered cumulative total in
// `road_to_10000_totals`). A Cogent Closed Transactions source later is another
// RoadTotalSource handed to buildRoadView(); the math and the UI do not change.
//
// ACCESS
//   READ   any signed-in AE-tool user (AEs, admins, the assistant); juice_box_only
//          guests are refused. AEs get a view-only payload (`can_update: false`).
//   UPDATE admin or assistant only (Corey, Ryan, Tonja) — checked here AND again
//          inside the database function.

import type { SupabaseClient } from "@supabase/supabase-js";

import { appDateOf } from "@/lib/one-on-one-meetings";
import { companyHolidayValues } from "@/lib/company-calendar";
import {
  ROAD_TO_10000_GOAL,
  computeRoadMetrics,
  type RoadGoal,
  type RoadTotalSource,
  type RoadView,
  type TotalReading,
  type TotalSourceId,
} from "@/lib/road-to-10000";
import { ApiError, forbidden, requireAeToolAccess, type AuthedSalesperson } from "@/lib/server/auth";
import { selectAllPages } from "@/lib/server/paginate";
import { fetchRangeAdjustments } from "@/lib/server/working-days";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

export const ROAD_TOTALS_TABLE = "road_to_10000_totals" as const;
const COLUMNS =
  "id, seq, goal_year, total, source, is_correction, note, entered_by_name, entered_at";

type Row = {
  id: string;
  total: number;
  source: TotalSourceId;
  is_correction: boolean;
  note: string | null;
  entered_by_name: string | null;
  entered_at: string;
};

const toReading = (r: Row): TotalReading => ({
  id: r.id,
  total: r.total,
  recordedAt: r.entered_at,
  recordedOn: appDateOf(r.entered_at),
  source: r.source,
  isCorrection: r.is_correction,
  note: r.note,
  enteredByName: r.entered_by_name,
});

/** Postgres "relation does not exist" — the migration hasn't been applied. */
export function isMissingTable(error: { code?: string | null; message?: string } | null): boolean {
  return error?.code === "42P01" || /relation .* does not exist|schema cache/i.test(error?.message ?? "");
}

/** The V1 source: the newest hand-entered cumulative total. */
export function manualTotalSource(supabase: Db, goalYear: number = ROAD_TO_10000_GOAL.year): RoadTotalSource {
  return {
    id: "manual",
    async latest() {
      const res = await supabase
        .from(ROAD_TOTALS_TABLE)
        .select(COLUMNS)
        .eq("goal_year", goalYear)
        .order("seq", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (res.error) throw res.error;
      return res.data ? toReading(res.data as Row) : null;
    },
    async history() {
      const res = await selectAllPages<Row>(() =>
        supabase
          .from(ROAD_TOTALS_TABLE)
          .select(COLUMNS)
          .eq("goal_year", goalYear)
          .order("seq", { ascending: false }),
      );
      if (res.error) throw res.error;
      return res.data.map(toReading);
    },
  };
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export const canUpdateRoadTotal = (me: { role: string }) => me.role === "admin" || me.role === "assistant";

/** Whole calendar days from `earlier` to `later` (yyyy-MM-dd). */
export function calendarDaysBetween(earlier: string, later: string): number {
  return Math.round((Date.parse(`${later}T12:00:00Z`) - Date.parse(`${earlier}T12:00:00Z`)) / 86_400_000);
}

export async function buildRoadView(
  supabase: Db,
  source: RoadTotalSource,
  opts: { canUpdate: boolean; today: string; goal?: RoadGoal },
): Promise<RoadView> {
  const goal = opts.goal ?? ROAD_TO_10000_GOAL;
  const base: RoadView = {
    configured: true,
    goal,
    source: source.id,
    latest: null,
    metrics: null,
    daysSinceUpdate: null,
    history: [],
    holidays: [],
    extraHolidaysUnavailable: false,
    can_update: opts.canUpdate,
  };

  let history: TotalReading[];
  try {
    history = await source.history();
  } catch (err) {
    if (isMissingTable(err as { code?: string; message?: string })) return { ...base, configured: false };
    throw err;
  }
  const latest = history[0] ?? null;

  // Company holidays = the standard calendar UNION the admin-entered company-wide
  // days (the existing working_day_adjustments). If the admin rows can't be read
  // the standard calendar still applies; the page says the list may be incomplete.
  const adj = await fetchRangeAdjustments(supabase, goal.startDate, goal.endDate, []);
  const { values, holidays } = companyHolidayValues(goal.startDate, goal.endDate, adj.adjustments);

  return {
    ...base,
    latest,
    history,
    holidays,
    extraHolidaysUnavailable: adj.error !== null,
    metrics: latest
      ? computeRoadMetrics({
          total: latest.total,
          recordedOn: latest.recordedOn, // historical pace + reporting lag
          today: opts.today, // the real time left to the deadline
          holidayValues: values,
          goal,
        })
      : null,
    daysSinceUpdate: latest ? Math.max(0, calendarDaysBetween(latest.recordedOn, opts.today)) : null,
  };
}

// ---------------------------------------------------------------------------
// Access + the write
// ---------------------------------------------------------------------------

/** Any signed-in AE-tool user may READ the goal. */
export async function requireRoadReader(req: Request): Promise<AuthedSalesperson> {
  return requireAeToolAccess(req);
}

/** Admin or assistant may UPDATE the total. */
export async function requireRoadUpdater(req: Request): Promise<AuthedSalesperson> {
  const me = await requireAeToolAccess(req);
  if (!canUpdateRoadTotal(me)) throw forbidden("Only an admin or the assistant can update the Road to 10,000 total.");
  return me;
}

/** The editor was looking at an older total. */
export class RoadStaleError extends Error {
  constructor() {
    super("The total was just updated by someone else. Review the latest and try again.");
    this.name = "RoadStaleError";
  }
}
/** Lower than the current total, and not marked as a correction. */
export class RoadLowerThanCurrentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoadLowerThanCurrentError";
  }
}

export async function recordTotal(
  supabase: Db,
  me: { id: string },
  input: { total: number; isCorrection: boolean; note: string | null; expectedLatestId: string | null },
): Promise<TotalReading> {
  const res = await supabase.rpc("record_road_to_10000_total", {
    p_actor: me.id,
    p_total: input.total,
    p_is_correction: input.isCorrection,
    p_note: input.note,
    p_expected_latest_id: input.expectedLatestId,
    p_goal_year: ROAD_TO_10000_GOAL.year,
  });
  if (res.error) {
    const e = res.error as { code?: string | null; message: string };
    if (isMissingTable(e) || e.code === "42883") {
      throw new ApiError(503, "Road to 10,000 isn't set up yet — the database update hasn't been applied.");
    }
    switch (e.code) {
      case "42501":
        throw forbidden("Only an admin or the assistant can update the Road to 10,000 total.");
      case "40001":
        throw new RoadStaleError();
      case "23514":
        if (/lower than the current total/i.test(e.message)) throw new RoadLowerThanCurrentError(e.message);
        throw new ApiError(400, "That total isn't allowed.");
      case "22023":
      case "22004":
        throw new ApiError(400, e.message); // authored messages from the function
      default:
        console.warn(`[road-to-10000] write failed code=${e.code ?? "?"} msg=${e.message}`);
        throw new ApiError(500, "Could not save the total. Please try again.");
    }
  }
  const row = res.data as Row | null;
  if (!row) throw new ApiError(500, "Could not save the total.");
  return toReading(row);
}
