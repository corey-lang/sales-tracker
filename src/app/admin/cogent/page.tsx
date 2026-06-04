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

  const sortedItems = useMemo(() => {
    if (load.status !== "ready") return [];
    const items = [...load.data.items];
    const num = (v: number | null | undefined) =>
      v === null || v === undefined ? -Infinity : v;
    switch (sort) {
      case "pace":
        items.sort((a, b) => num(b.pacePercent) - num(a.pacePercent));
        break;
      case "orders":
        items.sort((a, b) => b.orderCount - a.orderCount);
        break;
      case "goal":
        items.sort((a, b) => num(b.percentToGoal) - num(a.percentToGoal));
        break;
      case "name":
        items.sort((a, b) => a.salespersonName.localeCompare(b.salespersonName));
        break;
    }
    return items;
  }, [load, sort]);

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
                <CardTitle>By AE</CardTitle>
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
            </CardHeader>
            <CardContent>
              {sortedItems.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {lastUpdated
                    ? "No mapped AE orders this month."
                    : "Not synced yet — click Refresh to load orders."}
                </p>
              ) : (
                <AeTable items={sortedItems} />
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

function AeTable({ items }: { items: AeItem[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="py-2 pr-3 font-medium">AE</th>
            <th className="py-2 px-3 text-right font-medium">Orders</th>
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
