"use client";

import { useState } from "react";
import { format } from "date-fns";

import { supabase } from "@/lib/supabase/client";
import {
  ACTIVITIES,
  ZERO_ACTIVITY,
  type ActivityKey,
  type ActivityValues,
} from "@/lib/activities";

import { ActivityCounter } from "@/components/activity-counter";

type Props = {
  salespersonId: string;
  onSaved?: () => void;
};

const QUICK_ADD_EXCLUDE: ReadonlySet<ActivityKey> = new Set(["impressions"]);

export function DailyEntryForm({ salespersonId, onSaved }: Props) {
  const [inputs, setInputs] = useState<ActivityValues>(ZERO_ACTIVITY);
  const [savingKey, setSavingKey] = useState<ActivityKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setKey = (key: ActivityKey, next: number) =>
    setInputs((v) => ({ ...v, [key]: next }));

  const saveDelta = async (key: ActivityKey, delta: number) => {
    if (delta <= 0) return false;
    const today = format(new Date(), "yyyy-MM-dd");

    setSavingKey(key);
    setError(null);

    const { data: existing, error: fetchErr } = await supabase
      .from("activity_entries")
      .select(key)
      .eq("salesperson_id", salespersonId)
      .eq("entry_date", today)
      .maybeSingle();

    if (fetchErr) {
      setError(fetchErr.message);
      setSavingKey(null);
      return false;
    }

    const current = Number(
      (existing as unknown as Record<string, number> | null)?.[key] ?? 0,
    );
    const next = current + delta;

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
    <div className="space-y-3">
      {ACTIVITIES.map((a) => (
        <ActivityCounter
          key={a.key}
          id={`activity-${a.key}`}
          label={a.label}
          value={inputs[a.key]}
          onChange={(n) => setKey(a.key, n)}
          onSave={() => handleSaveRow(a.key)}
          onQuickAdd={
            QUICK_ADD_EXCLUDE.has(a.key)
              ? undefined
              : () => handleQuickAdd(a.key)
          }
          saving={savingKey === a.key}
          disabled={savingKey !== null && savingKey !== a.key}
        />
      ))}
      {error && (
        <p className="pt-2 text-sm text-destructive">Couldn&apos;t save: {error}</p>
      )}
    </div>
  );
}
