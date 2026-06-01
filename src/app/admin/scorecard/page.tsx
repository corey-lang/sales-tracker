"use client";

import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "@/lib/api-client";
import { formatActivityStamp } from "@/lib/dates";
import { progressColor, recentBusinessWeeks } from "@/lib/goals";
import {
  DEFAULT_WORKING_DAYS,
  formatAvailableDays,
  paceVerdict,
  paceVerdictLabel,
} from "@/lib/working-days";
import { useScrollToTop } from "@/lib/use-scroll-to-top";
import { cn } from "@/lib/utils";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Admin AE Scorecard — manager-only operating snapshot for one Mon-Fri
// week. Shows weekly score % alongside raw KPI counts (visits, cards,
// to-dos, offices, last-active) so the manager can see how each AE is
// USING the app, not just their leaderboard percentage.
//
// Raw counts live only here and on /admin/reports/activity. The
// AE-facing /leaderboard stays percentage-only by design.

type ScorecardRow = {
  id: string;
  first_name: string;
  percent: number | null;
  available_days: number;
  expected_percent: number;
  is_holiday_week: boolean;
  manual_visits: number;
  crm_visits: number;
  cards_scanned: number;
  cards_approved: number;
  todos_created: number;
  todos_completed: number;
  offices_added: number;
  last_active_at: string | null;
};

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; rows: ScorecardRow[] };

/** Sort: percent desc, AEs with no goal (null) last, name as tiebreaker. */
function rankRows(rows: ScorecardRow[]): ScorecardRow[] {
  return [...rows].sort((a, b) => {
    if (a.percent === null && b.percent === null) {
      return a.first_name.localeCompare(b.first_name);
    }
    if (a.percent === null) return 1;
    if (b.percent === null) return -1;
    return b.percent - a.percent || a.first_name.localeCompare(b.first_name);
  });
}

export default function AdminScorecardPage() {
  useScrollToTop();

  const weeks = useMemo(() => recentBusinessWeeks(12), []);
  const [weekStart, setWeekStart] = useState(weeks[0].weekStart);
  const [load, setLoad] = useState<Load>({ status: "loading" });

  const selectedWeek = weeks.find((w) => w.weekStart === weekStart);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoad({ status: "loading" });

    apiFetch(`/api/admin/scorecard?weekStart=${weekStart}`)
      .then(async (res) => {
        const body = (await res.json()) as {
          rows?: ScorecardRow[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setLoad({
            status: "error",
            message: body.error ?? "Couldn't load the scorecard.",
          });
          return;
        }
        setLoad({
          status: "ready",
          rows: rankRows(body.rows ?? []),
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoad({
          status: "error",
          message:
            err instanceof Error
              ? err.message
              : "Couldn't load the scorecard.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [weekStart]);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>AE Scorecard</CardTitle>
              <CardDescription>
                How each AE is using the app and executing this week.
              </CardDescription>
            </div>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Week
              <select
                value={weekStart}
                onChange={(e) => setWeekStart(e.target.value)}
                className="rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {weeks.map((w) => (
                  <option key={w.weekStart} value={w.weekStart}>
                    {w.label}
                    {w.isCurrent ? " (current)" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Manual visits</span>{" "}
            come from activity entries.{" "}
            <span className="font-medium text-foreground">
              Office CRM visits
            </span>{" "}
            come from visits logged through Offices.
          </p>
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              Cards Approved
            </span>{" "}
            = approved contacts from that AE&apos;s scans (attributed to the
            scanner, not the admin who clicked approve).
          </p>
        </CardContent>
      </Card>

      {load.status === "error" ? (
        <Card>
          <CardContent className="py-6">
            <p className="text-sm text-destructive">
              Couldn&apos;t load the scorecard: {load.message}
            </p>
          </CardContent>
        </Card>
      ) : load.status === "loading" ? (
        <Card>
          <CardContent className="py-6">
            <p className="text-sm text-muted-foreground">Loading…</p>
          </CardContent>
        </Card>
      ) : load.rows.length === 0 ? (
        <Card>
          <CardContent className="py-6">
            <p className="text-sm text-muted-foreground">
              No AEs to score for {selectedWeek?.label ?? "this week"}.
            </p>
          </CardContent>
        </Card>
      ) : (
        load.rows.map((row, i) => (
          <ScorecardCard key={row.id} rank={i + 1} row={row} />
        ))
      )}
    </div>
  );
}

/** One AE — score chip plus a tight grid of raw KPI tiles. */
function ScorecardCard({ rank, row }: { rank: number; row: ScorecardRow }) {
  const { percent, last_active_at } = row;
  const percentColor =
    percent === null ? "text-muted-foreground" : progressColor(percent).text;
  const lastActiveLabel = last_active_at
    ? formatActivityStamp(last_active_at)
    : "Never";
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-3">
            <span className="text-lg font-semibold tabular-nums text-muted-foreground">
              #{rank}
            </span>
            <div className="min-w-0">
              <CardTitle className="truncate text-base">
                {row.first_name}
              </CardTitle>
              {row.available_days < DEFAULT_WORKING_DAYS ? (
                <p className="text-xs text-muted-foreground">
                  Goals adjusted for approved time off
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <PaceChip
              percent={percent}
              expectedPercent={row.expected_percent}
            />
            <div className="flex flex-col items-end gap-0.5">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Score
              </span>
              <span
                className={cn(
                  "text-2xl font-bold tabular-nums",
                  percentColor,
                )}
              >
                {percent === null ? "—" : `${percent}%`}
              </span>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile
            label="Available Days"
            value={
              row.available_days < DEFAULT_WORKING_DAYS
                ? `${formatAvailableDays(row.available_days)}${row.is_holiday_week ? " (holiday)" : ""}`
                : formatAvailableDays(row.available_days)
            }
            muted={row.available_days >= DEFAULT_WORKING_DAYS}
          />
          <Tile label="Manual Visits" value={row.manual_visits} />
          <Tile label="Office CRM Visits" value={row.crm_visits} />
          <Tile label="Cards Scanned" value={row.cards_scanned} />
          <Tile label="Cards Approved" value={row.cards_approved} />
          <Tile label="To-Dos Created" value={row.todos_created} />
          <Tile label="To-Dos Completed" value={row.todos_completed} />
          <Tile label="Offices Added" value={row.offices_added} />
          <Tile label="Last Active" value={lastActiveLabel} muted />
        </div>
      </CardContent>
    </Card>
  );
}

/** Available-days-aware pace chip shown alongside the raw score. Does NOT
 *  change the score — it's the "on pace given approved time off" read. */
function PaceChip({
  percent,
  expectedPercent,
}: {
  percent: number | null;
  expectedPercent: number;
}) {
  const verdict = paceVerdict(percent, expectedPercent);
  if (verdict === "none") return null;
  const tone =
    verdict === "ahead"
      ? "bg-green-500/10 text-green-700 dark:text-green-400"
      : verdict === "on_pace"
        ? "bg-green-500/10 text-green-700 dark:text-green-400"
        : "bg-amber-500/10 text-amber-700 dark:text-amber-400";
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Pace
      </span>
      <span
        className={cn(
          "rounded-full px-2 py-0.5 text-xs font-semibold",
          tone,
        )}
        title={`Expected ~${expectedPercent}% by now`}
      >
        {paceVerdictLabel(verdict)}
      </span>
    </div>
  );
}

function Tile({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: number | string;
  muted?: boolean;
}) {
  return (
    <div className="rounded-lg border bg-muted/20 p-2.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-0.5 truncate text-lg font-bold tabular-nums",
          muted && "text-sm font-semibold",
        )}
        title={typeof value === "string" ? value : undefined}
      >
        {value}
      </p>
    </div>
  );
}
