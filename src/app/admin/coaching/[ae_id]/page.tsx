"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { addDays, format, parseISO } from "date-fns";
import {
  Archive,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Plus,
  Trash2,
  Trophy,
  Undo2,
} from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { GOAL_ACTIVITY_KEYS } from "@/lib/goal-activities";
import { progressColor } from "@/lib/goals";
import { cn } from "@/lib/utils";
import type {
  CoachingDetail,
  CoachingRelationship,
  CurrentWeeklyGoal,
  NextWeekGoalOverride,
  TrainingCommitment,
  WeeklyFocus,
  WeeklyFocusCommitment,
  WeeklyGoalValues,
} from "@/lib/one-on-ones";
import { WEEKLY_GOAL_MAX_VALUE } from "@/lib/one-on-ones";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

// Admin → Coaching → AE detail (Weekly Focus model).
//
// Layout:
//   A. Snapshot Header                  -> SnapshotSection
//   B. This Week                        -> CurrentWeekSection
//        * Carried Commitments banner   (motivational, NOT punitive)
//        * Focus / Wins / Blockers panes
//        * Training Focus / Manager Notes panes
//        * Commitments (this week)
//   C. Gold List / Key Relationships    -> RelationshipsSection (persistent)
//   D. Training Commitments             -> TrainingSection (standing)
//   E. Past weeks                       -> HistorySection
//
// The current Weekly Focus row is auto-created server-side on GET — the
// UI never asks the manager to "start" a week. Carried commitments come
// from prior weeks' open items and round-trip to their original week's
// commitment endpoint, so completing one moves it out of carryover
// without duplicating history.

type Tone = "good" | "warn" | "bad" | "neutral";

/**
 * Shared mutation wrapper for inline row actions (toggle, delete, save).
 * Returns `true` on success and fires `onSuccess`; returns `false` on
 * any non-2xx response or thrown error so the caller can flip a local
 * "failed" indicator without bouncing the UI or trusting an in-flight
 * request that never landed. Deliberately silent — failure feedback is
 * surfaced inline by each row, not via toasts/alerts.
 */
async function runMutation(
  request: () => Promise<Response>,
  onSuccess: () => void,
): Promise<boolean> {
  try {
    const res = await request();
    if (!res.ok) return false;
    onSuccess();
    return true;
  } catch {
    return false;
  }
}

const TONE_CLASS: Record<Tone, string> = {
  good: "bg-green-500/10 text-green-700 dark:text-green-400",
  warn: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  bad: "bg-red-500/10 text-red-700 dark:text-red-400",
  neutral: "bg-muted text-muted-foreground",
};

/** "Week of MMM d" — Mon-Fri range derived from a week_start Monday. */
function weekLabel(weekStart: string): string {
  const monday = parseISO(weekStart);
  const friday = addDays(monday, 4);
  return `Week of ${format(monday, "MMM d")} – ${format(friday, "MMM d")}`;
}

export default function CoachingAeDetailPage() {
  const params = useParams<{ ae_id: string }>();
  const aeId = params.ae_id;

  const [detail, setDetail] = useState<CoachingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await apiFetch(`/api/admin/coaching/${aeId}`);
    const body = (await res.json().catch(() => null)) as
      | CoachingDetail
      | { error?: string }
      | null;
    if (!res.ok || !body || "error" in body) {
      setError(
        (body && "error" in body && body.error) ||
          `Couldn't load (${res.status}).`,
      );
      return;
    }
    setDetail(body as CoachingDetail);
    setError(null);
  }, [aeId]);

  useEffect(() => {
    // Calls setState inside the async body; safe and intentional — this
    // is the bootstrap fetch for the page.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  if (error) {
    return (
      <Card>
        <CardContent className="space-y-3 py-6 text-center text-sm">
          <p className="text-destructive">Couldn&apos;t load: {error}</p>
          <Link
            href="/admin/coaching"
            className="text-primary underline-offset-4 hover:underline"
          >
            Back to Coaching
          </Link>
        </CardContent>
      </Card>
    );
  }

  if (!detail) {
    return (
      <p className="px-1 py-6 text-center text-sm text-muted-foreground">
        Loading…
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link
          href="/admin/coaching"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          All AEs
        </Link>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight">
          {detail.ae.first_name} · Weekly Focus
        </h2>
      </div>

      <SnapshotSection detail={detail} />

      <WeeklyGoalsCard
        weekTotals={detail.snapshot.week_totals}
        goal={detail.weekly_goal_current}
      />

      <NextWeekGoalsCard
        aeId={aeId}
        currentGoal={detail.weekly_goal_current}
        nextOverride={detail.weekly_goal_next_override}
        nextWeekStart={detail.next_week_start}
        onChange={refresh}
      />

      <CurrentWeekSection
        currentWeek={detail.current_week}
        managerNotes={detail.manager_notes}
        carried={detail.carried_commitments}
        onChange={refresh}
      />

      <RelationshipsSection
        aeId={aeId}
        relationships={detail.relationships}
        archived={detail.archived_relationships}
        onChange={refresh}
      />

      <TrainingSection
        aeId={aeId}
        items={detail.training}
        onChange={refresh}
      />

      <HistorySection history={detail.history} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section A — Snapshot header (unchanged from prior coaching page)
// ---------------------------------------------------------------------------

function SnapshotSection({ detail }: { detail: CoachingDetail }) {
  const { snapshot } = detail;
  const pctClass =
    snapshot.percent === null
      ? "text-muted-foreground"
      : progressColor(snapshot.percent).text;
  const ranked =
    snapshot.rank === null
      ? "—"
      : `#${snapshot.rank}${
          snapshot.total_ranked > 0 ? ` / ${snapshot.total_ranked}` : ""
        }`;
  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              This week
            </p>
            <p
              className={cn(
                "text-5xl font-bold tabular-nums leading-none",
                pctClass,
              )}
            >
              {snapshot.percent === null ? "—" : `${snapshot.percent}%`}
            </p>
          </div>
          <div className="flex flex-col items-end">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold",
                TONE_CLASS.neutral,
              )}
            >
              <Trophy aria-hidden="true" className="size-3.5" />
              Rank {ranked}
            </span>
            <TrendStrip trend={snapshot.trend} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          <Stat label="Office visits" value={snapshot.week_totals.office_visits} />
          <Stat label="1:1s held" value={snapshot.week_totals.ones_held} />
          <Stat label="1:1s set" value={snapshot.week_totals.ones_scheduled} />
          <Stat label="Service" value={snapshot.week_totals.service_requests} />
          <Stat label="Impressions" value={snapshot.week_totals.impressions} />
          <Stat
            label="Team meetings"
            value={snapshot.week_totals.team_meetings}
          />
          <Stat
            label="Gold list"
            value={snapshot.week_totals.gold_list_touches}
          />
          <Stat
            label="Biz cards"
            value={snapshot.week_totals.business_cards}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-2.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function TrendStrip({
  trend,
}: {
  trend: { week_start: string; percent: number | null }[];
}) {
  if (trend.length === 0) return null;
  return (
    <div
      className="mt-2 flex items-end gap-1"
      aria-label="Last few weeks of pace"
    >
      {trend.map((t) => {
        const pct = t.percent ?? 0;
        const display = t.percent === null ? "—" : `${t.percent}`;
        const tone =
          t.percent === null
            ? "neutral"
            : t.percent >= 100
              ? "good"
              : t.percent >= 70
                ? "warn"
                : "bad";
        return (
          <div
            key={t.week_start}
            className="flex w-12 flex-col items-center gap-1"
            title={`Week of ${format(new Date(t.week_start), "MMM d")} — ${display}%`}
          >
            <div className="flex h-10 w-full items-end overflow-hidden rounded bg-muted/60">
              <div
                className={cn(
                  "w-full",
                  tone === "good" && "bg-green-500/70",
                  tone === "warn" && "bg-amber-500/70",
                  tone === "bad" && "bg-red-500/70",
                  tone === "neutral" && "bg-muted-foreground/30",
                )}
                style={{ height: `${Math.min(100, Math.max(6, pct))}%` }}
              />
            </div>
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {display}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section B — This Week (the auto-created current Weekly Focus row)
// ---------------------------------------------------------------------------

function CurrentWeekSection({
  currentWeek,
  managerNotes,
  carried,
  onChange,
}: {
  currentWeek: WeeklyFocus & { commitments: WeeklyFocusCommitment[] };
  managerNotes: string | null;
  carried: CoachingDetail["carried_commitments"];
  onChange: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <CardTitle>This Week</CardTitle>
            <CardDescription>{weekLabel(currentWeek.week_start)}</CardDescription>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            {currentWeek.visibility === "shared"
              ? "Shared with AE"
              : "Manager only"}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {carried.length > 0 && (
          <CarryoverBlock items={carried} onChange={onChange} />
        )}

        <FocusNotesBlock weeklyFocus={currentWeek} onChange={onChange} />

        <CommitmentsBlock
          weeklyFocus={currentWeek}
          commitments={currentWeek.commitments}
          onChange={onChange}
        />

        <CoachNotesBlock
          weeklyFocus={currentWeek}
          managerNotes={managerNotes}
          onChange={onChange}
        />
      </CardContent>
    </Card>
  );
}

/**
 * Motivational carryover banner — surfaces open commitments from prior
 * weeks under the current week. The framing is intentionally positive
 * ("carried over from last week") rather than punitive ("incomplete /
 * failed"). Completing a carried item PATCHes the ORIGINAL week's
 * commitment row (not a copy) so history stays clean and the item drops
 * out of carryover on the next refresh.
 */
function CarryoverBlock({
  items,
  onChange,
}: {
  items: CoachingDetail["carried_commitments"];
  onChange: () => void;
}) {
  // Group by source week so the manager can see "from last week" vs.
  // "from 2 weeks ago" at a glance.
  const groups = useMemo(() => {
    const m = new Map<string, CoachingDetail["carried_commitments"]>();
    for (const c of items) {
      const bucket = m.get(c.source_week_start) ?? [];
      bucket.push(c);
      m.set(c.source_week_start, bucket);
    }
    return Array.from(m.entries()); // already newest-first from API
  }, [items]);

  return (
    <section className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {items.length} commitment{items.length === 1 ? "" : "s"} carried over
        </h3>
        <span className="text-[11px] text-muted-foreground">
          From previous weeks — finish, edit, or drop.
        </span>
      </div>
      <div className="space-y-2">
        {groups.map(([weekStart, group]) => (
          <div key={weekStart} className="space-y-1">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {weekLabel(weekStart)}
            </p>
            <ul className="space-y-1.5">
              {group.map((c) => (
                <CommitmentRow key={c.id} commitment={c} onChange={onChange} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Top notes block — Focus / Wins / Blockers. The "Need Help / Blockers"
 * pane writes to the legacy `notes_opportunities` column (relabeled in
 * UI only — see weekly_focus.sql comments). All three are part of the
 * shared focus row and remain candidates for visibility='shared' in the
 * future AE-facing surface (unlike Manager Notes, which is private).
 */
function FocusNotesBlock({
  weeklyFocus,
  onChange,
}: {
  weeklyFocus: WeeklyFocus;
  onChange: () => void;
}) {
  return (
    <section className="grid gap-3 md:grid-cols-3">
      <NoteEditor
        key={`${weeklyFocus.id}-focus`}
        label="This week focus"
        placeholder="What matters most this week?"
        value={weeklyFocus.notes_focus}
        weeklyFocusId={weeklyFocus.id}
        field="notes_focus"
        onChange={onChange}
      />
      <NoteEditor
        key={`${weeklyFocus.id}-wins`}
        label="Wins"
        placeholder="Recent wins to celebrate…"
        value={weeklyFocus.notes_wins}
        weeklyFocusId={weeklyFocus.id}
        field="notes_wins"
        onChange={onChange}
      />
      <NoteEditor
        key={`${weeklyFocus.id}-blockers`}
        label="Need help / blockers"
        placeholder="Where are they stuck?"
        value={weeklyFocus.notes_opportunities}
        weeklyFocusId={weeklyFocus.id}
        field="notes_opportunities"
        onChange={onChange}
      />
    </section>
  );
}

/**
 * Lower notes block — Training Focus / Manager Notes. Pulled out from
 * the top block so the visual rhythm of the page is Focus → Commitments
 * → Coaching narrative rather than a single wide field grid.
 *
 * Manager Notes value is sourced from `detail.manager_notes` (a separate
 * private-notes table), not from the focus row, so it cannot be served
 * to a future AE-facing surface by accident.
 */
function CoachNotesBlock({
  weeklyFocus,
  managerNotes,
  onChange,
}: {
  weeklyFocus: WeeklyFocus;
  managerNotes: string | null;
  onChange: () => void;
}) {
  return (
    <section className="grid gap-3 md:grid-cols-2">
      <NoteEditor
        key={`${weeklyFocus.id}-training`}
        label="Training focus"
        placeholder="Skill, shadow, or rep we're building this week…"
        value={weeklyFocus.notes_training}
        weeklyFocusId={weeklyFocus.id}
        field="notes_training"
        onChange={onChange}
      />
      <NoteEditor
        key={`${weeklyFocus.id}-manager`}
        label="Manager notes"
        privateBadge
        placeholder="Coaching observations — private to the manager."
        value={managerNotes}
        weeklyFocusId={weeklyFocus.id}
        field="notes_manager"
        onChange={onChange}
      />
    </section>
  );
}

type SaveStatus = "idle" | "saving" | "saved" | "failed";

type NoteField =
  | "notes_focus"
  | "notes_wins"
  | "notes_opportunities"
  | "notes_training"
  | "notes_manager";

/** Idle delay before an in-progress edit autosaves. */
const NOTE_AUTOSAVE_MS = 1500;

function NoteEditor({
  label,
  placeholder,
  value,
  weeklyFocusId,
  field,
  onChange,
  privateBadge,
}: {
  label: string;
  placeholder?: string;
  value: string | null;
  weeklyFocusId: string;
  field: NoteField;
  onChange: () => void;
  /** Renders a "Private" badge — used for the Manager Notes pane. */
  privateBadge?: boolean;
}) {
  // Local edit state. The editor is keyed on `weeklyFocusId` at the call
  // site (via React's `key` prop) so switching to a different week
  // remounts it with a fresh `value`. Same-week refreshes after a save
  // don't need reconciliation — the post-save local text already matches
  // the server.
  const initial = value ?? "";
  const [text, setText] = useState(initial);
  const [status, setStatus] = useState<SaveStatus>("idle");

  // Refs so the autosave timer (and the unmount flush) see the latest
  // values without needing the effect to re-run on every keystroke.
  const savedValueRef = useRef(initial);
  const textRef = useRef(initial);

  const persist = useCallback(
    async (next: string) => {
      if (next === savedValueRef.current) return;
      setStatus("saving");
      try {
        const res = await apiFetch(
          `/api/admin/one-on-ones/${weeklyFocusId}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ [field]: next || null }),
          },
        );
        if (!res.ok) {
          setStatus("failed");
          return;
        }
        savedValueRef.current = next;
        setStatus("saved");
        onChange();
      } catch {
        setStatus("failed");
      }
    },
    [weeklyFocusId, field, onChange],
  );

  // Debounced autosave: fires NOTE_AUTOSAVE_MS after the user stops
  // typing, so a closed tab / quick navigation doesn't lose the last
  // edit. onBlur still triggers an immediate save (no wait).
  useEffect(() => {
    if (text === savedValueRef.current) return;
    const t = window.setTimeout(() => {
      void persist(text);
    }, NOTE_AUTOSAVE_MS);
    return () => window.clearTimeout(t);
  }, [text, persist]);

  // Best-effort flush on unmount — covers route navigation between AEs.
  // We can't await an async call in a cleanup, but firing it lets the
  // browser keep the request alive while the page changes.
  useEffect(() => {
    return () => {
      if (textRef.current !== savedValueRef.current) {
        void persist(textRef.current);
      }
    };
    // Intentionally only on mount/unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clear "Saved" badge after a short pause so it doesn't linger.
  // "Failed" sticks until the next save attempt so it can't be missed.
  useEffect(() => {
    if (status !== "saved") return;
    const t = window.setTimeout(() => setStatus("idle"), 1600);
    return () => window.clearTimeout(t);
  }, [status]);

  return (
    <div>
      <label className="flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span>{label}</span>
        {privateBadge && (
          <span
            className="rounded bg-amber-500/15 px-1 py-px text-[9px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400"
            title="Stored in a manager-only table; never returned to AE-facing reads."
          >
            Private
          </span>
        )}
        <NoteStatusPill
          status={status}
          onRetry={() => void persist(textRef.current)}
        />
      </label>
      <textarea
        value={text}
        onChange={(e) => {
          const next = e.target.value;
          textRef.current = next;
          setText(next);
          // The user is editing — drop a lingering "Saved"/"Failed" badge
          // so the indicator only reflects the current attempt.
          if (status !== "saving") setStatus("idle");
        }}
        onBlur={() => void persist(textRef.current)}
        rows={4}
        placeholder={placeholder ?? `Capture ${label.toLowerCase()}…`}
        className="mt-1 w-full resize-y rounded-md border border-border bg-background/40 px-2 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      />
    </div>
  );
}

/**
 * Tiny inline status indicator next to the note label. Stays out of the
 * way at rest (no badge when `idle`) and surfaces real state during /
 * after a save attempt. `Failed` includes a Retry affordance so a
 * dropped network call doesn't silently lose the user's edit.
 */
function NoteStatusPill({
  status,
  onRetry,
}: {
  status: SaveStatus;
  onRetry: () => void;
}) {
  if (status === "idle") return null;
  if (status === "saving") {
    return (
      <span className="text-[10px] font-medium normal-case tracking-normal text-muted-foreground/70">
        Saving…
      </span>
    );
  }
  if (status === "saved") {
    return (
      <span className="text-[10px] font-medium normal-case tracking-normal text-green-600 dark:text-green-400">
        Saved
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium normal-case tracking-normal text-destructive">
      Failed
      <button
        type="button"
        onClick={(e) => {
          // Stop the click from bubbling into the label/textarea focus.
          e.preventDefault();
          onRetry();
        }}
        className="rounded px-1 underline-offset-2 hover:underline"
      >
        Retry
      </button>
    </span>
  );
}

function CommitmentsBlock({
  weeklyFocus,
  commitments,
  onChange,
}: {
  weeklyFocus: WeeklyFocus;
  commitments: WeeklyFocusCommitment[];
  onChange: () => void;
}) {
  // Active = anything not dropped. Dropped rows stay in `commitments`
  // so server-side state matches the response payload, but they don't
  // surface in the active list or counter — they're history, not work.
  const active = commitments.filter((c) => c.status !== "dropped");
  const done = active.filter((c) => c.status === "completed").length;
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Commitments</h3>
        <span className="text-xs text-muted-foreground">
          {done}/{active.length} done
        </span>
      </div>
      <AddCommitmentForm
        path={`/api/admin/one-on-ones/${weeklyFocus.id}/commitments`}
        placeholder="Add a commitment for this week…"
        onCreated={onChange}
      />
      <ul className="space-y-1.5">
        {active.map((c) => (
          <CommitmentRow key={c.id} commitment={c} onChange={onChange} />
        ))}
      </ul>
    </section>
  );
}

function CommitmentRow({
  commitment,
  onChange,
}: {
  commitment: WeeklyFocusCommitment;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const path = `/api/admin/one-on-ones/${commitment.one_on_one_id}/commitments/${commitment.id}`;
  const run = async (request: () => Promise<Response>) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const ok = await runMutation(request, onChange);
    if (!ok) setFailed(true);
    setBusy(false);
  };
  const isCompleted = commitment.status === "completed";
  const toggle = () =>
    run(() =>
      apiFetch(path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: isCompleted ? "open" : "completed",
        }),
      }),
    );
  // DELETE → server-side soft-drop. UI affordance reads as "Drop"
  // ("remove from active focus"), not "Delete" — the historical row
  // remains for coaching history.
  const drop = () => run(() => apiFetch(path, { method: "DELETE" }));
  return (
    <li
      className={cn(
        "flex items-center gap-2 rounded-md border bg-muted/20 px-2 py-1.5 transition-colors",
        failed ? "border-destructive/60 bg-destructive/5" : "border-border/60",
      )}
    >
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        aria-label={isCompleted ? "Mark not completed" : "Mark completed"}
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center rounded border transition-colors",
          isCompleted
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background hover:border-primary/40",
        )}
      >
        {isCompleted && <Check aria-hidden="true" className="size-3.5" />}
      </button>
      <p
        className={cn(
          "flex-1 text-sm",
          isCompleted && "text-muted-foreground line-through",
        )}
      >
        {commitment.content}
      </p>
      {failed && <MutationFailedHint />}
      {commitment.due_date && (
        <span className="text-[11px] text-muted-foreground">
          {format(new Date(commitment.due_date), "MMM d")}
        </span>
      )}
      <button
        type="button"
        onClick={drop}
        disabled={busy}
        title="Drop — remove from active focus, keep history"
        aria-label="Drop commitment"
        className="rounded p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      >
        <Trash2 aria-hidden="true" className="size-3.5" />
      </button>
    </li>
  );
}

/**
 * Inline, low-volume "save failed" marker for row-level mutations.
 * Sits between the row content and trailing affordances; tells the
 * manager something went wrong without bouncing or modaling them out
 * of the coaching flow. Auto-clears when the next attempt starts.
 */
function MutationFailedHint() {
  return (
    <span
      role="alert"
      title="Save failed — try again"
      className="text-[10px] font-semibold uppercase tracking-wide text-destructive"
    >
      Failed
    </span>
  );
}

function AddCommitmentForm({
  path,
  placeholder,
  onCreated,
}: {
  path: string;
  placeholder: string;
  onCreated: () => void;
}) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = text.trim();
    if (!content || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `Could not add (${res.status}).`);
      }
      setText("");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex items-center gap-2">
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        disabled={saving}
        maxLength={500}
        className="flex-1"
      />
      <Button
        type="submit"
        size="sm"
        disabled={saving || text.trim().length === 0}
        className="gap-1.5"
      >
        <Plus aria-hidden="true" className="size-4" />
        Add
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Section C — Gold List / Key Relationships (persistent across weeks)
// ---------------------------------------------------------------------------

function RelationshipsSection({
  aeId,
  relationships,
  archived,
  onChange,
}: {
  aeId: string;
  relationships: CoachingRelationship[];
  archived: CoachingRelationship[];
  onChange: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ contact_name: "", company: "" });
  const submit = async () => {
    if (!draft.contact_name.trim() || adding) return;
    setAdding(true);
    setAddError(null);
    try {
      const res = await apiFetch(`/api/admin/coaching/${aeId}/relationships`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_name: draft.contact_name.trim(),
          company: draft.company.trim() || null,
        }),
      });
      if (!res.ok) {
        // 409 = active dedupe conflict from the unique index. Preserve
        // the typed values so the manager can edit them rather than
        // retype from scratch.
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        const message =
          res.status === 409
            ? body?.error ?? "Already on this AE's Gold List."
            : body?.error ?? `Couldn't add (${res.status}).`;
        setAddError(message);
        return;
      }
      setDraft({ contact_name: "", company: "" });
      onChange();
    } catch {
      setAddError("Couldn't add — please retry.");
    } finally {
      setAdding(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Gold list relationships</CardTitle>
        <CardDescription>
          Strategic relationships we&apos;re building — persistent across weeks,
          not the AE&apos;s personal gold-list touch log.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
        >
          <Input
            value={draft.contact_name}
            onChange={(e) =>
              setDraft({ ...draft, contact_name: e.target.value })
            }
            placeholder="Contact name"
            disabled={adding}
            maxLength={200}
          />
          <Input
            value={draft.company}
            onChange={(e) => setDraft({ ...draft, company: e.target.value })}
            placeholder="Company / brokerage"
            disabled={adding}
            maxLength={200}
          />
          <Button
            type="submit"
            size="sm"
            disabled={adding || draft.contact_name.trim().length === 0}
            className="gap-1.5"
          >
            <Plus aria-hidden="true" className="size-4" />
            Add
          </Button>
        </form>
        {addError && (
          <p className="text-xs text-destructive" role="alert">
            {addError}
          </p>
        )}
        {relationships.length === 0 ? (
          <p className="text-sm text-muted-foreground">No relationships yet.</p>
        ) : (
          <ul className="space-y-2">
            {relationships.map((r) => (
              <RelationshipRow
                key={r.id}
                aeId={aeId}
                relationship={r}
                onChange={onChange}
              />
            ))}
          </ul>
        )}
        <ArchivedRelationships
          aeId={aeId}
          archived={archived}
          onChange={onChange}
        />
      </CardContent>
    </Card>
  );
}

/**
 * Collapsed "Archived" disclosure under the active Gold List.
 *
 * Archived rows are kept queryable so the longitudinal relationship
 * history isn't lost when a contact cools or rolls off the focus list.
 * Rendering them in a `<details>` keeps the active card clean while
 * still putting the Restore affordance one tap away — without this, the
 * relationship endpoint's `archived: false` toggle would be unreachable
 * from the UI.
 */
function ArchivedRelationships({
  aeId,
  archived,
  onChange,
}: {
  aeId: string;
  archived: CoachingRelationship[];
  onChange: () => void;
}) {
  if (archived.length === 0) return null;
  return (
    <details className="rounded-md border border-border/60 bg-muted/10">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Archived ({archived.length})
      </summary>
      <ul className="space-y-2 border-t border-border/60 p-3">
        {archived.map((r) => (
          <RelationshipRow
            key={r.id}
            aeId={aeId}
            relationship={r}
            onChange={onChange}
          />
        ))}
      </ul>
    </details>
  );
}

function RelationshipRow({
  aeId,
  relationship,
  onChange,
}: {
  aeId: string;
  relationship: CoachingRelationship;
  onChange: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState({
    title: relationship.title ?? "",
    status: relationship.status ?? "",
    next_step: relationship.next_step ?? "",
    notes: relationship.notes ?? "",
  });
  const path = `/api/admin/coaching/${aeId}/relationships/${relationship.id}`;

  const send = async (
    payload: Record<string, unknown>,
    fallback: string,
  ) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(body?.error ?? fallback);
        return;
      }
      onChange();
    } catch {
      setError(fallback);
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    send(
      {
        title: edit.title || null,
        status: edit.status || null,
        next_step: edit.next_step || null,
        notes: edit.notes || null,
      },
      "Couldn't save — please retry.",
    );

  // DELETE soft-archives server-side; using the explicit `archived` flag
  // keeps the affordance reversible from the same endpoint via Restore.
  const archive = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(path, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(body?.error ?? "Couldn't archive — please retry.");
        return;
      }
      onChange();
    } catch {
      setError("Couldn't archive — please retry.");
    } finally {
      setBusy(false);
    }
  };

  const restore = () =>
    send({ archived: false }, "Couldn't restore — please retry.");

  const archived = relationship.archived_at !== null;

  return (
    <li className="rounded-md border border-border/60 bg-muted/10">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {relationship.contact_name}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {[relationship.title, relationship.company]
              .filter(Boolean)
              .join(" · ") || "—"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {archived && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Archived
            </span>
          )}
          {!archived && relationship.status && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
              {relationship.status}
            </span>
          )}
          {expanded ? (
            <ChevronUp aria-hidden="true" className="size-4 text-muted-foreground" />
          ) : (
            <ChevronDown aria-hidden="true" className="size-4 text-muted-foreground" />
          )}
        </div>
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-border/60 px-3 py-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              value={edit.title}
              onChange={(e) => setEdit({ ...edit, title: e.target.value })}
              placeholder="Title"
              disabled={busy}
              maxLength={200}
            />
            <Input
              value={edit.status}
              onChange={(e) => setEdit({ ...edit, status: e.target.value })}
              placeholder="Status (new, warming up, strong, advocate, cooling off…)"
              disabled={busy}
              maxLength={200}
            />
          </div>
          <Input
            value={edit.next_step}
            onChange={(e) => setEdit({ ...edit, next_step: e.target.value })}
            placeholder="Next step"
            disabled={busy}
            maxLength={2000}
          />
          <textarea
            value={edit.notes}
            onChange={(e) => setEdit({ ...edit, notes: e.target.value })}
            placeholder="Notes"
            rows={3}
            disabled={busy}
            maxLength={2000}
            className="w-full resize-y rounded-md border border-border bg-background/40 px-2 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          />
          <div className="flex items-center justify-between gap-2">
            {archived ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={restore}
                disabled={busy}
                className="text-primary hover:bg-primary/10"
              >
                <Undo2 aria-hidden="true" className="size-3.5" />
                Restore
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={archive}
                disabled={busy}
                title="Archive — keep the longitudinal history, hide from active list"
                className="text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              >
                <Archive aria-hidden="true" className="size-3.5" />
                Archive
              </Button>
            )}
            <div className="flex items-center gap-2">
              {error && (
                <span
                  role="alert"
                  className="text-[10px] font-semibold uppercase tracking-wide text-destructive"
                >
                  {error}
                </span>
              )}
              <Button
                type="button"
                size="sm"
                onClick={save}
                disabled={busy}
              >
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Section D — Training Commitments (standing per-AE, not weekly)
// ---------------------------------------------------------------------------

function TrainingSection({
  aeId,
  items,
  onChange,
}: {
  aeId: string;
  items: TrainingCommitment[];
  onChange: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Training commitments</CardTitle>
        <CardDescription>
          Standing development assignments — shadow a presentation, practice
          objection handling, social posts, etc.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <AddCommitmentForm
          path={`/api/admin/coaching/${aeId}/training`}
          placeholder="Add a training item…"
          onCreated={onChange}
        />
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No training items yet.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {items.map((t) => (
              <TrainingRow key={t.id} aeId={aeId} item={t} onChange={onChange} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function TrainingRow({
  aeId,
  item,
  onChange,
}: {
  aeId: string;
  item: TrainingCommitment;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const path = `/api/admin/coaching/${aeId}/training/${item.id}`;
  const run = async (request: () => Promise<Response>) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const ok = await runMutation(request, onChange);
    if (!ok) setFailed(true);
    setBusy(false);
  };
  const toggle = () =>
    run(() =>
      apiFetch(path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completed: !item.completed }),
      }),
    );
  const remove = () => run(() => apiFetch(path, { method: "DELETE" }));
  return (
    <li
      className={cn(
        "flex items-center gap-2 rounded-md border bg-muted/20 px-2 py-1.5 transition-colors",
        failed ? "border-destructive/60 bg-destructive/5" : "border-border/60",
      )}
    >
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        aria-label={item.completed ? "Mark not completed" : "Mark completed"}
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center rounded border transition-colors",
          item.completed
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background hover:border-primary/40",
        )}
      >
        {item.completed && <Check aria-hidden="true" className="size-3.5" />}
      </button>
      <p
        className={cn(
          "flex-1 text-sm",
          item.completed && "text-muted-foreground line-through",
        )}
      >
        {item.content}
      </p>
      {failed && <MutationFailedHint />}
      {item.due_date && (
        <span className="text-[11px] text-muted-foreground">
          {format(new Date(item.due_date), "MMM d")}
        </span>
      )}
      <button
        type="button"
        onClick={remove}
        disabled={busy}
        aria-label="Delete training item"
        className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 aria-hidden="true" className="size-3.5" />
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Section E — Past weeks (history timeline)
// ---------------------------------------------------------------------------

function HistorySection({
  history,
}: {
  history: Array<WeeklyFocus & { commitments: WeeklyFocusCommitment[] }>;
}) {
  if (history.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Past weeks</CardTitle>
        <CardDescription>Newest first.</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          {history.map((m) => {
            const done = m.commitments.filter(
              (c) => c.status === "completed",
            ).length;
            // Dropped items don't add to the displayed total — they're
            // archived from active focus, not "incomplete".
            const total = m.commitments.filter(
              (c) => c.status !== "dropped",
            ).length;
            return (
              <li
                key={m.id}
                className="rounded-md border border-border/60 bg-muted/10 p-3"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-semibold">
                    {weekLabel(m.week_start)}
                  </p>
                  <span className="text-xs text-muted-foreground">
                    {total > 0
                      ? `${done}/${total} commitments done`
                      : "No commitments"}
                  </span>
                </div>
                {m.notes_focus && (
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    Focus: {m.notes_focus}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section — Weekly Goals (current-week progress)
// ---------------------------------------------------------------------------

/**
 * Compact "Goal Progress" card — `actual / weekly_target — pct%` per
 * activity. Reads `weekly_goal_current` (resolved server-side with the
 * same precedence the leaderboard uses) and the snapshot week_totals
 * (already populated for this page), so there's no duplicated scoring
 * math on the client.
 *
 * Activities with a target of 0 are still shown so the manager can spot
 * goal columns that haven't been set yet — the row reads `n / —` and
 * doesn't render a percent (avoiding a divide-by-zero "Infinity%" stat).
 */
function WeeklyGoalsCard({
  weekTotals,
  goal,
}: {
  weekTotals: CoachingDetail["snapshot"]["week_totals"];
  goal: CurrentWeeklyGoal;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <CardTitle>Weekly goals</CardTitle>
            <CardDescription>
              {goal.source === "none"
                ? "No active goal yet — set one on the Admin → Dashboard goals card."
                : goal.source === "personal"
                  ? "Personal goal in effect."
                  : "Team default goal in effect."}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2 sm:grid-cols-2">
          {GOAL_ACTIVITY_KEYS.map((a) => {
            const actual = Number(weekTotals[a.key] ?? 0);
            const target = Number(goal.values[a.key] ?? 0);
            return (
              <GoalProgressRow
                key={a.key}
                label={a.label}
                actual={actual}
                target={target}
              />
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function GoalProgressRow({
  label,
  actual,
  target,
}: {
  label: string;
  actual: number;
  target: number;
}) {
  // Target = 0 => the goal column isn't set yet. Show the actual, but no
  // percent or filled bar — a divide-by-zero would be both misleading and
  // discouraging in a coaching surface.
  const hasTarget = target > 0;
  const rawPct = hasTarget ? (actual / target) * 100 : 0;
  const pctDisplay = hasTarget ? Math.round(rawPct) : null;
  const filled = Math.min(100, Math.max(0, rawPct));
  const tone =
    !hasTarget
      ? { bar: "bg-muted-foreground/30", text: "text-muted-foreground" }
      : progressColor(rawPct);
  return (
    <li className="rounded-md border border-border/60 bg-muted/10 p-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <span className={cn("text-xs font-semibold tabular-nums", tone.text)}>
          {pctDisplay === null ? "—" : `${pctDisplay}%`}
        </span>
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <p className="text-sm">
          <span className="text-base font-semibold tabular-nums">{actual}</span>
          <span className="text-muted-foreground"> / </span>
          <span className="tabular-nums">{hasTarget ? target : "—"}</span>
        </p>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
        <div
          className={cn("h-full", tone.bar)}
          style={{ width: `${filled}%` }}
        />
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Section — Next Week Goals (manager planning)
// ---------------------------------------------------------------------------

/**
 * "Keep same or adjust?" card. Defaults to the keep-same state when no
 * override row exists. Saving in keep-same mode DELETEs any prior
 * override row; saving in custom mode UPSERTs the per-AE override at
 * next Monday's `effective_from`. The route prevents duplicate inserts,
 * and the resolved state round-trips back so the form re-syncs without
 * a full refetch.
 *
 * Existing CURRENT-week goals are never touched by this card — the
 * server only ever writes to the next-Monday override row.
 */
function NextWeekGoalsCard({
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
  // keepSame defaults to TRUE when no per-AE override row exists for
  // next Monday — the natural "inherit whatever's active that day" state.
  const [keepSame, setKeepSame] = useState<boolean>(nextOverride === null);

  // Editable values for the custom branch. Seeded from the existing
  // override row if there is one, otherwise from the current week's
  // values so the manager starts with a sensible draft.
  const seedValues: WeeklyGoalValues = useMemo(() => {
    return nextOverride?.values ?? currentGoal.values;
  }, [nextOverride, currentGoal]);
  const [values, setValues] = useState<WeeklyGoalValues>(seedValues);

  // Re-sync local state when the upstream detail refetches (e.g. after a
  // save round-trip). Key on the override id / null so an unchanged
  // detail render doesn't clobber in-progress edits — this is exactly
  // the "sync from props that change irregularly" case the rule allows.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setKeepSame(nextOverride === null);
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
      const body = keepSame
        ? { keep_same: true }
        : { keep_same: false, values };
      const res = await apiFetch(
        `/api/admin/coaching/${aeId}/next-week-goals`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
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

  const weekLabel = nextWeekStart
    ? `Week of ${format(addDays(parseISO(nextWeekStart), 0), "MMM d")}–${format(
        addDays(parseISO(nextWeekStart), 4),
        "MMM d",
      )}`
    : "Next week";

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <CardTitle>Next week goals</CardTitle>
            <CardDescription>
              {weekLabel} — manager only.
            </CardDescription>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            Manager only
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={keepSame}
            onChange={(e) => setKeepSame(e.target.checked)}
            disabled={saving}
            className="mt-0.5 size-4 rounded border-border accent-primary"
          />
          <span className="flex flex-col">
            <span>Use active goals for next week</span>
            <span className="text-[11px] text-muted-foreground">
              No per-AE override — next week uses whichever goal (personal
              or team default) is in effect on Monday.
            </span>
          </span>
        </label>

        {!keepSame && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-1 text-left font-semibold">Goal</th>
                  <th className="py-1 text-right font-semibold">This week</th>
                  <th className="py-1 text-right font-semibold">Next week</th>
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
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {keepSame
              ? nextOverride
                ? "Saving clears the existing next-week override; next week will use whichever goal is in effect on Monday."
                : "No per-AE override scheduled — next week will use whichever goal is in effect on Monday."
              : nextOverride
                ? "Editing the existing per-AE override for next Monday."
                : "A per-AE override will be created for next Monday."}
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
              {saving ? "Saving…" : "Save next week"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
