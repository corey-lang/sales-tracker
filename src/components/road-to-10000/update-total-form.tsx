"use client";

import { useState } from "react";

import { apiFetch } from "@/lib/api-client";
import { formatPercent, formatWhole, type RoadView } from "@/lib/road-to-10000";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// "Update Road to 10,000" — Corey and Tonja (the server enforces who).
//
// ONE number: the current CUMULATIVE Homescriptions sold, straight from the
// Cogent Closed Transactions report. No daily adds, no weekly adds, no deltas, no
// math. Everything else is calculated from it.
//
// A total LOWER than the current one is only accepted as an explicit correction
// with a short reason; the earlier value stays in the history either way.

export function UpdateTotalForm({ view, onSaved }: { view: RoadView; onSaved: (view: RoadView) => void }) {
  const target = view.goal.target;
  const current = view.latest?.total ?? null;

  const [raw, setRaw] = useState("");
  const [isCorrection, setIsCorrection] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const trimmed = raw.trim();
  const parsed = trimmed === "" ? null : Number(trimmed);
  const isWhole = parsed !== null && Number.isInteger(parsed);
  const inRange = isWhole && parsed >= 0 && parsed <= target;
  const lower = inRange && current !== null && parsed < current;
  const problem =
    trimmed === ""
      ? null
      : !isWhole
        ? "Enter a whole number."
        : parsed < 0
          ? "The total can't be negative."
          : parsed > target
            ? `The total can't be more than ${formatWhole(target)}.`
            : null;
  const needsReason = lower || isCorrection;
  const canSave = inRange && !busy && (!needsReason || (lower ? isCorrection : true)) && (!isCorrection || note.trim() !== "");

  const submit = async () => {
    if (!canSave || parsed === null) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await apiFetch("/api/road-to-10000", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          total: parsed,
          expected_latest_id: view.latest?.id ?? null,
          ...(isCorrection ? { is_correction: true, note: note.trim() } : {}),
        }),
      });
      const body = (await res.json().catch(() => null)) as (RoadView & { error?: string; view?: RoadView; code?: string }) | null;
      if (res.status === 201 && body) {
        onSaved(body);
        setRaw("");
        setIsCorrection(false);
        setNote("");
        setSaved(true);
        return;
      }
      if (res.status === 409 && body?.code === "stale" && body.view) {
        onSaved(body.view); // show what's current; keep what was typed
        setError("Someone else just updated the total. The latest is shown above — check your number and save again.");
        return;
      }
      if (res.status === 409 && body?.code === "lower_than_current") {
        setError("That's lower than the current total. If you're correcting a mistake, check “This is a correction” and add a reason.");
        return;
      }
      setError(body?.error ?? `Couldn't save (${res.status}).`);
    } catch {
      setError("Couldn't reach the server — nothing was saved. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div>
        <h2 className="text-base font-semibold">Update Road to 10,000</h2>
        <p className="text-sm text-muted-foreground">
          Enter the current <span className="font-medium text-foreground">cumulative</span> total from the Cogent Closed
          Transactions report. Don&apos;t add anything up — just the number the report shows.
        </p>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Homescriptions Sold</span>
        <Input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder={current !== null ? String(current) : "e.g. 7842"}
          value={raw}
          disabled={busy}
          aria-invalid={Boolean(problem)}
          onChange={(e) => {
            setRaw(e.target.value.replace(/[,\s]/g, ""));
            setSaved(false);
          }}
          className="min-h-12 text-lg tabular-nums"
        />
        {problem ? (
          <span role="alert" className="text-xs font-medium text-destructive">
            {problem}
          </span>
        ) : inRange ? (
          <span className="text-xs text-muted-foreground">
            {formatWhole(parsed)} / {formatWhole(target)} — {formatPercent((parsed / target) * 100)}% complete
            {current !== null ? ` (current: ${formatWhole(current)})` : ""}
          </span>
        ) : null}
      </label>

      {lower ? (
        <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
          That&apos;s lower than the current total ({formatWhole(current as number)}). A total only goes down when you&apos;re
          correcting a mistake — check the box below and say why. The earlier number stays in the history.
        </p>
      ) : null}

      <label className="flex min-h-11 items-start gap-3 rounded-md border border-border/70 px-3 py-2.5 text-sm">
        <input
          type="checkbox"
          checked={isCorrection}
          disabled={busy}
          onChange={(e) => setIsCorrection(e.target.checked)}
          className="mt-0.5 size-5 shrink-0 accent-primary"
        />
        <span>
          <span className="font-medium">This is a correction</span>
          <span className="block text-xs text-muted-foreground">Fixing a number entered by mistake.</span>
        </span>
      </label>

      {isCorrection || lower ? (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Reason for the correction</span>
          <Input
            value={note}
            maxLength={500}
            disabled={busy}
            placeholder="e.g. Typo — meant 7,482"
            onChange={(e) => setNote(e.target.value)}
            className="min-h-11"
          />
        </label>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="text-sm font-medium text-primary">
          Saved.
        </p>
      ) : null}

      <div>
        <Button type="submit" size="lg" className="min-h-11" disabled={!canSave}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
