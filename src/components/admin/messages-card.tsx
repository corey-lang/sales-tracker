"use client";

import { useEffect, useState } from "react";
import { format, parseISO } from "date-fns";

import { supabase } from "@/lib/supabase/client";
import { formatDateMDY } from "@/lib/dates";
import { useSalesperson } from "@/lib/use-salesperson";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Salesperson = { id: string; first_name: string };

type Message = {
  id: string;
  salesperson_id: string | null;
  body: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

const GLOBAL_SCOPE = "__global__";

type Props = {
  people: Salesperson[];
};

export function MessagesCard({ people }: Props) {
  const { salesperson } = useSalesperson();
  const [allPeople, setAllPeople] = useState<Salesperson[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);

  const [scope, setScope] = useState<string>(GLOBAL_SCOPE);
  const [body, setBody] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const refresh = () => setRefreshTick((n) => n + 1);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from("salespeople")
      .select("id, first_name")
      .then(({ data }) => {
        if (cancelled) return;
        if (data) setAllPeople(data as Salesperson[]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from("messages")
      .select("*")
      .order("updated_at", { ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setError(error.message);
          return;
        }
        setMessages((data ?? []) as Message[]);
        // Pre-fill the form's body with the currently-selected scope's message.
        const targetId = scope === GLOBAL_SCOPE ? null : scope;
        const existing = (data ?? []).find(
          (m: Message) => m.salesperson_id === targetId,
        );
        setBody(existing?.body ?? "");
      });
    return () => {
      cancelled = true;
    };
    // We intentionally don't include `scope` in deps — auto-load on scope
    // change is handled by handleScopeChange below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  const handleScopeChange = (next: string) => {
    setScope(next);
    setError(null);
    setSavedMsg(null);
    const targetId = next === GLOBAL_SCOPE ? null : next;
    const existing = messages.find((m) => m.salesperson_id === targetId);
    setBody(existing?.body ?? "");
  };

  const handleSave = async () => {
    const trimmed = body.trim();
    if (!trimmed) {
      setError("Type a message body before saving.");
      return;
    }
    setSaving(true);
    setError(null);
    setSavedMsg(null);

    const salespersonId = scope === GLOBAL_SCOPE ? null : scope;
    const existing = messages.find(
      (m) => m.salesperson_id === salespersonId,
    );

    const result = existing
      ? await supabase
          .from("messages")
          .update({
            body: trimmed,
            updated_at: new Date().toISOString(),
            created_by: salesperson?.id ?? null,
          })
          .eq("id", existing.id)
          .select()
      : await supabase
          .from("messages")
          .insert({
            salesperson_id: salespersonId,
            body: trimmed,
            created_by: salesperson?.id ?? null,
          })
          .select();

    setSaving(false);
    if (result.error) {
      setError(result.error.message);
      return;
    }
    setSavedMsg(existing ? "Message updated." : "Message posted.");
    refresh();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this message?")) return;
    const { error } = await supabase.from("messages").delete().eq("id", id);
    if (error) {
      setError(error.message);
      return;
    }
    refresh();
  };

  const handleClear = () => {
    setBody("");
    setError(null);
    setSavedMsg(null);
  };

  const personById = (id: string | null) => {
    if (!id) return "Unknown";
    return allPeople.find((p) => p.id === id)?.first_name ?? "Unknown";
  };

  const scopeLabel = (id: string | null) => {
    if (!id) return "Global default (everyone)";
    return allPeople.find((p) => p.id === id)?.first_name ?? "Unknown";
  };

  const formatTimestamp = (ts: string) =>
    `${formatDateMDY(ts)} ${format(parseISO(ts), "h:mm a")}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Messages</CardTitle>
        <CardDescription>
          Post a message to everyone (Global default) or to one rep. It shows
          at the top of their dashboard. Saving for the same scope replaces
          that scope&apos;s current message.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <section className="space-y-3 rounded-md border p-4">
          <h3 className="text-sm font-semibold">Add or change message</h3>

          <div className="space-y-1.5">
            <Label htmlFor="msg-scope">Scope</Label>
            <Select value={scope} onValueChange={handleScopeChange}>
              <SelectTrigger id="msg-scope" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={GLOBAL_SCOPE}>
                  Global default (everyone)
                </SelectItem>
                {people.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.first_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="msg-body">Message</Label>
            <textarea
              id="msg-body"
              className="w-full min-h-[100px] rounded-md border border-input bg-background p-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Type your message…"
              disabled={saving}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={handleSave} disabled={saving || !body.trim()}>
              {saving ? "Saving…" : "Save message"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleClear}
              disabled={saving}
            >
              Clear
            </Button>
            {error && <p className="text-sm text-destructive">{error}</p>}
            {savedMsg && !error && (
              <p className="text-sm text-green-600 dark:text-green-400">
                {savedMsg}
              </p>
            )}
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Current messages</h3>
          {messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">No messages yet.</p>
          ) : (
            <ul className="space-y-2">
              {messages.map((m) => (
                <li key={m.id} className="rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-semibold">
                      {scopeLabel(m.salesperson_id)}
                    </span>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => handleDelete(m.id)}
                    >
                      Delete
                    </Button>
                  </div>
                  <p className="mt-1.5 whitespace-pre-wrap">{m.body}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Last edited {formatTimestamp(m.updated_at)}
                    {m.created_by && ` by ${personById(m.created_by)}`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
