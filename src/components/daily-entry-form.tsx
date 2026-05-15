"use client";

import { useEffect, useState } from "react";
import { format } from "date-fns";

import { supabase } from "@/lib/supabase/client";
import {
  ACTIVITIES,
  ZERO_ACTIVITY,
  type ActivityKey,
  type ActivityValues,
} from "@/lib/activities";
import {
  businessWeekToDateRange,
  fetchActiveGoalFor,
  weeklyTargetsFrom,
} from "@/lib/goals";

import { ActivityCounter } from "@/components/activity-counter";

type Props = {
  salespersonId: string;
  refreshKey?: number;
  onSaved?: () => void;
};

export function DailyEntryForm({
  salespersonId,
  refreshKey = 0,
  onSaved,
}: Props) {
  const [inputs, setInputs] = useState<ActivityValues>(ZERO_ACTIVITY);
  const [weeklyTotals, setWeeklyTotals] =
    useState<ActivityValues>(ZERO_ACTIVITY);
  const [targets, setTargets] = useState<ActivityValues>(ZERO_ACTIVITY);
  const [hasGoals, setHasGoals] = useState(false);
  const [savingKey, setSavingKey] = useState<ActivityKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const { since, through } = businessWeekToDateRange();

    Promise.all([
      supabase
        .from("activity_entries")
        .select(ACTIVITIES.map((a) => a.key).join(","))
        .eq("salesperson_id", salespersonId)
        .gte("entry_date", since)
        .lte("entry_date", through),
      fetchActiveGoalFor(salespersonId),
    ]).then(([totalsRes, goalRes]) => {
      if (cancelled) return;
      const firstErr = totalsRes.error ?? goalRes.error;
      if (firstErr) {
        setError(firstErr.message);
        return;
      }
      const nextTotals = { ...ZERO_ACTIVITY };
      for (const row of (totalsRes.data ??
        []) as unknown as Partial<ActivityValues>[]) {
        for (const a of ACTIVITIES) {
          nextTotals[a.key] += Number(row[a.key] ?? 0);
        }
      }
      setWeeklyTotals(nextTotals);

      const goal = goalRes.data;
      setHasGoals(!!goal);
      setTargets(weeklyTargetsFrom(goal));
      setError(null);
    });

    return () => {
      cancelled = true;
    };
  }, [salespersonId, refreshKey]);

  const setKey = (key: ActivityKey, next: number) =>
    setInputs((v) => ({ ...v, [key]: next }));

  const saveDelta = async (key: ActivityKey, delta: number) => {
    if (delta <= 0) return false;
    const today = format(new Date(), "yyyy-MM-dd");

    setSavingKey(key);
    setError(null);

    const currentToday = await supabase
      .from("activity_entries")
      .select(key)
      .eq("salesperson_id", salespersonId)
      .eq("entry_date", today)
      .maybeSingle();

    if (currentToday.error) {
      setSavingKey(null);
      setError(currentToday.error.message);
      return false;
    }

    const row = currentToday.data as Partial<ActivityValues> | null;
    const next = Number(row?.[key] ?? 0) + delta;

    const { error: upsertErr } = await supabase.from("activity_entries").upsert(
      {
        salesperson_id: salespersonId,
        entry_date: today,
        [key]: next,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "salesperson_id,entry_date" },
    );

    setSavingKey(null);
    if (upsertErr) {
      setError(upsertErr.message);
      return false;
    }
    // Optimistic update to local cache; entryVersion refetch will reconcile
    // with any concurrent writes from EditWeekCard etc.
    const { isBusinessDay } = businessWeekToDateRange();
    if (isBusinessDay) {
      setWeeklyTotals((v) => ({ ...v, [key]: v[key] + delta }));
    }
    onSaved?.();
    return true;
  };

  const handleSaveRow = async (key: ActivityKey) => {
    const ok = await saveDelta(key, inputs[key]);
    if (ok) setInputs((v) => ({ ...v, [key]: 0 }));
  };

  const handleQuickAdd = (key: ActivityKey) => {
    void saveDelta(key, 1);
  };

  return (
    <div>
      <div className="divide-y divide-border border-t border-border">
        {ACTIVITIES.map((a) => (
          <div key={a.key} className="py-4 last:pb-0">
            <ActivityCounter
              id={`activity-${a.key}`}
              label={a.label}
              value={inputs[a.key]}
              current={weeklyTotals[a.key]}
              target={targets[a.key]}
              hasGoal={hasGoals}
              onChange={(n) => setKey(a.key, n)}
              onSave={() => handleSaveRow(a.key)}
              onQuickAdd={() => handleQuickAdd(a.key)}
              saving={savingKey === a.key}
              disabled={savingKey !== null && savingKey !== a.key}
            />
          </div>
        ))}
      </div>
      {error && (
        <p className="pt-3 text-sm text-destructive">
          Couldn&apos;t save: {error}
        </p>
      )}
    </div>
  );
}
