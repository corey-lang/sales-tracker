"use client";

import { useEffect, useMemo, useState } from "react";

import { supabase } from "@/lib/supabase/client";
import {
  ACTIVITIES,
  ZERO_ACTIVITY,
  type ActivityKey,
  type ActivityValues,
} from "@/lib/activities";
import { recentBusinessWeeks } from "@/lib/goals";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// `activity_entries` stores daily rows (one per salesperson_id + entry_date).
// A "week" here is the Monday-Friday business week the rest of the app reports
// on (see businessWeekToDateRange / weekStartsOn:1). This card loads the
// Mon-Fri SUM for the selected week and, on save, consolidates the whole week
// onto the Monday (week-start) row, then deletes that week's Tue-Fri rows so
// the Mon-Fri sum equals the entered weekly total exactly — no double count.
// Saturday/Sunday rows are intentionally left alone: they fall outside the
// business week every other view sums over, so the editor never shows or
// touches them. Deletes are scoped to this salesperson and this week only.

type Props = {
  salespersonId: string;
  refreshKey?: number;
  onSaved?: () => void;
};

export function EditWeekCard({
  salespersonId,
  refreshKey = 0,
  onSaved,
}: Props) {
  const weeks = useMemo(() => recentBusinessWeeks(12), []);
  const [weekStart, setWeekStart] = useState(weeks[0].weekStart);
  const [values, setValues] = useState<ActivityValues>(ZERO_ACTIVITY);
  const [hasExisting, setHasExisting] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const selectedWeek =
    weeks.find((w) => w.weekStart === weekStart) ?? weeks[0];
  const friday = selectedWeek.friday;

  useEffect(() => {
    let cancelled = false;
    supabase
      .from("activity_entries")
      .select(ACTIVITIES.map((a) => a.key).join(","))
      .eq("salesperson_id", salespersonId)
      .gte("entry_date", weekStart)
      .lte("entry_date", friday)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setError(error.message);
          setHasExisting(null);
          return;
        }
        const rows = (data ?? []) as unknown as Array<Partial<ActivityValues>>;
        const next: ActivityValues = { ...ZERO_ACTIVITY };
        for (const row of rows) {
          for (const a of ACTIVITIES) {
            next[a.key] += Number(row[a.key] ?? 0);
          }
        }
        setValues(next);
        setHasExisting(rows.length > 0);
        setError(null);
        setSavedMsg(null);
      });
    return () => {
      cancelled = true;
    };
  }, [salespersonId, weekStart, friday, refreshKey]);

  const setKey = (key: ActivityKey, n: number) =>
    setValues((v) => ({ ...v, [key]: Math.max(0, Math.floor(n) || 0) }));

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSavedMsg(null);

    // 1. Write the full weekly total onto the Monday (week-start) row.
    const { error: upsertErr } = await supabase
      .from("activity_entries")
      .upsert(
        {
          salesperson_id: salespersonId,
          entry_date: weekStart,
          ...values,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "salesperson_id,entry_date" },
      );
    if (upsertErr) {
      setSaving(false);
      setError(upsertErr.message);
      return;
    }

    // 2. Remove this week's Tue-Fri rows so the Mon-Fri sum equals the
    //    weekly total. gt(weekStart) excludes Monday; the salesperson_id
    //    filter and the date range keep other AEs, other weeks, and the
    //    Sat/Sun rows untouched.
    const { error: delErr } = await supabase
      .from("activity_entries")
      .delete()
      .eq("salesperson_id", salespersonId)
      .gt("entry_date", weekStart)
      .lte("entry_date", friday);
    setSaving(false);
    if (delErr) {
      setError(delErr.message);
      return;
    }

    setSavedMsg(`Saved weekly totals for ${selectedWeek.label}.`);
    setHasExisting(true);
    onSaved?.();
  };

  const summary = ACTIVITIES.filter((a) => values[a.key] > 0)
    .map((a) => `${a.label} ${values[a.key]}`)
    .join(", ");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit or backfill week</CardTitle>
        <CardDescription>
          Override or fill in a whole Monday-Friday week. The numbers below are
          the week&apos;s <strong>totals</strong> and replace whatever is
          stored for that week (the Log activity form above adds increments
          instead).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="edit-week">Select week</Label>
          <Select
            value={weekStart}
            onValueChange={setWeekStart}
          >
            <SelectTrigger id="edit-week" className="w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {weeks.map((w) => (
                <SelectItem key={w.weekStart} value={w.weekStart}>
                  {w.label}
                  {w.isCurrent ? " (current week)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {hasExisting === true && (
          <p className="text-sm text-muted-foreground">
            ✓ Existing weekly entry loaded for {selectedWeek.label}.{" "}
            {summary ? `Was: ${summary}.` : "All values were zero."} Edit below
            and save to replace the week&apos;s totals.
          </p>
        )}
        {hasExisting === false && (
          <p className="text-sm text-muted-foreground">
            No entries yet for {selectedWeek.label}. Fill in the week&apos;s
            totals and save to create them.
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
            {saving ? "Saving…" : "Save week"}
          </Button>
          {error && (
            <p className="text-sm text-destructive">
              Couldn&apos;t save: {error}
            </p>
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
