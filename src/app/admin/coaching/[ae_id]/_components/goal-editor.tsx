"use client";

import { useEffect, useMemo, useState } from "react";
import { addDays, format, parseISO } from "date-fns";
import { ChevronRight } from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { GOAL_ACTIVITY_KEYS } from "@/lib/goal-activities";
import type {
  CurrentWeeklyGoal,
  NextWeekGoalOverride,
  WeeklyGoalValues,
} from "@/lib/one-on-ones";
import { WEEKLY_GOAL_MAX_VALUE } from "@/lib/one-on-ones";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Update Weekly Goals — the EXISTING goal editor, moved here unchanged in
// behavior (same PUT /api/admin/coaching/[ae_id]/goals, same Start This Week /
// Start Next Week effective-date semantics). The 1:1 workspace renders it
// inside a collapsed-by-default disclosure so it stops dominating the page.

/** "Visits 40 · Presentations 1 · …" — the collapsed one-line summary. */
export function goalSummaryLine(goal: CurrentWeeklyGoal): string {
  if (goal.source === "none") return "No goal set";
  const SHORT: Partial<Record<keyof WeeklyGoalValues, string>> = {
    office_visits: "Visits",
    presentations: "Presentations",
    impressions: "Impressions",
    ones_scheduled: "1:1s set",
    ones_held: "1:1s held",
    service_requests: "Service",
    team_meetings: "Team mtgs",
    gold_list_touches: "Gold List",
  };
  return GOAL_ACTIVITY_KEYS.filter((a) => Number(goal.values[a.key] ?? 0) > 0)
    .map((a) => `${SHORT[a.key] ?? a.label} ${goal.values[a.key]}`)
    .join(" · ");
}

export function UpdateGoalsDisclosure(props: {
  aeId: string;
  currentGoal: CurrentWeeklyGoal;
  nextOverride: NextWeekGoalOverride | null;
  nextWeekStart: string;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-12 w-full items-center gap-2 px-4 py-3 text-left sm:px-5"
      >
        <ChevronRight
          aria-hidden="true"
          className={`size-4 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="font-semibold">Update Weekly Goals</span>
        {!open ? (
          <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
            {goalSummaryLine(props.currentGoal)}
            {props.nextOverride ? " · change scheduled next week" : ""}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="border-t border-border/60 px-4 py-4 sm:px-5">
          <NextWeekGoalsCard {...props} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * "Update goals" card. Lets the manager change an AE's weekly goals and
 * choose when the change takes effect:
 *   * Start This Week — writes a per-AE weekly_goals row at the CURRENT
 *     Monday's effective_from. The new goal applies retroactively to
 *     this Mon-Fri week (leaderboard / tracker recompute immediately)
 *     and remains active every future week until another change is made.
 *   * Start Next Week — writes at next Monday's effective_from. This
 *     week stays on the current goal; the new one takes effect Monday
 *     and remains active every future week until another change is made.
 *
 * PRODUCT MODEL — ONGOING, NOT ONE-WEEK
 *   This is NOT a one-week override. Goal changes persist until the next
 *   goal change. The underlying weekly_goals table is effective-dated,
 *   and every read site (AE dashboard, Weekly Tracker, leaderboards,
 *   reports, Weekly Focus) resolves to the latest row whose
 *   effective_from <= the week being viewed. Writing at a Monday slots
 *   the new row into that timeline; no other rows are touched.
 *
 * `nextOverride` here is still useful as a "yes there's already a row
 * scheduled at next Monday" signal — surfaced as a small notice so the
 * manager understands they're editing that future row.
 */
export function NextWeekGoalsCard({
  aeId,
  currentGoal,
  nextOverride,
  nextWeekStart,
  onChange,
}: {
  aeId: string;
  currentGoal: CurrentWeeklyGoal;
  nextOverride: NextWeekGoalOverride | null;
  nextWeekStart: string;
  onChange: () => void;
}) {
  // Default to "next_week" — the safer choice. "This week" retroactively
  // changes the in-flight leaderboard percent, so make it an explicit
  // pick rather than the default.
  type StartChoice = "this_week" | "next_week";
  const [start, setStart] = useState<StartChoice>("next_week");

  // Editable values. Seed from the existing next-Monday row if one
  // exists (so the manager picks up an in-flight scheduled change),
  // otherwise from the current week's resolved values.
  const seedValues: WeeklyGoalValues = useMemo(() => {
    return nextOverride?.values ?? currentGoal.values;
  }, [nextOverride, currentGoal]);
  const [values, setValues] = useState<WeeklyGoalValues>(seedValues);

  // Re-sync local state when the upstream detail refetches (e.g. after a
  // save round-trip). Key on the override / current row ids so an
  // unchanged detail render doesn't clobber in-progress edits — this
  // is the "sync from props that change irregularly" case.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setValues(nextOverride?.values ?? currentGoal.values);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextOverride?.id ?? "none", currentGoal.id ?? "none"]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Clear the "Saved" pill after a moment so it doesn't linger.
  useEffect(() => {
    if (!saved) return;
    const t = window.setTimeout(() => setSaved(false), 1800);
    return () => window.clearTimeout(t);
  }, [saved]);

  const setKey = (key: keyof WeeklyGoalValues, raw: string) => {
    // Empty string => 0; clamp non-finite / negative input.
    const parsed = raw === "" ? 0 : Number(raw);
    const safe =
      Number.isFinite(parsed) && parsed >= 0
        ? Math.min(WEEKLY_GOAL_MAX_VALUE, Math.floor(parsed))
        : 0;
    setValues((v) => ({ ...v, [key]: safe }));
  };

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await apiFetch(`/api/admin/coaching/${aeId}/goals`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start, values }),
      });
      if (!res.ok) {
        const reason = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(reason?.error ?? `Couldn't save (${res.status}).`);
        return;
      }
      setSaved(true);
      onChange();
    } catch {
      setError("Couldn't save — please retry.");
    } finally {
      setSaving(false);
    }
  };

  // Friendly Mon-Fri label for whichever week the manager is targeting.
  const nextWeekLabel = nextWeekStart
    ? `${format(parseISO(nextWeekStart), "MMM d")}–${format(
        addDays(parseISO(nextWeekStart), 4),
        "MMM d",
      )}`
    : "next week";
  const thisMondayIso = nextWeekStart
    ? format(addDays(parseISO(nextWeekStart), -7), "yyyy-MM-dd")
    : null;
  const thisWeekLabel = thisMondayIso
    ? `${format(parseISO(thisMondayIso), "MMM d")}–${format(
        addDays(parseISO(thisMondayIso), 4),
        "MMM d",
      )}`
    : "this week";

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Change the AE&apos;s ongoing goals and pick when the change takes
        effect — manager only. Goal changes are operational: they are not
        part of the 1:1 record.
      </p>
        <fieldset className="space-y-2">
          <legend className="text-xs uppercase tracking-wide text-muted-foreground">
            When should this change take effect?
          </legend>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={`goal-start-${aeId}`}
              value="this_week"
              checked={start === "this_week"}
              onChange={() => setStart("this_week")}
              disabled={saving}
              className="mt-0.5 size-4 border-border accent-primary"
            />
            <span className="flex flex-col">
              <span>
                Start This Week
                <span className="ml-1 text-muted-foreground">
                  ({thisWeekLabel})
                </span>
              </span>
              <span className="text-[11px] text-muted-foreground">
                These goals will apply starting this week and continue
                until changed again. The leaderboard and tracker
                recompute against the new targets immediately.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={`goal-start-${aeId}`}
              value="next_week"
              checked={start === "next_week"}
              onChange={() => setStart("next_week")}
              disabled={saving}
              className="mt-0.5 size-4 border-border accent-primary"
            />
            <span className="flex flex-col">
              <span>
                Start Next Week
                <span className="ml-1 text-muted-foreground">
                  ({nextWeekLabel})
                </span>
              </span>
              <span className="text-[11px] text-muted-foreground">
                These goals will apply starting next week and continue
                until changed again. This week stays on the current
                goal.
              </span>
            </span>
          </label>
        </fieldset>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-1 text-left font-semibold">Goal</th>
                <th className="py-1 text-right font-semibold">Current</th>
                <th className="py-1 text-right font-semibold">New</th>
              </tr>
            </thead>
            <tbody>
              {GOAL_ACTIVITY_KEYS.map((a) => (
                <tr
                  key={a.key}
                  className="border-t border-border/60 last:border-b"
                >
                  <td className="py-1.5">{a.label}</td>
                  <td className="py-1.5 text-right text-muted-foreground tabular-nums">
                    {Number(currentGoal.values[a.key] ?? 0)}
                  </td>
                  <td className="py-1.5 text-right">
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={WEEKLY_GOAL_MAX_VALUE}
                      step={1}
                      value={values[a.key]}
                      onChange={(e) => setKey(a.key, e.target.value)}
                      disabled={saving}
                      className="ml-auto h-8 w-20 text-right tabular-nums"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {nextOverride && start === "next_week" && (
          <p className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
            A goal change is already scheduled for {nextWeekLabel}. Saving
            here updates that scheduled row in place.
          </p>
        )}
        {nextOverride && start === "this_week" && (
          <p className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
            Heads up: a separate goal change is already scheduled for{" "}
            {nextWeekLabel}. Starting this week sets the goal now, but
            that scheduled change still takes over on{" "}
            {nextWeekStart
              ? format(parseISO(nextWeekStart), "MMM d")
              : "next Monday"}
            .
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {start === "this_week"
              ? `Saving applies these goals starting ${thisWeekLabel} and continues until changed again.`
              : `Saving applies these goals starting ${nextWeekLabel} and continues until changed again.`}
          </p>
          <div className="flex items-center gap-2">
            {error && (
              <span
                role="alert"
                className="text-[10px] font-semibold uppercase tracking-wide text-destructive"
              >
                {error}
              </span>
            )}
            {saved && !error && (
              <span className="text-[10px] font-medium uppercase tracking-wide text-green-600 dark:text-green-400">
                Saved
              </span>
            )}
            <Button type="button" size="sm" onClick={submit} disabled={saving}>
              {saving
                ? "Saving…"
                : start === "this_week"
                  ? "Save (start this week)"
                  : "Save (start next week)"}
            </Button>
          </div>
        </div>
    </div>
  );
}
