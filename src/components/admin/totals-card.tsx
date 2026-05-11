"use client";

import { useEffect, useMemo, useState } from "react";
import { eachDayOfInterval, isWeekend, parseISO } from "date-fns";

import { supabase } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { formatDateMDY } from "@/lib/dates";
import { progressColor } from "@/lib/goals";

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

type GoalRow = AdminValues & {
  id: string;
  salesperson_id: string | null;
  effective_from: string;
  created_at?: string;
};

type Props = {
  from: string;
  to: string;
  salespersonFilter: string; // "all" or salesperson id
  people: Salesperson[];
};

function sortGoalsByRecency(a: GoalRow, b: GoalRow) {
  const eff = b.effective_from.localeCompare(a.effective_from);
  if (eff !== 0) return eff;
  return (b.created_at ?? "").localeCompare(a.created_at ?? "");
}

function activeGoalForPersonAt(
  personId: string,
  allGoals: GoalRow[],
  asOf: string,
): GoalRow | null {
  const personal = allGoals
    .filter(
      (g) => g.salesperson_id === personId && g.effective_from <= asOf,
    )
    .sort(sortGoalsByRecency);
  if (personal[0]) return personal[0];
  const global = allGoals
    .filter(
      (g) => g.salesperson_id === null && g.effective_from <= asOf,
    )
    .sort(sortGoalsByRecency);
  return global[0] ?? null;
}

function PercentBelow({ percent }: { percent: number | null }) {
  if (percent === null) return null;
  const { text } = progressColor(percent);
  return <div className={cn("text-xs tabular-nums", text)}>{percent}%</div>;
}

export function TotalsCard({ from, to, salespersonFilter, people }: Props) {
  const [totals, setTotals] = useState<Map<string, AdminValues>>(new Map());
  const [allGoals, setAllGoals] = useState<GoalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (people.length === 0) return;
    let cancelled = false;

    const cols = ["salesperson_id", ...ADMIN_ACTIVITY_KEYS.map((a) => a.key)];
    let totalsQuery = supabase
      .from("activity_entries")
      .select(cols.join(","))
      .gte("entry_date", from)
      .lte("entry_date", to);
    if (salespersonFilter !== "all") {
      totalsQuery = totalsQuery.eq("salesperson_id", salespersonFilter);
    }

    Promise.all([
      totalsQuery,
      supabase.from("weekly_goals").select("*"),
    ]).then(([totalsRes, goalsRes]) => {
      if (cancelled) return;
      const firstErr = totalsRes.error ?? goalsRes.error;
      if (firstErr) {
        setError(firstErr.message);
        setLoading(false);
        return;
      }
      const next = new Map<string, AdminValues>();
      for (const p of people) next.set(p.id, { ...ZERO_ADMIN });
      for (const row of (totalsRes.data ?? []) as unknown as Array<
        Partial<AdminValues> & { salesperson_id: string }
      >) {
        const bucket = next.get(row.salesperson_id);
        if (!bucket) continue;
        for (const a of ADMIN_ACTIVITY_KEYS) {
          bucket[a.key] += Number(row[a.key] ?? 0);
        }
      }
      setTotals(next);
      setAllGoals((goalsRes.data ?? []) as GoalRow[]);
      setError(null);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [from, to, salespersonFilter, people]);

  const workdays = useMemo(() => {
    try {
      const start = parseISO(from);
      const end = parseISO(to);
      if (end < start) return 0;
      return eachDayOfInterval({ start, end }).filter((d) => !isWeekend(d))
        .length;
    } catch {
      return 0;
    }
  }, [from, to]);

  const baseFilteredPeople =
    salespersonFilter === "all"
      ? people
      : people.filter((p) => p.id === salespersonFilter);

  const goalsByPerson = useMemo(() => {
    const map = new Map<string, GoalRow | null>();
    for (const p of baseFilteredPeople) {
      map.set(p.id, activeGoalForPersonAt(p.id, allGoals, to));
    }
    return map;
  }, [baseFilteredPeople, allGoals, to]);

  const computePercent = (count: number, expected: number): number | null => {
    if (expected <= 0) return null;
    return Math.round((count / expected) * 100);
  };

  // Per-person totals across all activities (for the Total column)
  const perPersonTotals = useMemo(() => {
    const out = new Map<
      string,
      { count: number; expected: number; percent: number | null }
    >();
    for (const p of baseFilteredPeople) {
      const t = totals.get(p.id) ?? ZERO_ADMIN;
      const goal = goalsByPerson.get(p.id);
      const count = ADMIN_ACTIVITY_KEYS.reduce((s, a) => s + t[a.key], 0);
      const expected = goal
        ? ADMIN_ACTIVITY_KEYS.reduce(
            (s, a) => s + Number(goal[a.key] ?? 0),
            0,
          ) * workdays
        : 0;
      out.set(p.id, {
        count,
        expected,
        percent: computePercent(count, expected),
      });
    }
    return out;
  }, [baseFilteredPeople, totals, goalsByPerson, workdays]);

  // Sort filtered people by total-percent desc; null percent goes to the
  // bottom; name as tiebreaker.
  const filteredPeople = useMemo(() => {
    const sorted = [...baseFilteredPeople];
    sorted.sort((a, b) => {
      const pa = perPersonTotals.get(a.id)?.percent ?? null;
      const pb = perPersonTotals.get(b.id)?.percent ?? null;
      if (pa === null && pb === null)
        return a.first_name.localeCompare(b.first_name);
      if (pa === null) return 1;
      if (pb === null) return -1;
      return pb - pa || a.first_name.localeCompare(b.first_name);
    });
    return sorted;
  }, [baseFilteredPeople, perPersonTotals]);

  // Grand totals across filtered AEs (Grand total row)
  const grand = useMemo(() => {
    const counts: AdminValues = { ...ZERO_ADMIN };
    const expecteds: AdminValues = { ...ZERO_ADMIN };
    let allCount = 0;
    let allExpected = 0;
    for (const p of baseFilteredPeople) {
      const t = totals.get(p.id) ?? ZERO_ADMIN;
      const goal = goalsByPerson.get(p.id);
      for (const a of ADMIN_ACTIVITY_KEYS) {
        const c = t[a.key];
        const e = goal ? Number(goal[a.key] ?? 0) * workdays : 0;
        counts[a.key] += c;
        expecteds[a.key] += e;
        allCount += c;
        allExpected += e;
      }
    }
    return { counts, expecteds, allCount, allExpected };
  }, [baseFilteredPeople, totals, goalsByPerson, workdays]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity totals</CardTitle>
        <CardDescription>
          {formatDateMDY(from)} → {formatDateMDY(to)},{" "}
          {salespersonFilter === "all" ? "all reps" : "1 rep"} ·{" "}
          {workdays} workday{workdays === 1 ? "" : "s"} in range
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">Couldn&apos;t load: {error}</p>
        ) : filteredPeople.length === 0 ? (
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
                {filteredPeople.map((p) => {
                  const t = totals.get(p.id) ?? ZERO_ADMIN;
                  const goal = goalsByPerson.get(p.id);
                  const summary = perPersonTotals.get(p.id);
                  return (
                    <tr key={p.id} className="border-b last:border-b-0">
                      <td className="py-2 pr-3 font-medium align-top">
                        {p.first_name}
                      </td>
                      {ADMIN_ACTIVITY_KEYS.map((a) => {
                        const count = t[a.key];
                        const daily = goal ? Number(goal[a.key] ?? 0) : 0;
                        const expected = daily * workdays;
                        const percent = computePercent(count, expected);
                        return (
                          <td
                            key={a.key}
                            className="py-2 px-2 text-right align-top"
                          >
                            <div className="tabular-nums">{count}</div>
                            <PercentBelow percent={percent} />
                          </td>
                        );
                      })}
                      <td className="py-2 pl-2 text-right align-top">
                        <div className="font-semibold tabular-nums">
                          {summary?.count ?? 0}
                        </div>
                        <PercentBelow percent={summary?.percent ?? null} />
                      </td>
                    </tr>
                  );
                })}
                {filteredPeople.length > 1 && (
                  <tr className={cn("bg-muted/40")}>
                    <td className="py-2 pr-3 font-semibold align-top">
                      Grand total
                    </td>
                    {ADMIN_ACTIVITY_KEYS.map((a) => {
                      const count = grand.counts[a.key];
                      const expected = grand.expecteds[a.key];
                      const percent = computePercent(count, expected);
                      return (
                        <td
                          key={a.key}
                          className="py-2 px-2 text-right align-top"
                        >
                          <div className="font-semibold tabular-nums">
                            {count}
                          </div>
                          <PercentBelow percent={percent} />
                        </td>
                      );
                    })}
                    <td className="py-2 pl-2 text-right align-top">
                      <div className="font-semibold tabular-nums">
                        {grand.allCount}
                      </div>
                      <PercentBelow
                        percent={computePercent(
                          grand.allCount,
                          grand.allExpected,
                        )}
                      />
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
