"use client";

import { useEffect, useState } from "react";
import { format } from "date-fns";

import { supabase } from "@/lib/supabase/client";
import {
  ACTIVITIES,
  ZERO_ACTIVITY,
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

export function TodayTotalsCard({ salespersonId, refreshKey }: Props) {
  const [totals, setTotals] = useState<ActivityValues>(ZERO_ACTIVITY);
  const [targets, setTargets] = useState<ActivityValues>(ZERO_ACTIVITY);
  const [hasGoals, setHasGoals] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const today = format(new Date(), "yyyy-MM-dd");

    const totalsPromise = supabase
      .from("activity_entries")
      .select(ACTIVITIES.map((a) => a.key).join(","))
      .eq("salesperson_id", salespersonId)
      .eq("entry_date", today)
      .maybeSingle();

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
        if (totalsResult.data) {
          const row = totalsResult.data as unknown as Partial<ActivityValues>;
          for (const a of ACTIVITIES) {
            nextTotals[a.key] = Number(row[a.key] ?? 0);
          }
        }
        setTotals(nextTotals);

        const goal = goalResult.data;
        setHasGoals(!!goal);
        setTargets(dailyTargetsFrom(goal));

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
        <CardTitle>Today&apos;s totals</CardTitle>
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
