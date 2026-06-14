"use client";

import { useEffect, useState } from "react";

import { supabase } from "@/lib/supabase/client";
import {
  ACTIVITIES,
  ZERO_ACTIVITY,
  type ActivityValues,
} from "@/lib/activities";
import {
  activityWeekToDateRange,
  fetchActiveGoalFor,
  pairedBusinessMonday,
  weeklyTargetsFrom,
} from "@/lib/goals";

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

export function TodayTotalsCard({ salespersonId, refreshKey }: Props) {
  const [totals, setTotals] = useState<ActivityValues>(ZERO_ACTIVITY);
  const [targets, setTargets] = useState<ActivityValues>(ZERO_ACTIVITY);
  const [hasGoals, setHasGoals] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Sun-Sat activity week so weekend logging shows in the weekly totals.
    const { since, through } = activityWeekToDateRange();

    const totalsPromise = supabase
      .from("activity_entries")
      .select(ACTIVITIES.map((a) => a.key).join(","))
      .eq("salesperson_id", salespersonId)
      .gte("entry_date", since)
      .lte("entry_date", through);

    Promise.all([
      totalsPromise,
      // Goal for the Mon-Fri week paired with the current Sun-Sat activity week.
      fetchActiveGoalFor(salespersonId, pairedBusinessMonday()),
    ]).then(
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
            nextTotals[a.key] += Number(row[a.key] ?? 0);
          }
        }
        setTotals(nextTotals);

        const goal = goalResult.data;
        setHasGoals(!!goal);
        setTargets(weeklyTargetsFrom(goal));

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
        <CardTitle>Weekly totals</CardTitle>
        {!hasGoals && (
          <CardDescription>
            Add a row to <code>weekly_goals</code> to see progress vs targets.
          </CardDescription>
        )}
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
                target={targets[a.key]}
                showBar={hasGoals}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
