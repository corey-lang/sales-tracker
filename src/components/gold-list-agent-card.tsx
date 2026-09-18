"use client";

import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  CalendarClock,
  Check,
  ChevronDown,
  History,
  Mail,
  Pencil,
  Phone,
  Plus,
  X,
} from "lucide-react";

import { apiFetchJson } from "@/lib/api-client";
import { APP_TIMEZONE, formatDateMDY, formatTaskMoment } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { goldListEmailHref, goldListPhoneHref } from "@/lib/gold-list-contact";
import {
  ACTIVITY_NOTE_MAX_LENGTH,
  AGENT_FIELD_MAX_LENGTH,
  AGENT_NAME_MAX_LENGTH,
  AGENT_NOTES_MAX_LENGTH,
  OUTCOME_NOTE_MAX_LENGTH,
  scheduleToneFor,
  type GoldListActivity,
  type GoldListActivitySummary,
  type GoldListAgentWithFollowUp,
} from "@/lib/gold-list";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

// One Gold List agent, and the whole follow-up loop for them:
//
//   schedule an activity -> complete it (optional outcome note) -> schedule
//   the next one, with every completed activity kept in History.
//
// The card never deletes an activity when it is completed; completion flips
// the row's status and a NEW row carries the next touch, so the relationship's
// timeline survives indefinitely and across weeks.
//
// THREE NOTES, THREE PLACES — they are never merged or substituted:
//   * the agent's `notes`      — the standing relationship note, edited in
//                                Edit agent, shown inside Details & history.
//   * `activity_note`          — OPTIONAL plan for the scheduled activity,
//                                written in the activity form, shown under the
//                                description on the card and in history.
//   * `outcome_note`           — OPTIONAL record of what happened, written in
//                                the completion form, shown in history only.
//
// WRITE AFFORDANCES ARE GATED ON `agent.can_edit`, which the server computes
// (owner-only). An admin viewing another AE's Gold List sees the same card in
// read-only form — and the API would reject the write anyway; this is the UX
// half of the same rule.

const TEXTAREA_CLASS =
  "mt-1 w-full resize-y rounded-md border border-border bg-background/40 px-2 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

/** Which inline form (if any) the card is showing. Only one at a time. */
type CardMode = "idle" | "edit" | "schedule" | "reschedule" | "complete";

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function GoldListAgentCard({
  agent,
  todayIso,
  showOwner,
  onAgentChange,
  onKeepVisibleChange,
  outsideFilters = false,
}: {
  agent: GoldListAgentWithFollowUp;
  /** Today in the app timezone (yyyy-mm-dd), passed down so every card agrees. */
  todayIso: string;
  /** Label the card with its owner — the admin "All AEs" view. */
  showOwner: boolean;
  /** Hands the updated agent back to the board so the header count and list stay live. */
  onAgentChange: (agent: GoldListAgentWithFollowUp) => void;
  onKeepVisibleChange?: (id: string, keep: boolean) => void;
  outsideFilters?: boolean;
}) {
  const [mode, setMode] = useState<CardMode>("idle");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const activityRequest = useRef<string | null>(null);
  const actionFocus = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (restoreFocus.current && mode === "idle" && !busy) {
      restoreFocus.current = false;
      actionFocus.current?.focus();
    }
  }, [mode, busy]);
  const [error, setError] = useState<string | null>(null);

  // History is fetched lazily — the board payload carries only the counts, so
  // an agent with years of touches costs nothing until someone opens it.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<GoldListActivity[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const archived = agent.archived_at !== null;
  const next = agent.next_activity;
  const canEdit = agent.can_edit;

  const closeForms = () => {
    onKeepVisibleChange?.(agent.id, false);
    setMode("idle");
    restoreFocus.current = true;
    setError(null);
  };

  /** Applies a completed/cancelled activity to the card's summary locally so
   *  the UI updates immediately, with no refetch. */
  const applyCompletion = (activity: GoldListActivity) => {
    onAgentChange({
      ...agent,
      next_activity: null,
      completed_count:
        activity.status === "completed"
          ? agent.completed_count + 1
          : agent.completed_count,
      last_completed_on:
        activity.status === "completed"
          ? new Intl.DateTimeFormat("en-CA", {
              timeZone: APP_TIMEZONE,
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
            }).format(new Date(activity.completed_at!))
          : agent.last_completed_on,
    });
    // Keep an open history pane truthful.
    setHistory((prev) =>
      prev ? [activity, ...prev.filter((a) => a.id !== activity.id)] : prev,
    );
  };

  const scheduleActivity = async (
    description: string,
    activityNote: string,
    scheduledFor: string,
  ): Promise<GoldListActivity> => {
    activityRequest.current ??= crypto.randomUUID();
    const res = await apiFetchJson<{ activity: GoldListActivity }>(
      `/api/gold-list/agents/${agent.id}/activities`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description,
          activity_note: activityNote.trim() || null,
          request_id: activityRequest.current,
          scheduled_for: scheduledFor,
        }),
      },
    );
    activityRequest.current = null;
    return res.activity;
  };

  const handleSchedule = async (
    description: string,
    activityNote: string,
    scheduledFor: string,
  ) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const activity = await scheduleActivity(
        description,
        activityNote,
        scheduledFor,
      );
      onAgentChange({
        ...agent,
        next_activity: activity.status === "scheduled" ? activity : null,
      });
      setHistory((prev) => (prev ? [activity, ...prev] : prev));
      closeForms();
    } catch (err) {
      setError(messageOf(err, "Could not schedule that activity."));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const handleReschedule = async (
    description: string,
    activityNote: string,
    scheduledFor: string,
  ) => {
    if (!next) return;
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetchJson<{ activity: GoldListActivity }>(
        `/api/gold-list/agents/${agent.id}/activities/${next.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            description,
            // Sent on every edit so clearing the field clears the stored note.
            // The server rejects this outright once the activity is finished.
            activity_note: activityNote.trim() || null,
            scheduled_for: scheduledFor,
          }),
        },
      );
      onAgentChange({ ...agent, next_activity: res.activity });
      setHistory((prev) =>
        prev
          ? prev.map((a) => (a.id === res.activity.id ? res.activity : a))
          : prev,
      );
      closeForms();
    } catch (err) {
      setError(messageOf(err, "Could not reschedule that activity."));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  /**
   * Complete the open activity, then (optionally) schedule the next one.
   *
   * Completion saves first, then opens a separate next-activity form.
   * Skipping or failing to schedule cannot undo the saved history.
   */
  const handleComplete = async (outcomeNote: string) => {
    if (!next || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const completed = await apiFetchJson<{ activity: GoldListActivity }>(
        `/api/gold-list/agents/${agent.id}/activities/${next.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: "completed",
            outcome_note: outcomeNote.trim() || null,
          }),
        },
      );
      onKeepVisibleChange?.(agent.id, true);
      applyCompletion(completed.activity);
      setMode("schedule");
    } catch (err) {
      setError(messageOf(err, "Could not complete that activity."));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const handleCancelActivity = async () => {
    if (!next) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(`Cancel “${next.description}” for ${agent.agent_name}?`)
    ) {
      return;
    }
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetchJson<{ activity: GoldListActivity }>(
        `/api/gold-list/agents/${agent.id}/activities/${next.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "cancelled" }),
        },
      );
      applyCompletion(res.activity);
    } catch (err) {
      setError(messageOf(err, "Could not cancel that activity."));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const handleSaveDetails = async (patch: Record<string, string | null>) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetchJson<{ agent: GoldListAgentWithFollowUp }>(
        `/api/gold-list/agents/${agent.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      onAgentChange(res.agent);
      closeForms();
    } catch (err) {
      setError(messageOf(err, "Could not save those details."));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const handleArchiveToggle = async () => {
    if (
      !archived &&
      typeof window !== "undefined" &&
      !window.confirm(
        `Archive ${agent.agent_name}? Their activity history is kept and you can restore them later.`,
      )
    ) {
      return;
    }
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetchJson<{ agent: GoldListAgentWithFollowUp }>(
        `/api/gold-list/agents/${agent.id}`,
        archived
          ? {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ archived: false }),
            }
          : { method: "DELETE" },
      );
      closeForms();
      onAgentChange(res.agent);
    } catch (err) {
      setError(
        messageOf(
          err,
          archived
            ? "Could not restore that agent."
            : "Could not archive that agent.",
        ),
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const toggleHistory = async () => {
    const opening = !historyOpen;
    setHistoryOpen(opening);
    if (!opening || history !== null) return;
    await loadHistory();
  };

  const loadHistory = async () => {
    setHistoryLoading(true);
    setError(null);
    try {
      const res = await apiFetchJson<{ activities: GoldListActivity[] }>(
        `/api/gold-list/agents/${agent.id}/activities`,
      );
      setHistory(res.activities);
    } catch (err) {
      setError(messageOf(err, "Could not load the history."));
      // Contact details remain available even if the history request fails.
    } finally {
      setHistoryLoading(false);
    }
  };

  return (
    // Compact spacing applies to groups, not to control targets or text sizes.
    <Card
      className={cn(
        "min-w-0 gap-3 py-3 [overflow-wrap:anywhere] [&_button]:min-h-11 [&_button]:min-w-11 [&_button]:text-base [&_button:focus-visible]:ring-primary [&_input]:min-h-11 [&_input]:text-base [&_textarea]:text-base [&_a]:min-h-11",
      )}
    >
      <CardContent className="space-y-2.5 px-3">
        {outsideFilters ? (
          <p role="status" className="text-[0.9375rem] text-foreground/80">
            Activity completed. Schedule the next activity or skip to return to
            your filtered list.
          </p>
        ) : null}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 space-y-0.5">
            {/* Level 1 of the hierarchy — the only 20px text on the card. */}
            <p className="break-words text-xl font-semibold leading-snug">
              {agent.agent_name}
            </p>
            {/* Level 4 — metadata, but at 15px and a brighter mix than
                `muted-foreground` so it reads on the dark card instead of
                receding into it. */}
            {agent.brokerage ? (
              <p className="break-words text-[0.9375rem] leading-snug text-foreground/80">
                {agent.brokerage}
              </p>
            ) : null}
            {/* Shown only where rows could belong to someone else — see
                shouldShowOwnerLine(). An AE's own list never repeats their
                name on every card. */}
            {showOwner && agent.owner_name ? (
              <p className="text-[0.9375rem] leading-snug text-foreground/70">
                AE: {agent.owner_name}
              </p>
            ) : null}
          </div>
          {canEdit ? (
            // `shrink-0` so the action pair never collapses into the name, and
            // the two 44px targets stay side by side with a gap between them —
            // Archive is not reachable by a slightly-off tap on Edit.
            <div className="flex shrink-0 items-center gap-1">
              {!archived ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Edit ${agent.agent_name}`}
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    setMode(mode === "edit" ? "idle" : "edit");
                  }}
                >
                  <Pencil aria-hidden="true" />
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={
                  archived
                    ? `Restore ${agent.agent_name}`
                    : `Archive ${agent.agent_name}`
                }
                disabled={busy}
                onClick={() => void handleArchiveToggle()}
              >
                {archived ? (
                  <ArchiveRestore aria-hidden="true" />
                ) : (
                  <Archive aria-hidden="true" />
                )}
              </Button>
            </div>
          ) : null}
        </div>

        {/* CONTACT ROW — always on the card, not behind Details.
            A collapsed card has to answer three things: who is this, how do I
            reach them, and what is next. Reaching them is core work, so the
            row sits directly under the identity block and above the activity
            section, and it stays put when Details & history is expanded (and
            when a history load fails) — there is ONE set of links, live in
            every state, rather than a second copy inside the disclosure that
            would duplicate the same tel:/mailto: targets.

            Rendered only when there is something to show: an agent with no
            phone and no email gets no row, no placeholder and no extra gap.

            `flex-wrap` lets the two links share a row when they fit and stack
            when they don't; the email's `break-all` wraps a long address
            inside the card instead of widening the page. The card's
            `[&_a]:min-h-11` gives each link a 44px target without padding
            that would show as a box. */}
        {(agent.phone || agent.email) && mode !== "edit" ? (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-0 text-base">
            {agent.phone ? (
              <a
                href={goldListPhoneHref(agent.phone)}
                aria-label={`Call ${agent.agent_name} at ${agent.phone}`}
                className="inline-flex min-w-0 break-all items-center gap-1.5 rounded-sm text-foreground/90 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                <Phone aria-hidden="true" className="size-4 shrink-0" />
                {agent.phone}
              </a>
            ) : null}
            {agent.email ? (
              <a
                href={goldListEmailHref(agent.email)}
                aria-label={`Email ${agent.agent_name} at ${agent.email}`}
                className="inline-flex min-w-0 items-center gap-1.5 rounded-sm text-foreground/90 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                <Mail aria-hidden="true" className="size-4 shrink-0" />
                <span className="break-all">{agent.email}</span>
              </a>
            ) : null}
          </div>
        ) : null}

        {historyOpen && agent.notes && mode !== "edit" ? (
          <p className="whitespace-pre-wrap break-words text-[0.9375rem] text-foreground/80">
            {agent.notes}
          </p>
        ) : null}

        {mode === "edit" ? (
          <EditAgentForm
            agent={agent}
            busy={busy || historyLoading}
            onCancel={closeForms}
            onSave={handleSaveDetails}
          />
        ) : null}

        {/* ----- the follow-up loop ----- */}
        {archived ? (
          <p className="text-[0.9375rem] text-foreground/70">
            Archived {formatTaskMoment(agent.archived_at!)}. History is kept.
          </p>
        ) : next ? (
          <NextActivityRow
            activity={next}
            todayIso={todayIso}
            canEdit={canEdit}
            busy={busy || historyLoading}
            active={mode}
            onComplete={() => {
              setError(null);
              setMode(mode === "complete" ? "idle" : "complete");
            }}
            onReschedule={() => {
              setError(null);
              setMode(mode === "reschedule" ? "idle" : "reschedule");
            }}
            onCancel={() => void handleCancelActivity()}
          />
        ) : (
          // No dashed empty-state box: it cost ~60px of card height and a
          // border to say one short sentence. This is the same information as
          // a plain row — status on the left, action on the right — which
          // `flex-wrap` stacks cleanly at narrow widths rather than shrinking
          // either one to force a single line.
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <p className="text-base font-medium text-foreground/90">
              No next activity
            </p>
            {canEdit ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setMode(mode === "schedule" ? "idle" : "schedule");
                }}
              >
                <Plus aria-hidden="true" />
                Add Activity
              </Button>
            ) : null}
          </div>
        )}

        {mode === "schedule" ? (
          <ScheduleActivityForm
            title="Schedule an activity"
            defaultDate={todayIso}
            busy={busy || historyLoading}
            defaultDescription=""
            defaultNote=""
            onCancel={closeForms}
            onSubmit={handleSchedule}
          />
        ) : null}

        {mode === "reschedule" && next ? (
          <ScheduleActivityForm
            title="Edit activity"
            defaultDate={next.scheduled_for}
            busy={busy || historyLoading}
            defaultDescription={next.description}
            defaultNote={next.activity_note ?? ""}
            submitLabel="Save"
            onCancel={closeForms}
            onSubmit={handleReschedule}
          />
        ) : null}

        {mode === "complete" && next ? (
          <CompleteActivityForm
            activity={next}
            busy={busy || historyLoading}
            onCancel={closeForms}
            onSubmit={handleComplete}
          />
        ) : null}

        {error ? (
          <p role="alert" className="text-[0.9375rem] text-destructive">
            {error}
          </p>
        ) : null}

        {/* ----- preserved history ----- */}
        <div className="space-y-2">
          {/* The WHOLE ROW is the control, not just the chevron: full width,
              its label and its summary inside the button, the chevron pushed
              to the far edge by `justify-between`. Keyboard operation, the
              aria-expanded state, lazy loading and the disabled-while-a-form-
              is-open behaviour are unchanged; only the hit area and the
              typography grew. The negative margin lets the hover/focus
              background bleed to the card's padding edge without widening the
              card. */}
          <button
            type="button"
            ref={actionFocus}
            disabled={busy || mode !== "idle"}
            onClick={() => void toggleHistory()}
            aria-expanded={historyOpen}
            className="-mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-2 rounded-md px-2 text-left text-base font-medium text-foreground/90 transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
          >
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="inline-flex items-center gap-1.5">
                <History aria-hidden="true" className="size-4 shrink-0" />
                Details &amp; history ({agent.completed_count})
              </span>
              {agent.last_completed_on ? (
                <span className="text-[0.9375rem] font-normal text-foreground/70">
                  · Last {formatDateMDY(agent.last_completed_on)}
                </span>
              ) : null}
            </span>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "size-5 shrink-0 transition-transform",
                historyOpen && "rotate-180",
              )}
            />
          </button>
          {historyOpen ? (
            historyLoading ? (
              <p className="text-[0.9375rem] text-foreground/70">Loading…</p>
            ) : history === null ? (
              <Button variant="outline" onClick={() => void loadHistory()}>
                Retry history
              </Button>
            ) : (
              <ActivityHistoryList
                activities={history ?? []}
                creator={agent.owner_name ?? agent.salesperson_id}
              />
            )
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

/** The open activity, with the three things you can do to it. */
function NextActivityRow({
  activity,
  todayIso,
  canEdit,
  busy,
  active,
  onComplete,
  onReschedule,
  onCancel,
}: {
  activity: GoldListActivitySummary;
  todayIso: string;
  canEdit: boolean;
  busy: boolean;
  active: CardMode;
  onComplete: () => void;
  onReschedule: () => void;
  onCancel: () => void;
}) {
  const tone = scheduleToneFor(activity.scheduled_for, todayIso);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
      {/* With a note present the text block claims the whole first row on
          phones, so a long note wraps across the card's full width instead of
          into a ~100px ribbon beside the buttons (the row is `flex-wrap`, so
          the actions drop to their own line). Rows without a note keep the
          compact side-by-side layout — the extra line is spent only where
          there is something to read. */}
      {/* On phones the text always claims the full row and the actions wrap
          beneath it. Sharing the row squeezed a short description like "Office
          visit 09-18-2026" into a ~90px column that broke after every word —
          the review's "do not shrink the text to force one line". From `sm:`
          up there is room for both, so they sit side by side again. */}
      <div className="min-w-0 flex-1 basis-full sm:basis-auto">
        {/* Level 2 of the hierarchy: the activity itself, 16px and medium —
            the most important thing on a card that has one. */}
        {/* Inline (not flex) so a long description wraps AROUND the icon
            instead of leaving it stranded alone on the first line. */}
        <p className="text-base font-medium leading-snug">
          <CalendarClock
            aria-hidden="true"
            className="mr-1.5 inline size-4 shrink-0 align-[-0.15em]"
          />
          {activity.description}{" "}
          <span className="whitespace-nowrap text-[0.9375rem] font-normal text-foreground/70">
            {formatDateMDY(activity.scheduled_for)}
          </span>
        </p>
        {/* The OPTIONAL plan note, rendered only when there is one — no empty
            placeholder — and kept visually secondary to the description:
            smaller, muted, below it. `whitespace-pre-wrap break-words` (plus
            the card's [overflow-wrap:anywhere]) keeps a long note wrapping
            inside the card at 320px instead of forcing the row wider. */}
        {activity.activity_note ? (
          <p className="mt-0.5 whitespace-pre-wrap break-words text-[0.9375rem] leading-snug text-foreground/80">
            {activity.activity_note}
          </p>
        ) : null}
        <ToneLabel tone={tone} />
      </div>
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-1">
          <Button
            size="sm"
            disabled={busy}
            aria-pressed={active === "complete"}
            onClick={onComplete}
          >
            <Check aria-hidden="true" />
            Complete
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            aria-pressed={active === "reschedule"}
            onClick={onReschedule}
          >
            Edit
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Cancel this activity"
            disabled={busy}
            onClick={onCancel}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ToneLabel({ tone }: { tone: ReturnType<typeof scheduleToneFor> }) {
  if (tone === "overdue") {
    return (
      <p className="mt-0.5 text-[0.9375rem] font-semibold text-destructive">
        Overdue
      </p>
    );
  }
  if (tone === "today") {
    return (
      <p className="mt-0.5 text-[0.9375rem] font-semibold text-primary">
        Due today
      </p>
    );
  }
  return <p className="mt-0.5 text-[0.9375rem] text-foreground/70">Upcoming</p>;
}

/**
 * The one activity form — used to add an activity, to edit the open one, and
 * as the "schedule the next activity" step of the completion flow, so all
 * three offer the same fields in the same order.
 *
 * Activity (required, short free text — no category dropdown), Note (optional,
 * the plan for this touch), Due date (required).
 */
function ScheduleActivityForm({
  title,
  defaultDate,
  busy,
  defaultDescription,
  defaultNote,
  submitLabel = "Schedule",
  onCancel,
  onSubmit,
}: {
  title: string;
  defaultDate: string;
  busy: boolean;
  defaultDescription: string;
  /** Existing scheduled note when editing; "" when adding. */
  defaultNote: string;
  submitLabel?: string;
  onCancel: () => void;
  onSubmit: (
    description: string,
    note: string,
    date: string,
  ) => void | Promise<void>;
}) {
  const [description, setDescription] = useState(defaultDescription);
  const [note, setNote] = useState(defaultNote);
  const [date, setDate] = useState(defaultDate);
  return (
    <form
      className="space-y-3 rounded-md border border-border p-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy && description.trim() && date)
          void onSubmit(description.trim(), note, date);
      }}
    >
      <p className="text-sm font-medium">{title}</p>
      <label className="block text-sm">
        Activity
        <Input
          autoFocus
          required
          maxLength={500}
          placeholder="Phone call, office visit, lunch…"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      {/* Optional, and clearly secondary to the activity itself. Blank stays
          blank: the routes turn "" into NULL rather than storing an empty
          string. */}
      <label className="block text-sm">
        Note (optional)
        <textarea
          className={TEXTAREA_CLASS}
          rows={2}
          aria-label="Note (optional)"
          maxLength={ACTIVITY_NOTE_MAX_LENGTH}
          placeholder="What this touch is for…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <label className="block min-w-0 text-sm">
        Due date
        <Input
          className="min-w-0 w-full"
          type="date"
          required
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !description.trim() || !date}>
          {busy ? "Saving…" : submitLabel}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          {defaultDescription ? "Cancel" : "Skip for now"}
        </Button>
      </div>
    </form>
  );
}

function CompleteActivityForm({
  busy,
  onCancel,
  onSubmit,
}: {
  activity: GoldListActivitySummary;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (note: string) => void | Promise<void>;
}) {
  const [note, setNote] = useState("");
  return (
    <form
      className="space-y-3 rounded-md border border-border p-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) void onSubmit(note);
      }}
    >
      <label className="block text-sm">
        Outcome note (optional)
        <textarea
          autoFocus
          className={TEXTAREA_CLASS}
          rows={3}
          maxLength={OUTCOME_NOTE_MAX_LENGTH}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <p className="text-sm text-foreground/70">
        After completing, you can schedule the next activity or skip it.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Complete"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The preserved timeline. Completed rows carry their outcome note. */
function ActivityHistoryList({
  activities,
  creator,
}: {
  activities: GoldListActivity[];
  creator: string;
}) {
  const past = activities
    .filter((a) => a.status !== "scheduled")
    .sort((a, b) =>
      (b.completed_at ?? b.updated_at).localeCompare(
        a.completed_at ?? a.updated_at,
      ),
    );
  if (past.length === 0) {
    return (
      <p className="text-[0.9375rem] text-foreground/70">
        No completed activity yet. Completed activities stay here for good.
      </p>
    );
  }
  return (
    <ul className="space-y-2 border-l border-border pl-3">
      {past.map((activity) => (
        <li key={activity.id} className="space-y-0.5">
          <p className="text-base leading-snug">
            <span className="font-medium">{activity.description}</span>{" "}
            <span className="text-[0.9375rem] text-foreground/70">
              {formatDateMDY(activity.scheduled_for)}
            </span>
            {activity.status === "cancelled" ? (
              <span className="text-muted-foreground"> · cancelled</span>
            ) : null}
          </p>
          {/* The two notes are DIFFERENT RECORDS and are labelled as such: the
              plan the activity was scheduled with, and what actually happened.
              Either may be absent; neither is ever shown in the other's place.
              Both are preserved verbatim once the activity is completed — the
              history trigger freezes the row. */}
          {activity.activity_note ? (
            <p className="whitespace-pre-wrap break-words text-[0.9375rem] leading-snug text-foreground/80">
              <span className="font-medium">Scheduled note:</span>{" "}
              {activity.activity_note}
            </p>
          ) : null}
          {/* Tertiary stamps — the only 14px text on the card, and still on a
              brighter mix than muted-foreground. */}
          <p className="text-sm text-foreground/60">
            Created by {creator} · {formatTaskMoment(activity.created_at)}
          </p>
          {activity.completed_at ? (
            <p className="text-sm text-foreground/60">
              Completed {formatTaskMoment(activity.completed_at)}
            </p>
          ) : null}
          {activity.outcome_note ? (
            <p className="whitespace-pre-wrap break-words text-[0.9375rem] leading-snug text-foreground/80">
              <span className="font-medium">Outcome:</span>{" "}
              {activity.outcome_note}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Inline editor for the agent's own details (not their activity). */
function EditAgentForm({
  agent,
  busy,
  onCancel,
  onSave,
}: {
  agent: GoldListAgentWithFollowUp;
  busy: boolean;
  onCancel: () => void;
  onSave: (patch: Record<string, string | null>) => void | Promise<void>;
}) {
  const [name, setName] = useState(agent.agent_name);
  const [brokerage, setBrokerage] = useState(agent.brokerage ?? "");
  const [phone, setPhone] = useState(agent.phone ?? "");
  const [email, setEmail] = useState(agent.email ?? "");
  const [notes, setNotes] = useState(agent.notes ?? "");

  return (
    <form
      className="space-y-2 rounded-md border border-border p-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = name.trim();
        if (!trimmed || busy) return;
        void onSave({
          agent_name: trimmed,
          brokerage: brokerage.trim() || null,
          phone: phone.trim() || null,
          email: email.trim() || null,
          notes: notes.trim() || null,
        });
      }}
    >
      <Input
        value={name}
        autoFocus
        required
        maxLength={AGENT_NAME_MAX_LENGTH}
        aria-label="Agent name"
        placeholder="Agent name"
        onChange={(e) => setName(e.target.value)}
      />
      <Input
        value={brokerage}
        maxLength={AGENT_FIELD_MAX_LENGTH}
        aria-label="Brokerage"
        placeholder="Brokerage"
        onChange={(e) => setBrokerage(e.target.value)}
      />
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={phone}
          type="tel"
          maxLength={AGENT_FIELD_MAX_LENGTH}
          aria-label="Phone"
          placeholder="Phone"
          onChange={(e) => setPhone(e.target.value)}
        />
        <Input
          value={email}
          type="email"
          maxLength={AGENT_FIELD_MAX_LENGTH}
          aria-label="Email"
          placeholder="Email"
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <textarea
        value={notes}
        rows={2}
        maxLength={AGENT_NOTES_MAX_LENGTH}
        aria-label="Notes"
        placeholder="Notes"
        onChange={(e) => setNotes(e.target.value)}
        className={TEXTAREA_CLASS}
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !name.trim()}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
