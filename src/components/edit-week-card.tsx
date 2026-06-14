"use client";

import { useEffect, useMemo, useState } from "react";
import { format, parseISO } from "date-fns";

import { supabase } from "@/lib/supabase/client";
import {
  ACTIVITIES,
  ZERO_ACTIVITY,
  type ActivityKey,
  type ActivityValues,
} from "@/lib/activities";
import { todayInAppTimezone } from "@/lib/dates";
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

// Edits a whole Sunday-Saturday ACTIVITY week, split into THREE independently
// scoped sections so weekend activity is never folded into a weekday row:
//
//   - Sunday   → written only to the Sunday entry_date row.
//   - Mon-Fri  → the existing safe BUSINESS-week replacement: the entered total
//                is consolidated onto the Monday row and that week's Tue-Fri
//                rows are deleted, so the Mon-Fri sum equals the entered total.
//                Leaderboard / scorecard / admin reports read exactly this.
//   - Saturday → written only to the Saturday entry_date row.
//
// Sunday and Saturday are weekend rows: they count toward the AE dashboard's
// Sun-Sat display totals (DailyEntryForm / MyWeekCard / ActivityWeekContext)
// but stay OUT of every Mon-Fri business surface. Saving one section never
// touches another section's dates. All writes/deletes are scoped to this
// salesperson. A Sun-Sat activity week straddles two business weeks (its Sunday
// is the prior week's tail) — that's expected; each section owns its own dates.

type SavingSection = "sunday" | "week" | "saturday" | null;

type Props = {
  salespersonId: string;
  refreshKey?: number;
  onSaved?: () => void;
};

const sumRows = (
  rows: Array<Partial<ActivityValues>>,
): ActivityValues => {
  const out: ActivityValues = { ...ZERO_ACTIVITY };
  for (const row of rows) {
    for (const a of ACTIVITIES) {
      out[a.key] += Number(row[a.key] ?? 0);
    }
  }
  return out;
};

const summarize = (v: ActivityValues): string =>
  ACTIVITIES.filter((a) => v[a.key] > 0)
    .map((a) => `${a.label} ${v[a.key]}`)
    .join(", ");

const shortDate = (yyyyMmDd: string): string =>
  format(parseISO(yyyyMmDd), "MMM d");

function ActivityGrid({
  idPrefix,
  values,
  onChange,
  disabled,
}: {
  idPrefix: string;
  values: ActivityValues;
  onChange: (key: ActivityKey, n: number) => void;
  disabled: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {ACTIVITIES.map((a) => (
        <div key={a.key} className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-${a.key}`}>{a.label}</Label>
          <Input
            id={`${idPrefix}-${a.key}`}
            type="number"
            inputMode="numeric"
            min={0}
            placeholder="0"
            value={values[a.key] === 0 ? "" : values[a.key]}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => {
              const raw = e.target.value;
              onChange(a.key, raw === "" ? 0 : Number(raw));
            }}
            disabled={disabled}
          />
        </div>
      ))}
    </div>
  );
}

export function EditWeekCard({
  salespersonId,
  refreshKey = 0,
  onSaved,
}: Props) {
  const weeks = useMemo(() => recentActivityWeeks(12), []);
  const [weekStart, setWeekStart] = useState(weeks[0].weekStart);
  const [sundayValues, setSundayValues] = useState<ActivityValues>(ZERO_ACTIVITY);
  const [weekValues, setWeekValues] = useState<ActivityValues>(ZERO_ACTIVITY);
  const [saturdayValues, setSaturdayValues] =
    useState<ActivityValues>(ZERO_ACTIVITY);
  const [saving, setSaving] = useState<SavingSection>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const selectedWeek =
    weeks.find((w) => w.weekStart === weekStart) ?? weeks[0];
  const sunday = selectedWeek.weekStart;
  const monday = selectedWeek.monday;
  const friday = selectedWeek.friday;
  const saturday = selectedWeek.weekEnd;

  // On a Sunday the current activity week's Mon-Fri portion is next week's
  // business days. Those rows must NOT be written before the business week
  // begins, so the Mon-Fri section is gated until its Monday has arrived.
  // Sunday/Saturday weekend sections stay editable regardless.
  const todayStr = format(todayInAppTimezone(), "yyyy-MM-dd");
  const mondayNotOpen = monday > todayStr;

  useEffect(() => {
    let cancelled = false;
    const cols = ["entry_date", ...ACTIVITIES.map((a) => a.key)].join(",");
    supabase
      .from("activity_entries")
      .select(cols)
      .eq("salesperson_id", salespersonId)
      .gte("entry_date", sunday)
      .lte("entry_date", saturday)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setError(error.message);
          return;
        }
        const rows = (data ?? []) as unknown as Array<
          Partial<ActivityValues> & { entry_date?: string }
        >;
        // Bucket each daily row onto its own section by entry_date.
        const sundayRows = rows.filter((r) => r.entry_date === sunday);
        const saturdayRows = rows.filter((r) => r.entry_date === saturday);
        const weekRows = rows.filter(
          (r) =>
            typeof r.entry_date === "string" &&
            r.entry_date >= monday &&
            r.entry_date <= friday,
        );
        setSundayValues(sumRows(sundayRows));
        setSaturdayValues(sumRows(saturdayRows));
        setWeekValues(sumRows(weekRows));
        setError(null);
        setSavedMsg(null);
      });
    return () => {
      cancelled = true;
    };
  }, [salespersonId, sunday, monday, friday, saturday, refreshKey]);

  // Write a single weekend day (Sunday or Saturday) to its OWN entry_date row.
  // No deletes — a weekend day is one row, and we must never touch weekday rows.
  const saveDay = async (
    section: "sunday" | "saturday",
    entryDate: string,
    values: ActivityValues,
    label: string,
  ) => {
    setSaving(section);
    setError(null);
    setSavedMsg(null);
    const { error: upsertErr } = await supabase
      .from("activity_entries")
      .upsert(
        {
          salesperson_id: salespersonId,
          entry_date: entryDate,
          ...values,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "salesperson_id,entry_date" },
      );
    setSaving(null);
    if (upsertErr) {
      setError(upsertErr.message);
      return;
    }
    setSavedMsg(`Saved ${label} (${shortDate(entryDate)}).`);
    onSaved?.();
  };

  // Replace the Mon-Fri BUSINESS-week total: consolidate onto Monday, then
  // delete Tue-Fri. gt(monday) excludes Monday; lte(friday) stops at Friday —
  // so Sunday (before Monday) and Saturday (after Friday) rows are untouched.
  const saveWeek = async () => {
    // Defense in depth: never write a Mon-Fri row before the business week opens.
    if (mondayNotOpen) return;
    setSaving("week");
    setError(null);
    setSavedMsg(null);

    const { error: upsertErr } = await supabase
      .from("activity_entries")
      .upsert(
        {
          salesperson_id: salespersonId,
          entry_date: monday,
          ...weekValues,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "salesperson_id,entry_date" },
      );
    if (upsertErr) {
      setSaving(null);
      setError(upsertErr.message);
      return;
    }

    const { error: delErr } = await supabase
      .from("activity_entries")
      .delete()
      .eq("salesperson_id", salespersonId)
      .gt("entry_date", monday)
      .lte("entry_date", friday);
    setSaving(null);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    setSavedMsg(
      `Saved Mon-Fri business totals (${shortDate(monday)} – ${shortDate(friday)}).`,
    );
    onSaved?.();
  };

  const sundaySummary = summarize(sundayValues);
  const weekSummary = summarize(weekValues);
  const saturdaySummary = summarize(saturdayValues);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit activity week</CardTitle>
        <CardDescription>
          Edit a whole Sunday-Saturday activity week. Sunday starts the new
          activity week; Saturday closes it. Weekend activity is counted in AE
          dashboard totals; Mon-Fri business totals remain separate for
          business-week reporting. (The Log activity form above adds increments.)
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
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
          <p className="text-xs text-muted-foreground">
            Each section saves to its own day(s); weekend days never move into
            weekday rows.
          </p>
        </div>

        {/* Sunday — own entry_date row */}
        <section className="space-y-3 rounded-lg border border-border p-3">
          <div>
            <h3 className="text-sm font-medium">Sunday · {shortDate(sunday)}</h3>
            <p className="text-xs text-muted-foreground">
              Start of the activity week. Saved to Sunday only.
              {sundaySummary ? ` Loaded: ${sundaySummary}.` : ""}
            </p>
          </div>
          <ActivityGrid
            idPrefix="edit-sun"
            values={sundayValues}
            onChange={(k, n) =>
              setSundayValues((v) => ({ ...v, [k]: Math.max(0, Math.floor(n) || 0) }))
            }
            disabled={saving !== null}
          />
          <Button
            variant="outline"
            onClick={() => saveDay("sunday", sunday, sundayValues, "Sunday")}
            disabled={saving !== null}
          >
            {saving === "sunday" ? "Saving…" : "Save Sunday"}
          </Button>
        </section>

        {/* Mon-Fri — business-week replacement (safe) */}
        <section className="space-y-3 rounded-lg border border-border p-3">
          <div>
            <h3 className="text-sm font-medium">
              Mon-Fri business totals · {shortDate(monday)} – {shortDate(friday)}
            </h3>
            <p className="text-xs text-muted-foreground">
              These are the week&apos;s <strong>totals</strong> and replace the
              stored Mon-Fri business-week totals (leaderboard / scorecard read
              these). Weekend rows are not affected.
              {weekSummary ? ` Loaded: ${weekSummary}.` : ""}
            </p>
            {mondayNotOpen && (
              <p className="mt-1 text-xs font-medium text-primary">
                Mon-Fri business totals open Monday. Sunday activity can be
                edited above.
              </p>
            )}
          </div>
          <ActivityGrid
            idPrefix="edit-week"
            values={weekValues}
            onChange={(k, n) =>
              setWeekValues((v) => ({ ...v, [k]: Math.max(0, Math.floor(n) || 0) }))
            }
            disabled={saving !== null || mondayNotOpen}
          />
          <Button onClick={saveWeek} disabled={saving !== null || mondayNotOpen}>
            {saving === "week" ? "Saving…" : "Save Mon-Fri totals"}
          </Button>
        </section>

        {/* Saturday — own entry_date row */}
        <section className="space-y-3 rounded-lg border border-border p-3">
          <div>
            <h3 className="text-sm font-medium">
              Saturday · {shortDate(saturday)}
            </h3>
            <p className="text-xs text-muted-foreground">
              Close of the activity week. Saved to Saturday only.
              {saturdaySummary ? ` Loaded: ${saturdaySummary}.` : ""}
            </p>
          </div>
          <ActivityGrid
            idPrefix="edit-sat"
            values={saturdayValues}
            onChange={(k, n) =>
              setSaturdayValues((v) => ({
                ...v,
                [k]: Math.max(0, Math.floor(n) || 0),
              }))
            }
            disabled={saving !== null}
          />
          <Button
            variant="outline"
            onClick={() =>
              saveDay("saturday", saturday, saturdayValues, "Saturday")
            }
            disabled={saving !== null}
          >
            {saving === "saturday" ? "Saving…" : "Save Saturday"}
          </Button>
        </section>

        {error && (
          <p className="text-sm text-destructive">Couldn&apos;t save: {error}</p>
        )}
        {savedMsg && !error && (
          <p className="text-sm text-green-600 dark:text-green-400">{savedMsg}</p>
        )}
      </CardContent>
    </Card>
  );
}
