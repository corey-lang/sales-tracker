"use client";

import { format, parseISO } from "date-fns";
import { Check, Circle, Minus } from "lucide-react";

import { formatTaskMoment } from "@/lib/dates";
import type {
  CommitmentReview,
  GoldListDiscussionNote,
  MeetingRecord,
} from "@/lib/one-on-one-meetings";
import { cn } from "@/lib/utils";

import { ActivityResults } from "./activity-results";
import { Section } from "./autosave-text";

// A completed 1:1, read-only, rendered ONLY from what was frozen at
// completion: the activity snapshot, the Gold List note snapshots, and the
// commitment reviews. Nothing here reads live goals, activity, or Gold List
// rows, so later changes to any of them can't rewrite what this meeting shows.

function longDate(iso: string): string {
  return format(parseISO(iso), "MMM d, yyyy");
}

function Prose({ text, empty }: { text: string | null; empty: string }) {
  return text ? (
    <p className="whitespace-pre-wrap text-sm leading-relaxed">{text}</p>
  ) : (
    <p className="text-sm text-muted-foreground">{empty}</p>
  );
}

export function MeetingRecordView({ record }: { record: MeetingRecord }) {
  const { meeting } = record;
  const discussed = record.gold_list_notes.filter(
    (n) => n.note || n.action_taken,
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl bg-muted/40 px-4 py-3 text-sm">
        <p className="font-medium">
          1:1 with {meeting.ae_name ?? "AE"} · {longDate(meeting.meeting_date)}
        </p>
        <p className="text-muted-foreground">
          {meeting.status === "completed" && meeting.completed_at
            ? `Completed ${formatTaskMoment(meeting.completed_at)}`
            : "In progress"}
          {meeting.manager_name ? ` · with ${meeting.manager_name}` : ""}
          {meeting.status === "completed" ? " · read-only record" : ""}
        </p>
      </div>

      <Section title="Wins">
        <Prose text={meeting.wins} empty="No wins recorded." />
      </Section>

      <Section title="Activity & Results">
        {meeting.activity_snapshot ? (
          <ActivityResults snapshot={meeting.activity_snapshot} frozen />
        ) : (
          <p className="text-sm text-muted-foreground">
            Captured when the 1:1 is completed.
          </p>
        )}
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Activity notes
          </p>
          <Prose text={meeting.activity_notes} empty="No activity notes." />
        </div>
      </Section>

      <Section
        title="Gold List"
        description={
          discussed.length
            ? `${discussed.length} agent${discussed.length === 1 ? "" : "s"} discussed`
            : undefined
        }
      >
        {discussed.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No Gold List agents discussed.
          </p>
        ) : (
          <ul className="space-y-2">
            {discussed.map((n) => (
              <DiscussedAgent key={n.id} note={n} />
            ))}
          </ul>
        )}
      </Section>

      <Section title="Coaching">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Coaching focus
        </p>
        <Prose text={meeting.coaching_focus} empty="No coaching focus set." />
        <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Coaching / discussion notes
        </p>
        <Prose text={meeting.coaching_notes} empty="No coaching notes." />
      </Section>

      <Section title="Commitments & Next Steps">
        <ReviewedCommitments reviews={record.commitment_reviews} />
      </Section>
    </div>
  );
}

function DiscussedAgent({ note }: { note: GoldListDiscussionNote }) {
  return (
    <li className="rounded-lg border border-border/70 px-3 py-2.5">
      <p className="font-semibold">
        {note.agent_name}
        {note.brokerage ? (
          <span className="font-normal text-muted-foreground"> · {note.brokerage}</span>
        ) : null}
      </p>
      <p className="text-sm text-muted-foreground">
        Last:{" "}
        {note.last_activity_on
          ? `${format(parseISO(note.last_activity_on), "MMM d")} — ${note.last_activity_description}`
          : "none"}
        {" · "}Next:{" "}
        {note.next_activity_on
          ? `${format(parseISO(note.next_activity_on), "MMM d")} — ${note.next_activity_description}`
          : "none"}
      </p>
      {note.activity_changes.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-sm">
          {note.activity_changes.map((c, i) => (
            <li key={i} className="text-foreground/80">
              <span className="font-medium capitalize">{c.kind}</span>:{" "}
              {c.description} ({format(parseISO(c.date), "MMM d")})
            </li>
          ))}
        </ul>
      ) : null}
      {note.note ? (
        <p className="mt-1.5 whitespace-pre-wrap rounded-md bg-muted/40 px-2 py-1.5 text-sm">
          {note.note}
        </p>
      ) : null}
    </li>
  );
}

export function ReviewedCommitments({
  reviews,
}: {
  reviews: CommitmentReview[];
}) {
  if (reviews.length === 0) {
    return <p className="text-sm text-muted-foreground">No commitments.</p>;
  }
  const groups: Array<[string, CommitmentReview[]]> = [
    ["Carryover reviewed", reviews.filter((r) => r.origin === "carryover")],
    ["Made in this 1:1", reviews.filter((r) => r.origin === "new")],
  ];
  return (
    <div className="space-y-3">
      {groups
        .filter(([, rows]) => rows.length > 0)
        .map(([label, rows]) => (
          <div key={label}>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {label}
            </p>
            <ul className="space-y-1">
              {rows.map((r) => (
                <li key={r.id} className="flex items-start gap-2 text-sm">
                  <StatusIcon status={r.status} />
                  <span
                    className={cn(
                      r.status !== "open" && "text-muted-foreground",
                      r.status === "dropped" && "line-through",
                    )}
                  >
                    {r.description}
                    <span className="block text-[11px] text-muted-foreground">
                      {r.owner === "ae" ? "AE" : "Manager"}
                      {r.due_date ? ` · due ${format(parseISO(r.due_date), "MMM d")}` : ""}
                      {r.origin === "carryover" && r.origin_meeting_date
                        ? ` · from ${format(parseISO(r.origin_meeting_date), "MMM d")}`
                        : ""}
                      {r.legacy_commitment_id ? " · Weekly Focus" : ""}
                      {` · ${r.status === "open" ? "still open" : r.status}`}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
    </div>
  );
}

function StatusIcon({ status }: { status: CommitmentReview["status"] }) {
  if (status === "completed") {
    return (
      <Check
        aria-label="Completed"
        className="mt-0.5 size-4 shrink-0 text-green-600 dark:text-green-400"
      />
    );
  }
  if (status === "dropped") {
    return (
      <Minus aria-label="Dropped" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
    );
  }
  return <Circle aria-label="Open" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />;
}
