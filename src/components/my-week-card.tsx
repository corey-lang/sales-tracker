"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/api-client";
import { supabase } from "@/lib/supabase/client";
import {
  ACTIVITIES,
  ZERO_ACTIVITY,
  type ActivityKey,
  type ActivityValues,
} from "@/lib/activities";
import {
  activityWeekToDateRange,
  adjustedTargetsFrom,
  fetchActiveGoalFor,
  pairedBusinessMonday,
} from "@/lib/goals";
import {
  DEFAULT_WORKING_DAYS,
  formatAvailableDays,
} from "@/lib/working-days";

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

export function MyWeekCard({ salespersonId, refreshKey }: Props) {
  const [totals, setTotals] = useState<ActivityValues>(ZERO_ACTIVITY);
  const [targets, setTargets] = useState<ActivityValues>(ZERO_ACTIVITY);
  const [hasGoals, setHasGoals] = useState(false);
  const [availableDays, setAvailableDays] = useState(DEFAULT_WORKING_DAYS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Displayed activity totals use the Sun-Sat logging week so weekend
    // catch-up entries show here, matching DailyEntryForm. Goal targets and
    // availability below stay on the Mon-Fri business week (adjustedTargetsFrom
    // / availableDays) — only the raw activity sum is Sun-Sat.
    const { since, through } = activityWeekToDateRange();

    const totalsPromise = supabase
      .from("activity_entries")
      .select(ACTIVITIES.map((a) => a.key).join(","))
      .eq("salesperson_id", salespersonId)
      .gte("entry_date", since)
      .lte("entry_date", through);

    // The AE's own available days come from the server (working_day_adjustments
    // is server-only). Resolves to the available-day count on success, or null
    // on ANY failure (non-OK response or network error) — we must NOT assume a
    // full 5-day week, since that would silently show ORIGINAL targets as if
    // they were the time-off-adjusted ones. Raw provider text is never read or
    // shown.
    const availPromise: Promise<number | null> = apiFetch(
      "/api/me/working-days",
    )
      .then(async (r) => {
        if (!r.ok) return null;
        const body = (await r.json()) as { availableDays?: unknown };
        return typeof body.availableDays === "number"
          ? body.availableDays
          : null;
      })
      .catch(() => null);

    Promise.all([
      totalsPromise,
      // Goal for the Mon-Fri week paired with the current Sun-Sat activity week,
      // so it aligns with the availPromise window (/api/me/working-days).
      fetchActiveGoalFor(salespersonId, pairedBusinessMonday()),
      availPromise,
    ]).then(([totalsResult, goalResult, availableDaysOrNull]) => {
      if (cancelled) return;
      if (totalsResult.error ?? goalResult.error) {
        // Raw provider text isn't shown — a generic message keeps it safe.
        setError("Couldn't load your weekly tracker.");
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

      const goal = goalResult.data;
      const goalsPresent = !!goal;

      // FAIL CLOSED: when this AE has goals, we need their available days to
      // show correct adjusted targets. If the availability read failed, show a
      // safe message rather than original targets masquerading as adjusted.
      if (goalsPresent && availableDaysOrNull === null) {
        setError("Couldn't load your weekly targets.");
        setLoading(false);
        return;
      }

      // With no goals there are no targets to adjust, so a missing availability
      // read is harmless — just show the running totals.
      const days = availableDaysOrNull ?? DEFAULT_WORKING_DAYS;

      setTotals(nextTotals);
      setAvailableDays(days);
      setHasGoals(goalsPresent);
      // Targets are reduced for approved time off (round(original × days / 5)).
      setTargets(adjustedTargetsFrom(goal, days));
      setError(null);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [salespersonId, refreshKey]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Weekly tracker</CardTitle>
        <CardDescription>
          {hasGoals
            ? "Sun-Sat logged activity, compared with adjusted weekly targets."
            : "Sun-Sat logged activity this week."}
        </CardDescription>
        {!loading &&
        !error &&
        hasGoals &&
        availableDays < DEFAULT_WORKING_DAYS ? (
          <p className="text-xs font-medium text-primary">
            {formatAvailableDays(availableDays)} Available Days This Week ·
            targets adjusted for approved time off
          </p>
        ) : null}
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          // `error` is already a complete, safe message (no raw provider text).
          <p className="text-sm text-destructive">{error}</p>
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
