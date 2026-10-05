"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";

import {
  formatPace,
  formatPercent,
  formatWhole,
  type RoadView,
} from "@/lib/road-to-10000";
import { cn } from "@/lib/utils";

import { Card } from "@/components/ui/card";
import { RoadProgressBar } from "@/components/road-to-10000/progress-bar";
import { RoadStatusBadge } from "@/components/road-to-10000/status-badge";
import { ageLabel, shortDate } from "@/components/road-to-10000/format";
import { useRoadView } from "@/components/road-to-10000/use-road-view";

// AE Home "Road to 10,000" card — the company goal: 10,000 Homescriptions sold in
// 2026. Sits between This Week and Orders. The whole card opens the full page.
//
// It shows the latest recorded cumulative total and the pace computed from it
// THROUGH THE DATE IT WAS RECORDED, with that date on the card, so a total that
// is a few days old never looks more current than it is.

export function RoadTo10000Card() {
  const { state } = useRoadView();

  if (state.status === "loading") {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">Loading Road to 10,000…</p>
      </Shell>
    );
  }
  if (state.status === "error") {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">Road to 10,000 is temporarily unavailable.</p>
      </Shell>
    );
  }
  const { view } = state;
  if (!view.configured) {
    // Not set up yet (database update not applied): only the people who could set
    // it up are told; everyone else sees nothing rather than an empty goal.
    return view.can_update ? (
      <Link href="/road-to-10000" className="block">
        <Card size="sm" className="border border-dashed border-border bg-transparent px-3 ring-0">
          <p className="text-sm font-medium">🏁 Road to 10,000 isn&apos;t set up yet</p>
          <p className="text-xs text-muted-foreground">
            The database update hasn&apos;t been applied. Open for details.
          </p>
        </Card>
      </Link>
    ) : null;
  }
  return <Body view={view} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <Card size="sm" className="px-3">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">🏁 Road to 10,000</p>
      {children}
    </Card>
  );
}

/** The compact Home card for a loaded view. Exported so it can be rendered in tests. */
export function RoadHomeCardBody({ view }: { view: RoadView }) {
  return <Body view={view} />;
}

function Body({ view }: { view: RoadView }) {
  const m = view.metrics;
  const age = ageLabel(view.daysSinceUpdate);
  const stale = (view.daysSinceUpdate ?? 0) > 0;
  return (
    <Link
      href="/road-to-10000"
      aria-label="Road to 10,000 — open the full view"
      className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    >
      {/* Deliberately SHORT: the Home card answers three questions — where are we,
          how far to go, how are we doing. Projected finish, required pace and the
          rest of the math live on the full view. */}
      <Card
        size="sm"
        className="gap-1.5 bg-gradient-to-br from-primary/10 via-card to-card px-3 py-2.5 ring-1 ring-primary/30 transition-colors hover:ring-primary/50"
      >
        {/* Headline row: the title, and (quietly) how fresh the total is. */}
        <div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-primary">🏁 Road to 10,000</p>
            <span className="flex min-w-0 items-center gap-1">
              {view.latest ? (
                <span className={cn("truncate text-[11px]", stale ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground")}>
                  Updated {shortDate(view.latest.recordedOn)}
                  {age && stale ? ` · ${age}` : ""}
                </span>
              ) : null}
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            </span>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-2">
            <p className="text-sm font-semibold">We&apos;re on our way. 🚀</p>
            <p className="text-[11px] text-muted-foreground">10,000 Homescriptions Sold</p>
          </div>
        </div>

        {m && view.latest ? (
          <>
            <div className="flex items-end justify-between gap-3">
              <p className="text-3xl font-bold leading-none tabular-nums tracking-tight">
                {formatWhole(m.total)}
                <span className="text-sm font-medium text-muted-foreground"> / {formatWhole(m.target)}</span>
              </p>
              <p className="text-right leading-none">
                <span className="text-xl font-bold tabular-nums">{formatPercent(m.percentComplete)}%</span>
                <span className="block text-[11px] text-muted-foreground">Complete</span>
              </p>
            </div>

            <RoadProgressBar percent={m.percentComplete} />

            <p className="text-sm leading-tight">
              <span className="font-semibold tabular-nums">{formatWhole(m.remaining)}</span>{" "}
              <span className="text-muted-foreground">Homescriptions to go</span>
            </p>

            {/* One footer row: the pace on the left, where it stands on the right. */}
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 border-t border-border/60 pt-1.5">
              <p className="leading-tight">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Pace</span>{" "}
                <span className="text-base font-semibold tabular-nums">{formatPace(m.currentPace)}</span>
                {m.currentPace !== null ? <span className="text-xs font-medium text-muted-foreground">/day</span> : null}
              </p>
              <RoadStatusBadge metrics={m} compact />
            </div>
          </>
        ) : (
          <>
            <p className="text-3xl font-bold leading-none tabular-nums tracking-tight">
              — <span className="text-sm font-medium text-muted-foreground">/ {formatWhole(view.goal.target)}</span>
            </p>
            <RoadProgressBar percent={0} />
            <p className="text-sm text-muted-foreground">
              No total recorded yet.{view.can_update ? " Tap to enter the first one." : ""}
            </p>
          </>
        )}
      </Card>
    </Link>
  );
}
