"use client";

import { addDays, format, parseISO } from "date-fns";

import { ACTIVITIES } from "@/lib/activities";
import { progressColor } from "@/lib/goals";
import type {
  ActivityComparisonCell,
  ActivitySnapshot,
  ActivityWeekResult,
} from "@/lib/one-on-one-meetings";
import { cn } from "@/lib/utils";

// Last Week vs This Week. Pure presentation over an ActivitySnapshot that the
// server computed with buildActivityReport() — each week scored against the
// goals in effect THAT week (time-off adjusted), exactly as the leaderboard
// and activity report score it. Used live in the workspace and, frozen, in a
// completed 1:1's record; this component never computes a percentage itself.

const LABELS: Record<string, string> = {
  office_visits: "Office visits",
  service_requests: "Service requests",
  ones_scheduled: "1:1s scheduled",
  ones_held: "1:1s held",
  presentations: "Presentations",
  impressions: "Impressions",
  team_meetings: "Team meetings",
  gold_list_touches: "Gold List",
};

function weekRange(week: ActivityWeekResult): string {
  const start = parseISO(week.activity_since);
  const end = addDays(start, 6);
  const sameMonth = start.getMonth() === end.getMonth();
  return `${format(start, "MMM d")}–${format(end, sameMonth ? "d" : "MMM d")}`;
}

function pctClass(percent: number | null): string {
  return percent === null ? "text-muted-foreground" : progressColor(percent).text;
}

function Pct({ value }: { value: number | null }) {
  return (
    <span className={cn("font-semibold tabular-nums", pctClass(value))}>
      {value === null ? "—" : `${value}%`}
    </span>
  );
}

function ScoreTile({
  label,
  week,
  partial,
}: {
  label: string;
  week: ActivityWeekResult;
  partial?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        {label} · {weekRange(week)}
        {partial ? " (to date)" : ""}
      </p>
      <p
        className={cn(
          "mt-1 text-3xl font-bold leading-none tabular-nums sm:text-4xl",
          pctClass(week.score),
        )}
      >
        {week.score === null ? "—" : `${week.score}%`}
      </p>
      {week.available_days < 5 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {week.available_days} available day
          {week.available_days === 1 ? "" : "s"} — goals adjusted
          {week.is_holiday_week ? " (holiday week)" : ""}
        </p>
      ) : null}
    </div>
  );
}

/** "of 40" under a count when that week's goal differs from the Goal column. */
function GoalHint({
  cell,
  reference,
}: {
  cell: ActivityComparisonCell;
  reference: number;
}) {
  if (cell.goal === reference) return null;
  return (
    <span className="block text-[11px] text-muted-foreground">
      goal {cell.goal > 0 ? cell.goal : "—"}
    </span>
  );
}

export function ActivityResults({
  snapshot,
  frozen = false,
}: {
  snapshot: ActivitySnapshot;
  /** True when rendering a completed meeting's frozen snapshot. */
  frozen?: boolean;
}) {
  const last = snapshot.last_week;
  const current = snapshot.this_week;
  // A week is "to date" while its Saturday hasn't been reached yet.
  const partial =
    !frozen ||
    current.activity_through <
      format(addDays(parseISO(current.activity_since), 6), "yyyy-MM-dd");

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:gap-3">
        <ScoreTile label="Last week" week={last} />
        <ScoreTile label="This week" week={current} partial={partial} />
      </div>

      {/* Desktop / tablet: one row per activity, both weeks side by side. */}
      <table className="hidden w-full text-sm sm:table">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-muted-foreground">
            <th className="py-1.5 text-left font-semibold">Activity</th>
            <th className="py-1.5 text-right font-semibold">Last week</th>
            <th className="py-1.5 pr-4 text-right font-semibold">%</th>
            <th className="py-1.5 text-right font-semibold">This week</th>
            <th className="py-1.5 pr-4 text-right font-semibold">%</th>
            <th className="py-1.5 text-right font-semibold">Goal</th>
          </tr>
        </thead>
        <tbody>
          {ACTIVITIES.map((a) => {
            const l = last.cells[a.key];
            const t = current.cells[a.key];
            return (
              <tr key={a.key} className="border-t border-border/60">
                <td className="py-2">{LABELS[a.key] ?? a.label}</td>
                <td className="py-2 text-right tabular-nums">
                  {l.actual}
                  <GoalHint cell={l} reference={t.goal} />
                </td>
                <td className="py-2 pr-4 text-right">
                  <Pct value={l.percent} />
                </td>
                <td className="py-2 text-right tabular-nums">{t.actual}</td>
                <td className="py-2 pr-4 text-right">
                  <Pct value={t.percent} />
                </td>
                <td className="py-2 text-right tabular-nums text-muted-foreground">
                  {t.goal > 0 ? t.goal : "—"}
                  {t.goal !== t.original_goal ? (
                    <span className="block text-[11px]">of {t.original_goal}</span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Phone: compact rows — no horizontal scroll. */}
      <ul className="space-y-1.5 sm:hidden">
        {ACTIVITIES.map((a) => {
          const l = last.cells[a.key];
          const t = current.cells[a.key];
          return (
            <li
              key={a.key}
              className="rounded-md border border-border/60 px-3 py-2"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium">
                  {LABELS[a.key] ?? a.label}
                </span>
                <span className="text-xs text-muted-foreground">
                  Goal {t.goal > 0 ? t.goal : "—"}
                </span>
              </div>
              <div className="mt-1 grid grid-cols-2 gap-2 text-sm">
                <span>
                  <span className="text-xs text-muted-foreground">Last </span>
                  <span className="tabular-nums">{l.actual}</span>{" "}
                  <Pct value={l.percent} />
                  {l.goal !== t.goal ? (
                    <span className="text-[11px] text-muted-foreground">
                      {" "}
                      / {l.goal > 0 ? l.goal : "—"}
                    </span>
                  ) : null}
                </span>
                <span>
                  <span className="text-xs text-muted-foreground">This </span>
                  <span className="tabular-nums">{t.actual}</span>{" "}
                  <Pct value={t.percent} />
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-muted-foreground">
        {frozen
          ? `Frozen when this 1:1 was completed. `
          : "Live. "}
        Each week is scored against the goals in effect that week, the same way
        the leaderboard scores it.
      </p>
    </div>
  );
}
