"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { format, parseISO } from "date-fns";
import { ArrowLeft, Check, Circle, History, Play } from "lucide-react";

import { apiFetchJson } from "@/lib/api-client";
import { formatTaskMoment } from "@/lib/dates";
import {
  COACHING_FOCUS_MAX_LENGTH,
  MEETING_NOTES_MAX_LENGTH,
  revisionColumn,
  type GoldListDiscussionNote,
  type MeetingCommitment,
  type MeetingRecord,
  type MeetingTextField,
  type OneOnOneMeeting,
  type OneOnOneWorkspace,
  type WorkspaceGoldListAgent,
} from "@/lib/one-on-one-meetings";
import {
  DraftAutosave,
  completeDraft,
  type FieldSaver,
} from "@/lib/draft-autosave";
import { useSalesperson } from "@/lib/use-salesperson";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

import { ActivityResults } from "./_components/activity-results";
import {
  AutosaveText,
  DraftContext,
  Section,
  revisionedSave,
  useDraft,
  useDraftField,
  useDraftLocked,
} from "./_components/autosave-text";
import { CommitmentsSection } from "./_components/commitments";
import { UpdateGoalsDisclosure } from "./_components/goal-editor";
import { GoldListReview, noteKey } from "./_components/gold-list-review";
import { LegacyWeeklyFocus } from "./_components/legacy-weekly-focus";

// Admin → Weekly Focus → AE: the manager's 1:1 WORKSPACE (manager-only).
//
// Meeting flow, top to bottom:
//   Header (last 1:1 / today / Start or resume / History)
//   → From your last 1:1   (focus + that meeting's follow-ups, live status)
//   → Wins
//   → Activity & Results   (Last Week vs This Week, each on its own goals)
//   → Gold List            (the AE's REAL list; live updates + 1:1 notes)
//   → Coaching
//   → Commitments & Next Steps (carryover first, then new)
//   → Update Weekly Goals  (existing editor, collapsed)
//   → Complete 1:1
//   → Legacy Weekly Focus  (collapsed; old weekly records stay visible)
//
// GET never creates anything. "Start 1:1" creates-or-resumes the AE's single
// in-progress draft; every field autosaves to it, so a refresh loses nothing
// and never forks a second meeting. "Complete 1:1" freezes the record.
//
// AUTOSAVE / COMPLETION
//   One DraftAutosave coordinator (lib/draft-autosave.ts) owns every draft
//   field and tracks every meeting action for this page. Complete 1:1 locks
//   it, durably saves every field (including collapsed Gold List notes) and
//   waits for in-flight actions, and only then calls the server — which
//   completes in one database transaction. On failure everything unlocks,
//   intact, for a retry.

function shortDate(iso: string): string {
  return format(parseISO(iso), "MMM d");
}

export default function OneOnOneWorkspacePage() {
  const params = useParams<{ ae_id: string }>();
  const aeId = params.ae_id;
  const router = useRouter();
  const { salesperson } = useSalesperson();

  const [ws, setWs] = useState<OneOnOneWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [draft] = useState(() => new DraftAutosave());

  // Warn before leaving with unsaved text (not relied on for correctness —
  // completion flushes the coordinator explicitly).
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!draft.isDirty()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [draft]);

  const refresh = useCallback(async () => {
    try {
      const body = await apiFetchJson<OneOnOneWorkspace>(
        `/api/admin/coaching/${aeId}/meetings`,
      );
      setWs(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load.");
    }
  }, [aeId]);

  useEffect(() => {
    // Bootstrap fetch; setState happens inside the async body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const patch = useCallback(
    (update: (w: OneOnOneWorkspace) => OneOnOneWorkspace) => {
      setWs((prev) => (prev ? update(prev) : prev));
    },
    [],
  );

  const start = async () => {
    if (starting) return;
    setStarting(true);
    try {
      await apiFetchJson<{ meeting: OneOnOneMeeting }>(
        `/api/admin/coaching/${aeId}/meetings`,
        { method: "POST" },
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start the 1:1.");
    } finally {
      setStarting(false);
    }
  };

  if (error && !ws) {
    return (
      <Card>
        <CardContent className="space-y-3 py-6 text-center text-sm">
          <p className="text-destructive">Couldn&apos;t load: {error}</p>
          <Link
            href="/admin/coaching"
            className="text-primary underline-offset-4 hover:underline"
          >
            Back to Weekly Focus
          </Link>
        </CardContent>
      </Card>
    );
  }
  if (!ws) {
    return (
      <p className="px-1 py-6 text-center text-sm text-muted-foreground">
        Loading…
      </p>
    );
  }

  const meeting = ws.meeting;
  const aeName = ws.ae.first_name;
  const managerName =
    meeting?.manager_name ?? salesperson?.first_name ?? "Manager";

  // The coordinator holds what's on screen; the server's echo is never
  // written back into a field (so a slow response can't revert newer text).
  // Each save names the revision it's based on; a stale one (another tab
  // saved first) is refused and surfaced as a conflict, never overwritten.
  const saveField =
    (field: MeetingTextField) => async (value: string, revision: number) => {
      if (!meeting) return revision;
      return revisionedSave(
        `/api/admin/one-on-one-meetings/${meeting.id}`,
        "PATCH",
        { field, value: value.trim() ? value : null, expected_revision: revision },
        (json) => (json as { revision: number }).revision,
      );
    };

  const fieldKey = (field: MeetingTextField) =>
    `${meeting?.id ?? "none"}:${field}`;
  const fieldProps = (field: MeetingTextField) => ({
    fieldKey: fieldKey(field),
    value: meeting?.[field] ?? null,
    revision: meeting?.[revisionColumn(field)] ?? 0,
    disabled: !meeting,
    save: saveField(field),
  });

  const upsertCommitment = (c: MeetingCommitment) =>
    patch((w) => {
      const isNew = meeting !== null && c.origin_meeting_id === meeting.id;
      const inNew = w.new_commitments.some((x) => x.id === c.id);
      return {
        ...w,
        new_commitments: isNew
          ? inNew
            ? w.new_commitments.map((x) => (x.id === c.id ? c : x))
            : [...w.new_commitments, c]
          : w.new_commitments,
        carryover: w.carryover.map((x) =>
          x.id === c.id ? { ...x, ...c } : x,
        ),
        last_completed: w.last_completed
          ? {
              ...w.last_completed,
              commitments: w.last_completed.commitments.map((x) =>
                x.id === c.id ? c : x,
              ),
            }
          : null,
      };
    });

  return (
    <DraftContext.Provider value={draft}>
      <div className="flex flex-col gap-4 pb-8">
        <WorkspaceHeader
          ws={ws}
          starting={starting}
          onStart={start}
          historyOpen={historyOpen}
          onToggleHistory={() => setHistoryOpen((v) => !v)}
        />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {historyOpen ? <HistoryPanel ws={ws} /> : null}

        {ws.last_completed ? (
          <FromLastOneOnOne
            aeId={aeId}
            last={ws.last_completed}
            onFollowUp={upsertCommitment}
            meetingId={meeting?.id ?? null}
          />
        ) : null}

        <Section title="Wins / Good News">
          <AutosaveText
            key={fieldKey("wins")}
            {...fieldProps("wins")}
            label="Wins"
            rows={3}
            maxLength={MEETING_NOTES_MAX_LENGTH}
            placeholder={
              meeting
                ? "Wins, good news, things to celebrate…"
                : "Start the 1:1 to capture wins."
            }
          />
        </Section>

        <Section
          id="activity"
          title="Activity & Results"
          description="Last week vs this week, each scored on the goals in effect that week."
        >
          <ActivityResults snapshot={ws.activity} />
          <div className="mt-4">
            <AutosaveText
              key={fieldKey("activity_notes")}
              {...fieldProps("activity_notes")}
              label="Activity notes"
              rows={2}
              maxLength={MEETING_NOTES_MAX_LENGTH}
              placeholder={
                meeting
                  ? "What stands out in the numbers…"
                  : "Start the 1:1 to add activity notes."
              }
            />
          </div>
        </Section>

        <GoldListReview
          agents={ws.gold_list}
          notes={ws.gold_list_notes}
          todayIso={ws.today}
          meetingId={meeting?.id ?? null}
          actionAgentIds={new Set(ws.gold_list_action_agent_ids)}
          onAction={(agentId) =>
            patch((w) =>
              w.gold_list_action_agent_ids.includes(agentId)
                ? w
                : { ...w, gold_list_action_agent_ids: [...w.gold_list_action_agent_ids, agentId] },
            )
          }
          onAgentChange={(agent: WorkspaceGoldListAgent) =>
            patch((w) => ({
              ...w,
              gold_list: w.gold_list.map((a) => (a.id === agent.id ? agent : a)),
            }))
          }
          onNoteChange={(note: GoldListDiscussionNote) =>
            patch((w) => ({
              ...w,
              gold_list_notes: [
                ...w.gold_list_notes.filter((n) => n.agent_id !== note.agent_id),
                note,
              ],
            }))
          }
        />

        <CoachingSection
          meeting={meeting}
          previousFocus={ws.last_completed?.meeting.coaching_focus ?? null}
          focus={fieldProps("coaching_focus")}
          notes={fieldProps("coaching_notes")}
        />

        <CommitmentsSection
          meetingId={meeting?.id ?? null}
          carryover={ws.carryover}
          legacy={ws.legacy_carryover}
          created={ws.new_commitments}
          aeName={aeName}
          managerName={managerName}
          onCommitment={upsertCommitment}
          onRemoved={(id) =>
            patch((w) => ({
              ...w,
              new_commitments: w.new_commitments.filter((c) => c.id !== id),
            }))
          }
          onLegacyChange={() => void refresh()}
        />

        <UpdateGoalsDisclosure
          aeId={aeId}
          currentGoal={ws.weekly_goal_current}
          nextOverride={ws.weekly_goal_next_override}
          nextWeekStart={ws.next_week_start}
          onChange={() => void refresh()}
        />

        {meeting ? (
          <CompleteBar
            ws={ws}
            onCompleted={(record) =>
              router.push(`/admin/coaching/${aeId}/meetings/${record.meeting.id}`)
            }
          />
        ) : (
          <div className="rounded-xl border border-dashed border-border p-4 text-center">
            <Button size="lg" onClick={() => void start()} disabled={starting}>
              <Play aria-hidden="true" />
              {starting ? "Starting…" : "Start 1:1"}
            </Button>
          </div>
        )}

        <LegacyWeeklyFocus aeId={aeId} meetingId={meeting?.id ?? null} />
      </div>
    </DraftContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Header + history
// ---------------------------------------------------------------------------

function WorkspaceHeader({
  ws,
  starting,
  onStart,
  historyOpen,
  onToggleHistory,
}: {
  ws: OneOnOneWorkspace;
  starting: boolean;
  onStart: () => void;
  historyOpen: boolean;
  onToggleHistory: () => void;
}) {
  const last = ws.last_completed?.meeting;
  return (
    <div className="space-y-2">
      <Link
        href="/admin/coaching"
        className="inline-flex min-h-9 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        All AEs
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            {ws.ae.first_name} · 1:1 Workspace
          </h2>
          <p className="text-sm text-muted-foreground">
            Last 1:1: {last ? shortDate(last.meeting_date) : "none yet"} ·
            Today: {shortDate(ws.today)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {ws.meeting ? (
            <span className="inline-flex min-h-10 items-center gap-2 rounded-full bg-primary/10 px-3 text-sm font-medium text-primary">
              <span aria-hidden="true" className="size-2 rounded-full bg-primary" />
              In progress · started {formatTaskMoment(ws.meeting.started_at)}
            </span>
          ) : (
            <Button size="lg" onClick={onStart} disabled={starting}>
              <Play aria-hidden="true" />
              {starting ? "Starting…" : "Start 1:1"}
            </Button>
          )}
          <Button
            size="lg"
            variant="outline"
            aria-expanded={historyOpen}
            onClick={onToggleHistory}
          >
            <History aria-hidden="true" />
            1:1 History
            {ws.history.length > 0 ? ` (${ws.history.length})` : ""}
          </Button>
        </div>
      </div>
      {ws.meeting ? (
        <p className="text-xs text-muted-foreground">
          Everything saves automatically. Complete the 1:1 at the bottom to lock
          it into history.
        </p>
      ) : null}
    </div>
  );
}

function HistoryPanel({ ws }: { ws: OneOnOneWorkspace }) {
  // First page arrives with the workspace; older pages load on demand.
  const [older, setOlder] = useState<OneOnOneWorkspace["history"]>([]);
  const [hasMore, setHasMore] = useState(ws.history_has_more);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = [...ws.history, ...older];

  const loadOlder = async () => {
    const last = items[items.length - 1];
    if (!last || loading) return;
    setLoading(true);
    setError(null);
    try {
      const page = await apiFetchJson<{
        items: OneOnOneWorkspace["history"];
        has_more: boolean;
      }>(
        `/api/admin/coaching/${ws.ae.id}/meetings/history?before=${encodeURIComponent(last.completed_at)}&before_id=${last.id}`,
      );
      setOlder((prev) => [...prev, ...page.items]);
      setHasMore(page.has_more);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load older 1:1s.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Section title="1:1 History" description="Completed 1:1s, newest first.">
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No completed 1:1s yet.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {items.map((h) => (
            <li key={h.id}>
              <Link
                href={`/admin/coaching/${ws.ae.id}/meetings/${h.id}`}
                className="flex min-h-11 items-center justify-between gap-3 py-2 hover:text-primary"
              >
                <span className="shrink-0 font-medium">
                  {format(parseISO(h.meeting_date), "MMM d, yyyy")}
                </span>
                <span className="min-w-0 truncate text-sm text-muted-foreground">
                  {h.coaching_focus ?? ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {hasMore ? (
        <Button
          variant="outline"
          size="lg"
          className="mt-2 w-full sm:w-auto"
          disabled={loading}
          onClick={() => void loadOlder()}
        >
          {loading ? "Loading…" : "Load older 1:1s"}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// From your last 1:1
// ---------------------------------------------------------------------------

function FromLastOneOnOne({
  aeId,
  last,
  meetingId,
  onFollowUp,
}: {
  aeId: string;
  last: NonNullable<OneOnOneWorkspace["last_completed"]>;
  meetingId: string | null;
  onFollowUp: (c: MeetingCommitment) => void;
}) {
  const { meeting, commitments } = last;
  const draft = useDraft();
  const locked = useDraftLocked();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // Checking a follow-up off here resolves it IN the current 1:1 (same route
  // as the Commitments section), so it needs a meeting in progress.
  const toggle = async (c: MeetingCommitment) => {
    if (!meetingId || busy || locked) return;
    setBusy(c.id);
    setFailed(false);
    try {
      const res = await draft.mutate(() =>
        apiFetchJson<{ commitment: MeetingCommitment }>(
          `/api/admin/one-on-one-meetings/${meetingId}/commitments/${c.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              status: c.status === "completed" ? "open" : "completed",
            }),
          },
        ),
      );
      onFollowUp(res.commitment);
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };
  const label = format(parseISO(meeting.meeting_date), "MMM d");
  return (
    <section className="rounded-xl border border-primary/30 bg-primary/5 p-4 sm:p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-primary">
        From your last 1:1 — {label}
      </p>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-xs text-muted-foreground">Coaching focus</p>
          <p className="text-sm font-medium">{meeting.coaching_focus ?? "—"}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Follow-ups</p>
          {commitments.length === 0 ? (
            <p className="text-sm text-muted-foreground">None recorded.</p>
          ) : (
            <ul className="space-y-0.5">
              {commitments.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    disabled={!meetingId || busy === c.id || locked}
                    onClick={() => void toggle(c)}
                    className="flex min-h-9 items-start gap-2 text-left text-sm disabled:cursor-default"
                    title={meetingId ? undefined : "Start the 1:1 to check these off"}
                  >
                    {c.status === "completed" ? (
                      <Check
                        aria-label="Done"
                        className="mt-0.5 size-4 shrink-0 text-green-600 dark:text-green-400"
                      />
                    ) : (
                      <Circle
                        aria-label="Open"
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                      />
                    )}
                    <span
                      className={cn(
                        c.status === "completed" && "text-muted-foreground line-through",
                      )}
                    >
                      {c.description}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {failed ? (
            <p role="alert" className="text-xs text-destructive">
              Not saved — try again.
            </p>
          ) : null}
        </div>
      </div>
      <Link
        href={`/admin/coaching/${aeId}/meetings/${meeting.id}`}
        className="mt-2 inline-flex min-h-9 items-center text-sm font-medium text-primary underline-offset-4 hover:underline"
      >
        View full {label} notes
      </Link>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Coaching
// ---------------------------------------------------------------------------

type FieldBinding = {
  fieldKey: string;
  value: string | null;
  revision: number;
  disabled: boolean;
  save: FieldSaver;
};

function CoachingSection({
  meeting,
  previousFocus,
  focus,
  notes,
}: {
  meeting: OneOnOneMeeting | null;
  previousFocus: string | null;
  focus: FieldBinding;
  notes: FieldBinding;
}) {
  // Carrying the previous focus forward is an explicit choice — today's
  // field is never pre-filled from history.
  const focusField = useDraftField(focus.fieldKey, focus.value, focus.save, focus.revision);
  const canCarry = Boolean(
    meeting && previousFocus && !focusField.value.trim() && !focusField.locked,
  );
  return (
    <Section title="Coaching">
      <div className="space-y-3">
        <AutosaveText
          {...focus}
          label="Coaching focus"
          multiline={false}
          maxLength={COACHING_FOCUS_MAX_LENGTH}
          placeholder={
            meeting ? "What are we coaching on?" : "Start the 1:1 to set a focus."
          }
          hint={
            previousFocus ? (
              <>
                Last time: {previousFocus}
                {canCarry ? (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className="font-medium text-primary underline-offset-2 hover:underline"
                      onClick={(e) => {
                        e.preventDefault();
                        if (focusField.set(previousFocus)) void focusField.flush();
                      }}
                    >
                      Carry forward
                    </button>
                  </>
                ) : null}
              </>
            ) : undefined
          }
        />
        <AutosaveText
          {...notes}
          label="Coaching / discussion notes"
          rows={4}
          maxLength={MEETING_NOTES_MAX_LENGTH}
          placeholder={
            meeting
              ? "What we discussed, progress, observations, things to remember next time…"
              : "Start the 1:1 to take coaching notes."
          }
        />
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Complete 1:1
// ---------------------------------------------------------------------------

function CompleteBar({
  ws,
  onCompleted,
}: {
  ws: OneOnOneWorkspace;
  onCompleted: (record: MeetingRecord) => void;
}) {
  const draft = useDraft();
  const locked = useDraftLocked(); // also re-renders as notes are typed
  const [error, setError] = useState<string | null>(null);
  const meeting = ws.meeting!;
  const actionIds = new Set(ws.gold_list_action_agent_ids);
  const discussed = ws.gold_list.filter(
    (a) =>
      actionIds.has(a.id) ||
      (
        draft.get(noteKey(meeting.id, a.id))?.value ??
        ws.gold_list_notes.find((n) => n.agent_id === a.id)?.note ??
        ""
      ).trim() !== "",
  ).length;
  const created = ws.new_commitments.filter((c) => c.status !== "dropped").length;

  const complete = async () => {
    if (draft.locked) return;
    if (
      !window.confirm(
        `Complete this 1:1 with ${ws.ae.first_name}? It becomes a permanent, read-only record.`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      // Locks the draft, saves every field (collapsed ones too) and waits for
      // in-flight actions, then completes. Unlocks intact on any failure.
      const record = await completeDraft(draft, () =>
        apiFetchJson<MeetingRecord>(
          `/api/admin/one-on-one-meetings/${meeting.id}/complete`,
          { method: "POST" },
        ),
      );
      onCompleted(record);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't complete the 1:1.");
    }
  };

  return (
    <section className="rounded-xl bg-card p-4 ring-1 ring-foreground/10 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {locked
            ? "Saving your notes and completing the 1:1 — editing is paused."
            : `${discussed} Gold List agent${discussed === 1 ? "" : "s"} discussed · ${created} new commitment${created === 1 ? "" : "s"}. Completing saves a permanent record, including this week's numbers.`}
        </p>
        <Button
          size="lg"
          onClick={() => void complete()}
          disabled={locked}
          className="min-h-11 w-full sm:w-auto"
        >
          <Check aria-hidden="true" />
          {locked ? "Completing…" : "Complete 1:1"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error} Your notes are still here — try again.
        </p>
      ) : null}
    </section>
  );
}
