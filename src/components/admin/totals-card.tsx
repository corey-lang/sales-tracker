"use client";

import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { formatDateMDY } from "@/lib/dates";
import { averagePercent, progressColor } from "@/lib/goals";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const ADMIN_ACTIVITY_KEYS = [
  { key: "office_visits", label: "Visits" },
  { key: "service_requests", label: "Reqs" },
  { key: "ones_scheduled", label: "1:1 Sch" },
  { key: "ones_held", label: "1:1 Held" },
  { key: "presentations", label: "Pres" },
  { key: "impressions", label: "Impr" },
  { key: "team_meetings", label: "Mtgs" },
  { key: "gold_list_touches", label: "Gold" },
] as const;

const ADMIN_KEY_NAMES = ADMIN_ACTIVITY_KEYS.map((a) => a.key);

export type AdminKey = (typeof ADMIN_ACTIVITY_KEYS)[number]["key"];
export type AdminValues = Record<AdminKey, number>;

export const ZERO_ADMIN: AdminValues = {
  office_visits: 0,
  service_requests: 0,
  ones_scheduled: 0,
  ones_held: 0,
  presentations: 0,
  impressions: 0,
  team_meetings: 0,
  gold_list_touches: 0,
};

type Salesperson = { id: string; first_name: string };

// One AE's range result from /api/admin/activity-totals — the Range Goal
// Engine has already summed each week's prorated, time-off-adjusted goal.
type TotalsRow = {
  id: string;
  first_name: string;
  actuals: AdminValues;
  originalTargets: AdminValues;
  adjustedTargets: AdminValues;
  availableDays: number;
  businessDaysInRange: number;
  percent: number | null;
};

type TotalsResponse = {
  isHolidayWeek: boolean;
  anyAdjusted: boolean;
  businessDays: number;
  rows: TotalsRow[];
};

type Props = {
  from: string;
  to: string;
  salespersonFilter: string; // "all" or salesperson id
  people: Salesperson[];
};

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: TotalsResponse };

function PercentBelow({ percent }: { percent: number | null }) {
  if (percent === null) return null;
  const { text } = progressColor(percent);
  return <div className={cn("text-xs tabular-nums", text)}>{percent}%</div>;
}

export function TotalsCard({ from, to, salespersonFilter, people }: Props) {
  const [load, setLoad] = useState<Load>({ status: "loading" });

  useEffect(() => {
    if (people.length === 0) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoad({ status: "loading" });

    // The Range Goal Engine (server-only — it reads working_day_adjustments)
    // computes actuals + the summed adjusted range target. apiFetch attaches
    // the admin session token. Fails closed: any non-OK response shows a safe
    // message rather than unadjusted numbers.
    const params = new URLSearchParams({ from, to, salesperson: salespersonFilter });
    apiFetch(`/api/admin/activity-totals?${params.toString()}`)
      .then(async (res) => {
        const body = (await res.json()) as Partial<TotalsResponse> & {
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setLoad({
            status: "error",
            message: body.error ?? "Couldn't load activity totals.",
          });
          return;
        }
        setLoad({
          status: "ready",
          data: {
            isHolidayWeek: body.isHolidayWeek ?? false,
            anyAdjusted: body.anyAdjusted ?? false,
            businessDays: body.businessDays ?? 0,
            rows: body.rows ?? [],
          },
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoad({
          status: "error",
          message:
            err instanceof Error ? err.message : "Couldn't load activity totals.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [from, to, salespersonFilter, people]);

  // Rank by total percent desc; null last; name tiebreak.
  const rankedRows = useMemo(() => {
    if (load.status !== "ready") return [];
    return [...load.data.rows].sort((a, b) => {
      const pa = a.percent;
      const pb = b.percent;
      if (pa === null && pb === null)
        return a.first_name.localeCompare(b.first_name);
      if (pa === null) return 1;
      if (pb === null) return -1;
      return pb - pa || a.first_name.localeCompare(b.first_name);
    });
  }, [load]);

  // Grand totals across the shown AEs.
  const grand = useMemo(() => {
    const actuals: AdminValues = { ...ZERO_ADMIN };
    const targets: AdminValues = { ...ZERO_ADMIN };
    let allCount = 0;
    let allTarget = 0;
    for (const r of rankedRows) {
      for (const a of ADMIN_ACTIVITY_KEYS) {
        actuals[a.key] += r.actuals[a.key];
        targets[a.key] += r.adjustedTargets[a.key];
        allCount += r.actuals[a.key];
        allTarget += r.adjustedTargets[a.key];
      }
    }
    // Grand "Total" % uses the same per-activity-average (diminishing-returns)
    // method as the leaderboard, so the bottom-right cell is consistent with
    // the rest of the app — not a raw sum that high-volume activities dominate.
    const allPercent = averagePercent(actuals, targets, ADMIN_KEY_NAMES);
    return { actuals, targets, allCount, allTarget, allPercent };
  }, [rankedRows]);

  // Raw per-activity completion (actual ÷ adjusted range target).
  const percentOf = (count: number, target: number): number | null =>
    target <= 0 ? null : Math.round((count / target) * 100);

  const summary =
    load.status === "ready"
      ? load.data.anyAdjusted
        ? `${load.data.isHolidayWeek ? "Holiday-adjusted · " : ""}targets adjusted for holidays and approved time off`
        : `${load.data.businessDays} business day${load.data.businessDays === 1 ? "" : "s"} in range · compared with weekly goals`
      : "";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity totals</CardTitle>
        <CardDescription>
          {formatDateMDY(from)} → {formatDateMDY(to)},{" "}
          {salespersonFilter === "all" ? "all reps" : "1 rep"}
          {summary ? <> · {summary}</> : null}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {load.status === "loading" ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : load.status === "error" ? (
          <p className="text-sm text-destructive">{load.message}</p>
        ) : rankedRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No salespeople.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Salesperson</th>
                  {ADMIN_ACTIVITY_KEYS.map((a) => (
                    <th
                      key={a.key}
                      className="py-2 px-2 text-right font-medium"
                    >
                      {a.label}
                    </th>
                  ))}
                  <th className="py-2 pl-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {rankedRows.map((r) => (
                  <tr key={r.id} className="border-b last:border-b-0">
                    <td className="py-2 pr-3 font-medium align-top">
                      {r.first_name}
                    </td>
                    {ADMIN_ACTIVITY_KEYS.map((a) => {
                      const count = r.actuals[a.key];
                      const target = r.adjustedTargets[a.key];
                      return (
                        <td
                          key={a.key}
                          className="py-2 px-2 text-right align-top"
                        >
                          <div className="tabular-nums">
                            {count}
                            <span className="text-xs text-muted-foreground">
                              /{target}
                            </span>
                          </div>
                          <PercentBelow percent={percentOf(count, target)} />
                        </td>
                      );
                    })}
                    <td className="py-2 pl-2 text-right align-top">
                      <div className="font-semibold tabular-nums">
                        {ADMIN_ACTIVITY_KEYS.reduce(
                          (s, a) => s + r.actuals[a.key],
                          0,
                        )}
                      </div>
                      <PercentBelow percent={r.percent} />
                    </td>
                  </tr>
                ))}
                {rankedRows.length > 1 && (
                  <tr className={cn("bg-muted/40")}>
                    <td className="py-2 pr-3 font-semibold align-top">
                      Grand total
                    </td>
                    {ADMIN_ACTIVITY_KEYS.map((a) => {
                      const count = grand.actuals[a.key];
                      const target = grand.targets[a.key];
                      return (
                        <td
                          key={a.key}
                          className="py-2 px-2 text-right align-top"
                        >
                          <div className="font-semibold tabular-nums">
                            {count}
                            <span className="text-xs font-normal text-muted-foreground">
                              /{target}
                            </span>
                          </div>
                          <PercentBelow percent={percentOf(count, target)} />
                        </td>
                      );
                    })}
                    <td className="py-2 pl-2 text-right align-top">
                      <div className="font-semibold tabular-nums">
                        {grand.allCount}
                        <span className="text-xs font-normal text-muted-foreground">
                          /{grand.allTarget}
                        </span>
                      </div>
                      <PercentBelow percent={grand.allPercent} />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
