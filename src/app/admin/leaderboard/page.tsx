"use client";

import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "@/lib/api-client";
import { useScrollToTop } from "@/lib/use-scroll-to-top";
import { progressColor, recentActivityWeeks } from "@/lib/goals";
import {
  DEFAULT_WORKING_DAYS,
  formatAvailableDays,
  paceVerdict,
  paceVerdictLabel,
} from "@/lib/working-days";
import { cn } from "@/lib/utils";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Admin Leaderboard — the team standings with a prior-week selector.
//
// Standings come from the admin-only GET /api/admin/leaderboard?weekStart=…,
// which enforces admin access server-side (requireAdmin) and is reached via
// apiFetch so the session token is sent. It computes percentages server-side
// and returns only id / name / raw totals / percent — never goal targets. The
// AE-facing /leaderboard still uses /api/leaderboard, which has no week
// parameter, so non-admins cannot pull historical leaderboard data.

type Standing = {
  id: string;
  first_name: string;
  percent: number | null;
  availableDays?: number;
  expectedPercent?: number;
  isHolidayWeek?: boolean;
};
type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; standings: Standing[] };

/** Sort: percent desc, reps with no goal (null) last, name as tiebreaker. */
function rankStandings(rows: Standing[]): Standing[] {
  return [...rows].sort((a, b) => {
    if (a.percent === null && b.percent === null) {
      return a.first_name.localeCompare(b.first_name);
    }
    if (a.percent === null) return 1;
    if (b.percent === null) return -1;
    return b.percent - a.percent || a.first_name.localeCompare(b.first_name);
  });
}

export default function AdminLeaderboardPage() {
  useScrollToTop();

  // Current Sun-Sat activity week + the prior 11 weeks; current is first.
  const weeks = useMemo(() => recentActivityWeeks(12), []);
  const [weekStart, setWeekStart] = useState(weeks[0].weekStart);
  const [load, setLoad] = useState<Load>({ status: "loading" });

  const selectedWeek = weeks.find((w) => w.weekStart === weekStart);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoad({ status: "loading" });

    apiFetch(`/api/admin/leaderboard?weekStart=${weekStart}`)
      .then(async (res) => {
        const body = (await res.json()) as {
          standings?: Standing[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setLoad({
            status: "error",
            message: body.error ?? "Couldn't load the leaderboard.",
          });
          return;
        }
        setLoad({
          status: "ready",
          standings: rankStandings(body.standings ?? []),
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoad({
          status: "error",
          message:
            err instanceof Error
              ? err.message
              : "Couldn't load the leaderboard.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [weekStart]);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Team standings</CardTitle>
            <CardDescription>
              Ranked by % of weekly goal completed (Sunday-Saturday activity).
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
      <CardContent>
        {load.status === "error" ? (
          <p className="text-sm text-destructive">
            Couldn&apos;t load: {load.message}
          </p>
        ) : load.status === "loading" ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : load.standings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No standings for {selectedWeek?.label ?? "this week"}.
          </p>
        ) : (
          <ol className="space-y-2">
            {load.standings.map((s, i) => (
              <StandingRow key={s.id} rank={i + 1} standing={s} />
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function StandingRow({
  rank,
  standing,
}: {
  rank: number;
  standing: Standing;
}) {
  const { percent } = standing;
  const percentColor =
    percent === null ? "text-muted-foreground" : progressColor(percent).text;
  const availableDays = standing.availableDays ?? DEFAULT_WORKING_DAYS;
  const reducedDays = availableDays < DEFAULT_WORKING_DAYS;
  const verdict = paceVerdict(percent, standing.expectedPercent ?? 0);
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
      <div className="flex min-w-0 items-baseline gap-3">
        <span className="text-lg font-semibold tabular-nums text-muted-foreground">
          #{rank}
        </span>
        <div className="min-w-0">
          <span className="truncate text-base font-medium">
            {standing.first_name}
          </span>
          {/* Available-days context — pace only; the score is unchanged. */}
          {reducedDays ? (
            <p className="text-xs text-muted-foreground">
              {standing.isHolidayWeek ? "Holiday • " : ""}
              {formatAvailableDays(availableDays)} avail days ·{" "}
              {paceVerdictLabel(verdict)}
            </p>
          ) : null}
        </div>
      </div>
      {/* Score only — raw activity counts live on /admin/reports/activity. */}
      <span
        className={cn(
          "shrink-0 text-2xl font-bold tabular-nums",
          percentColor,
        )}
      >
        {percent === null ? "—" : `${percent}%`}
      </span>
    </li>
  );
}
