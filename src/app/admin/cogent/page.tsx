"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";

import { apiFetchJson } from "@/lib/api-client";
import { useScrollToTop } from "@/lib/use-scroll-to-top";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Admin Cogent Orders — leadership view onto GET /api/cogent/orders-summary.
// Company summary card + a per-AE table sortable by Pace %. Same month-to-date
// source of truth and order pace as the AE Home Orders card (getMonthlyOrders).
// Admin-gated server-side (requireAdmin) and by admin/layout.tsx. Reads only;
// no direct Cogent calls or API key in the browser.

type AeItem = {
  salespersonId: string;
  salespersonName: string;
  territories: string[];
  orderCount: number;
  orderTarget: number;
  percentToGoal: number | null;
  todayOrders: number | null;
  pacePercent?: number | null;
};

type TerritoryItem = {
  salesTerritoryName: string;
  salespersonId: string;
  salespersonName: string;
  orderCount: number;
  orderTarget: number;
  percentToGoal: number | null;
  todayOrders: number | null;
  pacePercent?: number | null;
};

type UnmappedTerritory = {
  salesTerritoryName: string;
  orderCount: number;
  orderTarget: number;
};

type OrderPace = {
  businessDaysTotal: number;
  businessDaysElapsed: number;
  expectedPercent: number;
};

type CompanyOrders = {
  orderCount: number;
  orderTarget: number;
  percentToGoal: number | null;
  todayOrders: number | null;
  pacePercent: number | null;
};

type Summary = {
  startDate: string;
  endDate: string;
  pace: OrderPace | null;
  company: CompanyOrders | null;
  items: AeItem[];
  territoryItems: TerritoryItem[];
  unmappedTerritories: UnmappedTerritory[];
};

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: Summary };

type SortKey = "pace" | "orders" | "goal" | "name";

const SORT_LABELS: Record<SortKey, string> = {
  pace: "Pace % (high → low)",
  orders: "Orders (high → low)",
  goal: "Goal % (high → low)",
  name: "AE name (A → Z)",
};

// Market grouping — lets leadership view AEs by area. Mapping rules:
//   Utah    = territories beginning with "UT"
//   Phoenix = territories beginning with "PHX"
//   Texas   = Austin, San Antonio, DFW East, DFW West
//   Nevada  = NV Las Vegas, NV Mesquite
// Selecting a market SCOPES the displayed metrics to that market: By-AE rows are
// rebuilt from only the matching territories (a cross-market AE shows just that
// market's subset), and By-Territory lists the matching territories. Display-only
// — it never changes the underlying orders, pace, or production-AE filtering.
type MarketKey = "all" | "utah" | "phoenix" | "texas" | "nevada";

const MARKETS: { key: MarketKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "utah", label: "Utah" },
  { key: "phoenix", label: "Phoenix" },
  { key: "texas", label: "Texas" },
  { key: "nevada", label: "Nevada" },
];

const MARKET_LABEL: Record<MarketKey, string> = Object.fromEntries(
  MARKETS.map((m) => [m.key, m.label]),
) as Record<MarketKey, string>;

const TEXAS_TERRITORIES = new Set([
  "austin",
  "san antonio",
  "dfw east",
  "dfw west",
]);
const NEVADA_TERRITORIES = new Set(["nv las vegas", "nv mesquite"]);

function territoryInMarket(territory: string, market: MarketKey): boolean {
  const t = territory.trim();
  switch (market) {
    case "all":
      return true;
    case "utah":
      return t.toUpperCase().startsWith("UT");
    case "phoenix":
      return t.toUpperCase().startsWith("PHX");
    case "texas":
      return TEXAS_TERRITORIES.has(t.toLowerCase());
    case "nevada":
      return NEVADA_TERRITORIES.has(t.toLowerCase());
  }
}

/** Per-AE Today: never "—" in the table — 0 when null (req: "Display 0 if none"). */
function todayCount(value: number | null | undefined): number {
  return value ?? 0;
}

// View toggle — same data, two granularities.
type ViewKey = "ae" | "territory";

/** A row sortable by the shared keys (works for both AE and territory rows). */
type SortableRow = {
  orderCount: number;
  percentToGoal: number | null;
  pacePercent?: number | null;
};

/** Applies a SortKey to rows; `nameOf` supplies the label for name-sort. Default
 *  (pace) and all options mirror the existing By-AE behavior. */
function sortRows<T extends SortableRow>(
  rows: T[],
  sort: SortKey,
  nameOf: (r: T) => string,
): T[] {
  const num = (v: number | null | undefined) =>
    v === null || v === undefined ? -Infinity : v;
  const copy = [...rows];
  switch (sort) {
    case "pace":
      copy.sort((a, b) => num(b.pacePercent) - num(a.pacePercent));
      break;
    case "orders":
      copy.sort((a, b) => b.orderCount - a.orderCount);
      break;
    case "goal":
      copy.sort((a, b) => num(b.percentToGoal) - num(a.percentToGoal));
      break;
    case "name":
      copy.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
      break;
  }
  return copy;
}

type FilterSummary = {
  orders: number;
  today: number;
  goal: number;
  goalPercent: number | null;
  pacePercent: number | null;
};

/** orders / goal × 100, 1 decimal; null when no goal. Matches the server's
 *  round1 goal-% so rebuilt rows agree with AE/territory rows. */
function goalPercentOf(orders: number, goal: number): number | null {
  return goal > 0 ? Math.round((orders / goal) * 1000) / 10 : null;
}

/** Whole-number pace % — same shape as the server's pacePercentValue:
 *  goalFraction / expectedFraction × 100. null when not computable. */
function pacePercentOf(
  orders: number,
  goal: number,
  pace: OrderPace | null,
): number | null {
  if (
    goal <= 0 ||
    !pace ||
    pace.businessDaysElapsed <= 0 ||
    pace.businessDaysTotal <= 0
  ) {
    return null;
  }
  return Math.round(
    (orders / goal / (pace.businessDaysElapsed / pace.businessDaysTotal)) * 100,
  );
}

/** Totals for the visible rows — same orders/goal/pace formulas used per-row,
 *  so the summary matches the table's columns exactly. */
function summarize(
  rows: { orderCount: number; orderTarget: number; todayOrders: number | null }[],
  pace: OrderPace | null,
): FilterSummary {
  const orders = rows.reduce((s, r) => s + r.orderCount, 0);
  const goal = rows.reduce((s, r) => s + r.orderTarget, 0);
  const today = rows.reduce((s, r) => s + todayCount(r.todayOrders), 0);
  return {
    orders,
    today,
    goal,
    goalPercent: goalPercentOf(orders, goal),
    pacePercent: pacePercentOf(orders, goal, pace),
  };
}

/** "—" when null, else "53.5%". */
function formatPercent(percent: number | null | undefined): string {
  return percent === null || percent === undefined ? "—" : `${percent}%`;
}

/** Whole-number pace %, "—" when not computable. */
function formatPace(pace: number | null | undefined): string {
  return pace === null || pace === undefined ? "—" : `${pace}%`;
}

/** ≥100 = ahead (primary), <100 = behind (amber), null = muted. */
function paceClass(pace: number | null | undefined): string {
  if (pace === null || pace === undefined) return "text-muted-foreground";
  return pace >= 100 ? "text-primary" : "text-amber-600 dark:text-amber-400";
}

export default function AdminCogentPage() {
  useScrollToTop();

  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [sort, setSort] = useState<SortKey>("pace");
  const [market, setMarket] = useState<MarketKey>("all");
  const [view, setView] = useState<ViewKey>("ae");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Applies a summary-shaped response (from the cached GET or the manual-sync
  // POST) and stamps "Last updated" from the server's last_successful_refresh.
  const applyBody = useCallback(
    (body: Partial<Summary> & { refreshedAt?: string }) => {
      setLoad({
        status: "ready",
        data: {
          startDate: body.startDate ?? "",
          endDate: body.endDate ?? "",
          pace: body.pace ?? null,
          company: body.company ?? null,
          items: body.items ?? [],
          territoryItems: body.territoryItems ?? [],
          unmappedTerritories: body.unmappedTerritories ?? [],
        },
      });
      // Never stamp "now" when the cache is empty — leave it null so the UI
      // shows the not-synced state instead of a misleading fresh timestamp.
      setLastUpdated(body.refreshedAt ? new Date(body.refreshedAt) : null);
    },
    [],
  );

  // Initial load + the 15-minute client poll READ the cached snapshot (no live
  // Cogent call). The cron keeps the cache fresh server-side.
  const loadCached = useCallback(
    async (mode: "initial" | "poll") => {
      try {
        const body = await apiFetchJson<Partial<Summary> & { refreshedAt?: string }>(
          "/api/cogent/orders-summary",
        );
        applyBody(body);
      } catch (err) {
        // A background poll keeps the last good data; only initial load errors.
        if (mode === "initial") {
          setLoad({
            status: "error",
            message:
              err instanceof Error
                ? err.message
                : "Couldn't load the Cogent orders summary.",
          });
        }
      }
    },
    [applyBody],
  );

  // Manual refresh runs the SAME sync as the cron (POST), then applies the fresh
  // rollup. Keeps existing data on failure.
  const manualRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const body = await apiFetchJson<Partial<Summary> & { refreshedAt?: string }>(
        "/api/admin/cogent/refresh",
        { method: "POST" },
      );
      applyBody(body);
    } catch {
      // Keep the last good data; the timestamp simply won't advance.
    } finally {
      setRefreshing(false);
    }
  }, [applyBody]);

  useEffect(() => {
    // loadCached updates state after an async fetch; canonical on-mount pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadCached("initial");
    // Poll the cached snapshot every 15 minutes to pick up the cron's refreshes.
    const id = setInterval(() => void loadCached("poll"), 15 * 60 * 1000);
    return () => clearInterval(id);
  }, [loadCached]);

  // By-AE rows:
  //   • All    → full AE totals (load.data.items).
  //   • Market → REBUILT from the matching-market territoryItems, grouped by AE,
  //     so each AE row shows ONLY that market's subset (e.g. Heather under Utah
  //     shows UT South only, not her NV Mesquite). Orders/Today/Goal are summed
  //     from the matching territories; Goal % / Pace % are recomputed from that
  //     subset with the same formulas the server uses. Then sorted (default
  //     Pace % desc). Falls back to empty if territoryItems aren't in the
  //     snapshot yet (legacy cache) — the next sync repopulates them.
  const aeRows = useMemo(() => {
    if (load.status !== "ready") return [];
    if (market === "all") {
      return sortRows([...load.data.items], sort, (r) => r.salespersonName);
    }
    const matching = load.data.territoryItems.filter((t) =>
      territoryInMarket(t.salesTerritoryName, market),
    );
    const byAe = new Map<string, AeItem>();
    for (const t of matching) {
      const cur = byAe.get(t.salespersonId);
      if (cur) {
        cur.orderCount += t.orderCount;
        cur.orderTarget += t.orderTarget;
        cur.todayOrders = todayCount(cur.todayOrders) + todayCount(t.todayOrders);
        cur.territories.push(t.salesTerritoryName);
      } else {
        byAe.set(t.salespersonId, {
          salespersonId: t.salespersonId,
          salespersonName: t.salespersonName,
          territories: [t.salesTerritoryName],
          orderCount: t.orderCount,
          orderTarget: t.orderTarget,
          todayOrders: todayCount(t.todayOrders),
          percentToGoal: null, // recomputed from the subset below
          pacePercent: null,
        });
      }
    }
    const rebuilt = Array.from(byAe.values()).map((r) => ({
      ...r,
      territories: [...r.territories].sort(),
      percentToGoal: goalPercentOf(r.orderCount, r.orderTarget),
      pacePercent: pacePercentOf(r.orderCount, r.orderTarget, load.data.pace),
    }));
    return sortRows(rebuilt, sort, (r) => r.salespersonName);
  }, [load, sort, market]);

  const territoryRows = useMemo(() => {
    if (load.status !== "ready") return [];
    const filtered = load.data.territoryItems.filter((t) =>
      territoryInMarket(t.salesTerritoryName, market),
    );
    return sortRows(filtered, sort, (r) => r.salesTerritoryName);
  }, [load, sort, market]);

  const pace = load.status === "ready" ? load.data.pace : null;
  // Summary = the SAME visible rows of the current view. By-AE market rows are
  // now market-scoped (rebuilt from matching territories), so the summary equals
  // the table's column sums exactly — and a cross-market AE is never
  // double-counted across markets. At "All" this is the company total.
  const visibleRows = view === "ae" ? aeRows : territoryRows;
  const summary = useMemo(
    () => summarize(visibleRows, pace),
    [visibleRows, pace],
  );
  const summaryLabel =
    market === "all" ? "Company Total" : `${MARKET_LABEL[market]} Total`;

  return (
    <div className="flex flex-col gap-4">
      {load.status === "ready" && (
        <CompanyCard
          company={load.data.company}
          pace={load.data.pace}
          startDate={load.data.startDate}
          endDate={load.data.endDate}
          lastUpdated={lastUpdated}
          refreshing={refreshing}
          onRefresh={() => void manualRefresh()}
        />
      )}

      {load.status === "error" ? (
        <Card>
          <CardContent className="py-6">
            <p className="text-sm text-destructive">
              Couldn&apos;t load the Cogent orders summary: {load.message}
            </p>
          </CardContent>
        </Card>
      ) : load.status === "loading" ? (
        <Card>
          <CardContent className="py-6">
            <p className="text-sm text-muted-foreground">Loading…</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                {/* View toggle — By AE / By Territory (default By AE). */}
                <div className="inline-flex rounded-md border border-border p-0.5 text-sm">
                  {(
                    [
                      { key: "ae", label: "By AE" },
                      { key: "territory", label: "By Territory" },
                    ] as { key: ViewKey; label: string }[]
                  ).map((v) => (
                    <button
                      key={v.key}
                      type="button"
                      aria-pressed={view === v.key}
                      onClick={() => setView(v.key)}
                      className={`h-7 rounded px-3 font-medium transition-colors ${
                        view === v.key
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {v.label}
                    </button>
                  ))}
                </div>
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  Sort
                  <select
                    className="h-8 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:border-primary"
                    value={sort}
                    onChange={(e) => setSort(e.target.value as SortKey)}
                  >
                    {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                      <option key={k} value={k}>
                        {SORT_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {/* Market filter chips — filters both views by area. */}
              <div className="flex flex-wrap gap-1.5 pt-1">
                {MARKETS.map((m) => {
                  const active = market === m.key;
                  return (
                    <button
                      key={m.key}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setMarket(m.key)}
                      className={`h-7 rounded-full border px-3 text-xs font-medium transition-colors ${
                        active
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-background text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </CardHeader>
            <CardContent>
              {visibleRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {market !== "all"
                    ? `No ${view === "territory" ? "territories" : "AEs"} in ${MARKET_LABEL[market]}.`
                    : lastUpdated
                      ? `No mapped ${view === "territory" ? "territory" : "AE"} orders this month.`
                      : "Not synced yet — click Refresh to load orders."}
                </p>
              ) : (
                <>
                  <FilterSummaryRow
                    label={summaryLabel}
                    summary={summary}
                    paceAvailable={pace !== null}
                  />
                  {view === "ae" ? (
                    <AeTable items={aeRows} />
                  ) : (
                    <TerritoryTable items={territoryRows} />
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <UnmappedCard territories={load.data.unmappedTerritories} />
        </>
      )}
    </div>
  );
}

function CompanyCard({
  company,
  pace,
  startDate,
  endDate,
  lastUpdated,
  refreshing,
  onRefresh,
}: {
  company: CompanyOrders | null;
  pace: OrderPace | null;
  startDate: string;
  endDate: string;
  lastUpdated: Date | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const hasGoal = !!company && company.orderTarget > 0;
  const today = company?.todayOrders ?? null;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>🏠 Orders</CardTitle>
            <CardDescription>
              Company orders this month and today&apos;s count
            </CardDescription>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="h-8 shrink-0 rounded-md border border-border px-3 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {company ? (
          <>
            <div className="flex items-end justify-between gap-3">
              <p className="text-3xl font-bold tabular-nums leading-none">
                {company.orderCount}
                {hasGoal && (
                  <span className="text-lg font-medium text-muted-foreground">
                    {" "}
                    / {company.orderTarget}
                  </span>
                )}
              </p>
              <p className="text-2xl font-semibold tabular-nums leading-none">
                {formatPercent(company.percentToGoal)}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              {pace ? (
                <span className={`font-medium ${paceClass(company.pacePercent)}`}>
                  {formatPace(company.pacePercent)} Pace
                </span>
              ) : (
                <span className="text-muted-foreground">
                  Pace unavailable — holiday data could not be loaded.
                </span>
              )}
              <span className="text-muted-foreground">
                Today:{" "}
                <span className="font-semibold tabular-nums text-foreground">
                  {today === null ? "—" : today}
                </span>
                {today !== null && today > 0 ? " 🎉" : ""}
              </span>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Not synced yet — click Refresh to load orders.
          </p>
        )}

        <p className="text-xs text-muted-foreground">
          Month {startDate} → {endDate}
          {pace
            ? ` · business days ${pace.businessDaysElapsed}/${pace.businessDaysTotal} · expected ${pace.expectedPercent}%`
            : ""}
          {lastUpdated ? ` · Last updated: ${format(lastUpdated, "h:mm a")}` : ""}
        </p>
      </CardContent>
    </Card>
  );
}

/** Compact totals strip above the table for the current filter/view. */
function FilterSummaryRow({
  label,
  summary,
  paceAvailable,
}: {
  label: string;
  summary: FilterSummary;
  paceAvailable: boolean;
}) {
  return (
    <div className="mb-3 rounded-lg border bg-muted/40 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="text-sm font-semibold">{label}</span>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm tabular-nums">
          <span className="text-muted-foreground">
            Orders{" "}
            <span className="font-semibold text-foreground">
              {summary.orders}
            </span>
          </span>
          <span className="text-muted-foreground">
            Today{" "}
            <span className="font-semibold text-foreground">
              {summary.today}
            </span>
            {summary.today > 0 ? " 🎉" : ""}
          </span>
          <span className="text-muted-foreground">
            Goal{" "}
            <span className="font-semibold text-foreground">{summary.goal}</span>
          </span>
          <span className="text-muted-foreground">
            Goal %{" "}
            <span className="font-semibold text-foreground">
              {formatPercent(summary.goalPercent)}
            </span>
          </span>
          {paceAvailable ? (
            <span className={`font-semibold ${paceClass(summary.pacePercent)}`}>
              {formatPace(summary.pacePercent)} Pace
            </span>
          ) : (
            <span className="text-muted-foreground">Pace —</span>
          )}
        </div>
      </div>
    </div>
  );
}

function TerritoryTable({ items }: { items: TerritoryItem[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="py-2 pr-3 font-medium">Territory</th>
            <th className="py-2 px-3 font-medium">AE</th>
            <th className="py-2 px-3 text-right font-medium">Orders</th>
            <th className="py-2 px-3 text-right font-medium">Today</th>
            <th className="py-2 px-3 text-right font-medium">Goal</th>
            <th className="py-2 px-3 text-right font-medium">Goal %</th>
            <th className="py-2 pl-3 text-right font-medium">Pace %</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.salesTerritoryName} className="border-b last:border-0">
              <td className="py-2 pr-3 font-medium">{it.salesTerritoryName}</td>
              <td className="py-2 px-3 text-muted-foreground">
                {it.salespersonName}
              </td>
              <td className="py-2 px-3 text-right tabular-nums">
                {it.orderCount}
              </td>
              <td className="py-2 px-3 text-right tabular-nums">
                {todayCount(it.todayOrders)}
                {todayCount(it.todayOrders) > 0 ? " 🎉" : ""}
              </td>
              <td className="py-2 px-3 text-right tabular-nums">
                {it.orderTarget}
              </td>
              <td className="py-2 px-3 text-right tabular-nums">
                {formatPercent(it.percentToGoal)}
              </td>
              <td
                className={`py-2 pl-3 text-right font-semibold tabular-nums ${paceClass(it.pacePercent)}`}
              >
                {formatPace(it.pacePercent)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AeTable({ items }: { items: AeItem[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="py-2 pr-3 font-medium">AE</th>
            <th className="py-2 px-3 text-right font-medium">Orders</th>
            <th className="py-2 px-3 text-right font-medium">Today</th>
            <th className="py-2 px-3 text-right font-medium">Goal</th>
            <th className="py-2 px-3 text-right font-medium">Goal %</th>
            <th className="py-2 pl-3 text-right font-medium">Pace %</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.salespersonId} className="border-b last:border-0">
              <td className="py-2 pr-3">
                <span className="font-medium">{it.salespersonName}</span>
                {it.territories.length > 0 && (
                  <span className="block text-xs text-muted-foreground">
                    {it.territories.join(", ")}
                  </span>
                )}
              </td>
              <td className="py-2 px-3 text-right tabular-nums">
                {it.orderCount}
              </td>
              <td className="py-2 px-3 text-right tabular-nums">
                {todayCount(it.todayOrders)}
                {todayCount(it.todayOrders) > 0 ? " 🎉" : ""}
              </td>
              <td className="py-2 px-3 text-right tabular-nums">
                {it.orderTarget}
              </td>
              <td className="py-2 px-3 text-right tabular-nums">
                {formatPercent(it.percentToGoal)}
              </td>
              <td
                className={`py-2 pl-3 text-right font-semibold tabular-nums ${paceClass(it.pacePercent)}`}
              >
                {formatPace(it.pacePercent)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UnmappedCard({ territories }: { territories: UnmappedTerritory[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Unmapped territories</CardTitle>
        <CardDescription>
          Cogent territories with orders that map to no production AE. These do
          not count toward any AE&apos;s totals or the company total. Ideally
          this list is empty — add a row to cogent_territory_mappings to
          attribute one.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {territories.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None — every territory with orders is mapped to a production AE.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {territories.map((t) => (
              <li
                key={t.salesTerritoryName}
                className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2 text-sm"
              >
                <span className="font-medium">{t.salesTerritoryName}</span>
                <span className="tabular-nums text-muted-foreground">
                  {t.orderCount} orders · target {t.orderTarget}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
