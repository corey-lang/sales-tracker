"use client";

import { useEffect, useState } from "react";
import { Check, Copy, RefreshCw, Sparkles } from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import {
  FOLLOWUP_BODY_MAX_LENGTH,
  FOLLOWUP_SUBJECT_MAX_LENGTH,
  formatEmailForCopy,
  type OneOnOneMeeting,
  type OneOnOneWorkspace,
} from "@/lib/one-on-one-meetings";
import type { FieldSaver } from "@/lib/draft-autosave";

import { Button } from "@/components/ui/button";

import {
  AutosaveText,
  Section,
  useDraft,
  useDraftVersion,
} from "./autosave-text";
import { noteKey } from "./gold-list-review";

// AE Follow-Up Email — a warm coaching recap the manager copies into Outlook
// and sends THEMSELVES. Nothing is sent from the app.
//
//   * "Generate Follow-Up Email" asks the server for a draft built ONLY from
//     shareable meeting content (wins, activity, Gold List discussion and
//     actions, 1:1 Notes, commitments, goal changes). The manager's PRIVATE
//     notes are never part of that input — the server never selects them.
//   * Subject and body are ordinary autosaving fields (same revision/conflict
//     protocol as the notes) and save with the meeting; Complete 1:1 flushes
//     them like any other field, and the FINAL edited email is what history
//     shows.
//   * Nothing regenerates on its own. When the meeting's shareable content
//     changes after generation the UI says so and offers Regenerate; the
//     manager's edits are never overwritten automatically.
//   * If the AI is unavailable, an inline retry state appears. Nothing about
//     the meeting changes, and the email is optional — Complete 1:1 never
//     depends on it. The fields are editable, so the email can be written by
//     hand instead.

type FieldBinding = {
  fieldKey: string;
  value: string | null;
  revision: number;
  disabled: boolean;
  save: FieldSaver;
};

type GenerateOk = {
  subject: string;
  body: string;
  subject_revision: number;
  body_revision: number;
};
type GenerateFail = {
  error?: string;
  retryable?: boolean;
  followup_conflict?: {
    subject: { value: string | null; revision: number };
    body: { value: string | null; revision: number };
  };
};

const STALE_RECHECK_MS = 2000;

export function FollowupEmailSection({
  ws,
  meeting,
  subject,
  body,
}: {
  ws: OneOnOneWorkspace;
  meeting: OneOnOneMeeting | null;
  subject: FieldBinding;
  body: FieldBinding;
}) {
  const draft = useDraft();
  useDraftVersion(draft); // re-render as fields change (the token below reads them)
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<{ message: string; retryable: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<"email" | "body" | null>(null);
  const [staleFromServer, setStaleFromServer] = useState(ws.followup_stale);
  const [generatedOnce, setGeneratedOnce] = useState(
    Boolean(meeting?.followup_generated_at),
  );

  // Both fields must be registered with the coordinator before an adopt.
  draft.ensure(subject.fieldKey, subject.value ?? "", subject.save, subject.revision);
  draft.ensure(body.fieldKey, body.value ?? "", body.save, body.revision);
  const subjectText = draft.get(subject.fieldKey)?.value ?? "";
  const bodyText = draft.get(body.fieldKey)?.value ?? "";
  const hasEmail = subjectText.trim() !== "" || bodyText.trim() !== "";

  // ---- staleness ----------------------------------------------------------
  // A token of everything the server fingerprints (the meeting's shareable
  // content). Private notes are deliberately NOT in it. When it moves, wait
  // for autosave to settle, then ask the server whether the email still
  // matches — the server owns the fingerprint.
  const meetingId = meeting?.id ?? null;
  const token = JSON.stringify([
    draft.get(`${meetingId}:wins`)?.value ?? meeting?.wins,
    draft.get(`${meetingId}:activity_notes`)?.value ?? meeting?.activity_notes,
    draft.get(`${meetingId}:coaching_notes`)?.value ?? meeting?.coaching_notes,
    ws.gold_list.map((a) => [
      a.id,
      draft.get(noteKey(meetingId ?? "", a.id))?.value ??
        ws.gold_list_notes.find((n) => n.agent_id === a.id)?.note ??
        "",
    ]),
    ws.gold_list_action_agent_ids,
    ws.gold_list_added_agent_ids,
    ws.gold_list_edited_agent_ids,
    ws.new_commitments.map((c) => [c.id, c.description, c.status, c.owner, c.due_date]),
    ws.carryover.map((c) => [c.id, c.status]),
    ws.weekly_goal_current,
    ws.weekly_goal_next_override,
  ]);
  useEffect(() => {
    if (!meetingId || !hasEmail || generating) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      if (cancelled) return;
      // Wait for pending autosaves so the server sees what's on screen.
      if (draft.isDirty()) {
        timer = setTimeout(check, STALE_RECHECK_MS);
        return;
      }
      try {
        const res = await apiFetch(`/api/admin/one-on-one-meetings/${meetingId}/followup`);
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as { stale: boolean };
        setStaleFromServer(json.stale);
      } catch {
        /* the banner is a hint; a failed check just leaves it as is */
      }
    };
    timer = setTimeout(check, STALE_RECHECK_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [token, meetingId, hasEmail, generating, draft]);

  const stale = hasEmail && staleFromServer;

  // ---- generate / regenerate ---------------------------------------------
  const generate = async () => {
    if (!meetingId || generating || draft.locked) return;
    if (
      hasEmail &&
      !window.confirm(
        "Regenerating replaces the current email — including any edits you've made. Continue?",
      )
    ) {
      return;
    }
    setGenerating(true);
    setGenError(null);
    setNotice(null);
    try {
      // Make sure anything typed in the email is saved, so the revisions we
      // send are current and nothing typed is replaced silently.
      const flushed = await Promise.all([
        draft.flush(subject.fieldKey),
        draft.flush(body.fieldKey),
      ]);
      const s = draft.get(subject.fieldKey);
      const b = draft.get(body.fieldKey);
      if (!flushed.every(Boolean) || !s || !b || s.status === "conflict" || b.status === "conflict") {
        setGenError({
          message: "The email has changes that haven't saved yet. Resolve that first, then try again.",
          retryable: true,
        });
        return;
      }

      // Tracked: Complete 1:1 waits for this, but a failure here never
      // blocks completing (track() vs. mutate()).
      const res = await draft.track(() =>
        apiFetch(`/api/admin/one-on-one-meetings/${meetingId}/followup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expected_subject_revision: s.revision,
            expected_body_revision: b.revision,
          }),
        }),
      );
      const json = (await res.json().catch(() => ({}))) as GenerateOk & GenerateFail;

      if (res.ok) {
        await draft.adopt(subject.fieldKey, json.subject, json.subject_revision);
        await draft.adopt(body.fieldKey, json.body, json.body_revision);
        setGeneratedOnce(true);
        setStaleFromServer(false);
        return;
      }
      if (res.status === 409 && json.followup_conflict) {
        // Edited in another tab: show THAT version; regenerating is up to them.
        const c = json.followup_conflict;
        await draft.adopt(subject.fieldKey, c.subject.value ?? "", c.subject.revision);
        await draft.adopt(body.fieldKey, c.body.value ?? "", c.body.revision);
        setNotice(
          "The email was changed in another tab or device — showing that version. Regenerate to replace it.",
        );
        return;
      }
      setGenError({
        message: json.error ?? "Couldn't generate the email right now.",
        retryable: json.retryable !== false,
      });
    } catch (err) {
      setGenError({
        message:
          err instanceof Error && err.name === "DraftLockedError"
            ? "The 1:1 is being completed."
            : "Couldn't reach the server to generate the email. Your 1:1 is untouched.",
        retryable: true,
      });
    } finally {
      setGenerating(false);
    }
  };

  // ---- copy -----------------------------------------------------------------
  const copy = async (what: "email" | "body") => {
    // What's on screen (including text not yet saved) is what gets copied.
    const text =
      what === "email"
        ? formatEmailForCopy(subjectText, bodyText)
        : bodyText.trim();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Older/locked-down browsers: fall back to a temporary textarea.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } finally {
        document.body.removeChild(ta);
      }
    }
    setCopied(what);
    window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 1800);
  };

  const off = !meeting || generating;
  return (
    <Section
      id="followup-email"
      title="AE Follow-Up Email"
      description={
        meeting
          ? "A warm recap to send to the AE yourself — generate a draft, edit it, copy it into Outlook. Nothing is sent from here."
          : "Start the 1:1 to draft a follow-up email."
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="lg"
          onClick={() => void generate()}
          disabled={off || draft.locked}
          className="min-h-11"
        >
          {hasEmail ? (
            <RefreshCw aria-hidden="true" className={generating ? "animate-spin" : ""} />
          ) : (
            <Sparkles aria-hidden="true" />
          )}
          {generating
            ? "Writing your email…"
            : hasEmail
              ? "Regenerate"
              : "Generate Follow-Up Email"}
        </Button>
        {hasEmail ? (
          <>
            <Button size="lg" variant="outline" onClick={() => void copy("email")} className="min-h-11">
              {copied === "email" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied === "email" ? "Copied" : "Copy Email"}
            </Button>
            <Button size="lg" variant="ghost" onClick={() => void copy("body")} className="min-h-11">
              {copied === "body" ? "Copied" : "Copy body only"}
            </Button>
          </>
        ) : null}
      </div>

      {stale && !generating ? (
        <p
          role="status"
          className="mt-3 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200"
        >
          Meeting details changed since this email was generated. Your edits are
          untouched — use <span className="font-medium">Regenerate</span> when you want a fresh draft.
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-3 rounded-md bg-muted px-3 py-2 text-sm">
          {notice}
        </p>
      ) : null}
      {genError ? (
        <div
          role="alert"
          className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
        >
          <p className="font-medium text-destructive">{genError.message}</p>
          <p className="mt-0.5 text-muted-foreground">
            Everything in your 1:1 is saved, and you can still complete it —
            the email is optional. You can also write it below by hand.
          </p>
          {genError.retryable ? (
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void generate()}>
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 space-y-3">
        <AutosaveText
          {...subject}
          disabled={off || subject.disabled}
          label="Subject"
          multiline={false}
          maxLength={FOLLOWUP_SUBJECT_MAX_LENGTH}
          placeholder="Subject line"
        />
        <AutosaveText
          {...body}
          disabled={off || body.disabled}
          label="Email"
          rows={12}
          maxLength={FOLLOWUP_BODY_MAX_LENGTH}
          placeholder={
            generatedOnce || hasEmail ? "" : "Generate a draft, or write your own recap here."
          }
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Built only from wins, activity, Gold List discussion, 1:1 Notes,
        commitments and goal changes. Private Manager Notes are never used.
      </p>
    </Section>
  );
}
