"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import { Trash2 } from "lucide-react";

import { apiFetch, apiFetchJson } from "@/lib/api-client";
import { supabase } from "@/lib/supabase/client";
import { formatDateMDY, todayInAppTimezone } from "@/lib/dates";
import { mondayOfWeek } from "@/lib/goals";
import { formatAvailableDays } from "@/lib/working-days";
import { useScrollToTop } from "@/lib/use-scroll-to-top";

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

// Admin → Tools → Working Day Adjustments.
//
// Admins mark days as unavailable for EVERYONE (a holiday) or for ONE AE
// (PTO/conference/travel). This reduces available working days, which adjusts
// PACE expectations only — weekly goals are never changed. Writes go through
// the admin-gated /api/admin/working-day-adjustments routes; this page reads
// the list back from the same route. The admin-role guard lives in
// admin/layout.tsx.

type Adjustment = {
  id: string;
  adjustment_date: string;
  salesperson_id: string | null;
  applies_to_all: boolean;
  day_value: number;
  reason: string;
  note: string | null;
  salesperson_name: string | null;
  created_at?: string;
};

type Salesperson = { id: string; first_name: string };

const COMMON_REASONS = [
  "Holiday",
  "PTO",
  "Conference",
  "Company Event",
  "Travel",
];

const inputClass =
  "rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export default function AdminWorkingDaysPage() {
  useScrollToTop();

  const [people, setPeople] = useState<Salesperson[]>([]);
  const [adjustments, setAdjustments] = useState<Adjustment[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // yyyy-MM-dd in the app's Denver business day — the value an <input type=date>
  // expects and the format the API validates.
  const today = useMemo(() => format(todayInAppTimezone(), "yyyy-MM-dd"), []);

  const refresh = useCallback(async () => {
    try {
      const body = await apiFetchJson<{ adjustments: Adjustment[] }>(
        "/api/admin/working-day-adjustments",
      );
      setAdjustments(body.adjustments ?? []);
      setLoadError(null);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Couldn't load adjustments.",
      );
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // AEs only, for the individual-adjustment picker.
    supabase
      .from("salespeople")
      .select("id, first_name")
      .eq("role", "ae")
      .eq("is_test", false)
      .order("first_name", { ascending: true })
      .then(({ data }) => {
        if (cancelled || !data) return;
        setPeople(data as Salesperson[]);
      });
    // refresh() sets state only after an awaited fetch (not synchronously),
    // so this is safe; the lint rule can't see through the useCallback.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // Group by the Monday of each adjustment's week, newest week first.
  const grouped = useMemo(() => {
    if (!adjustments) return [];
    const byWeek = new Map<string, Adjustment[]>();
    for (const a of adjustments) {
      const wk = mondayOfWeek(parseISO(a.adjustment_date));
      const list = byWeek.get(wk) ?? [];
      list.push(a);
      byWeek.set(wk, list);
    }
    return Array.from(byWeek.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([weekStart, items]) => ({
        weekStart,
        items: items.sort((x, y) =>
          x.adjustment_date.localeCompare(y.adjustment_date),
        ),
      }));
  }, [adjustments]);

  const handleDelete = async (id: string) => {
    if (!window.confirm("Remove this working day adjustment?")) return;
    try {
      const res = await apiFetch(`/api/admin/working-day-adjustments/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Delete failed.");
      }
      await refresh();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Delete failed.");
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Working Day Adjustments</CardTitle>
          <CardDescription>
            Mark days unavailable for a holiday (everyone) or approved time off
            (one AE). This adjusts pace expectations only —{" "}
            <span className="font-medium text-foreground">
              weekly goals are never changed
            </span>
            . A full week is 5 available days.
          </CardDescription>
        </CardHeader>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <AddGlobalForm today={today} onSaved={refresh} />
        <AddIndividualForm today={today} people={people} onSaved={refresh} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Current adjustments</CardTitle>
          <CardDescription>Grouped by week, newest first.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {loadError ? (
            <p className="text-sm text-destructive">
              Couldn&apos;t load: {loadError}
            </p>
          ) : !adjustments ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : grouped.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No adjustments yet. Every AE has 5 available days each week.
            </p>
          ) : (
            grouped.map((group) => (
              <WeekGroup
                key={group.weekStart}
                weekStart={group.weekStart}
                items={group.items}
                onDelete={handleDelete}
              />
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AddGlobalForm({
  today,
  onSaved,
}: {
  today: string;
  onSaved: () => void;
}) {
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState("Holiday");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await apiFetch("/api/admin/working-day-adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          applies_to_all: true,
          adjustment_date: date,
          reason: reason.trim(),
          note: note.trim() || null,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not save.");
      setOk("Holiday added for everyone.");
      setNote("");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add global (holiday)</CardTitle>
        <CardDescription>Applies to all AEs.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="g-date">Date</Label>
          <Input
            id="g-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="g-reason">Reason</Label>
          <Input
            id="g-reason"
            list="reason-options"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Holiday"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="g-note">Note (optional)</Label>
          <Input
            id="g-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Memorial Day"
          />
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {ok ? <p className="text-sm text-green-600">{ok}</p> : null}
        <Button onClick={submit} disabled={busy || !date || !reason.trim()}>
          {busy ? "Saving…" : "Add holiday"}
        </Button>
      </CardContent>
    </Card>
  );
}

function AddIndividualForm({
  today,
  people,
  onSaved,
}: {
  today: string;
  people: Salesperson[];
  onSaved: () => void;
}) {
  const [salespersonId, setSalespersonId] = useState("");
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState("PTO");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await apiFetch("/api/admin/working-day-adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          applies_to_all: false,
          salesperson_id: salespersonId,
          adjustment_date: date,
          reason: reason.trim(),
          note: note.trim() || null,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not save.");
      setOk("Adjustment added.");
      setNote("");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add individual (PTO/travel)</CardTitle>
        <CardDescription>Applies to one AE.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="i-ae">AE</Label>
          <select
            id="i-ae"
            className={inputClass}
            value={salespersonId}
            onChange={(e) => setSalespersonId(e.target.value)}
          >
            <option value="">Select an AE…</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.first_name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="i-date">Date</Label>
          <Input
            id="i-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="i-reason">Reason</Label>
          <Input
            id="i-reason"
            list="reason-options"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="PTO"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="i-note">Note (optional)</Label>
          <Input
            id="i-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Sales conference"
          />
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {ok ? <p className="text-sm text-green-600">{ok}</p> : null}
        <Button
          onClick={submit}
          disabled={busy || !salespersonId || !date || !reason.trim()}
        >
          {busy ? "Saving…" : "Add adjustment"}
        </Button>
      </CardContent>
      {/* Shared reason suggestions for both forms. */}
      <datalist id="reason-options">
        {COMMON_REASONS.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
    </Card>
  );
}

function WeekGroup({
  weekStart,
  items,
  onDelete,
}: {
  weekStart: string;
  items: Adjustment[];
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Week of {formatDateMDY(weekStart)}
      </p>
      <ul className="flex flex-col gap-1.5">
        {items.map((a) => (
          <li
            key={a.id}
            className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2 text-sm"
          >
            <div className="min-w-0">
              <p className="font-medium">
                {formatDateMDY(a.adjustment_date)} ·{" "}
                {a.applies_to_all
                  ? "Everyone"
                  : (a.salesperson_name ?? "Unknown AE")}
              </p>
              <p className="text-xs text-muted-foreground">
                {a.reason}
                {a.note ? ` — ${a.note}` : ""}
                {a.day_value !== 1
                  ? ` · ${formatAvailableDays(a.day_value)} day`
                  : ""}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Delete adjustment"
              onClick={() => onDelete(a.id)}
            >
              <Trash2 className="size-4 text-destructive" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
