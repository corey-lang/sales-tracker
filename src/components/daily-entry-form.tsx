"use client";

import { useEffect, useState } from "react";

import {
  activityValuesFrom,
  fetchMyActivityWeek,
  incrementMyActivity,
} from "@/lib/api-activity";
import {
  ACTIVITIES,
  ZERO_ACTIVITY,
  type ActivityKey,
  type ActivityValues,
} from "@/lib/activities";
import { weeklyTargetsFrom } from "@/lib/goals";

import { ActivityCounter } from "@/components/activity-counter";

// Log-activity counters.
//
// IDENTITY: this card has no `salespersonId` prop by design. Reads and writes
// go through /api/me/activity/*, which takes the AE from the signed session
// token and re-reads their `salespeople` row — so the browser cannot name whose
// activity it is logging. It previously read and upserted `activity_entries`
// directly with the anon key, scoped by an id that came from localStorage.

type Props = {
  refreshKey?: number;
  onSaved?: () => void;
};

export function DailyEntryForm({ refreshKey = 0, onSaved }: Props) {
  const [inputs, setInputs] = useState<ActivityValues>(ZERO_ACTIVITY);
  const [weeklyTotals, setWeeklyTotals] =
    useState<ActivityValues>(ZERO_ACTIVITY);
  const [targets, setTargets] = useState<ActivityValues>(ZERO_ACTIVITY);
  const [hasGoals, setHasGoals] = useState(false);
  const [savingKey, setSavingKey] = useState<ActivityKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // One authenticated read returns this Sun-Sat activity week's totals
    // (weekend catch-up entries included) plus the caller's own goal for the
    // paired Mon-Fri week — the same pairing the client used to compute.
    fetchMyActivityWeek()
      .then((week) => {
        if (cancelled) return;
        setWeeklyTotals(activityValuesFrom(week.totals));
        const goal = week.goal ?? null;
        setHasGoals(!!goal);
        setTargets(weeklyTargetsFrom(goal));
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Server messages are author-written and safe to show (401/403 read
        // as "sign in again" / "not available for your account").
        setError(err instanceof Error ? err.message : "Could not load your week.");
      });

    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const setKey = (key: ActivityKey, next: number) =>
    setInputs((v) => ({ ...v, [key]: next }));

  const saveDelta = async (key: ActivityKey, delta: number) => {
    if (delta <= 0) return false;

    setSavingKey(key);
    setError(null);

    // The server owns both halves of the write: the `entry_date` (the Denver
    // business day, so a rep tapping just past midnight local time still lands
    // on the right day) and the salesperson (the session's AE). The read-add-
    // upsert that used to run here now runs behind requireAeToolAccess.
    try {
      const res = await incrementMyActivity(key, delta);
      setSavingKey(null);
      // Server truth, not an optimistic guess — reconciles with any concurrent
      // write (e.g. from EditWeekCard) in the same response.
      setWeeklyTotals(activityValuesFrom(res.totals));
      onSaved?.();
      return true;
    } catch (err: unknown) {
      setSavingKey(null);
      setError(err instanceof Error ? err.message : "Could not save that.");
      return false;
    }
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
