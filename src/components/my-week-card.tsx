"use client";

import { useEffect, useState } from "react";
import { format, startOfWeek } from "date-fns";

import { supabase } from "@/lib/supabase/client";
import {
  ACTIVITIES,
  ZERO_ACTIVITY,
  type ActivityKey,
  type ActivityValues,
} from "@/lib/activities";
import { dailyTargetsFrom, fetchActiveGoalFor } from "@/lib/goals";

import { ActivityProgressRow } from "@/components/activity-progress-row";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Props = {
  salespersonId: string;
  refreshKey: number;
};

function workdaysElapsedThisWeek(today: Date): number {
  const dow = today.getDay(); // 0 Sun, 1 Mon, ..., 6 Sat
  if (dow === 0 || dow === 6) return 5; // weekend → full work week done
  return dow; // Mon=1, ..., Fri=5
}

export function MyWeekCard({ salespersonId, refreshKey }: Props) {
  const [totals, setTotals] = useState<ActivityValues>(ZERO_ACTIVITY);
  const [paceTargets, setPaceTargets] = useState<ActivityValues>(ZERO_ACTIVITY);
  const [hasGoals, setHasGoals] = useState(false);
  const [workdays, setWorkdays] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const now = new Date();
    const weekStart = startOfWeek(now, { weekStartsOn: 1 });
    const since = format(weekStart, "yyyy-MM-dd");
    const elapsed = workdaysElapsedThisWeek(now);

    const totalsPromise = supabase
      .from("activity_entries")
      .select(ACTIVITIES.map((a) => a.key).join(","))
      .eq("salesperson_id", salespersonId)
      .gte("entry_date", since);

    Promise.all([totalsPromise, fetchActiveGoalFor(salespersonId)]).then(
      ([totalsResult, goalResult]) => {
        if (cancelled) return;
        const firstErr = totalsResult.error ?? goalResult.error;
        if (firstErr) {
          setError(firstErr.message);
          setLoading(false);
          return;
        }

        const nextTotals = { ...ZERO_ACTIVITY };
        for (const row of (totalsResult.data ??
          []) as unknown as Partial<ActivityValues>[]) {
          for (const a of ACTIVITIES) {
            nextTotals[a.key] += Number(row[a.key as ActivityKey] ?? 0);
          }
        }
        setTotals(nextTotals);

        const goal = goalResult.data;
        const dailies = dailyTargetsFrom(goal);
        const pace = { ...ZERO_ACTIVITY };
        for (const a of ACTIVITIES) {
          pace[a.key] = dailies[a.key] * elapsed;
        }
        setHasGoals(!!goal);
        setPaceTargets(pace);
        setWorkdays(elapsed);

        setError(null);
        setLoading(false);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [salespersonId, refreshKey]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>This week</CardTitle>
        <CardDescription>
          {hasGoals
            ? `Workday ${workdays}/5 — targets scale with the week.`
            : "Totals since Monday."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">Couldn&apos;t load: {error}</p>
        ) : (
          <ul className="space-y-3">
            {ACTIVITIES.map((a) => (
              <ActivityProgressRow
                key={a.key}
                label={a.label}
                value={totals[a.key]}
                target={paceTargets[a.key]}
                showBar={hasGoals}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
