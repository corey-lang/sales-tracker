"use client";

import { useState } from "react";
import { format, parseISO } from "date-fns";
import { Check, Plus, Trash2, X } from "lucide-react";

import { apiFetchJson } from "@/lib/api-client";
import {
  MEETING_COMMITMENT_MAX_LENGTH,
  type CommitmentOwner,
  type LegacyCarryoverCommitment,
  type MeetingCommitment,
  type MeetingCommitmentStatus,
} from "@/lib/one-on-one-meetings";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { Section, useDraft, useDraftLocked } from "./autosave-text";
import { CommitmentRow as LegacyCommitmentRow } from "./legacy-weekly-focus";

// Commitments & Next Steps.
//
//   CARRYOVER — open commitments from earlier 1:1s surface here
//   automatically. Checking one off records THIS meeting as where it was
//   resolved (the origin meeting is kept), so history shows both "made on
//   Sept 15" and "resolved Sept 29". Legacy Weekly Focus commitments that are
//   still open appear too, handled by their original endpoint.
//
//   NEW — commitments made in this meeting, each with an owner (AE or
//   manager) and an optional due date.

function shortDate(iso: string): string {
  return format(parseISO(iso), "MMM d");
}

export function CommitmentsSection({
  meetingId,
  carryover,
  legacy,
  created,
  aeName,
  managerName,
  onCommitment,
  onRemoved,
  onLegacyChange,
}: {
  meetingId: string | null;
  carryover: Array<MeetingCommitment & { origin_meeting_date: string | null }>;
  legacy: LegacyCarryoverCommitment[];
  created: MeetingCommitment[];
  aeName: string;
  managerName: string;
  onCommitment: (c: MeetingCommitment) => void;
  onRemoved: (id: string) => void;
  onLegacyChange: () => void;
}) {
  const locked = useDraftLocked();
  const ownerLabel = (o: CommitmentOwner) => (o === "ae" ? aeName : managerName);
  const visibleCreated = created.filter((c) => c.status !== "dropped");
  return (
    <Section
      id="commitments"
      title="Commitments & Next Steps"
      description={
        meetingId
          ? "Open items carry into the next 1:1 automatically."
          : "Start the 1:1 to add or check off commitments."
      }
    >
      {carryover.length + legacy.length > 0 ? (
        <div className="mb-4 space-y-1.5">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Carryover from earlier 1:1s
          </h4>
          <ul className="space-y-1.5">
            {carryover.map((c) => (
              <MeetingCommitmentRow
                key={c.id}
                commitment={c}
                meetingId={meetingId}
                ownerLabel={ownerLabel(c.owner)}
                origin={c.origin_meeting_date ? `From ${shortDate(c.origin_meeting_date)}` : null}
                carryover
                onChange={onCommitment}
                onRemoved={onRemoved}
              />
            ))}
          </ul>
          {legacy.length > 0 ? (
            <>
              <p className="pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                From Weekly Focus
              </p>
              <ul className="space-y-1.5">
                {legacy.map((c) => (
                  <LegacyCommitmentRow
                    key={c.id}
                    commitment={c}
                    meetingId={meetingId}
                    onChange={onLegacyChange}
                  />
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          This 1:1
        </h4>
        {meetingId && !locked ? (
          <AddCommitmentForm
            meetingId={meetingId}
            aeName={aeName}
            managerName={managerName}
            onCreated={onCommitment}
          />
        ) : null}
        {visibleCreated.length === 0 ? (
          <p className="text-sm text-muted-foreground">No commitments yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {visibleCreated.map((c) => (
              <MeetingCommitmentRow
                key={c.id}
                commitment={c}
                meetingId={meetingId}
                ownerLabel={ownerLabel(c.owner)}
                origin={null}
                carryover={false}
                onChange={onCommitment}
                onRemoved={onRemoved}
              />
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

function MeetingCommitmentRow({
  commitment,
  meetingId,
  ownerLabel,
  origin,
  carryover,
  onChange,
  onRemoved,
}: {
  commitment: MeetingCommitment;
  meetingId: string | null;
  ownerLabel: string;
  origin: string | null;
  carryover: boolean;
  onChange: (c: MeetingCommitment) => void;
  onRemoved: (id: string) => void;
}) {
  const draft = useDraft();
  const locked = useDraftLocked();
  const [busyFlag, setBusy] = useState(false);
  const busy = busyFlag || locked;
  const [failed, setFailed] = useState<string | null>(null);
  const done = commitment.status === "completed";
  const dropped = commitment.status === "dropped";
  const path = meetingId
    ? `/api/admin/one-on-one-meetings/${meetingId}/commitments/${commitment.id}`
    : null;

  const setStatus = async (status: MeetingCommitmentStatus) => {
    if (!path || busy) return;
    setBusy(true);
    setFailed(null);
    try {
      const res = await draft.mutate(() =>
        apiFetchJson<{ commitment: MeetingCommitment }>(path, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        }),
      );
      onChange(res.commitment);
    } catch (err) {
      setFailed(err instanceof Error ? err.message : "Not saved");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!path || busy) return;
    setBusy(true);
    setFailed(null);
    try {
      await draft.mutate(() => apiFetchJson(path, { method: "DELETE" }));
      onRemoved(commitment.id);
    } catch (err) {
      setFailed(err instanceof Error ? err.message : "Not saved");
      setBusy(false);
    }
  };

  return (
    <li
      className={cn(
        "flex items-start gap-2 rounded-md border bg-muted/20 px-2 py-2",
        failed ? "border-destructive/60" : "border-border/60",
      )}
    >
      <button
        type="button"
        disabled={!path || busy || dropped}
        onClick={() => void setStatus(done ? "open" : "completed")}
        aria-label={done ? "Mark not done" : "Mark done"}
        className={cn(
          "inline-flex size-9 shrink-0 items-center justify-center rounded-md border transition-colors sm:size-7",
          done
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background hover:border-primary/50",
          !path && "cursor-default opacity-70",
        )}
      >
        {done ? <Check aria-hidden="true" className="size-4" /> : null}
      </button>
      <div className="min-w-0 flex-1 pt-1 sm:pt-0.5">
        <p
          className={cn(
            "text-sm leading-snug",
            (done || dropped) && "text-muted-foreground line-through",
          )}
        >
          {commitment.description}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {ownerLabel}
          {commitment.due_date ? ` · due ${shortDate(commitment.due_date)}` : ""}
          {origin ? ` · ${origin}` : ""}
          {dropped ? " · dropped" : ""}
        </p>
        {failed ? (
          <p role="alert" className="text-[11px] text-destructive">
            {failed}
          </p>
        ) : null}
      </div>
      {path ? (
        carryover ? (
          dropped ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void setStatus("open")}
            >
              Undo
            </Button>
          ) : !done ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void setStatus("dropped")}
              title="Drop — no longer relevant; history is kept"
              aria-label="Drop commitment"
              className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted sm:size-7"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          ) : null
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => void remove()}
            aria-label="Delete commitment"
            className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:size-7"
          >
            <Trash2 aria-hidden="true" className="size-4" />
          </button>
        )
      ) : null}
    </li>
  );
}

function AddCommitmentForm({
  meetingId,
  aeName,
  managerName,
  onCreated,
}: {
  meetingId: string;
  aeName: string;
  managerName: string;
  onCreated: (c: MeetingCommitment) => void;
}) {
  const draft = useDraft();
  const [text, setText] = useState("");
  const [owner, setOwner] = useState<CommitmentOwner>("ae");
  const [due, setDue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const description = text.trim();
    if (!description || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await draft.mutate(() =>
        apiFetchJson<{ commitment: MeetingCommitment }>(
          `/api/admin/one-on-one-meetings/${meetingId}/commitments`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ description, owner, due_date: due || null }),
          },
        ),
      );
      onCreated(res.commitment);
      setText("");
      setDue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add commitment or follow-up…"
          maxLength={MEETING_COMMITMENT_MAX_LENGTH}
          disabled={saving}
          className="h-10 flex-1 text-base sm:text-sm"
        />
        <Button
          type="submit"
          size="lg"
          disabled={saving || !text.trim()}
          className="h-10"
        >
          <Plus aria-hidden="true" />
          Add
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-xs text-muted-foreground">Owner</span>
        {(["ae", "manager"] as const).map((o) => (
          <button
            key={o}
            type="button"
            aria-pressed={owner === o}
            onClick={() => setOwner(o)}
            className={cn(
              "min-h-9 rounded-full border px-3",
              owner === o
                ? "border-primary bg-primary/10 text-primary"
                : "border-border hover:bg-muted",
            )}
          >
            {o === "ae" ? aeName : managerName}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          Due
          <Input
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className="h-9 w-40 text-sm"
          />
        </label>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
