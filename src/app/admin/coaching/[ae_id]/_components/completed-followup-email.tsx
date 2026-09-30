"use client";

import { useState } from "react";
import { Check, Copy, Lock, Pencil, RefreshCw, Sparkles } from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import {
  FOLLOWUP_BODY_MAX_LENGTH,
  FOLLOWUP_SUBJECT_MAX_LENGTH,
  formatEmailForCopy,
  type OneOnOneMeeting,
} from "@/lib/one-on-one-meetings";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";

import { Section, TEXTAREA_CLASS } from "./autosave-text";

// AE Follow-Up Email on a COMPLETED 1:1.
//
// The meeting is frozen and is NOT reopened. The follow-up email is the one
// artifact that can still be written afterwards, through
// /api/admin/one-on-one-meetings/[id]/followup (POST = generate from the
// meeting's FROZEN record, PUT = save a hand edit). Nothing else on this page
// is editable, and only the FINAL saved email is kept — there is no revision
// history, just an edit-and-save.
//
// Concurrency: every save / regeneration carries the email's two revisions.
// If another tab saved first the server answers 409 with their text; we never
// overwrite silently — the manager sees theirs and decides.

type Email = { subject: string; body: string; subjectRev: number; bodyRev: number };
type ServerEmail = {
  subject: string | null;
  body: string | null;
  subject_revision: number;
  body_revision: number;
};
type Failure = {
  error?: string;
  retryable?: boolean;
  followup_conflict?: {
    subject: { value: string | null; revision: number };
    body: { value: string | null; revision: number };
  };
};

export function CompletedFollowupEmail({ meeting }: { meeting: OneOnOneMeeting }) {
  const [saved, setSaved] = useState<Email>({
    subject: meeting.followup_subject ?? "",
    body: meeting.followup_body ?? "",
    subjectRev: meeting.followup_subject_rev,
    bodyRev: meeting.followup_body_rev,
  });
  const [editing, setEditing] = useState(false);
  const [draftSubject, setDraftSubject] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [busy, setBusy] = useState<"save" | "generate" | null>(null);
  const [error, setError] = useState<{ message: string; retryable: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [theirs, setTheirs] = useState<{ subject: string; body: string } | null>(null);
  const [copied, setCopied] = useState<"email" | "body" | null>(null);

  const hasEmail = saved.subject.trim() !== "" || saved.body.trim() !== "";
  const url = `/api/admin/one-on-one-meetings/${meeting.id}/followup`;

  const adopt = (s: ServerEmail) =>
    setSaved({
      subject: s.subject ?? "",
      body: s.body ?? "",
      subjectRev: s.subject_revision,
      bodyRev: s.body_revision,
    });

  const startEdit = () => {
    setDraftSubject(saved.subject);
    setDraftBody(saved.body);
    setError(null);
    setNotice(null);
    setTheirs(null);
    setEditing(true);
  };
  const cancelEdit = () => {
    setEditing(false);
    setTheirs(null);
    setNotice(null);
  };

  const save = async () => {
    if (busy) return;
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: draftSubject,
          body: draftBody,
          expected_subject_revision: saved.subjectRev,
          expected_body_revision: saved.bodyRev,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as ServerEmail & Failure;
      if (res.ok) {
        adopt(json);
        setEditing(false);
        setTheirs(null);
        return;
      }
      if (res.status === 409 && json.followup_conflict) {
        // Changed elsewhere. Keep what the manager typed in the box, show the
        // other version, and move our revisions forward so a second Save is an
        // explicit, informed overwrite.
        const c = json.followup_conflict;
        setTheirs({ subject: c.subject.value ?? "", body: c.body.value ?? "" });
        setSaved({
          subject: c.subject.value ?? "",
          body: c.body.value ?? "",
          subjectRev: c.subject.revision,
          bodyRev: c.body.revision,
        });
        setNotice(
          "This email was changed in another tab or device. Their version is shown below; your edits are still in the box. Save again to replace theirs, or Cancel to keep theirs.",
        );
        return;
      }
      setError({ message: json.error ?? `Couldn't save (${res.status}).`, retryable: true });
    } catch {
      setError({ message: "Couldn't reach the server — your edits are still here. Try again.", retryable: true });
    } finally {
      setBusy(null);
    }
  };

  const generate = async () => {
    if (busy || editing) return;
    if (
      hasEmail &&
      !window.confirm("Regenerating replaces the saved email, including any edits you've made. Continue?")
    ) {
      return;
    }
    setBusy("generate");
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expected_subject_revision: saved.subjectRev,
          expected_body_revision: saved.bodyRev,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as ServerEmail & Failure;
      if (res.ok) {
        adopt(json);
        return;
      }
      if (res.status === 409 && json.followup_conflict) {
        const c = json.followup_conflict;
        setSaved({
          subject: c.subject.value ?? "",
          body: c.body.value ?? "",
          subjectRev: c.subject.revision,
          bodyRev: c.body.revision,
        });
        setNotice("The email was changed in another tab or device — showing that version. Regenerate again to replace it.");
        return;
      }
      setError({
        message: json.error ?? "Couldn't generate the email right now.",
        retryable: json.retryable !== false,
      });
    } catch {
      setError({ message: "Couldn't reach the server to generate the email.", retryable: true });
    } finally {
      setBusy(null);
    }
  };

  const copy = async (what: "email" | "body") => {
    const text = what === "email" ? formatEmailForCopy(saved.subject, saved.body) : saved.body.trim();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
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

  return (
    <Section
      id="followup-email"
      title="AE Follow-Up Email"
      description="The final version prepared for the AE — not sent from the app."
    >
      <p className="mb-3 flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
        <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>
          This 1:1 is completed and frozen. <span className="font-medium text-foreground">The follow-up
          email can still be prepared or edited</span> — it is generated from the record as it stood at
          this 1:1, not from today&apos;s data.
        </span>
      </p>

      {!editing ? (
        <div className="flex flex-wrap items-center gap-2">
          {hasEmail ? (
            <>
              <Button size="lg" variant="outline" onClick={startEdit} disabled={busy !== null} className="min-h-11">
                <Pencil aria-hidden="true" />
                Edit Follow-Up Email
              </Button>
              <Button size="lg" variant="outline" onClick={() => void generate()} disabled={busy !== null} className="min-h-11">
                <RefreshCw aria-hidden="true" className={busy === "generate" ? "animate-spin" : ""} />
                {busy === "generate" ? "Writing your email…" : "Regenerate"}
              </Button>
              <Button size="lg" variant="outline" onClick={() => void copy("email")} className="min-h-11">
                {copied === "email" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                {copied === "email" ? "Copied" : "Copy Email"}
              </Button>
              <Button size="lg" variant="ghost" onClick={() => void copy("body")} className="min-h-11">
                {copied === "body" ? "Copied" : "Copy body only"}
              </Button>
            </>
          ) : (
            <>
              <Button size="lg" onClick={() => void generate()} disabled={busy !== null} className="min-h-11">
                <Sparkles aria-hidden="true" className={busy === "generate" ? "animate-pulse" : ""} />
                {busy === "generate" ? "Writing your email…" : "Generate Follow-Up Email"}
              </Button>
              <Button size="lg" variant="outline" onClick={startEdit} disabled={busy !== null} className="min-h-11">
                <Pencil aria-hidden="true" />
                Write one manually
              </Button>
            </>
          )}
        </div>
      ) : null}

      {notice ? (
        <p role="status" className="mt-3 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
          {notice}
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
          <p className="font-medium text-destructive">{error.message}</p>
          <p className="mt-0.5 text-muted-foreground">
            The completed 1:1 is untouched. You can still write the email by hand.
          </p>
        </div>
      ) : null}

      {editing ? (
        <div className="mt-4 space-y-3">
          {theirs ? (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Their version
              </p>
              <p className="mt-1 font-medium">{theirs.subject || "—"}</p>
              <p className="mt-1 whitespace-pre-wrap">{theirs.body}</p>
            </div>
          ) : null}
          <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Subject
            <input
              type="text"
              value={draftSubject}
              maxLength={FOLLOWUP_SUBJECT_MAX_LENGTH}
              onChange={(e) => setDraftSubject(e.target.value)}
              disabled={busy !== null}
              placeholder="Subject line"
              className={cn(TEXTAREA_CLASS, "mt-1 min-h-10 font-normal normal-case tracking-normal text-foreground")}
            />
          </label>
          <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Email
            <textarea
              value={draftBody}
              rows={12}
              maxLength={FOLLOWUP_BODY_MAX_LENGTH}
              onChange={(e) => setDraftBody(e.target.value)}
              disabled={busy !== null}
              placeholder="Write your recap to the AE here."
              className={cn(TEXTAREA_CLASS, "mt-1 font-normal normal-case tracking-normal text-foreground")}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="lg" onClick={() => void save()} disabled={busy !== null} className="min-h-11">
              {busy === "save" ? "Saving…" : "Save"}
            </Button>
            <Button size="lg" variant="outline" onClick={cancelEdit} disabled={busy !== null} className="min-h-11">
              Cancel
            </Button>
          </div>
        </div>
      ) : hasEmail ? (
        <div className="mt-4 space-y-2">
          <p className="text-sm">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Subject</span>
            <br />
            {saved.subject || "—"}
          </p>
          <p className="whitespace-pre-wrap rounded-md bg-muted/40 px-3 py-2 text-sm leading-relaxed">
            {saved.body}
          </p>
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">No follow-up email has been prepared for this 1:1.</p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        Built only from wins, activity, Gold List discussion, 1:1 Notes, commitments and goal changes
        recorded at this 1:1. Private Manager Notes are never used.
      </p>
    </Section>
  );
}
