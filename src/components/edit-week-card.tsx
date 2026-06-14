"use client";

import { useEffect, useMemo, useState } from "react";

import { supabase } from "@/lib/supabase/client";
import {
  ACTIVITIES,
  ZERO_ACTIVITY,
  type ActivityKey,
  type ActivityValues,
} from "@/lib/activities";
import { recentActivityWeeks } from "@/lib/goals";

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

// Edit the totals for one Sun-Sat ACTIVITY week (activity tracking is weekly,
// not day-by-day). On save the entered totals REPLACE that week's logged
// activity: the total is written to the week's Sunday row (the activity week's
// canonical day, always <= today) and every other day in the Sun-Sat range is
// cleared, so the week sums to exactly the entered numbers — no double count.
// Both steps run atomically in one transaction via the `replace_activity_week`
// RPC (supabase/replace_activity_week.sql), so no partial double-count state is
// ever observable on failure.
//
// Every AE-facing weekly-activity surface reads the SAME Sun-Sat window
// (DailyEntryForm, MyWeekCard, TodayTotalsCard, the leaderboard/scorecard/
// report numerators), so a saved week shows identically everywhere. Working-day
// targets, PTO, available days, and pace stay Mon-Fri and are unaffected by
// where the activity rows sit.

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
  const weeks = useMemo(() => recentActivityWeeks(12), []);
  const [weekStart, setWeekStart] = useState(weeks[0].weekStart);
  const [values, setValues] = useState<ActivityValues>(ZERO_ACTIVITY);
  const [hasExisting, setHasExisting] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const selectedWeek =
    weeks.find((w) => w.weekStart === weekStart) ?? weeks[0];
  const weekEnd = selectedWeek.weekEnd; // Saturday

  useEffect(() => {
    let cancelled = false;
    supabase
      .from("activity_entries")
      .select(ACTIVITIES.map((a) => a.key).join(","))
      .eq("salesperson_id", salespersonId)
      .gte("entry_date", weekStart)
      .lte("entry_date", weekEnd)
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
  }, [salespersonId, weekStart, weekEnd, refreshKey]);

  const setKey = (key: ActivityKey, n: number) =>
    setValues((v) => ({ ...v, [key]: Math.max(0, Math.floor(n) || 0) }));

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSavedMsg(null);

    // Replacing a week's totals is TWO steps — write the total onto the week's
    // Sunday row, then clear the rest of the Sun-Sat week — and they MUST be
    // atomic: a failure between them would leave the week double-counted. So the
    // whole replacement runs in a single Postgres transaction via the
    // `replace_activity_week` RPC (see supabase/replace_activity_week.sql)
    // instead of separate upsert + delete client calls. The RPC validates the
    // Sun-Sat window, writes Sunday, and deletes Mon..Sat — scoped to this AE
    // and this week — all-or-nothing.
    const { error: rpcErr } = await supabase.rpc("replace_activity_week", {
      p_salesperson_id: salespersonId,
      p_week_start: weekStart, // Sunday
      p_week_end: weekEnd, // Saturday
      p_values: values,
    });
    setSaving(false);
    if (rpcErr) {
      setError(rpcErr.message);
      return;
    }

    setSavedMsg(`Saved activity totals for ${selectedWeek.label}.`);
    setHasExisting(true);
    onSaved?.();
  };

  const summary = ACTIVITIES.filter((a) => values[a.key] > 0)
    .map((a) => `${a.label} ${values[a.key]}`)
    .join(", ");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit activity week</CardTitle>
        <CardDescription>
          Edit the totals for this Sunday-Saturday activity week. Saving replaces
          the week&apos;s logged activity totals. The Log activity form above
          adds increments.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="edit-week">Select activity week</Label>
          <Select value={weekStart} onValueChange={setWeekStart}>
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
            ✓ Existing totals loaded for {selectedWeek.label}.{" "}
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
                  setKey(a.key, raw === "" ? 0 : Number(raw));
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
