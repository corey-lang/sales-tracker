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
import { formatDateMDY } from "@/lib/dates";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Props = {
  salespersonId: string;
  refreshKey?: number;
  onSaved?: () => void;
};

export function EditEntryCard({
  salespersonId,
  refreshKey = 0,
  onSaved,
}: Props) {
  const today = format(new Date(), "yyyy-MM-dd");
  const [date, setDate] = useState(today);
  const [values, setValues] = useState<ActivityValues>(ZERO_ACTIVITY);
  const [hasExisting, setHasExisting] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from("activity_entries")
      .select(ACTIVITIES.map((a) => a.key).join(","))
      .eq("salesperson_id", salespersonId)
      .eq("entry_date", date)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setError(error.message);
          setHasExisting(null);
          return;
        }
        const next: ActivityValues = { ...ZERO_ACTIVITY };
        if (data) {
          const row = data as unknown as Partial<ActivityValues>;
          for (const a of ACTIVITIES) {
            next[a.key] = Number(row[a.key] ?? 0);
          }
        }
        setValues(next);
        setHasExisting(!!data);
        setError(null);
        setSavedMsg(null);
      });
    return () => {
      cancelled = true;
    };
  }, [salespersonId, date, refreshKey]);

  const setKey = (key: ActivityKey, n: number) =>
    setValues((v) => ({ ...v, [key]: Math.max(0, Math.floor(n) || 0) }));

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    const { error: upsertErr } = await supabase
      .from("activity_entries")
      .upsert(
        {
          salesperson_id: salespersonId,
          entry_date: date,
          ...values,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "salesperson_id,entry_date" },
      );
    setSaving(false);
    if (upsertErr) {
      setError(upsertErr.message);
      return;
    }
    setSavedMsg(`Saved entry for ${formatDateMDY(date)}.`);
    setHasExisting(true);
    onSaved?.();
  };

  const summary = ACTIVITIES.filter((a) => values[a.key] > 0)
    .map((a) => `${a.label} ${values[a.key]}`)
    .join(", ");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit or backfill entry</CardTitle>
        <CardDescription>
          Override today&apos;s totals or fill in a past day. Sets absolute
          values (the Log activity form above adds increments instead).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="edit-date">Date</Label>
          <Input
            id="edit-date"
            type="date"
            value={date}
            max={today}
            onChange={(e) => setDate(e.target.value)}
            className="w-44"
            disabled={saving}
          />
        </div>

        {hasExisting === true && (
          <p className="text-sm text-muted-foreground">
            ✓ Existing entry loaded for {formatDateMDY(date)}.{" "}
            {summary
              ? `Was: ${summary}.`
              : "All values were zero."}{" "}
            Edit below and save to overwrite.
          </p>
        )}
        {hasExisting === false && (
          <p className="text-sm text-muted-foreground">
            No entry yet for {formatDateMDY(date)}. Fill in values and save to
            create one.
          </p>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {ACTIVITIES.map((a) => (
            <div key={a.key} className="space-y-1.5">
              <Label htmlFor={`edit-${a.key}`}>{a.label}</Label>
              <Input
                id={`edit-${a.key}`}
                type="number"
                inputMode="numeric"
                min={0}
                placeholder="0"
                value={values[a.key] === 0 ? "" : values[a.key]}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => {
                  const raw = e.target.value;
                  const next = raw === "" ? 0 : Number(raw);
                  setKey(a.key, next);
                }}
                disabled={saving}
              />
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save entry"}
          </Button>
          {error && (
            <p className="text-sm text-destructive">Couldn&apos;t save: {error}</p>
          )}
          {savedMsg && !error && (
            <p className="text-sm text-green-600 dark:text-green-400">
              {savedMsg}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
