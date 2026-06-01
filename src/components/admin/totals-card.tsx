"use client";

import { useEffect, useMemo, useState } from "react";
import {
  addDays,
  eachDayOfInterval,
  format,
  isWeekend,
  parseISO,
  startOfWeek,
} from "date-fns";

import { apiFetch } from "@/lib/api-client";
import { supabase } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { formatDateMDY } from "@/lib/dates";
import {
  adjustedTargetsFrom,
  averagePercent,
  progressColor,
  weeklyTargetsFrom,
} from "@/lib/goals";
import {
  DEFAULT_WORKING_DAYS,
  formatAvailableDays,
} from "@/lib/working-days";

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
  // Per-AE available days for the week (only meaningful for a single-week
  // range). Empty = a full 5-day week / not applicable.
  const [availableDays, setAvailableDays] = useState<Map<string, number>>(
    new Map(),
  );
  const [isHolidayWeek, setIsHolidayWeek] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Working-day adjustments are per business week (available days out of 5).
  // They only map cleanly onto this card when the selected range IS exactly
  // one Mon-Fri business week — which is the default and the FiltersCard "this
  // week" buttons. For arbitrary custom ranges we leave targets unadjusted.
  const singleWeek = useMemo(() => {
    try {
      const start = parseISO(from);
      const end = parseISO(to);
      const monday = startOfWeek(start, { weekStartsOn: 1 });
      const friday = addDays(monday, 4);
      return (
        from === format(monday, "yyyy-MM-dd") &&
        to === format(friday, "yyyy-MM-dd") &&
        end >= start
      );
    } catch {
      return false;
    }
  }, [from, to]);

  useEffect(() => {
    if (people.length === 0) return;
    let cancelled = false;

    const cols = [
      "salesperson_id",
      "entry_date",
      ...ADMIN_ACTIVITY_KEYS.map((a) => a.key),
    ];
    let totalsQuery = supabase
      .from("activity_entries")
      .select(cols.join(","))
      .gte("entry_date", from)
      .lte("entry_date", to);
    if (salespersonFilter !== "all") {
      totalsQuery = totalsQuery.eq("salesperson_id", salespersonFilter);
    }

    // working_day_adjustments is server-only, so the per-AE available days come
    // from the admin route. Only fetched for a single-week range. On ANY
    // failure this throws so the whole load FAILS CLOSED — we must never show
    // unadjusted (full 5-day) targets when a holiday/PTO may apply.
    const availPromise: Promise<{
      isHolidayWeek?: boolean;
      availableDays?: Record<string, number>;
    } | null> = singleWeek
      ? apiFetch(`/api/admin/working-days/availability?weekStart=${from}`).then(
          async (r) => {
            if (!r.ok) {
              const b = (await r.json().catch(() => ({}))) as {
                error?: string;
              };
              throw new Error(
                b.error ?? "Couldn't load working day adjustments.",
              );
            }
            return r.json();
          },
        )
      : Promise.resolve(null);

    Promise.all([totalsQuery, supabase.from("weekly_goals").select("*"), availPromise])
      .then(([totalsRes, goalsRes, availData]) => {
        if (cancelled) return;
        if (totalsRes.error ?? goalsRes.error) {
          // Generic, safe message — never the raw provider text.
          setError("Couldn't load activity totals.");
          setLoading(false);
          return;
        }
        const next = new Map<string, AdminValues>();
        for (const p of people) next.set(p.id, { ...ZERO_ADMIN });
        for (const row of (totalsRes.data ?? []) as unknown as Array<
          Partial<AdminValues> & { salesperson_id: string; entry_date: string }
        >) {
          if (isWeekend(parseISO(row.entry_date))) continue;
          const bucket = next.get(row.salesperson_id);
          if (!bucket) continue;
          for (const a of ADMIN_ACTIVITY_KEYS) {
            bucket[a.key] += Number(row[a.key] ?? 0);
          }
        }
        setTotals(next);
        setAllGoals((goalsRes.data ?? []) as GoalRow[]);

        const dayMap = new Map<string, number>();
        if (availData?.availableDays) {
          for (const [id, d] of Object.entries(availData.availableDays)) {
            dayMap.set(id, Number(d));
          }
        }
        setAvailableDays(dayMap);
        setIsHolidayWeek(!!availData?.isHolidayWeek);

        setError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Fail closed — an adjustment-read failure must not degrade to
        // unadjusted targets. `err.message` here is our own safe string.
        setError(
          err instanceof Error
            ? err.message
            : "Couldn't load working day adjustments.",
        );
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [from, to, salespersonFilter, people, singleWeek]);

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

  // The TARGETS each AE is measured against: their weekly goal, REDUCED for
  // approved time off when this is a single business week
  // (adjusted = round(original × availableDays / 5), via the shared helper so
  // it matches the leaderboard and activity report). For non-single-week
  // ranges or AEs with a full 5-day week, this equals the original weekly goal.
  const expectedsByPerson = useMemo(() => {
    const map = new Map<string, AdminValues>();
    for (const p of baseFilteredPeople) {
      const goal = goalsByPerson.get(p.id) ?? null;
      const days = availableDays.get(p.id) ?? DEFAULT_WORKING_DAYS;
      const targets =
        singleWeek && days < DEFAULT_WORKING_DAYS
          ? adjustedTargetsFrom(goal, days)
          : weeklyTargetsFrom(goal);
      // Both helpers return the same 8 activity keys as AdminValues.
      map.set(p.id, targets as AdminValues);
    }
    return map;
  }, [baseFilteredPeople, goalsByPerson, availableDays, singleWeek]);

  const computePercent = (count: number, expected: number): number | null => {
    if (expected <= 0) return null;
    return Math.round((count / expected) * 100);
  };

  // Per-person totals across all activities (for the Total column).
  // The score is the average of per-activity completion percents so each
  // activity contributes equally regardless of its raw goal size.
  const perPersonTotals = useMemo(() => {
    const out = new Map<
      string,
      { count: number; percent: number | null }
    >();
    for (const p of baseFilteredPeople) {
      const t = totals.get(p.id) ?? ZERO_ADMIN;
      const count = ADMIN_ACTIVITY_KEYS.reduce((s, a) => s + t[a.key], 0);
      const expecteds = expectedsByPerson.get(p.id) ?? ZERO_ADMIN;
      out.set(p.id, {
        count,
        percent: averagePercent(t, expecteds, ADMIN_KEY_NAMES),
      });
    }
    return out;
  }, [baseFilteredPeople, totals, expectedsByPerson]);

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

  // Grand totals across filtered AEs (Grand total row). `allPercent` is the
  // average of the per-activity grand-total percents — same logic as the
  // per-person Total column, so the bottom-right cell stays consistent with
  // the rest of the row.
  const grand = useMemo(() => {
    const counts: AdminValues = { ...ZERO_ADMIN };
    const expecteds: AdminValues = { ...ZERO_ADMIN };
    let allCount = 0;
    for (const p of baseFilteredPeople) {
      const t = totals.get(p.id) ?? ZERO_ADMIN;
      const personExpecteds = expectedsByPerson.get(p.id) ?? ZERO_ADMIN;
      for (const a of ADMIN_ACTIVITY_KEYS) {
        const c = t[a.key];
        counts[a.key] += c;
        expecteds[a.key] += personExpecteds[a.key];
        allCount += c;
      }
    }
    const allPercent = averagePercent(counts, expecteds, ADMIN_KEY_NAMES);
    return { counts, expecteds, allCount, allPercent };
  }, [baseFilteredPeople, totals, expectedsByPerson]);

  // Header copy: when this single week has reduced days, say so and that
  // targets were adjusted — NOT the misleading "5 business days in range".
  const reducedAny =
    singleWeek &&
    baseFilteredPeople.some(
      (p) =>
        (availableDays.get(p.id) ?? DEFAULT_WORKING_DAYS) <
        DEFAULT_WORKING_DAYS,
    );
  // Representative available-day count for the copy: the selected AE's, else
  // the smallest among reps (a global holiday makes everyone the same).
  const repDays =
    salespersonFilter !== "all"
      ? (availableDays.get(salespersonFilter) ?? DEFAULT_WORKING_DAYS)
      : baseFilteredPeople.length > 0
        ? Math.min(
            ...baseFilteredPeople.map(
              (p) => availableDays.get(p.id) ?? DEFAULT_WORKING_DAYS,
            ),
          )
        : DEFAULT_WORKING_DAYS;
  const rangeSummary = reducedAny
    ? `${isHolidayWeek ? "Holiday week · " : ""}${formatAvailableDays(repDays)} available days · targets adjusted for approved time off`
    : `${workdays} business day${workdays === 1 ? "" : "s"} in range · compared with weekly goals`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity totals</CardTitle>
        <CardDescription>
          {formatDateMDY(from)} → {formatDateMDY(to)},{" "}
          {salespersonFilter === "all" ? "all reps" : "1 rep"} · {rangeSummary}
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
                  const expecteds = expectedsByPerson.get(p.id) ?? ZERO_ADMIN;
                  const summary = perPersonTotals.get(p.id);
                  return (
                    <tr key={p.id} className="border-b last:border-b-0">
                      <td className="py-2 pr-3 font-medium align-top">
                        {p.first_name}
                      </td>
                      {ADMIN_ACTIVITY_KEYS.map((a) => {
                        const count = t[a.key];
                        const expected = expecteds[a.key];
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
