/**
 * Orders Foundation V1 — the single source of truth for monthly/today order
 * numbers + order pace, shared by the AE Home Orders card and the Admin orders
 * screen so they never drift.
 *
 * Server-only. Wraps the Cogent orders library (src/lib/server/cogent.ts) for
 * the month-to-date window and computes ORDER PACE.
 *
 * IMPORTANT — order pace ≠ activity pace:
 *   Order pace uses business days = weekdays MINUS COMPANY HOLIDAYS ONLY
 *   (working_day_adjustments where applies_to_all = true). It deliberately does
 *   NOT subtract individual AE PTO / per-AE working-day adjustments, because
 *   orders keep coming in while an AE is out. Activity pace (unchanged, in
 *   src/lib/working-days.ts) subtracts holidays AND PTO.
 */

import {
  addDays,
  endOfMonth,
  format,
  getDay,
  parseISO,
  startOfMonth,
} from "date-fns";

import { getServerSupabase } from "@/lib/supabase/server";
import { todayInAppTimezone } from "@/lib/dates";
import {
  getOrdersSummary,
  type AeOrdersSummary,
  type UnmappedTerritory,
} from "@/lib/server/cogent";
import { fetchRangeAdjustments } from "@/lib/server/working-days";
import {
  paceVerdict,
  type PaceVerdict,
  type WorkingDayAdjustment,
} from "@/lib/working-days";

export type OrderPace = {
  /** Business days in the whole month (weekdays minus company holidays). */
  businessDaysTotal: number;
  /** Business days from month start THROUGH TODAY (inclusive) minus company
   *  holidays. Today counts because orders arrive throughout the day. A weekend
   *  or company-holiday "today" contributes 0, so elapsed stays at the last
   *  business day. */
  businessDaysElapsed: number;
  /** elapsed / total * 100, clamped 0..100, rounded to 1 decimal. */
  expectedPercent: number;
};

export type AeMonthlyOrders = AeOrdersSummary & {
  verdict: PaceVerdict;
  /** actual / expected × 100 as a whole number (100 = exactly on pace, >100
   *  ahead, <100 behind). null when not computable (no goal, no pace, or no
   *  expected progress yet). */
  pacePercent: number | null;
};

/** Company-wide rollup across all production AEs. */
export type CompanyOrders = {
  orderCount: number;
  orderTarget: number;
  percentToGoal: number | null;
  todayOrders: number | null;
  pacePercent: number | null;
};

export type MonthlyOrders = {
  startDate: string;
  endDate: string;
  monthEndDate: string;
  /** null when the company-holiday read failed — order pace is then UNAVAILABLE
   *  (counts still render). Never a silently-wrong weekdays-only pace. */
  pace: OrderPace | null;
  company: CompanyOrders;
  items: AeMonthlyOrders[];
  unmappedTerritories: UnmappedTerritory[];
};

/**
 * Pace % = goalFraction / expectedFraction × 100, as a whole number, where
 *   goalFraction     = orders / monthlyGoal
 *   expectedFraction = elapsed order business days / total order business days
 * Computed from RAW values (not the rounded display %s) so it matches the
 * formula exactly. null when there's no goal or no elapsed business day yet
 * (avoids divide-by-zero / a misleading value).
 */
function pacePercentValue(
  orderCount: number,
  orderTarget: number,
  businessDaysElapsed: number,
  businessDaysTotal: number,
): number | null {
  if (orderTarget <= 0 || businessDaysElapsed <= 0 || businessDaysTotal <= 0) {
    return null;
  }
  const goalFraction = orderCount / orderTarget;
  const expectedFraction = businessDaysElapsed / businessDaysTotal;
  return Math.round((goalFraction / expectedFraction) * 100);
}

/** The current month-to-date window, anchored to the app (Denver) timezone. */
function currentMonthWindow(now?: Date): {
  startDate: string;
  endDate: string;
  monthEndDate: string;
} {
  const todayAnchor = todayInAppTimezone(now);
  return {
    startDate: format(startOfMonth(todayAnchor), "yyyy-MM-dd"),
    endDate: format(todayAnchor, "yyyy-MM-dd"),
    monthEndDate: format(endOfMonth(todayAnchor), "yyyy-MM-dd"),
  };
}

/** Company-holiday day-off value per date — applies_to_all rows ONLY (never
 *  individual PTO). day_value is 1.0 (full) or 0.5 (half), capped at 1. */
function companyHolidayValueByDate(
  adjustments: WorkingDayAdjustment[],
): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of adjustments) {
    if (!a.applies_to_all) continue; // company holidays only
    const v = Math.min(1, Math.max(0, Number(a.day_value) || 0));
    m.set(a.adjustment_date, Math.min(1, (m.get(a.adjustment_date) ?? 0) + v));
  }
  return m;
}

/** Weekdays (Mon–Fri) in [start, end] inclusive, minus company-holiday values.
 *  Returns 0 when start > end. Bounded loop (≤ a month). */
function businessDaysBetween(
  startInclusive: string,
  endInclusive: string,
  holidayValues: Map<string, number>,
): number {
  if (startInclusive > endInclusive) return 0;
  const last = parseISO(endInclusive).getTime();
  let total = 0;
  let d = parseISO(startInclusive);
  let guard = 0;
  while (d.getTime() <= last && guard < 400) {
    const dow = getDay(d); // 0 Sun .. 6 Sat
    if (dow >= 1 && dow <= 5) {
      const ds = format(d, "yyyy-MM-dd");
      total += 1 - (holidayValues.get(ds) ?? 0);
    }
    d = addDays(d, 1);
    guard += 1;
  }
  return Math.round(total * 10) / 10;
}

/**
 * Month-to-date order totals per AE + order pace. Throws if the Cogent endpoint
 * is unavailable — callers decide how to degrade (the AE card fails gracefully;
 * the admin route surfaces a 502).
 */
export async function getMonthlyOrders(now?: Date): Promise<MonthlyOrders> {
  const { startDate, endDate, monthEndDate } = currentMonthWindow(now);

  // Order pace: company holidays only (applies_to_all). PTO is intentionally
  // ignored. If the holiday read FAILS, pace is marked UNAVAILABLE (null) — we
  // never show a silently-wrong weekdays-only pace. Order counts still render.
  const supabase = getServerSupabase();
  const { adjustments, error } = await fetchRangeAdjustments(
    supabase,
    startDate,
    monthEndDate,
  );

  let pace: OrderPace | null = null;
  if (error) {
    console.warn(
      "[orders] company-holiday read failed; order PACE marked unavailable (counts still returned)",
    );
  } else {
    const holidayValues = companyHolidayValueByDate(adjustments);
    const businessDaysTotal = businessDaysBetween(
      startDate,
      monthEndDate,
      holidayValues,
    );
    // Elapsed is THROUGH TODAY (inclusive) — orders come in during today.
    // businessDaysBetween already drops weekends + company holidays, so a
    // weekend/holiday "today" adds 0 and elapsed stays at the last business day.
    const businessDaysElapsed = businessDaysBetween(
      startDate,
      endDate,
      holidayValues,
    );
    const expectedPercent =
      businessDaysTotal > 0
        ? Math.min(
            100,
            Math.max(0, Math.round((businessDaysElapsed / businessDaysTotal) * 1000) / 10),
          )
        : 0;
    pace = { businessDaysTotal, businessDaysElapsed, expectedPercent };
  }

  // Month-to-date aggregate ONLY — the trusted source for monthly totals, goal
  // %, and pace %. Today Orders are NOT taken from here (the SalesReport6
  // same-day slice is unreliable); they are filled in by applyTodayBaselineDeltas
  // from these MTD totals. summary.items therefore carry todayOrders = null.
  const summary = await getOrdersSummary({ startDate, endDate });

  const items: AeMonthlyOrders[] = summary.items.map((it) => ({
    ...it,
    // No pace → no verdict ("none") / no pace%; UI shows a pace-unavailable msg.
    verdict: pace ? paceVerdict(it.percentToGoal, pace.expectedPercent) : "none",
    pacePercent: pace
      ? pacePercentValue(
          it.orderCount,
          it.orderTarget,
          pace.businessDaysElapsed,
          pace.businessDaysTotal,
        )
      : null,
  }));

  // Company rollup — same source/calculation as the per-AE numbers.
  const orderCount = items.reduce((s, i) => s + i.orderCount, 0);
  const orderTarget = items.reduce((s, i) => s + i.orderTarget, 0);
  const companyPercentToGoal =
    orderTarget > 0 ? Math.round((orderCount / orderTarget) * 1000) / 10 : null;
  const company: CompanyOrders = {
    orderCount,
    orderTarget,
    percentToGoal: companyPercentToGoal,
    // Today is null here; applyTodayBaselineDeltas fills it from the baseline.
    todayOrders: null,
    pacePercent: pace
      ? pacePercentValue(
          orderCount,
          orderTarget,
          pace.businessDaysElapsed,
          pace.businessDaysTotal,
        )
      : null,
  };

  return {
    startDate,
    endDate,
    monthEndDate,
    pace,
    company,
    items,
    unmappedTerritories: summary.unmappedTerritories,
  };
}

// ---------------------------------------------------------------------------
// Today Orders — daily baseline delta (Orders V1)
// ---------------------------------------------------------------------------
// WHY a baseline delta instead of a same-day query:
//   The SalesReport6 month-to-date aggregate is TRUSTED, but its same-day slice
//   is NOT — a [2026-06-04, 2026-06-04] request returned rows bucketed under
//   2026-06-02. The report groups into period buckets, not order events, so the
//   same-day window can't power operational Today Orders.
//
// THE APPROACH:
//   Snapshot the MTD total at the FIRST sync of each America/Denver day (the
//   "baseline"), then report
//       Today Orders = current MTD total − start-of-day MTD baseline   (≥ 0)
//   per AE and for the company. On the day's first sync baseline == current, so
//   Today = 0; it grows as orders land. A new MT calendar date creates a fresh
//   baseline row, so Today resets to 0 at the first sync of the new day.
//
// LIMITATION (documented intentionally): the baseline is captured at the first
// sync inside the cron's active window (~7:00 AM MT), not at literal midnight,
// so orders booked before the first sync of the day are absorbed into the
// baseline rather than counted as "today". This is acceptable for V1; a future
// true order-event / order-detail feed can replace it with exact Today counts.

const BASELINE_TABLE = "order_today_baseline";

type TodayBaseline = {
  baselineDate: string;
  companyTotal: number;
  /** salespersonId -> MTD order total captured at the baseline. */
  aeTotals: Record<string, number>;
};

/**
 * Loads the baseline for `baselineDate`, creating it from the current MTD totals
 * if absent. Race-safe: the create is an INSERT … ON CONFLICT DO NOTHING
 * (ignoreDuplicates), so the FIRST sync of the day fixes the start-of-day total
 * and later/overlapping syncs never overwrite it; we then always re-read the
 * authoritative row. Returns null when the baseline store is unavailable (Today
 * then renders as "—" while monthly totals / goal / pace still show).
 */
async function loadOrCreateTodayBaseline(
  baselineDate: string,
  companyTotal: number,
  aeTotals: Record<string, number>,
): Promise<TodayBaseline | null> {
  const supabase = getServerSupabase();

  const created = await supabase.from(BASELINE_TABLE).upsert(
    {
      baseline_date: baselineDate,
      company_total: companyTotal,
      ae_totals: aeTotals,
    },
    { onConflict: "baseline_date", ignoreDuplicates: true },
  );
  if (created.error) {
    // Non-fatal: the row may already exist from an earlier sync. Fall through to
    // the authoritative read below.
    console.warn(
      `[orders-baseline] create skipped/failed date=${baselineDate} code=${created.error.code ?? "?"} msg=${created.error.message}`,
    );
  }

  const read = await supabase
    .from(BASELINE_TABLE)
    .select("baseline_date, company_total, ae_totals")
    .eq("baseline_date", baselineDate)
    .maybeSingle();
  if (read.error || !read.data) {
    console.warn(
      `[orders-baseline] read failed date=${baselineDate} code=${read.error?.code ?? "?"} msg=${read.error?.message ?? "no row"}`,
    );
    return null;
  }

  const row = read.data as {
    baseline_date: string;
    company_total: number | string | null;
    ae_totals: unknown;
  };
  const aeTotalsRaw =
    row.ae_totals && typeof row.ae_totals === "object"
      ? (row.ae_totals as Record<string, unknown>)
      : {};
  const parsedAeTotals: Record<string, number> = {};
  for (const [id, v] of Object.entries(aeTotalsRaw)) {
    const n = typeof v === "string" ? Number(v) : v;
    parsedAeTotals[id] = typeof n === "number" && Number.isFinite(n) ? n : 0;
  }
  return {
    baselineDate: row.baseline_date,
    companyTotal: Number(row.company_total) || 0,
    aeTotals: parsedAeTotals,
  };
}

/**
 * Fills Today Orders on a freshly-computed MTD rollup using the daily baseline
 * delta (see the section header above). Pure with respect to `monthly` — it
 * returns a new object and never mutates the input. Today is left null (the
 * "unavailable" state) only when the baseline store can't be reached.
 *
 * baseline_date is `monthly.endDate`, which currentMonthWindow already anchored
 * to America/Denver — so the day boundary and rollover are Mountain Time.
 */
async function applyTodayBaselineDeltas(
  monthly: MonthlyOrders,
): Promise<MonthlyOrders> {
  const baselineDate = monthly.endDate; // Denver "today"
  const companyTotal = monthly.company.orderCount;
  const aeTotals: Record<string, number> = {};
  for (const it of monthly.items) aeTotals[it.salespersonId] = it.orderCount;

  const baseline = await loadOrCreateTodayBaseline(
    baselineDate,
    companyTotal,
    aeTotals,
  );
  if (!baseline) return monthly; // todayOrders stays null → UI shows "—"

  // Per-AE: current MTD − that AE's start-of-day baseline. An AE missing from
  // the baseline (appeared later in the day) gets baseline 0, so their delta is
  // their full today count. Clamp ≥ 0 because an MTD correction/void can move a
  // total down.
  const items = monthly.items.map((it) => ({
    ...it,
    todayOrders: Math.max(0, it.orderCount - (baseline.aeTotals[it.salespersonId] ?? 0)),
  }));

  // Company Today = SUM of the clamped per-AE deltas, so the company number is
  // always exactly the sum of the AE numbers the UI shows. company.orderCount
  // is by construction the sum of mapped-AE orderCounts (unmapped territories
  // are tracked separately and never enter company.orderCount), so this equals
  // (companyTotal − baseline.companyTotal) EXCEPT when an individual AE's MTD
  // decreased — then a single company-level clamp would read lower than the sum
  // of AE deltas. We intentionally prefer the summed-clamped value for AE/Admin
  // consistency; baseline.companyTotal is retained in storage for auditing.
  const companyTodayOrders = items.reduce(
    (s, i) => s + (i.todayOrders ?? 0),
    0,
  );

  return {
    ...monthly,
    items,
    company: { ...monthly.company, todayOrders: companyTodayOrders },
  };
}

// ---------------------------------------------------------------------------
// Cache (Orders Sync Cron V1)
// ---------------------------------------------------------------------------
// The cron + manual refresh WRITE the singleton `order_snapshot`; the AE/admin
// read routes READ it instead of hitting Cogent live on each page load.

const SNAPSHOT_TABLE = "order_snapshot";

export type OrdersSnapshot = {
  data: MonthlyOrders;
  /** Last SUCCESSFUL refresh (ISO). */
  refreshedAt: string;
};

/**
 * Computes the latest orders rollup from Cogent and upserts it into the
 * singleton cache. The single place that logs the sync lifecycle (start /
 * success / failure / duration), so the cron and manual-refresh paths log
 * identically. Throws on upstream/storage failure (callers translate to HTTP /
 * cron status); the cache (and its refreshed_at) is only updated on SUCCESS.
 */
export async function syncOrders(
  now?: Date,
): Promise<OrdersSnapshot & { durationMs: number; wrote: boolean }> {
  const startedAtMs = Date.now();
  const startedAtIso = new Date().toISOString();
  console.log("[orders-sync] start");
  try {
    // Trusted MTD rollup, then fill Today Orders from the daily baseline delta.
    // Both write paths (cron + manual refresh) go through here, so the baseline
    // is created/advanced consistently regardless of trigger.
    const monthly = await getMonthlyOrders(now);
    const data = await applyTodayBaselineDeltas(monthly);
    const durationMs = Date.now() - startedAtMs;
    const refreshedAt = new Date().toISOString();

    // Overwrite-safe upsert: the RPC refuses to overwrite a snapshot from a run
    // that STARTED later than this one, so an overlapping older sync can't
    // clobber a newer successful snapshot.
    const supabase = getServerSupabase();
    const res = await supabase.rpc("upsert_order_snapshot", {
      p_payload: data,
      p_started_at: startedAtIso,
      p_refreshed_at: refreshedAt,
      p_duration_ms: durationMs,
    });
    if (res.error) {
      console.error(
        `[orders-sync] failure (storage) durationMs=${durationMs} code=${res.error.code ?? "?"} msg=${res.error.message}`,
      );
      throw new Error("Could not store the orders snapshot.");
    }

    const wrote = res.data === true;
    console.log(
      `[orders-sync] success aes=${data.items.length} ` +
        `unmapped=${data.unmappedTerritories.length} ` +
        `paceAvailable=${data.pace !== null} wrote=${wrote} ` +
        `durationMs=${durationMs}` +
        (wrote ? "" : " (skipped: a newer sync already wrote)"),
    );
    return { data, refreshedAt, durationMs, wrote };
  } catch (err) {
    const durationMs = Date.now() - startedAtMs;
    console.error(
      `[orders-sync] failure durationMs=${durationMs} err=${String(err)}`,
    );
    throw err;
  }
}

/**
 * Reads the cached orders snapshot, or null when none exists / read fails.
 * THIS IS THE ONLY READ PATH used by page loads — it never calls Cogent. The
 * cache is populated/refreshed exclusively by syncOrders (cron + manual
 * refresh).
 */
export async function readOrdersSnapshot(): Promise<OrdersSnapshot | null> {
  const supabase = getServerSupabase();
  const res = await supabase
    .from(SNAPSHOT_TABLE)
    .select("payload, refreshed_at")
    .eq("id", true)
    .maybeSingle();
  if (res.error) {
    console.warn(
      `[orders-sync] snapshot read failed code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    return null;
  }
  if (!res.data) return null;
  const row = res.data as { payload: MonthlyOrders; refreshed_at: string };
  return { data: row.payload, refreshedAt: row.refreshed_at };
}
