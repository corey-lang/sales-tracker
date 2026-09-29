"use client";

import { useCallback, useEffect, useState } from "react";
import { addDays, format, parseISO } from "date-fns";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Plus,
  Trash2,
  Undo2,
} from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";

import { useOptionalDraft } from "./autosave-text";
import type {
  CoachingRelationship,
  LegacyWeeklyFocusDetail,
  TrainingCommitment,
  WeeklyFocusCommitment,
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

// Legacy Weekly Focus — everything the page used to show before it became a
// 1:1 workspace, kept VISIBLE and (where it was editable) STILL EDITABLE:
//   * Past weeks — every `one_on_ones` week row with its notes, private
//     manager notes, and commitments (read-only here).
//   * Training commitments — standing assignments (unchanged behavior).
//   * Coaching relationships — the manager's old relationship lens
//     (unchanged behavior; the AE's real Gold List lives in the 1:1).
// Collapsed by default and loaded only when opened, via the read-only
// GET /api/admin/coaching/[ae_id]/legacy. No legacy row is modified or hidden.
// The components below were moved from the old page without behavior
// changes.

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

/** "Week of MMM d" — Mon-Fri range derived from a week_start Monday. */
function weekLabel(weekStart: string): string {
  const monday = parseISO(weekStart);
  const friday = addDays(monday, 4);
  return `Week of ${format(monday, "MMM d")} – ${format(friday, "MMM d")}`;
}


export function LegacyWeeklyFocus({
  aeId,
  meetingId = null,
}: {
  aeId: string;
  /** The in-progress 1:1, if any — its legacy edits are meeting-scoped. */
  meetingId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<LegacyWeeklyFocusDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/admin/coaching/${aeId}/legacy`);
      const body = (await res.json().catch(() => null)) as
        | (LegacyWeeklyFocusDetail & { error?: string })
        | null;
      if (!res.ok || !body || body.error) {
        setError(body?.error ?? `Couldn't load (${res.status}).`);
        return;
      }
      setDetail(body);
      setError(null);
    } catch {
      setError("Couldn't load legacy Weekly Focus.");
    }
  }, [aeId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open && !detail) void refresh();
  }, [open, detail, refresh]);

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
          className={cn("size-4 shrink-0 transition-transform", open && "rotate-90")}
        />
        <span className="font-semibold">Legacy Weekly Focus</span>
        <span className="ml-auto text-xs text-muted-foreground">
          Past weeks · training · coaching relationships
        </span>
      </button>
      {open ? (
        <div className="space-y-4 border-t border-border/60 p-4 sm:p-5">
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : !detail ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <>
              <PastWeeks weeks={detail.weeks} meetingId={meetingId} onChange={refresh} />
              <TrainingSection
                aeId={aeId}
                items={detail.training}
                onChange={refresh}
              />
              <RelationshipsSection
                aeId={aeId}
                relationships={detail.relationships}
                archived={detail.archived_relationships}
                onChange={refresh}
              />
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

function PastWeeks({
  weeks,
  meetingId,
  onChange,
}: {
  weeks: LegacyWeeklyFocusDetail["weeks"];
  meetingId: string | null;
  onChange: () => void;
}) {
  if (weeks.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No Weekly Focus weeks recorded.</p>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Past weeks</CardTitle>
        <CardDescription>
          Weekly Focus records from before the 1:1 workspace. Newest first.
          Open commitments from these weeks also appear as carryover in the 1:1.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="space-y-2">
          {weeks.map((w) => (
            <PastWeekRow key={w.id} week={w} meetingId={meetingId} onChange={onChange} />
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function PastWeekRow({
  week,
  meetingId,
  onChange,
}: {
  week: LegacyWeeklyFocusDetail["weeks"][number];
  meetingId: string | null;
  onChange: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const active = week.commitments.filter((c) => c.status !== "dropped");
  const done = active.filter((c) => c.status === "completed").length;
  const panes: Array<[string, string | null]> = [
    ["Focus", week.notes_focus],
    ["Wins", week.notes_wins],
    ["Need help / blockers", week.notes_opportunities],
    ["Training focus", week.notes_training],
    ["Manager notes (private)", week.manager_notes],
  ];
  return (
    <li className="rounded-md border border-border/60 bg-muted/10">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <span className="text-sm font-semibold">{weekLabel(week.week_start)}</span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {active.length > 0 ? `${done}/${active.length} commitments done` : "No commitments"}
          {expanded ? (
            <ChevronUp aria-hidden="true" className="size-4" />
          ) : (
            <ChevronDown aria-hidden="true" className="size-4" />
          )}
        </span>
      </button>
      {expanded ? (
        <div className="space-y-3 border-t border-border/60 px-3 py-3">
          {panes
            .filter(([, v]) => v)
            .map(([label, v]) => (
              <div key={label}>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {label}
                </p>
                <p className="whitespace-pre-wrap text-sm">{v}</p>
              </div>
            ))}
          {active.length > 0 ? (
            <ul className="space-y-1.5">
              {active.map((c) => (
                <CommitmentRow
                  key={c.id}
                  commitment={c}
                  meetingId={meetingId}
                  onChange={onChange}
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * A legacy Weekly Focus commitment row.
 *
 * WHILE A 1:1 IS IN PROGRESS (`meetingId` set) its toggle / drop are
 * meeting-scoped: they go through the 1:1's route
 * (/api/admin/one-on-one-meetings/[id]/legacy-commitments/[cid], which takes
 * the 1:1's lock so the change can't land after its completion snapshot),
 * are tracked by the draft coordinator (Complete 1:1 waits for them), and are
 * disabled while the 1:1 is being completed. With no 1:1 in progress they use
 * the original Weekly Focus route, exactly as before.
 */
export function CommitmentRow({
  commitment,
  onChange,
  meetingId = null,
}: {
  commitment: WeeklyFocusCommitment;
  onChange: () => void;
  /** The in-progress 1:1, if any. */
  meetingId?: string | null;
}) {
  const draft = useOptionalDraft();
  const scoped = Boolean(meetingId && draft);
  const [busyFlag, setBusy] = useState(false);
  const busy = busyFlag || (scoped && draft!.locked);
  const [failed, setFailed] = useState(false);
  const path = scoped
    ? `/api/admin/one-on-one-meetings/${meetingId}/legacy-commitments/${commitment.id}`
    : `/api/admin/one-on-ones/${commitment.one_on_one_id}/commitments/${commitment.id}`;
  const run = async (request: () => Promise<Response>) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    let ok = false;
    try {
      ok = scoped
        ? await draft!.mutate(async () => {
            const done = await runMutation(request, onChange);
            // A refused write (e.g. 409 while completing) must count as a
            // failed meeting action so Complete doesn't proceed past it.
            if (!done) throw new Error("Not saved");
            return done;
          })
        : await runMutation(request, onChange);
    } catch {
      ok = false;
    }
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
        <CardTitle>Coaching relationships</CardTitle>
        <CardDescription>
          Preserved manager coaching notes, separate from the AE’s follow-up list.
          <a className="block underline" href={`/gold-list?ae_id=${aeId}`}>Open this AE’s Gold List for contacts and activities</a>
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

