/**
 * Server-side Cogent Orders integration — fetch + aggregate by AE.
 *
 * Server-only. Never import from a "use client" component: this module reads
 * COGENT_API_KEY and the service-role Supabase client, neither of which may
 * reach the browser.
 *
 * ENDPOINT SEMANTICS (SalesReport6 / `/orders-report`) — read this first.
 *   This is an AGGREGATE REPORTING endpoint, not an order-event feed:
 *     • It returns GROUPED rows (by territory / plan), each carrying a
 *       `policyCount` total — NOT individual order or policy records.
 *     • It exposes NO order identifiers and NO per-order timestamps. There is
 *       therefore no way to reason about when, in clock time, an individual
 *       order landed, nor to dedupe at the order level.
 *
 *   TRUSTED: month-to-date aggregate totals. The MTD `policyCount` sums match
 *   the production monthly numbers we trust, so this module powers "Orders this
 *   month", Goal %, Pace %, and the admin totals directly from them.
 *
 *   NOT TRUSTED: the same-day slice. A same-day request is unreliable — a
 *   2026-06-04 [today, today] query was observed returning rows bucketed under
 *   2026-06-02. Because the report groups into period buckets (not order
 *   events), its same-day window cannot power operational "Today Orders". This
 *   module therefore NO LONGER computes Today here; `todayOrders` is left null
 *   and filled by a daily BASELINE DELTA in src/lib/server/orders.ts
 *   (current MTD total − start-of-day MTD baseline). A future true order-event /
 *   order-detail feed can replace that baseline approach later.
 *
 * WHAT THIS DOES
 *   1. POSTs to Cogent's /orders-report with the AE *production* coverage
 *      filter (see COGENT_PRODUCTION_FILTER below).
 *   2. Parses the returned aggregate rows defensively (camel/Pascal casing).
 *   3. Aggregates rows by `salesTerritoryName`, then rolls territories up to
 *      an AE using the cogent_territory_mappings table.
 *
 * BUSINESS RULE (AE production orders / targets)
 *   INCLUDE  Buyers Coverage (RealEstate), Real Estate Runoff, Property
 *            Management Coverage.
 *   EXCLUDE  Homeowner Coverage, Renewal Coverage, Sellers Coverage.
 *   The include/exclude split is enforced at the SOURCE via the request flags
 *   below — Cogent only returns the included coverage types, so every row we
 *   receive already counts toward AE production.
 */

import { addDays, format, parseISO } from "date-fns";

import { getServerSupabase } from "@/lib/supabase/server";

// Production Elevate integration endpoint. The earlier `test-app.elevateh.com`
// host served delayed/test data (today's orders showed as 0); production
// surfaces real same-day orders. Overridable via env so the host can change
// without a code edit, defaulting to production.
export const COGENT_ORDERS_REPORT_URL =
  process.env.COGENT_ORDERS_REPORT_URL?.trim() ||
  "https://app.elevateh.com/api/integration/orders-report";

/** Application-level timeout for each Cogent orders-report request. */
const COGENT_FETCH_TIMEOUT_MS = 25_000;

/**
 * The SalesReport6 coverage filter that defines the Orders dashboard's
 * operational notion of "new orders". Cogent applies these flags server-side,
 * so the aggregate `policyCount` rows we get back only contain the coverage
 * types below — every row already counts toward the operational metric.
 *
 * This dashboard INTENTIONALLY represents operational production activity:
 *   INCLUDE  • Buyers Coverage          (showBuyersCoverage)
 *            • Real Estate Runoff        (showRealEstateRunOff)
 *            • Property Management        (showPropertyManagementCoverage)
 * and INTENTIONALLY EXCLUDES coverage the sales team does not treat as a new
 * order:
 *   EXCLUDE  • Renewals                  (showRenewalCoverage: false)
 *            • Homeowners                 (showHomeownerCoverage: false)
 *            • Sellers                    (showSellersCoverage: false)
 *
 * Renewals in particular were the source of an earlier over-count — they are a
 * book-of-business event, not new production, so they must stay excluded.
 * showPaidOnly stays false so we count orders as written, not just paid.
 *
 * SINGLE SOURCE OF TRUTH: this object is the only place the filter is defined.
 * It is spread into every SalesReport6 request body (fetchOrdersReport, used by
 * BOTH the monthly window and the today window) and the /api/cogent/test probe,
 * so the operational definition can never drift between Monthly and Today.
 */
export const COGENT_PRODUCTION_FILTER = {
  showBuyersCoverage: true,
  showSellersCoverage: false,
  showHomeownerCoverage: false,
  // Renewals are NOT new orders — excluding them is the operational definition,
  // not an oversight. Flipping this to true double-counts book-of-business.
  showRenewalCoverage: false,
  showPaidOnly: false,
  showRealEstateRunOff: true,
  showPropertyManagementCoverage: true,
} as const;

// ---------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------

/** One Cogent order row, after defensive normalization. */
export type CogentOrderRow = {
  salesTerritoryName: string;
  /** Orders on this row. */
  policyCount: number;
  /** Territory target as reported on this row. Repeats across a territory's
   *  plan rows — DO NOT sum across rows; see aggregation notes. */
  salesTarget: number;
};

/** Reads `obj[key]` case-insensitively, trying the documented camelCase key
 *  first then a few casing variants. SalesReport6 returns camelCase, but we
 *  tolerate PascalCase too so a casing change upstream can't silently zero a
 *  field. */
function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in obj) return obj[key];
    const lower = key.charAt(0).toLowerCase() + key.slice(1);
    if (lower in obj) return obj[lower];
    const upper = key.charAt(0).toUpperCase() + key.slice(1);
    if (upper in obj) return obj[upper];
  }
  return undefined;
}

/** Coerces an unknown into a finite, non-negative number; 0 otherwise. */
function toCount(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return 0;
  return n;
}

/** Trims an unknown string field; null when missing/empty/non-string. */
function toName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Locates the array of order rows inside an unknown payload. Cogent may
 *  return a bare array or wrap it under a key — we probe the common cases. */
function extractRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    for (const key of ["orders", "data", "results", "items", "records", "rows"]) {
      const value = (payload as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

/** Normalizes a raw payload into typed rows, dropping any row without a
 *  territory name (it can't be aggregated or attributed to an AE). */
export function parseCogentRows(payload: unknown): CogentOrderRow[] {
  const rows: CogentOrderRow[] = [];
  for (const raw of extractRows(payload)) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    const territory = toName(pick(obj, "salesTerritoryName", "territory"));
    if (!territory) continue;
    rows.push({
      salesTerritoryName: territory,
      policyCount: toCount(pick(obj, "policyCount", "orderCount", "count")),
      salesTarget: toCount(pick(obj, "salesTarget", "target")),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Territory-level aggregation
// ---------------------------------------------------------------------------

/** Per-territory totals after collapsing a territory's plan rows. */
export type TerritoryTotals = {
  salesTerritoryName: string;
  orderCount: number;
  orderTarget: number;
};

/**
 * Aggregates raw rows into one entry per territory.
 *
 * AGGREGATION RULES
 *   orderCount  = SUM(policyCount) across the territory's rows.
 *   orderTarget = MAX(nonzero salesTarget) across the territory's rows.
 *                 Targets REPEAT across a territory's plan rows, so summing
 *                 salesTarget would multiply the goal. We take the largest
 *                 nonzero value as the territory's single target.
 */
export function aggregateByTerritory(rows: CogentOrderRow[]): TerritoryTotals[] {
  const byTerritory = new Map<string, { orderCount: number; maxTarget: number }>();
  for (const row of rows) {
    const acc = byTerritory.get(row.salesTerritoryName) ?? {
      orderCount: 0,
      maxTarget: 0,
    };
    acc.orderCount += row.policyCount;
    if (row.salesTarget > acc.maxTarget) acc.maxTarget = row.salesTarget;
    byTerritory.set(row.salesTerritoryName, acc);
  }
  return Array.from(byTerritory.entries()).map(([name, acc]) => ({
    salesTerritoryName: name,
    orderCount: acc.orderCount,
    orderTarget: acc.maxTarget,
  }));
}

// ---------------------------------------------------------------------------
// AE-level aggregation
// ---------------------------------------------------------------------------

/** One AE's rolled-up production orders for the requested window. */
export type AeOrdersSummary = {
  salespersonId: string;
  /** Display name. Only first_name exists on salespeople today. */
  salespersonName: string;
  territories: string[];
  orderCount: number;
  orderTarget: number;
  /** orderCount / orderTarget * 100, rounded to 1 decimal; null when no
   *  target is set (avoids divide-by-zero / a misleading 0%). */
  percentToGoal: number | null;
  /** Today's order count for this AE. ALWAYS null out of getOrdersSummary —
   *  the SalesReport6 same-day slice is unreliable (see module header), so this
   *  is populated downstream in orders.ts via the daily baseline delta
   *  (current MTD − start-of-day MTD baseline, clamped ≥ 0). */
  todayOrders: number | null;
};

/** A territory with orders that maps to no active AE. Surfaced, never dropped. */
export type UnmappedTerritory = {
  salesTerritoryName: string;
  orderCount: number;
  orderTarget: number;
};

/** One MAPPED territory's MTD totals + the production AE it rolls up to. The
 *  per-territory rollup that backs the admin "By Territory" view. orderCount /
 *  orderTarget are the SAME aggregate values that sum into the AE totals, so
 *  the two views stay consistent. */
export type MappedTerritory = {
  salesTerritoryName: string;
  salespersonId: string;
  salespersonName: string;
  orderCount: number;
  orderTarget: number;
};

export type OrdersSummary = {
  startDate: string;
  endDate: string;
  items: AeOrdersSummary[];
  /** Per-territory MTD rollups for the mapped (production-AE) territories only.
   *  Unmapped territories stay in unmappedTerritories. */
  mappedTerritories: MappedTerritory[];
  unmappedTerritories: UnmappedTerritory[];
  /** Safe metadata for logging — never the payload itself. */
  meta: {
    rowCount: number;
    unmappedCount: number;
    durationMs: number;
    upstreamStatus: number;
  };
};

type Mapping = {
  sales_territory_name: string;
  salesperson_id: string;
  first_name: string;
};

/**
 * Loads active territory→AE mappings, joined to the AE, restricted to PRODUCTION
 * AEs only. Mirrors the positive allow-list in leaderboard-standings.ts:
 * `role = 'ae'` AND `is_test = false`. A mapping that points to an admin,
 * assistant, juice_box_only guest, or the seeded test account is dropped — its
 * territory then surfaces as UNMAPPED (flagged, never silently attributed),
 * so non-AE/test users can't leak into production order reporting.
 */
async function loadActiveMappings(): Promise<Mapping[]> {
  const supabase = getServerSupabase();
  const res = await supabase
    .from("cogent_territory_mappings")
    .select(
      "sales_territory_name, salesperson_id, salespeople(first_name, role, is_test)",
    )
    .eq("active", true);

  if (res.error) {
    console.warn(
      `[cogent] mapping lookup failed code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    throw new Error("Could not load Cogent territory mappings.");
  }

  const mappings: Mapping[] = [];
  for (const row of res.data ?? []) {
    const r = row as {
      sales_territory_name: string;
      salesperson_id: string;
      // supabase-js types the embedded relation as an array; it's 1:1 here.
      salespeople?:
        | { first_name?: unknown; role?: unknown; is_test?: unknown }
        | { first_name?: unknown; role?: unknown; is_test?: unknown }[]
        | null;
    };
    const rel = Array.isArray(r.salespeople) ? r.salespeople[0] : r.salespeople;
    const role = rel?.role;
    const isTest = rel?.is_test;
    // Positive allow-list: production AEs only.
    if (role !== "ae" || isTest === true) continue;
    const first = rel?.first_name;
    mappings.push({
      sales_territory_name: r.sales_territory_name,
      salesperson_id: r.salesperson_id,
      first_name: typeof first === "string" ? first : "(unknown)",
    });
  }
  return mappings;
}

/** Rounds to 1 decimal place. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Cogent's orders-report `endDate` is EXCLUSIVE — the window it counts is the
 * half-open interval [startDate, endDate). Verified empirically:
 *   [2026-05-29, 2026-05-29) → 0 orders   (empty interval)
 *   [2026-05-29, 2026-05-30) → 1 order    (the 29th's order)
 *   [2026-05-01, 2026-05-29) → 960        (excludes the 29th)
 *   [2026-05-01, 2026-05-30) → 961        (includes the 29th)
 *
 * So a same-day [d, d] query always returns 0, and any [start, today] window
 * silently drops *today's* orders. Every caller passes an INCLUSIVE end date
 * (what a human means by "through today"); this converts it to the exclusive
 * end Cogent wants by adding one calendar day. Single source of truth so no
 * caller has to remember the off-by-one. */
function exclusiveEnd(inclusiveEndYyyyMmDd: string): string {
  // Parse as a plain calendar day and add one. format() round-trips it back to
  // yyyy-MM-dd; no timezone math (these are date-only tokens).
  return format(addDays(parseISO(inclusiveEndYyyyMmDd), 1), "yyyy-MM-dd");
}

// ---------------------------------------------------------------------------
// Upstream fetch
// ---------------------------------------------------------------------------

type FetchResult = {
  rows: CogentOrderRow[];
  upstreamStatus: number;
  durationMs: number;
};

/**
 * POSTs the production filter to Cogent for the INCLUSIVE calendar range
 * [startDate, endDate] and returns parsed rows + safe metadata. The endDate is
 * converted to Cogent's exclusive end internally (see exclusiveEnd), so
 * callers always think in inclusive "through this day" terms. Throws on
 * missing key / network / non-200 / non-JSON so the caller can translate to an
 * HTTP error. Never logs or returns the API key or the raw payload.
 */
async function fetchOrdersReport(
  startDate: string,
  endDate: string,
): Promise<FetchResult> {
  const apiKey = process.env.COGENT_API_KEY?.trim();
  if (!apiKey) {
    console.warn("[cogent] COGENT_API_KEY is not set; cannot reach Orders API");
    throw new Error("COGENT_API_KEY is not configured on the server.");
  }

  const body = {
    startDate,
    // Cogent's endDate is exclusive — add one day so the INCLUSIVE end the
    // caller passed (e.g. "through today") is actually counted.
    endDate: exclusiveEnd(endDate),
    useEffectiveDate: false,
    ...COGENT_PRODUCTION_FILTER,
  };

  const startedAt = Date.now();
  // Application-level timeout so a hung upstream can't stall the sync (and, with
  // it, a serverless function) indefinitely. On timeout the fetch rejects with
  // an AbortError; we translate it to a clear, logged error and the SYNC fails
  // without touching the prior cached snapshot (the cache is only written on a
  // fully successful run).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COGENT_FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(COGENT_ORDERS_REPORT_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    if (timedOut) {
      console.warn(
        `[cogent] upstream timed out after ${COGENT_FETCH_TIMEOUT_MS}ms`,
      );
      throw new Error("The Cogent Orders API timed out.");
    }
    console.warn(`[cogent] upstream fetch failed err=${String(err)}`);
    throw new Error("Failed to reach the Cogent Orders API.");
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - startedAt;
  const text = await res.text();

  if (!res.ok) {
    console.warn(
      `[cogent] upstream non-200 status=${res.status} durationMs=${durationMs}`,
    );
    throw new Error(`Cogent Orders API returned status ${res.status}.`);
  }

  let payload: unknown;
  try {
    payload = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    console.warn(
      `[cogent] upstream returned non-JSON status=${res.status} len=${text.length}`,
    );
    throw new Error("Cogent Orders API returned a non-JSON response.");
  }

  return {
    rows: parseCogentRows(payload),
    upstreamStatus: res.status,
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Fetches the Cogent month-to-date orders report for [startDate, endDate],
 * aggregates by territory, maps territories to AEs, and returns per-AE
 * production MTD totals plus any unmapped territories.
 *
 * TODAY ORDERS ARE NOT COMPUTED HERE. The SalesReport6 same-day slice is
 * unreliable (see module header — same-day requests returned earlier-dated
 * buckets), so every returned `todayOrders` is null. Today is derived as a
 * daily baseline delta in orders.ts (applyTodayBaselineDeltas) from these MTD
 * totals, which ARE trusted.
 */
export async function getOrdersSummary(opts: {
  startDate: string;
  endDate: string;
}): Promise<OrdersSummary> {
  const { startDate, endDate } = opts;

  const main = await fetchOrdersReport(startDate, endDate);
  const mappings = await loadActiveMappings();

  // territory name -> { salespersonId, first_name }
  const territoryToAe = new Map<string, { id: string; name: string }>();
  for (const m of mappings) {
    territoryToAe.set(m.sales_territory_name, {
      id: m.salesperson_id,
      name: m.first_name,
    });
  }

  const territoryTotals = aggregateByTerritory(main.rows);

  // Roll territories up to AEs; collect unmapped territories separately.
  const byAe = new Map<
    string,
    {
      name: string;
      territories: string[];
      orderCount: number;
      orderTarget: number;
    }
  >();
  const unmapped: UnmappedTerritory[] = [];
  const mappedTerritories: MappedTerritory[] = [];

  for (const t of territoryTotals) {
    const ae = territoryToAe.get(t.salesTerritoryName);
    if (!ae) {
      unmapped.push({
        salesTerritoryName: t.salesTerritoryName,
        orderCount: t.orderCount,
        orderTarget: t.orderTarget,
      });
      continue;
    }
    // Per-territory rollup (same orderCount/orderTarget that sum into the AE).
    mappedTerritories.push({
      salesTerritoryName: t.salesTerritoryName,
      salespersonId: ae.id,
      salespersonName: ae.name,
      orderCount: t.orderCount,
      orderTarget: t.orderTarget,
    });
    const acc = byAe.get(ae.id) ?? {
      name: ae.name,
      territories: [],
      orderCount: 0,
      orderTarget: 0,
    };
    acc.territories.push(t.salesTerritoryName);
    acc.orderCount += t.orderCount;
    acc.orderTarget += t.orderTarget; // sum of per-territory (max) targets
    byAe.set(ae.id, acc);
  }

  const items: AeOrdersSummary[] = Array.from(byAe.entries())
    .map(([salespersonId, acc]) => ({
      salespersonId,
      salespersonName: acc.name,
      territories: acc.territories.sort(),
      orderCount: acc.orderCount,
      orderTarget: acc.orderTarget,
      percentToGoal:
        acc.orderTarget > 0 ? round1((acc.orderCount / acc.orderTarget) * 100) : null,
      // Filled downstream by the daily baseline delta (orders.ts).
      todayOrders: null,
    }))
    .sort((a, b) => a.salespersonName.localeCompare(b.salespersonName));

  unmapped.sort((a, b) => a.salesTerritoryName.localeCompare(b.salesTerritoryName));
  mappedTerritories.sort((a, b) =>
    a.salesTerritoryName.localeCompare(b.salesTerritoryName),
  );

  return {
    startDate,
    endDate,
    items,
    mappedTerritories,
    unmappedTerritories: unmapped,
    meta: {
      rowCount: main.rows.length,
      unmappedCount: unmapped.length,
      durationMs: main.durationMs,
      upstreamStatus: main.upstreamStatus,
    },
  };
}
