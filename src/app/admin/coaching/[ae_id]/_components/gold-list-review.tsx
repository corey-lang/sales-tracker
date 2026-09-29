"use client";

import { useMemo, useRef, useState } from "react";
import { format, parseISO } from "date-fns";
import { Check, ChevronDown, ChevronUp, History, MessageSquare, Plus } from "lucide-react";

import { apiFetchJson } from "@/lib/api-client";
import { formatDateMDY } from "@/lib/dates";
import type { GoldListActivity } from "@/lib/gold-list";
import {
  GOLD_LIST_DISCUSSION_NOTE_MAX_LENGTH,
  GOLD_LIST_REVIEW_FILTERS,
  goldListReviewBucket,
  matchesGoldListReviewFilter,
  sortGoldListForReview,
  summarizeGoldListForReview,
  type GoldListDiscussionNote,
  type GoldListReviewFilter,
  type WorkspaceGoldListAgent,
} from "@/lib/one-on-one-meetings";
import { cn } from "@/lib/utils";

import {
  ActivityHistoryList,
  CompleteActivityForm,
  ScheduleActivityForm,
} from "@/components/gold-list-agent-card";
import { Button } from "@/components/ui/button";

import {
  AutosaveText,
  Section,
  revisionedSave,
  useDraft,
  useDraftLocked,
} from "./autosave-text";

// Gold List Review — the AE's REAL Gold List, pulled live, ordered for a 1:1:
// overdue → no next activity → due this week → the rest.
//
// TWO KINDS OF WRITES, KEPT APART
//   A) Gold List changes (complete / schedule / edit the next activity) hit
//      the manager 1:1 routes, which run the SAME shared writer as the AE's
//      own /gold-list routes. They change the live Gold List.
//   B) The 1:1 discussion note is manager-only, meeting-specific, and stored
//      in one_on_one_gold_list_notes — never on the Gold List itself. Its
//      text lives in the page's draft coordinator, so collapsing a card
//      never loses it or drops it from Complete 1:1.
//
// An agent counts as "discussed" when it has a note or a Gold List action
// EXPLICITLY attributed to this 1:1 (the server stamps the meeting on the
// activity row) — never because of the AE's own unrelated activity.
//
// Both require an in-progress 1:1; before "Start 1:1" the section is a
// read-only prep view.

function shortDate(iso: string): string {
  return format(parseISO(iso), "MMM d");
}

const BUCKET_BADGE: Record<string, { label: string; className: string } | null> = {
  overdue: { label: "Overdue", className: "bg-red-500/10 text-red-700 dark:text-red-400" },
  no_next: {
    label: "No next activity",
    className: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  due_this_week: {
    label: "Due this week",
    className: "bg-primary/10 text-primary",
  },
  later: null,
};

export function GoldListReview({
  agents,
  notes,
  todayIso,
  meetingId,
  actionAgentIds,
  onAgentChange,
  onNoteChange,
  onAction,
}: {
  agents: WorkspaceGoldListAgent[];
  notes: GoldListDiscussionNote[];
  todayIso: string;
  /** The in-progress meeting, or null before Start 1:1. */
  meetingId: string | null;
  /** Agents with a Gold List action attributed to this 1:1. */
  actionAgentIds: ReadonlySet<string>;
  onAgentChange: (agent: WorkspaceGoldListAgent) => void;
  onNoteChange: (note: GoldListDiscussionNote) => void;
  onAction: (agentId: string) => void;
}) {
  const draft = useDraft();
  useDraftLocked(); // re-render on draft changes (typed notes count as discussed)
  const summary = useMemo(
    () => summarizeGoldListForReview(agents, todayIso),
    [agents, todayIso],
  );
  const [filter, setFilter] = useState<GoldListReviewFilter>(
    summary.overdue + summary.no_next > 0 ? "attention" : "all",
  );
  const noteByAgent = useMemo(() => {
    const m = new Map<string, GoldListDiscussionNote>();
    for (const n of notes) if (n.agent_id) m.set(n.agent_id, n);
    return m;
  }, [notes]);
  // Cards opened during this visit stay listed even if an update moves them
  // out of the current filter (e.g. scheduling the next activity takes an
  // agent out of "Needs attention") — a card never vanishes mid-conversation.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const visible = useMemo(
    () =>
      sortGoldListForReview(
        agents.filter(
          (a) =>
            opened.has(a.id) ||
            matchesGoldListReviewFilter(a, filter, todayIso),
        ),
        todayIso,
      ),
    [agents, filter, todayIso, opened],
  );
  const noteText = (agentId: string) =>
    meetingId
      ? (draft.get(noteKey(meetingId, agentId))?.value ??
        noteByAgent.get(agentId)?.note ??
        "")
      : "";
  const isDiscussed = (agentId: string) =>
    actionAgentIds.has(agentId) || noteText(agentId).trim() !== "";
  const discussed = agents.filter((a) => isDiscussed(a.id)).length;

  return (
    <Section
      id="gold-list"
      title="Gold List"
      description={
        meetingId
          ? "Updates here change the AE's real Gold List. Discussion notes stay in this 1:1."
          : "Start the 1:1 to update the Gold List or add discussion notes."
      }
    >
      <dl className="mb-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <SummaryStat label="Gold List agents" value={summary.total} />
        <SummaryStat label="Overdue" value={summary.overdue} tone="bad" />
        <SummaryStat label="No next activity" value={summary.no_next} tone="warn" />
        <SummaryStat label="Due this week" value={summary.due_this_week} />
      </dl>

      <div
        role="tablist"
        aria-label="Filter Gold List"
        className="mb-3 flex flex-wrap items-center gap-1.5"
      >
        {GOLD_LIST_REVIEW_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            role="tab"
            aria-selected={filter === f.key}
            onClick={() => {
              setFilter(f.key);
              setOpened(new Set());
            }}
            className={cn(
              "min-h-9 rounded-full border px-3 text-sm transition-colors",
              filter === f.key
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background hover:bg-muted",
            )}
          >
            {f.label}
          </button>
        ))}
        {discussed > 0 ? (
          <span className="ml-auto text-xs text-muted-foreground">
            {discussed} discussed this 1:1
          </span>
        ) : null}
      </div>

      {agents.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This AE has no active Gold List agents yet.
        </p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing here — try{" "}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => setFilter("all")}
          >
            All
          </button>
          .
        </p>
      ) : (
        <ul className="space-y-2">
          {visible.map((agent) => (
            <ReviewAgentCard
              key={agent.id}
              agent={agent}
              note={noteByAgent.get(agent.id) ?? null}
              todayIso={todayIso}
              meetingId={meetingId}
              discussed={isDiscussed(agent.id)}
              onAgentChange={onAgentChange}
              onNoteChange={onNoteChange}
              onAction={() => onAction(agent.id)}
              onOpen={() =>
                setOpened((prev) =>
                  prev.has(agent.id) ? prev : new Set(prev).add(agent.id),
                )
              }
            />
          ))}
        </ul>
      )}
    </Section>
  );
}

function SummaryStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "bad" | "warn";
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd
        className={cn(
          "text-xl font-semibold tabular-nums",
          value > 0 && tone === "bad" && "text-red-600 dark:text-red-400",
          value > 0 && tone === "warn" && "text-amber-600 dark:text-amber-400",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

type Mode = "idle" | "complete" | "schedule" | "edit";

/** Draft coordinator key for one agent's discussion note in one meeting. */
export function noteKey(meetingId: string, agentId: string): string {
  return `${meetingId}:note:${agentId}`;
}

function ReviewAgentCard({
  agent,
  note,
  todayIso,
  meetingId,
  discussed,
  onAgentChange,
  onNoteChange,
  onAction,
  onOpen,
}: {
  agent: WorkspaceGoldListAgent;
  note: GoldListDiscussionNote | null;
  todayIso: string;
  meetingId: string | null;
  discussed: boolean;
  onAgentChange: (agent: WorkspaceGoldListAgent) => void;
  onNoteChange: (note: GoldListDiscussionNote) => void;
  onAction: () => void;
  onOpen: () => void;
}) {
  const draft = useDraft();
  const locked = useDraftLocked();
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<Mode>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<GoldListActivity[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const requestId = useRef<string | null>(null);

  const bucket = goldListReviewBucket(agent, todayIso);
  const badge = BUCKET_BADGE[bucket];
  const next = agent.next_activity;
  const canEdit = meetingId !== null && agent.can_edit;
  const base = meetingId
    ? `/api/admin/one-on-one-meetings/${meetingId}/gold-list/${agent.id}`
    : null;

  const run = async (
    request: () => Promise<{ activity: GoldListActivity; agent: WorkspaceGoldListAgent }>,
    after: Mode,
  ) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Tracked by the draft so Complete 1:1 waits for it (and refuses to
      // start new ones while completing).
      const res = await draft.mutate(request);
      onAgentChange(res.agent);
      setHistory((prev) =>
        prev ? [res.activity, ...prev.filter((a) => a.id !== res.activity.id)] : prev,
      );
      onAction();
      setMode(after);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save — please retry.");
    } finally {
      setBusy(false);
    }
  };

  const schedule = (description: string, activityNote: string, date: string) => {
    requestId.current ??= crypto.randomUUID();
    const id = requestId.current;
    return run(async () => {
      const res = await apiFetchJson<{
        activity: GoldListActivity;
        agent: WorkspaceGoldListAgent;
      }>(`${base}/activities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description,
          activity_note: activityNote.trim() || null,
          scheduled_for: date,
          request_id: id,
        }),
      });
      requestId.current = null;
      return res;
    }, "idle");
  };

  const patchNext = (body: Record<string, unknown>, after: Mode) =>
    next
      ? run(
          () =>
            apiFetchJson(`${base}/activities/${next.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
          after,
        )
      : Promise.resolve();

  const toggleHistory = async () => {
    const opening = !historyOpen;
    setHistoryOpen(opening);
    if (!opening || history) return;
    try {
      // Admins may READ any AE's history through the existing Gold List route.
      const res = await apiFetchJson<{ activities: GoldListActivity[] }>(
        `/api/gold-list/agents/${agent.id}/activities`,
      );
      setHistory(res.activities);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load history.");
    }
  };

  return (
    <li
      className={cn(
        "rounded-lg border bg-background/40",
        discussed ? "border-primary/40" : "border-border/70",
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => {
          if (!expanded) onOpen();
          setExpanded((v) => !v);
        }}
        className="flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left"
      >
        <div className="min-w-0 space-y-0.5">
          <p className="text-base font-semibold leading-snug">
            {agent.agent_name}
            {agent.brokerage ? (
              <span className="font-normal text-muted-foreground">
                {" "}
                · {agent.brokerage}
              </span>
            ) : null}
          </p>
          <p className="text-sm text-muted-foreground">
            <span className="text-foreground/70">Last:</span>{" "}
            {agent.last_completed
              ? `${shortDate(agent.last_completed.completed_on)} — ${agent.last_completed.description}`
              : "No completed activity yet"}
          </p>
          <p className="text-sm">
            <span className="text-foreground/70">Next:</span>{" "}
            {next ? (
              <span className={cn(bucket === "overdue" && "font-medium text-red-600 dark:text-red-400")}>
                {shortDate(next.scheduled_for)} — {next.description}
              </span>
            ) : (
              <span className="text-muted-foreground">Nothing scheduled</span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {badge ? (
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                badge.className,
              )}
            >
              {badge.label}
            </span>
          ) : null}
          {discussed ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-primary">
              <MessageSquare aria-hidden="true" className="size-3" />
              Discussed
            </span>
          ) : null}
          {expanded ? (
            <ChevronUp aria-hidden="true" className="size-4 text-muted-foreground" />
          ) : (
            <ChevronDown aria-hidden="true" className="size-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {expanded ? (
        <div className="space-y-3 border-t border-border/60 px-3 py-3">
          {canEdit && mode === "idle" && !locked ? (
            <div className="flex flex-wrap gap-2">
              {next ? (
                <>
                  <Button
                    size="lg"
                    disabled={busy}
                    onClick={() => setMode("complete")}
                  >
                    <Check aria-hidden="true" />
                    Complete activity
                  </Button>
                  <Button
                    size="lg"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setMode("edit")}
                  >
                    Edit next activity
                  </Button>
                </>
              ) : (
                <Button
                  size="lg"
                  disabled={busy}
                  onClick={() => setMode("schedule")}
                >
                  <Plus aria-hidden="true" />
                  Add next activity
                </Button>
              )}
            </div>
          ) : null}

          {canEdit && !locked && mode === "complete" && next ? (
            <CompleteActivityForm
              activity={next}
              busy={busy}
              onCancel={() => setMode("idle")}
              onSubmit={(outcome) =>
                patchNext(
                  { status: "completed", outcome_note: outcome.trim() || null },
                  "schedule",
                )
              }
            />
          ) : null}
          {canEdit && !locked && mode === "schedule" ? (
            <ScheduleActivityForm
              title={`Next activity for ${agent.agent_name}`}
              defaultDate={todayIso}
              defaultDescription=""
              defaultNote=""
              busy={busy}
              onCancel={() => setMode("idle")}
              onSubmit={schedule}
            />
          ) : null}
          {canEdit && !locked && mode === "edit" && next ? (
            <ScheduleActivityForm
              title="Edit next activity"
              defaultDate={next.scheduled_for}
              defaultDescription={next.description}
              defaultNote={next.activity_note ?? ""}
              submitLabel="Save"
              busy={busy}
              onCancel={() => setMode("idle")}
              onSubmit={(description, activityNote, date) =>
                patchNext(
                  {
                    description,
                    activity_note: activityNote.trim() || null,
                    scheduled_for: date,
                  },
                  "idle",
                )
              }
            />
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          {meetingId ? (
            <AutosaveText
              fieldKey={noteKey(meetingId, agent.id)}
              label="1:1 discussion note"
              value={note?.note ?? null}
              rows={2}
              maxLength={GOLD_LIST_DISCUSSION_NOTE_MAX_LENGTH}
              placeholder="What you discussed about this agent — manager only."
              revision={note?.revision ?? 0}
              save={(text, revision) =>
                revisionedSave(
                  base!,
                  "PUT",
                  { note: text.trim() || null, expected_revision: revision },
                  (json) => {
                    const saved = (json as { note: GoldListDiscussionNote }).note;
                    onNoteChange(saved);
                    return saved.revision;
                  },
                )
              }
            />
          ) : null}

          <div>
            <button
              type="button"
              onClick={() => void toggleHistory()}
              aria-expanded={historyOpen}
              className="inline-flex min-h-9 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              <History aria-hidden="true" className="size-4" />
              Recent history {historyOpen ? "▴" : "▾"}
              {agent.completed_count > 0 ? ` (${agent.completed_count})` : ""}
            </button>
            {historyOpen ? (
              <div className="mt-2">
                {history === null ? (
                  <p className="text-sm text-muted-foreground">Loading…</p>
                ) : (
                  <ActivityHistoryList
                    activities={history.slice(0, 10)}
                    creator={agent.owner_name ?? "AE"}
                  />
                )}
              </div>
            ) : null}
          </div>
          {next?.activity_note ? (
            <p className="text-xs text-muted-foreground">
              Next activity note ({formatDateMDY(next.scheduled_for)}):{" "}
              {next.activity_note}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
