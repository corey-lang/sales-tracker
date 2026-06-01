"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CalendarDays, Trophy, Zap } from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { todayInAppTimezone } from "@/lib/dates";
import { progressColor } from "@/lib/goals";
import { DEFAULT_WORKING_DAYS, formatAvailableDays } from "@/lib/working-days";
import { cn } from "@/lib/utils";

import { Card, CardContent } from "@/components/ui/card";

// The AE's single "This week" section: personal momentum (the hero) plus a
// compact, secondary leaderboard for context — one card, one /api/leaderboard
// fetch. Percentages come from the server; raw goal targets never reach the
// browser.

type Props = {
  salespersonId: string;
  refreshKey: number;
};

type Standing = {
  id: string;
  first_name: string;
  percent: number | null;
  // Working-day-adjustment context from the server. Older payloads may omit
  // these, so consumers default to a full 5-day week.
  availableDays?: number;
  expectedPercent?: number;
  isHolidayWeek?: boolean;
};

/**
 * Business days remaining in the current Mon-Fri week, including today.
 *
 * `today` defaults to the current Denver business day (not the browser's
 * local clock) so a phone in another timezone shows the same "days left"
 * as the leaderboard/Weekly Focus around midnight on the Denver boundary.
 */
function businessDaysLeft(today: Date = todayInAppTimezone()): number {
  const dow = today.getDay(); // 0 Sun .. 6 Sat
  if (dow === 0 || dow === 6) return 0;
  return 6 - dow; // Mon = 5 … Fri = 1
}

type Tone = "good" | "warn" | "bad" | "neutral";

/**
 * A human, context-aware status for the weekly momentum pill. Reads percent
 * progress against where the week expects the rep to be, and leans
 * encouraging — never discouraging. "On pace" is never shown at 0%.
 *
 * `expectedPercent` is the share of this rep's AVAILABLE working days already
 * completed (server-computed from holiday/PTO adjustments). On a normal week
 * it equals (5 − daysLeft) / 5 × 100; on a 4-day week it scales so a rep out
 * for an approved day isn't judged "behind" for that day.
 */
function paceStatus(
  percent: number,
  expectedPercent: number,
  daysLeft: number,
): { label: string; tone: Tone } {
  // Over target — celebrate first, regardless of the day.
  if (percent >= 100) return { label: "Goal smashed", tone: "good" };
  // The business week is over.
  if (daysLeft === 0) return { label: "Week wrapped", tone: "neutral" };
  // Nothing logged yet — a fresh, neutral starting point, not "on pace".
  if (percent <= 0) return { label: "Ready to start", tone: "neutral" };

  // Clearly ahead of the week's pace.
  if (percent >= expectedPercent + 15)
    return { label: "Strong week", tone: "good" };
  // At pace, with a small grace band so a near-miss still reads as healthy.
  if (percent >= expectedPercent - 10) return { label: "On pace", tone: "good" };
  // Some progress, but behind pace — keep it gentle and motivating.
  return { label: "Getting started", tone: "warn" };
}

const TONE_CLASS: Record<Tone, string> = {
  good: "bg-green-500/10 text-green-700 dark:text-green-400",
  warn: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  bad: "bg-red-500/10 text-red-700 dark:text-red-400",
  neutral: "bg-muted text-muted-foreground",
};

export function ThisWeekCard({ salespersonId, refreshKey }: Props) {
  const [standings, setStandings] = useState<Standing[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // apiFetch attaches the signed session token — /api/leaderboard
    // gates on requireAeToolAccess so a bare fetch would 401.
    apiFetch("/api/leaderboard")
      .then(async (res) => {
        const body = (await res.json()) as {
          standings?: Standing[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error ?? "Couldn't load this week.");
          return;
        }
        setStandings(body.standings ?? []);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Couldn't load this week.");
      });
    return () => {
      cancelled = true;
    };
  }, [salespersonId, refreshKey]);

  return (
    <section className="space-y-1.5">
      <h2 className="px-0.5 text-sm font-medium text-muted-foreground">
        This week
      </h2>
      <Card
        size="sm"
        className="border-primary/15 bg-gradient-to-br from-primary/[0.07] to-card"
      >
        <CardContent>
          {error ? (
            <p className="text-sm text-destructive">
              Couldn&apos;t load: {error}
            </p>
          ) : !standings ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <ThisWeekBody
              standings={standings}
              salespersonId={salespersonId}
            />
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function ThisWeekBody({
  standings,
  salespersonId,
}: {
  standings: Standing[];
  salespersonId: string;
}) {
  // Rank by percent (no goal = lowest), name as tiebreak.
  const ranked = [...standings].sort(
    (a, b) =>
      (b.percent ?? -1) - (a.percent ?? -1) ||
      a.first_name.localeCompare(b.first_name),
  );
  const myIndex = ranked.findIndex((s) => s.id === salespersonId);
  const mine = myIndex >= 0 ? ranked[myIndex] : null;

  // Top 3, plus the current rep's row when they sit outside it.
  const rows: Array<{ standing: Standing; rank: number; detached: boolean }> =
    ranked.slice(0, 3).map((standing, i) => ({
      standing,
      rank: i + 1,
      detached: false,
    }));
  if (myIndex >= 3 && mine) {
    rows.push({ standing: mine, rank: myIndex + 1, detached: true });
  }

  // Informational time-off banner — never a goal reduction, just context.
  // Shown for any rep whose available days dropped below a full week.
  const availableDays = mine?.availableDays ?? DEFAULT_WORKING_DAYS;
  const availabilityLabel =
    mine && availableDays < DEFAULT_WORKING_DAYS
      ? mine.isHolidayWeek
        ? `Holiday Week • ${formatAvailableDays(availableDays)} Available Days`
        : `${formatAvailableDays(availableDays)} Available Days This Week`
      : null;

  return (
    <div className="space-y-3">
      {availabilityLabel ? (
        <div className="flex items-start gap-1.5 rounded-md bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary">
          <CalendarDays aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {availabilityLabel}
            <span className="block font-normal text-primary/80">
              Targets adjusted for approved time off
            </span>
          </span>
        </div>
      ) : null}
      <Momentum mine={mine} rank={myIndex + 1} total={ranked.length} />
      <Leaderboard rows={rows} currentSalespersonId={salespersonId} />
    </div>
  );
}

/** Personal momentum — the hero of the section. */
function Momentum({
  mine,
  rank,
  total,
}: {
  mine: Standing | null;
  rank: number;
  total: number;
}) {
  if (!mine || mine.percent === null) {
    return (
      <p className="text-sm text-muted-foreground">
        Weekly momentum appears once an admin sets your weekly goal.
      </p>
    );
  }

  const percent = mine.percent;
  const daysLeft = businessDaysLeft();
  // Server-computed expected-to-date pace (available-days aware). Fall back to
  // the even Mon-Fri curve if an older payload omits it.
  const expectedPercent =
    mine.expectedPercent ?? ((5 - daysLeft) / 5) * 100;
  const status = paceStatus(percent, expectedPercent, daysLeft);
  const color = progressColor(percent);
  const daysLeftLabel =
    daysLeft === 0
      ? "Week wrapped"
      : daysLeft === 1
        ? "Final day"
        : `${daysLeft} days left`;

  return (
    <div className="space-y-2">
      <div className="flex items-end justify-between gap-2">
        <div className="flex items-baseline gap-1.5">
          <span
            className={cn(
              "text-4xl font-bold leading-none tabular-nums",
              color.text,
            )}
          >
            {percent}%
          </span>
          <span className="text-xs text-muted-foreground">of goal</span>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
            TONE_CLASS[status.tone],
          )}
        >
          <Zap aria-hidden="true" className="size-3" />
          {status.label}
        </span>
      </div>

      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all", color.bar)}
          style={{ width: `${Math.min(percent, 100)}%` }}
        />
      </div>

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Trophy aria-hidden="true" className="size-3.5 text-amber-500" />
          <span className="font-semibold text-foreground tabular-nums">
            #{rank}
          </span>
          of {total}
        </span>
        <span aria-hidden="true">·</span>
        <span className="inline-flex items-center gap-1">
          <CalendarDays aria-hidden="true" className="size-3.5" />
          {daysLeftLabel}
        </span>
      </div>
    </div>
  );
}

/** Compact, secondary leaderboard — context around the rep's week. */
function Leaderboard({
  rows,
  currentSalespersonId,
}: {
  rows: Array<{ standing: Standing; rank: number; detached: boolean }>;
  currentSalespersonId: string;
}) {
  if (rows.length === 0) return null;

  return (
    <div className="space-y-1 border-t pt-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Leaderboard
        </span>
        <Link
          href="/leaderboard"
          className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          Full →
        </Link>
      </div>
      <ul>
        {rows.map(({ standing, rank, detached }) => {
          const isMe = standing.id === currentSalespersonId;
          const { text: percentColor } = progressColor(standing.percent ?? 0);
          return (
            <li
              key={standing.id}
              className={cn(
                "flex items-center gap-2 rounded-md px-1.5 py-1",
                isMe && "bg-primary/5",
                detached && "mt-0.5 border-t border-dashed pt-1.5",
              )}
            >
              <span className="w-4 shrink-0 text-center text-xs font-semibold tabular-nums text-muted-foreground">
                {rank}
              </span>
              {rank === 1 ? (
                <Trophy
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-amber-500"
                />
              ) : (
                <span aria-hidden="true" className="size-3.5 shrink-0" />
              )}
              <span className="flex-1 truncate text-sm font-medium">
                {standing.first_name}
                {isMe && (
                  <span className="ml-1 text-xs text-muted-foreground">
                    (you)
                  </span>
                )}
              </span>
              <span
                className={cn(
                  "text-sm font-semibold tabular-nums",
                  percentColor,
                )}
              >
                {standing.percent ?? 0}%
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
