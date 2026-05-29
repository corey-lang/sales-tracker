"use client";

import { useEffect, useMemo, useState } from "react";

import { useScrollToTop } from "@/lib/use-scroll-to-top";
import { supabase } from "@/lib/supabase/client";
import {
  ACTIVITIES,
  ZERO_ACTIVITY,
  type ActivityKey,
  type ActivityValues,
} from "@/lib/activities";
import {
  averagePercent,
  recentBusinessWeeks,
  resolveActiveGoal,
  weeklyTargetsFrom,
  type WeeklyGoal,
} from "@/lib/goals";
import { formatDateMDY, todayInAppTimezone } from "@/lib/dates";
import { cn } from "@/lib/utils";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Activity Reports — per-AE progress toward weekly goals for a selectable
// business week. Two views: Goal Progress (actual/goal counts) and Percentage
// (completion % per activity). Both are admin-only (admin/layout.tsx guard),
// so showing goal targets here is intended — the AE-facing leaderboard still
// never sees goals.
//
// Scoring is the app's existing logic: per-activity % is raw actual/goal, and
// the overall Score reuses averagePercent() (per-activity average with
// diminishing returns) — the same helper the leaderboard uses.

const ACTIVITY_KEYS = ACTIVITIES.map((a) => a.key);

/** Compact column labels matching the admin shorthand. */
const SHORT_LABELS: Record<ActivityKey, string> = {
  office_visits: "Visits",
  service_requests: "Reqs",
  ones_scheduled: "1:1 Sch",
  ones_held: "1:1 Held",
  presentations: "Pres",
  impressions: "Impr",
  team_meetings: "Mtgs",
  gold_list_touches: "Gold",
};

type Person = { id: string; first_name: string };
type Cell = { actual: number; goal: number; percent: number | null };
type ReportRow = {
  id: string;
  first_name: string;
  cells: Record<ActivityKey, Cell>;
  score: number | null;
};
type Tab = "progress" | "percent";
type Tone = { text: string; bar: string; chip: string };
type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; rows: ReportRow[] };

/** Color cue for a completion percentage. null = no goal set for that activity. */
function tone(percent: number | null): Tone {
  if (percent === null) {
    return {
      text: "text-muted-foreground",
      bar: "bg-muted-foreground/30",
      chip: "bg-muted text-muted-foreground",
    };
  }
  if (percent > 100) {
    return {
      text: "text-blue-600 dark:text-blue-400",
      bar: "bg-blue-500",
      chip: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
    };
  }
  if (percent >= 100) {
    return {
      text: "text-green-600 dark:text-green-400",
      bar: "bg-green-500",
      chip: "bg-green-500/15 text-green-700 dark:text-green-300",
    };
  }
  if (percent >= 50) {
    return {
      text: "text-amber-600 dark:text-amber-400",
      bar: "bg-amber-500",
      chip: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
    };
  }
  return {
    text: "text-red-600 dark:text-red-400",
    bar: "bg-red-500",
    chip: "bg-red-500/15 text-red-700 dark:text-red-300",
  };
}

export default function ActivityReportPage() {
  useScrollToTop();

  // Current business week + the prior 11 weeks; current is first.
  const weeks = useMemo(() => recentBusinessWeeks(12), []);
  const [weekStart, setWeekStart] = useState(weeks[0].weekStart);
  const week = useMemo(
    () => weeks.find((w) => w.weekStart === weekStart) ?? weeks[0],
    [weeks, weekStart],
  );

  const [tab, setTab] = useState<Tab>("progress");
  const [load, setLoad] = useState<Load>({ status: "loading" });

  // The week's reporting end — the Friday, or today for the still-running
  // week. "Today" is the Denver business-day, NOT a UTC slice — otherwise
  // the report's "through" date could disagree with the leaderboard's and
  // Weekly Focus's by up to a day at the UTC boundary.
  const today = useMemo(() => {
    const d = todayInAppTimezone();
    // YYYY-MM-DD slice of the Denver date that todayInAppTimezone()
    // already pegs to local midnight, so direct ISO slice is safe.
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
  }, []);
  const through = week.friday < today ? week.friday : today;

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoad({ status: "loading" });

    Promise.all([
      // Real AEs only — admins, the assistant, the test account, and
      // juice_box_only guests (Travis, Rizz, Faith, …) don't have goal
      // progress to report on. Positive `role = 'ae'` allow-list keeps any
      // future role out automatically; is_test stays as belt-and-suspenders
      // against the seeded test account leaking into the report.
      supabase
        .from("salespeople")
        .select("id, first_name")
        .eq("role", "ae")
        .eq("is_test", false)
        .order("first_name", { ascending: true }),
      supabase
        .from("activity_entries")
        .select(["salesperson_id", ...ACTIVITY_KEYS].join(","))
        .gte("entry_date", week.weekStart)
        .lte("entry_date", through),
      supabase.from("weekly_goals").select("*"),
    ])
      .then(([peopleRes, entriesRes, goalsRes]) => {
        if (cancelled) return;
        const err = peopleRes.error ?? entriesRes.error ?? goalsRes.error;
        if (err) {
          setLoad({ status: "error", message: err.message });
          return;
        }
        const people = (peopleRes.data ?? []) as Person[];
        const entries = (entriesRes.data ?? []) as unknown as Array<
          Partial<ActivityValues> & { salesperson_id: string }
        >;
        const goals = (goalsRes.data ?? []) as WeeklyGoal[];

        // Sum each AE's activity over the week.
        const totals = new Map<string, ActivityValues>();
        for (const p of people) totals.set(p.id, { ...ZERO_ACTIVITY });
        for (const e of entries) {
          const bucket = totals.get(e.salesperson_id);
          if (!bucket) continue;
          for (const k of ACTIVITY_KEYS) bucket[k] += Number(e[k] ?? 0);
        }

        const computed: ReportRow[] = people.map((p) => {
          const actual = totals.get(p.id) ?? { ...ZERO_ACTIVITY };
          // The goal in effect for this AE during the selected week.
          const targets = weeklyTargetsFrom(
            resolveActiveGoal(p.id, goals, through),
          );
          const cells = {} as Record<ActivityKey, Cell>;
          for (const k of ACTIVITY_KEYS) {
            const goal = targets[k];
            cells[k] = {
              actual: actual[k],
              goal,
              percent:
                goal > 0 ? Math.round((actual[k] / goal) * 100) : null,
            };
          }
          return {
            id: p.id,
            first_name: p.first_name,
            cells,
            // Overall score reuses the shared scoring helper.
            score: averagePercent(actual, targets, ACTIVITY_KEYS),
          };
        });

        // Rank by score; AEs with no goal (null) sort last.
        computed.sort((a, b) => {
          if (a.score === null && b.score === null) {
            return a.first_name.localeCompare(b.first_name);
          }
          if (a.score === null) return 1;
          if (b.score === null) return -1;
          return b.score - a.score || a.first_name.localeCompare(b.first_name);
        });
        setLoad({ status: "ready", rows: computed });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoad({
          status: "error",
          message: e instanceof Error ? e.message : "Couldn't load the report.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [week.weekStart, through]);

  const partialWeek = through < week.friday;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Activity Reports</CardTitle>
              <CardDescription>
                Each AE&apos;s progress toward their weekly goal, Monday-Friday.
                {partialWeek && ` Through ${formatDateMDY(through)}.`}
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

          {/* Report view tabs. */}
          <div className="mt-1 flex gap-1 rounded-lg border bg-muted/40 p-1">
            <TabButton
              active={tab === "progress"}
              onClick={() => setTab("progress")}
            >
              Goal Progress
            </TabButton>
            <TabButton
              active={tab === "percent"}
              onClick={() => setTab("percent")}
            >
              Percentage
            </TabButton>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <LegendDot className="bg-red-500" label="Under 50%" />
            <LegendDot className="bg-amber-500" label="50–99%" />
            <LegendDot className="bg-green-500" label="On goal" />
            <LegendDot className="bg-blue-500" label="Over goal" />
          </div>
        </CardContent>
      </Card>

      {load.status === "error" ? (
        <Card>
          <CardContent className="py-6">
            <p className="text-sm text-destructive">
              Couldn&apos;t load the report: {load.message}
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
              No AEs to report on for {week.label}.
            </p>
          </CardContent>
        </Card>
      ) : (
        load.rows.map((row) => (
          <AeReportCard key={row.id} row={row} tab={tab} />
        ))
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm ring-1 ring-border"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={cn("size-2.5 rounded-full", className)} />
      {label}
    </span>
  );
}

/** One AE — name, overall score, and a responsive grid of activity tiles. */
function AeReportCard({ row, tab }: { row: ReportRow; tab: Tab }) {
  const scoreTone = tone(row.score);
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-base">{row.first_name}</CardTitle>
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            Score
            <span
              className={cn(
                "rounded-full px-2.5 py-1 text-sm font-bold tabular-nums",
                scoreTone.chip,
              )}
            >
              {row.score === null ? "No goal" : `${row.score}%`}
            </span>
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {ACTIVITIES.map((a) => {
            const cell = row.cells[a.key];
            return tab === "progress" ? (
              <ProgressTile
                key={a.key}
                label={SHORT_LABELS[a.key]}
                cell={cell}
              />
            ) : (
              <PercentTile
                key={a.key}
                label={SHORT_LABELS[a.key]}
                percent={cell.percent}
              />
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

/** Goal Progress tile: actual/goal with a percentage bar. */
function ProgressTile({ label, cell }: { label: string; cell: Cell }) {
  const t = tone(cell.percent);
  return (
    <div className="rounded-lg border bg-muted/20 p-2.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-bold tabular-nums">
        {cell.actual}
        <span className="text-sm font-medium text-muted-foreground">
          /{cell.goal}
        </span>
      </p>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", t.bar)}
          style={{ width: `${Math.min(cell.percent ?? 0, 100)}%` }}
        />
      </div>
      <p className={cn("mt-1 text-xs font-semibold tabular-nums", t.text)}>
        {cell.percent === null ? "No goal" : `${cell.percent}%`}
      </p>
    </div>
  );
}

/** Percentage tile: just the completion percentage, color-cued. */
function PercentTile({
  label,
  percent,
}: {
  label: string;
  percent: number | null;
}) {
  const t = tone(percent);
  return (
    <div className="rounded-lg border bg-muted/20 p-2.5 text-center">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-2xl font-bold tabular-nums", t.text)}>
        {percent === null ? "—" : `${percent}%`}
      </p>
    </div>
  );
}
