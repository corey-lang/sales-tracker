"use client";

import { useRef, useState } from "react";

import { apiFetchJson } from "@/lib/api-client";
import {
  AGENT_FIELD_MAX_LENGTH,
  AGENT_NAME_MAX_LENGTH,
  AGENT_NOTES_MAX_LENGTH,
  type GoldListAgentWithFollowUp,
} from "@/lib/gold-list";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

// The Gold List's add-agent and edit-agent forms, in one place so the AE's own
// Gold List (/gold-list) and the manager's 1:1 workspace render the SAME forms
// with the same fields and limits — only the endpoint differs.

const TEXTAREA_CLASS =
  "mt-1 w-full resize-y rounded-md border border-border bg-background/40 px-2 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Add one agent. Only the name is required — everything else can wait. */
export function AddAgentForm<A extends GoldListAgentWithFollowUp = GoldListAgentWithFollowUp>({
  onCancel,
  onAdded,
  endpoint = "/api/gold-list/agents",
  listLabel = "your Gold List",
  run,
}: {
  onCancel: () => void;
  onAdded: (agent: A) => void;
  /** POST target. The AE board adds to the caller's own list; a 1:1 adds to the AE's. */
  endpoint?: string;
  /** Whose list the duplicate warning talks about. */
  listLabel?: string;
  /** Wraps the request (e.g. so Complete 1:1 waits for it). */
  run?: <T>(fn: () => Promise<T>) => Promise<T>;
}) {
  const [requestId] = useState(() => crypto.randomUUID());
  const submitting = useRef(false);
  const [duplicates, setDuplicates] = useState<Array<{
    id: string;
    agent_name: string;
    archived: boolean;
  }> | null>(null);
  const [name, setName] = useState("");
  const [brokerage, setBrokerage] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const send = () =>
        apiFetchJson<{
          agent?: A;
          duplicates?: Array<{
            id: string;
            agent_name: string;
            archived: boolean;
          }>;
        }>(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            request_id: requestId,
            confirm_duplicate: duplicates !== null,
            agent_name: trimmed,
            brokerage: brokerage.trim() || null,
            phone: phone.trim() || null,
            email: email.trim() || null,
            notes: notes.trim() || null,
          }),
        });
      const res = await (run ? run(send) : send());
      if (res.duplicates) setDuplicates(res.duplicates);
      else if (res.agent) onAdded(res.agent);
    } catch (err) {
      setError(messageOf(err, "Could not add that agent."));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <Card size="sm">
      <CardContent>
        <form
          className="space-y-2"
          onSubmit={submit}
          onChange={() => setDuplicates(null)}
        >
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Add agent
          </p>
          <Input
            value={name}
            required
            autoFocus
            maxLength={AGENT_NAME_MAX_LENGTH}
            aria-label="Agent name"
            placeholder="Agent name"
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            value={brokerage}
            maxLength={AGENT_FIELD_MAX_LENGTH}
            aria-label="Brokerage"
            placeholder="Brokerage (optional)"
            onChange={(e) => setBrokerage(e.target.value)}
          />
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={phone}
              type="tel"
              maxLength={AGENT_FIELD_MAX_LENGTH}
              aria-label="Phone"
              placeholder="Phone (optional)"
              onChange={(e) => setPhone(e.target.value)}
            />
            <Input
              value={email}
              type="email"
              maxLength={AGENT_FIELD_MAX_LENGTH}
              aria-label="Email"
              placeholder="Email (optional)"
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <textarea
            value={notes}
            rows={2}
            maxLength={AGENT_NOTES_MAX_LENGTH}
            aria-label="Notes"
            placeholder="Notes (optional)"
            onChange={(e) => setNotes(e.target.value)}
            className={TEXTAREA_CLASS}
          />
          {duplicates ? (
            <div role="alert" className="space-y-1 text-sm">
              <p>Possible matches on {listLabel}:</p>
              <ul>
                {duplicates.map((a) => (
                  <li key={a.id}>
                    {a.agent_name}
                    {a.archived
                      ? " (archived — you can restore this agent)"
                      : " (active)"}
                  </li>
                ))}
              </ul>
              <p>Review these records, or confirm this is a separate agent.</p>
            </div>
          ) : null}
          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !name.trim()}>
              {busy ? "Adding…" : duplicates ? "Confirm and add" : "Add agent"}
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
      </CardContent>
    </Card>
  );
}

/** Inline editor for the agent's own details (not their activity). */
export function EditAgentForm({
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
