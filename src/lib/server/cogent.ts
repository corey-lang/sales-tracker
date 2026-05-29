/**
 * Server-side Cogent Orders integration — fetch + aggregate by AE.
 *
 * Server-only. Never import from a "use client" component: this module reads
 * COGENT_API_KEY and the service-role Supabase client, neither of which may
 * reach the browser.
 *
 * WHAT THIS DOES
 *   1. POSTs to Cogent's /orders-report with the AE *production* coverage
 *      filter (see COGENT_PRODUCTION_FILTER below).
 *   2. Parses the returned rows defensively (the upstream shape is still
 *      being characterized via /api/cogent/test).
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

import { getServerSupabase } from "@/lib/supabase/server";

export const COGENT_ORDERS_REPORT_URL =
  "https://test-app.elevateh.com/api/integration/orders-report";

/**
 * The AE production-order coverage filter. Cogent applies these server-side,
 * so the response only contains coverage types that count toward AE orders
 * and targets. Kept as the single source of truth shared by the diagnostic
 * /api/cogent/test route and this library.
 */
export const COGENT_PRODUCTION_FILTER = {
  showBuyersCoverage: true,
  showSellersCoverage: false,
  showHomeownerCoverage: false,
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
 *  first then a few casing variants. The exact Cogent casing is still being
 *  confirmed via /api/cogent/test, so we tolerate camelCase / PascalCase. */
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
  /** Today's order count for this AE, or null when not computed. */
  todayOrders: number | null;
};

/** A territory with orders that maps to no active AE. Surfaced, never dropped. */
export type UnmappedTerritory = {
  salesTerritoryName: string;
  orderCount: number;
  orderTarget: number;
};

export type OrdersSummary = {
  startDate: string;
  endDate: string;
  items: AeOrdersSummary[];
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

/** Loads active territory→AE mappings, joined to the AE's first_name. */
async function loadActiveMappings(): Promise<Mapping[]> {
  const supabase = getServerSupabase();
  const res = await supabase
    .from("cogent_territory_mappings")
    .select("sales_territory_name, salesperson_id, salespeople(first_name)")
    .eq("active", true);

  if (res.error) {
    console.warn(
      `[cogent] mapping lookup failed code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    throw new Error("Could not load Cogent territory mappings.");
  }

  return (res.data ?? []).map((row) => {
    const r = row as {
      sales_territory_name: string;
      salesperson_id: string;
      // supabase-js types the embedded relation as an array; it's 1:1 here.
      salespeople?: { first_name?: unknown } | { first_name?: unknown }[] | null;
    };
    const rel = r.salespeople;
    const first = Array.isArray(rel) ? rel[0]?.first_name : rel?.first_name;
    return {
      sales_territory_name: r.sales_territory_name,
      salesperson_id: r.salesperson_id,
      first_name: typeof first === "string" ? first : "(unknown)",
    };
  });
}

/** Rounds to 1 decimal place. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
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
 * POSTs the production filter to Cogent for [startDate, endDate] and returns
 * parsed rows + safe metadata. Throws on missing key / network / non-200 /
 * non-JSON so the caller can translate to an HTTP error. Never logs or
 * returns the API key or the raw payload.
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
    endDate,
    useEffectiveDate: false,
    ...COGENT_PRODUCTION_FILTER,
  };

  const startedAt = Date.now();
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
    });
  } catch (err) {
    console.warn(`[cogent] upstream fetch failed err=${String(err)}`);
    throw new Error("Failed to reach the Cogent Orders API.");
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
 * Fetches the Cogent orders report for [startDate, endDate], aggregates by
 * territory, maps territories to AEs, and returns per-AE production totals
 * plus any unmapped territories.
 *
 * @param includeToday When true and `endDate` is today, today's orders are
 *   reused from the main window (no extra call); otherwise a second report
 *   for [today, today] is fetched. If the today call fails, todayOrders is
 *   left null rather than failing the whole request.
 */
export async function getOrdersSummary(opts: {
  startDate: string;
  endDate: string;
  today: string;
  includeToday?: boolean;
}): Promise<OrdersSummary> {
  const { startDate, endDate, today, includeToday = true } = opts;

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

  // Optionally compute today's per-territory counts.
  let todayByTerritory: Map<string, number> | null = null;
  if (includeToday) {
    try {
      // If the window already ends today, reuse it; we don't have per-day
      // granularity in the aggregate, so a same-day window is the only way
      // to isolate today's count. Reuse only when the whole window IS today.
      if (startDate === today && endDate === today) {
        todayByTerritory = new Map(
          territoryTotals.map((t) => [t.salesTerritoryName, t.orderCount]),
        );
      } else {
        const todayRes = await fetchOrdersReport(today, today);
        todayByTerritory = new Map(
          aggregateByTerritory(todayRes.rows).map((t) => [
            t.salesTerritoryName,
            t.orderCount,
          ]),
        );
      }
    } catch (err) {
      // Today is best-effort: never fail the summary over it.
      console.warn(`[cogent] today's window failed; todayOrders=null err=${String(err)}`);
      todayByTerritory = null;
    }
  }

  // Roll territories up to AEs; collect unmapped territories separately.
  const byAe = new Map<
    string,
    {
      name: string;
      territories: string[];
      orderCount: number;
      orderTarget: number;
      todayOrders: number | null;
    }
  >();
  const unmapped: UnmappedTerritory[] = [];

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
    const acc = byAe.get(ae.id) ?? {
      name: ae.name,
      territories: [],
      orderCount: 0,
      orderTarget: 0,
      todayOrders: todayByTerritory ? 0 : null,
    };
    acc.territories.push(t.salesTerritoryName);
    acc.orderCount += t.orderCount;
    acc.orderTarget += t.orderTarget; // sum of per-territory (max) targets
    if (todayByTerritory) {
      acc.todayOrders =
        (acc.todayOrders ?? 0) + (todayByTerritory.get(t.salesTerritoryName) ?? 0);
    }
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
      todayOrders: acc.todayOrders,
    }))
    .sort((a, b) => a.salespersonName.localeCompare(b.salespersonName));

  unmapped.sort((a, b) => a.salesTerritoryName.localeCompare(b.salesTerritoryName));

  return {
    startDate,
    endDate,
    items,
    unmappedTerritories: unmapped,
    meta: {
      rowCount: main.rows.length,
      unmappedCount: unmapped.length,
      durationMs: main.durationMs,
      upstreamStatus: main.upstreamStatus,
    },
  };
}
