"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  addDays,
  endOfMonth,
  format,
  startOfMonth,
  startOfWeek,
  subMonths,
  subWeeks,
} from "date-fns";

import { apiFetchJson } from "@/lib/api-client";
import { useSalesperson } from "@/lib/use-salesperson";
import { useScrollToTop } from "@/lib/use-scroll-to-top";
import { todayInAppTimezone, formatDateMDY } from "@/lib/dates";
import { progressColor } from "@/lib/goals";
import { cn } from "@/lib/utils";

import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Logo } from "@/components/logo";
import { BottomNav, BOTTOM_NAV_SPACER } from "@/components/bottom-nav";

// AE "My Activity" — the logged-in rep's own activity report for a date range,
// scored by the shared Range Goal Engine (same math as the admin surface). The
// route (/api/me/activity-report) hard-scopes to the session AE, so this page
// can only ever show the caller's own numbers.

const ACTIVITY_LABELS: Record<string, string> = {
  office_visits: "Visits",
  service_requests: "Reqs",
  ones_scheduled: "1:1 Scheduled",
  ones_held: "1:1 Held",
  presentations: "Presentations",
  impressions: "Impressions",
  team_meetings: "Meetings",
  gold_list_touches: "Gold List",
};

type ActivityRow = {
  key: string;
  actual: number;
  target: number;
  percent: number | null;
};

type WeekRow = {
  weekStart: string;
  rangeStart: string;
  rangeEnd: string;
  businessDaysInRange: number;
  availableDays: number;
  isHolidayWeek: boolean;
};

type Report = {
  from: string;
  to: string;
  isHolidayWeek: boolean;
  anyAdjusted: boolean;
  totalActual: number;
  overallPercent: number | null;
  activities: ActivityRow[];
  weekBreakdown: WeekRow[];
};

type PresetKey =
  | "this"
  | "last"
  | "last2"
  | "mtd"
  | "lastmonth"
  | "custom";

const PRESETS: { key: PresetKey; label: string }[] = [
  { key: "this", label: "This week" },
  { key: "last", label: "Last week" },
  { key: "last2", label: "Last 2 weeks" },
  { key: "mtd", label: "MTD" },
  { key: "lastmonth", label: "Last month" },
  { key: "custom", label: "Custom" },
];

const iso = (d: Date) => format(d, "yyyy-MM-dd");

/**
 * Resolve a preset to a {from,to} range, anchored to Denver today. Week presets
 * use the Sun-Sat ACTIVITY week (rolls Sunday) so weekend logging — and today's
 * Sunday activity — is included. The range engine still adjusts targets on the
 * Mon-Fri working days inside the range.
 */
function presetRange(preset: PresetKey, customFrom: string, customTo: string) {
  const today = todayInAppTimezone();
  // Current Sun-Sat activity week; `through` is already capped at today.
  const thisSunday = startOfWeek(today, { weekStartsOn: 0 });
  const thisSaturday = addDays(thisSunday, 6);
  const thisThrough = today < thisSaturday ? today : thisSaturday;
  switch (preset) {
    case "this":
      return { from: iso(thisSunday), to: iso(thisThrough) };
    case "last": {
      const lastSun = subWeeks(thisSunday, 1);
      return { from: iso(lastSun), to: iso(addDays(lastSun, 6)) };
    }
    case "last2":
      return { from: iso(subWeeks(thisSunday, 1)), to: iso(thisThrough) };
    case "mtd":
      return { from: iso(startOfMonth(today)), to: iso(today) };
    case "lastmonth": {
      const prev = subMonths(today, 1);
      return { from: iso(startOfMonth(prev)), to: iso(endOfMonth(prev)) };
    }
    case "custom":
      return { from: customFrom, to: customTo };
  }
}

export default function MyActivityPage() {
  const router = useRouter();
  const { salesperson, loaded } = useSalesperson();
  useScrollToTop();

  const [preset, setPreset] = useState<PresetKey>("this");
  const today = useMemo(() => iso(todayInAppTimezone()), []);
  const [customFrom, setCustomFrom] = useState(today);
  const [customTo, setCustomTo] = useState(today);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingReport, setLoadingReport] = useState(true);

  const { from, to } = useMemo(
    () => presetRange(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  );
  const rangeValid = !!from && !!to && from <= to;

  useEffect(() => {
    if (loaded && !salesperson) {
      router.replace("/");
      return;
    }
    if (loaded && salesperson?.role === "juice_box_only") {
      router.replace("/juice-box");
    }
  }, [loaded, salesperson, router]);

  useEffect(() => {
    if (!loaded || !salesperson || salesperson.role === "juice_box_only") return;
    // Invalid custom range — the render handles the message; no setState here.
    if (!rangeValid) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingReport(true);

    apiFetchJson<Report>(
      `/api/me/activity-report?from=${from}&to=${to}`,
    )
      .then((data) => {
        if (cancelled) return;
        setReport(data);
        setError(null);
        setLoadingReport(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Couldn't load your report.",
        );
        setLoadingReport(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loaded, salesperson, from, to, rangeValid]);

  if (!loaded || !salesperson) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  return (
    <>
      <main
        className={`pwa-safe-top mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-4 p-4 sm:p-6 ${BOTTOM_NAV_SPACER}`}
      >
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-muted-foreground">Your numbers</p>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              My Activity
            </h1>
          </div>
          <Logo width={160} height={49} priority className="shrink-0" />
          <Link
            href="/dashboard"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            ← Dashboard
          </Link>
        </header>

        {/* Quick range chips */}
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPreset(p.key)}
              className={cn(
                "rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
                preset === p.key
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        {preset === "custom" ? (
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              From
              <Input
                type="date"
                value={customFrom}
                max={customTo}
                onChange={(e) => setCustomFrom(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              To
              <Input
                type="date"
                value={customTo}
                min={customFrom}
                onChange={(e) => setCustomTo(e.target.value)}
              />
            </label>
          </div>
        ) : null}

        {!rangeValid ? (
          <Card>
            <CardContent className="py-6">
              <p className="text-sm text-destructive">
                Pick a start date on or before the end date.
              </p>
            </CardContent>
          </Card>
        ) : error ? (
          <Card>
            <CardContent className="py-6">
              <p className="text-sm text-destructive">{error}</p>
            </CardContent>
          </Card>
        ) : loadingReport || !report ? (
          <Card>
            <CardContent className="py-6">
              <p className="text-sm text-muted-foreground">Loading…</p>
            </CardContent>
          </Card>
        ) : (
          <>
            <SummaryCard report={report} />
            <BreakdownCard activities={report.activities} />
            {report.weekBreakdown.length > 1 ? (
              <WeekBreakdown weeks={report.weekBreakdown} />
            ) : null}
          </>
        )}
      </main>
      <BottomNav salesperson={salesperson} />
    </>
  );
}

function SummaryCard({ report }: { report: Report }) {
  const pct = report.overallPercent;
  const color = pct === null ? "text-muted-foreground" : progressColor(pct).text;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>
              {formatDateMDY(report.from)} → {formatDateMDY(report.to)}
            </CardTitle>
            <CardDescription>
              {report.totalActual} total activities
            </CardDescription>
          </div>
          <div className="text-right">
            <p className={cn("text-3xl font-bold tabular-nums leading-none", color)}>
              {pct === null ? "—" : `${pct}%`}
            </p>
            <p className="text-xs text-muted-foreground">overall</p>
          </div>
        </div>
      </CardHeader>
      {report.anyAdjusted ? (
        <CardContent>
          <p className="text-xs font-medium text-primary">
            {report.isHolidayWeek ? "Holiday in range • " : ""}
            Targets adjusted for holidays and approved time off
          </p>
        </CardContent>
      ) : null}
    </Card>
  );
}

function BreakdownCard({ activities }: { activities: ActivityRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Breakdown</CardTitle>
        <CardDescription>Actual vs. adjusted target per activity.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y">
          {activities.map((a) => {
            const color =
              a.percent === null
                ? { bar: "bg-muted-foreground/30", text: "text-muted-foreground" }
                : progressColor(a.percent);
            return (
              <li key={a.key} className="flex flex-col gap-1.5 py-2.5">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium">
                    {ACTIVITY_LABELS[a.key] ?? a.key}
                  </span>
                  <span className="tabular-nums">
                    {a.actual}
                    <span className="text-muted-foreground">/{a.target}</span>
                    <span
                      className={cn("ml-2 font-semibold", color.text)}
                    >
                      {a.percent === null ? "—" : `${a.percent}%`}
                    </span>
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn("h-full rounded-full transition-all", color.bar)}
                    style={{ width: `${Math.min(a.percent ?? 0, 100)}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function WeekBreakdown({ weeks }: { weeks: WeekRow[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center justify-between gap-3 text-left"
        >
          <CardTitle className="text-base">
            Week breakdown ({weeks.length})
          </CardTitle>
          <span className="text-sm text-muted-foreground">
            {open ? "Hide" : "Show"}
          </span>
        </button>
      </CardHeader>
      {open ? (
        <CardContent>
          <ul className="flex flex-col gap-1.5 text-sm">
            {weeks.map((w) => (
              <li
                key={w.weekStart}
                className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2"
              >
                <span className="font-medium">
                  {formatDateMDY(w.rangeStart)} → {formatDateMDY(w.rangeEnd)}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {w.isHolidayWeek ? "Holiday • " : ""}
                  {w.availableDays}/{w.businessDaysInRange} days counted
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      ) : null}
    </Card>
  );
}
