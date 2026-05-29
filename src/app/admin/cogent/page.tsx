"use client";

import { useEffect, useState } from "react";

import { apiFetchJson } from "@/lib/api-client";
import { useScrollToTop } from "@/lib/use-scroll-to-top";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Admin Cogent Orders (test view) — read-only window onto
// GET /api/cogent/orders-summary. One card per AE with their rolled-up
// production orders for the date range, plus any territories that map to no
// AE. The route is admin-gated server-side (requireAdmin) and admin-gated
// again by admin/layout.tsx; this page only READS via the existing endpoint —
// no direct Cogent calls, no API key in the browser, no DB writes.
//
// This is a diagnostic surface to confirm the territory→AE mapping before the
// AE Orders tile is built. It is intentionally NOT on the AE dashboard.

type AeItem = {
  salespersonId: string;
  salespersonName: string;
  territories: string[];
  orderCount: number;
  orderTarget: number;
  percentToGoal: number | null;
  todayOrders: number | null;
};

type UnmappedTerritory = {
  salesTerritoryName: string;
  orderCount: number;
  orderTarget: number;
};

type Summary = {
  startDate: string;
  endDate: string;
  items: AeItem[];
  unmappedTerritories: UnmappedTerritory[];
};

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: Summary };

export default function AdminCogentPage() {
  useScrollToTop();

  const [load, setLoad] = useState<Load>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoad({ status: "loading" });

    // apiFetchJson surfaces non-JSON responses (e.g. an HTML 404/redirect
    // page) as a descriptive error with status + body snippet instead of
    // crashing on "Unexpected token '<'".
    apiFetchJson<Partial<Summary>>("/api/cogent/orders-summary")
      .then((body) => {
        if (cancelled) return;
        setLoad({
          status: "ready",
          data: {
            startDate: body.startDate ?? "",
            endDate: body.endDate ?? "",
            items: body.items ?? [],
            unmappedTerritories: body.unmappedTerritories ?? [],
          },
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoad({
          status: "error",
          message:
            err instanceof Error
              ? err.message
              : "Couldn't load the Cogent orders summary.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Cogent Orders</CardTitle>
          <CardDescription>
            AE production orders from Cogent for the current month. Counts
            include Buyers, Real Estate Runoff, and Property Management
            coverage only. Diagnostic view — not yet on the AE dashboard.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {load.status === "ready" ? (
            <p className="text-sm text-muted-foreground">
              Date range:{" "}
              <span className="font-medium text-foreground">
                {load.data.startDate}
              </span>{" "}
              →{" "}
              <span className="font-medium text-foreground">
                {load.data.endDate}
              </span>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Date range: current month
            </p>
          )}
        </CardContent>
      </Card>

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
          {load.data.items.length === 0 ? (
            <Card>
              <CardContent className="py-6">
                <p className="text-sm text-muted-foreground">
                  No mapped AE orders for this date range.
                </p>
              </CardContent>
            </Card>
          ) : (
            load.data.items.map((item) => (
              <AeCard key={item.salespersonId} item={item} />
            ))
          )}

          <UnmappedCard territories={load.data.unmappedTerritories} />
        </>
      )}
    </div>
  );
}

/** Formats percent-to-goal: "—" when no target is set (null), else "53.5%". */
function formatPercent(percent: number | null): string {
  return percent === null ? "—" : `${percent}%`;
}

/** Formats an optional today count: "—" when not computed (null). */
function formatToday(value: number | null): string {
  return value === null ? "—" : String(value);
}

function AeCard({ item }: { item: AeItem }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>{item.salespersonName}</CardTitle>
            <CardDescription>
              {item.territories.length > 0
                ? item.territories.join(", ")
                : "No territories"}
            </CardDescription>
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold tabular-nums leading-none">
              {formatPercent(item.percentToGoal)}
            </p>
            <p className="text-xs text-muted-foreground">to goal</p>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-3 gap-3 text-center">
          <Stat label="Order Count" value={String(item.orderCount)} />
          <Stat label="Order Target" value={String(item.orderTarget)} />
          <Stat label="+ Today" value={formatToday(item.todayOrders)} />
        </dl>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border bg-muted/30 py-2">
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
      <dt className="text-xs text-muted-foreground">{label}</dt>
    </div>
  );
}

function UnmappedCard({ territories }: { territories: UnmappedTerritory[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Unmapped territories</CardTitle>
        <CardDescription>
          Cogent territories with orders that map to no AE. These do not count
          toward any AE&apos;s totals. Ideally this list is empty — add a row
          to cogent_territory_mappings to attribute one.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {territories.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None — every territory with orders is mapped to an AE.
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
