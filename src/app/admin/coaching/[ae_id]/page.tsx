"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { format } from "date-fns";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Plus,
  Trash2,
  Trophy,
} from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { progressColor } from "@/lib/goals";
import { cn } from "@/lib/utils";
import type {
  CoachingDetail,
  CoachingRelationship,
  OneOnOne,
  OneOnOneCommitment,
  TrainingCommitment,
} from "@/lib/one-on-ones";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

// Admin → Coaching → AE detail. Renders the seven sections defined in the
// 1:1 spec:
//
//   A. Snapshot Header              -> SnapshotSection
//   B. Gold List / Key Relationships -> RelationshipsSection
//   C. Training Commitments         -> TrainingSection
//   D. Previous 1:1 Commitments     -> PreviousCommitmentsSection (uses
//                                      detail.previous_commitments, sourced
//                                      from the meeting BEFORE the latest)
//   E. Notes (Wins / Opportunities / Focus) -> NotesSection
//   F. Commitments Before Next 1:1  -> NextCommitmentsSection
//   G. Timeline History             -> TimelineSection
//
// Sections D / E / F operate on the LATEST 1:1 row. The manager creates a
// new 1:1 with "Start new 1:1" — that fresh row becomes the latest, and
// the previous becomes the "Previous Commitments" surface.

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

  const latestOneOnOne = detail.one_on_ones[0] ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link
            href="/admin/coaching"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            All AEs
          </Link>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">
            Coaching {detail.ae.first_name}
          </h2>
        </div>
        <StartNewOneOnOneButton aeId={aeId} onCreated={refresh} />
      </div>

      <SnapshotSection detail={detail} />

      <CurrentOneOnOneSection
        aeId={aeId}
        latest={latestOneOnOne}
        previousCommitments={detail.previous_commitments}
        onChange={refresh}
      />

      <RelationshipsSection
        aeId={aeId}
        relationships={detail.relationships}
        onChange={refresh}
      />

      <TrainingSection
        aeId={aeId}
        items={detail.training}
        onChange={refresh}
      />

      <TimelineSection oneOnOnes={detail.one_on_ones} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section A — Snapshot header
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
// Sections D + E + F — the current 1:1 (Previous commitments, Notes, Next commitments)
// ---------------------------------------------------------------------------

function StartNewOneOnOneButton({
  aeId,
  onCreated,
}: {
  aeId: string;
  onCreated: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handle = async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/admin/coaching/${aeId}/one-on-ones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `Could not create (${res.status}).`);
      }
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create 1:1.");
    } finally {
      setCreating(false);
    }
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <Button onClick={handle} disabled={creating} className="gap-1.5">
        <Plus aria-hidden="true" className="size-4" />
        {creating ? "Starting…" : "Start new 1:1"}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function CurrentOneOnOneSection({
  aeId,
  latest,
  previousCommitments,
  onChange,
}: {
  aeId: string;
  latest: (OneOnOne & { commitments: OneOnOneCommitment[] }) | null;
  previousCommitments: OneOnOneCommitment[];
  onChange: () => void;
}) {
  if (!latest) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Current 1:1</CardTitle>
          <CardDescription>
            No 1:1 yet for {aeId ? "this AE" : "—"}. Tap{" "}
            <span className="font-medium">Start new 1:1</span> above to begin.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <CardTitle>Current 1:1</CardTitle>
            <CardDescription>
              {format(new Date(latest.meeting_date), "EEEE, MMM d, yyyy")}
            </CardDescription>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            {latest.visibility === "shared" ? "Shared with AE" : "Manager only"}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* D — Previous commitments (from the meeting BEFORE this one) */}
        {previousCommitments.length > 0 && (
          <PreviousCommitmentsBlock
            commitments={previousCommitments}
            onChange={onChange}
          />
        )}

        {/* E — Notes (Wins / Opportunities / Focus) */}
        <NotesBlock oneOnOne={latest} onChange={onChange} />

        {/* F — Commitments Before Next 1:1 */}
        <NextCommitmentsBlock
          oneOnOne={latest}
          commitments={latest.commitments}
          onChange={onChange}
        />
      </CardContent>
    </Card>
  );
}

function PreviousCommitmentsBlock({
  commitments,
  onChange,
}: {
  commitments: OneOnOneCommitment[];
  onChange: () => void;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Previous commitments</h3>
        <span className="text-xs text-muted-foreground">
          {commitments.filter((c) => c.completed).length}/{commitments.length}{" "}
          done
        </span>
      </div>
      <ul className="space-y-1.5">
        {commitments.map((c) => (
          <CommitmentRow key={c.id} commitment={c} onChange={onChange} />
        ))}
      </ul>
    </section>
  );
}

function NotesBlock({
  oneOnOne,
  onChange,
}: {
  oneOnOne: OneOnOne;
  onChange: () => void;
}) {
  return (
    <section className="grid gap-3 md:grid-cols-3">
      <NoteEditor
        key={`${oneOnOne.id}-wins`}
        label="Wins"
        value={oneOnOne.notes_wins}
        oneOnOneId={oneOnOne.id}
        field="notes_wins"
        onChange={onChange}
      />
      <NoteEditor
        key={`${oneOnOne.id}-opps`}
        label="Opportunities"
        value={oneOnOne.notes_opportunities}
        oneOnOneId={oneOnOne.id}
        field="notes_opportunities"
        onChange={onChange}
      />
      <NoteEditor
        key={`${oneOnOne.id}-focus`}
        label="Focus"
        value={oneOnOne.notes_focus}
        oneOnOneId={oneOnOne.id}
        field="notes_focus"
        onChange={onChange}
      />
    </section>
  );
}

type SaveStatus = "idle" | "saving" | "saved" | "failed";

function NoteEditor({
  label,
  value,
  oneOnOneId,
  field,
  onChange,
}: {
  label: string;
  value: string | null;
  oneOnOneId: string;
  field: "notes_wins" | "notes_opportunities" | "notes_focus";
  onChange: () => void;
}) {
  // Local edit state. The editor is keyed on `oneOnOneId` at the call site
  // (via React's `key` prop) so switching to a different 1:1 remounts it
  // with a fresh `value`. Same-meeting refreshes after a save don't need
  // reconciliation — the post-save local text already matches the server.
  const initial = value ?? "";
  const [text, setText] = useState(initial);
  const [savedValue, setSavedValue] = useState(initial);
  const [status, setStatus] = useState<SaveStatus>("idle");

  // Clear "Saved" / "Failed" badges shortly so they don't linger forever.
  // 1.6 s for "Saved" (long enough to register, short enough to fade);
  // "Failed" sticks until the next save attempt so it can't be missed.
  useEffect(() => {
    if (status !== "saved") return;
    const t = window.setTimeout(() => setStatus("idle"), 1600);
    return () => window.clearTimeout(t);
  }, [status]);

  const save = async () => {
    if (text === savedValue) return;
    setStatus("saving");
    try {
      const res = await apiFetch(`/api/admin/one-on-ones/${oneOnOneId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: text || null }),
      });
      if (!res.ok) {
        setStatus("failed");
        return;
      }
      setSavedValue(text);
      setStatus("saved");
      onChange();
    } catch {
      setStatus("failed");
    }
  };

  return (
    <div>
      <label className="flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span>{label}</span>
        <NoteStatusPill status={status} onRetry={save} />
      </label>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          // The user is editing — drop a lingering "Saved"/"Failed" badge
          // so the indicator only reflects the current attempt.
          if (status !== "saving") setStatus("idle");
        }}
        onBlur={save}
        rows={4}
        placeholder={`Capture ${label.toLowerCase()}…`}
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

function NextCommitmentsBlock({
  oneOnOne,
  commitments,
  onChange,
}: {
  oneOnOne: OneOnOne;
  commitments: OneOnOneCommitment[];
  onChange: () => void;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Commitments before next 1:1</h3>
        <span className="text-xs text-muted-foreground">
          {commitments.filter((c) => c.completed).length}/{commitments.length}{" "}
          done
        </span>
      </div>
      <AddCommitmentForm
        path={`/api/admin/one-on-ones/${oneOnOne.id}/commitments`}
        placeholder="Add a commitment for next 1:1…"
        onCreated={onChange}
      />
      <ul className="space-y-1.5">
        {commitments.map((c) => (
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
  commitment: OneOnOneCommitment;
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
  const toggle = () =>
    run(() =>
      apiFetch(path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completed: !commitment.completed }),
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
        aria-label={
          commitment.completed ? "Mark not completed" : "Mark completed"
        }
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center rounded border transition-colors",
          commitment.completed
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background hover:border-primary/40",
        )}
      >
        {commitment.completed && (
          <Check aria-hidden="true" className="size-3.5" />
        )}
      </button>
      <p
        className={cn(
          "flex-1 text-sm",
          commitment.completed && "text-muted-foreground line-through",
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
        onClick={remove}
        disabled={busy}
        aria-label="Delete commitment"
        className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
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
 * of the 1:1 flow. Auto-clears when the next attempt starts.
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
// Section B — Gold List / Key Relationships
// ---------------------------------------------------------------------------

function RelationshipsSection({
  aeId,
  relationships,
  onChange,
}: {
  aeId: string;
  relationships: CoachingRelationship[];
  onChange: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ contact_name: "", company: "" });
  const submit = async () => {
    if (!draft.contact_name.trim() || adding) return;
    setAdding(true);
    setAddError(null);
    const ok = await runMutation(
      () =>
        apiFetch(`/api/admin/coaching/${aeId}/relationships`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contact_name: draft.contact_name.trim(),
            company: draft.company.trim() || null,
          }),
        }),
      () => {
        // Only clear the draft on a real success — otherwise the manager
        // would type the contact again from scratch when the request
        // silently failed mid-1:1.
        setDraft({ contact_name: "", company: "" });
        onChange();
      },
    );
    if (!ok) setAddError("Couldn't add — please retry.");
    setAdding(false);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Key relationships</CardTitle>
        <CardDescription>
          People we&apos;re building with — manager view, separate from the AE&apos;s
          personal gold list.
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
      </CardContent>
    </Card>
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
  const [failed, setFailed] = useState(false);
  const [edit, setEdit] = useState({
    title: relationship.title ?? "",
    status: relationship.status ?? "",
    next_step: relationship.next_step ?? "",
    notes: relationship.notes ?? "",
  });
  const path = `/api/admin/coaching/${aeId}/relationships/${relationship.id}`;
  const run = async (request: () => Promise<Response>) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const ok = await runMutation(request, onChange);
    if (!ok) setFailed(true);
    setBusy(false);
  };
  const save = () =>
    run(() =>
      apiFetch(path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: edit.title || null,
          status: edit.status || null,
          next_step: edit.next_step || null,
          notes: edit.notes || null,
        }),
      }),
    );
  const remove = () => run(() => apiFetch(path, { method: "DELETE" }));
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
          {relationship.status && (
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
              placeholder="Status (cold, warm, closing…)"
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
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={remove}
              disabled={busy}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 aria-hidden="true" className="size-3.5" />
              Remove
            </Button>
            <div className="flex items-center gap-2">
              {failed && (
                <span
                  role="alert"
                  className="text-[10px] font-semibold uppercase tracking-wide text-destructive"
                >
                  Failed — retry
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
// Section C — Training Commitments
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
// Section G — Timeline History
// ---------------------------------------------------------------------------

function TimelineSection({
  oneOnOnes,
}: {
  oneOnOnes: Array<OneOnOne & { commitments: OneOnOneCommitment[] }>;
}) {
  // Skip the most recent meeting — it's already rendered as "Current 1:1".
  const history = useMemo(() => oneOnOnes.slice(1), [oneOnOnes]);
  if (history.length === 0) {
    return null;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Timeline</CardTitle>
        <CardDescription>Past 1:1s, newest first.</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          {history.map((m) => {
            const done = m.commitments.filter((c) => c.completed).length;
            const total = m.commitments.length;
            return (
              <li
                key={m.id}
                className="rounded-md border border-border/60 bg-muted/10 p-3"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-semibold">
                    {format(new Date(m.meeting_date), "EEEE, MMM d, yyyy")}
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
