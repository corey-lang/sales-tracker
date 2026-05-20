"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { Send, Trash2 } from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { supabase } from "@/lib/supabase/client";
import { useSalesperson } from "@/lib/use-salesperson";
import { useScrollToTop } from "@/lib/use-scroll-to-top";
import {
  BottomNav,
  BOTTOM_NAV_SPACER,
  canSeeJuiceBox,
} from "@/components/bottom-nav";
import {
  MESSAGE_MAX_LENGTH,
  TEAM_MESSAGES_CHANNEL,
  TEAM_MESSAGES_TABLE,
  type TeamMessage,
} from "@/lib/team-messages";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// Juice Box — Pass 2 live team feed.
//
// REALTIME
//   We subscribe to postgres_changes on `team_messages` via the browser
//   supabase-js client (anon key). The table has anon SELECT only, and is
//   published to supabase_realtime (see supabase/team_messages.sql), so
//   INSERT and UPDATE events stream live. No polling.
//
//   * INSERT  -> append to feed (id-dedup against the row we already added
//                optimistically when we POSTed)
//   * UPDATE  -> if is_deleted flipped to true, drop the row from view;
//                otherwise replace it (future-proof, not used yet).
//
// WRITES
//   All writes go through /api/team-messages (POST) and
//   /api/team-messages/:id (DELETE). The server enforces the admin/test
//   gate on every call; this page additionally redirects non-eligible
//   users at mount.

export default function JuiceBoxPage() {
  const router = useRouter();
  const { salesperson, loaded } = useSalesperson();
  useScrollToTop();

  // Two gates, one effect: not signed in -> /, ineligible -> /dashboard.
  useEffect(() => {
    if (!loaded) return;
    if (!salesperson) {
      router.replace("/");
      return;
    }
    if (!canSeeJuiceBox(salesperson)) {
      router.replace("/dashboard");
    }
  }, [loaded, salesperson, router]);

  if (!loaded || !salesperson || !canSeeJuiceBox(salesperson)) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  return (
    <>
      <main
        className={`mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-4 p-4 ${BOTTOM_NAV_SPACER}`}
      >
        <header className="space-y-1 pt-1">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Juice Box 🍊
          </h1>
          <p className="text-sm text-muted-foreground">Live team feed</p>
        </header>

        <JuiceBoxFeed
          currentUserId={salesperson.id}
          isAdmin={salesperson.is_admin}
        />
      </main>
      <BottomNav salesperson={salesperson} />
    </>
  );
}

type FeedState =
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "ready"; messages: TeamMessage[] };

function JuiceBoxFeed({
  currentUserId,
  isAdmin,
}: {
  currentUserId: string;
  isAdmin: boolean;
}) {
  const [state, setState] = useState<FeedState>({ kind: "loading" });

  // Merges an incoming message into the visible feed. Used by both the
  // optimistic post path and the realtime INSERT handler — id-dedup keeps
  // the two from doubling up.
  const upsertMessage = useCallback((incoming: TeamMessage) => {
    setState((prev) => {
      if (prev.kind !== "ready") return prev;
      if (incoming.is_deleted) {
        return {
          kind: "ready",
          messages: prev.messages.filter((m) => m.id !== incoming.id),
        };
      }
      const existing = prev.messages.findIndex((m) => m.id === incoming.id);
      if (existing >= 0) {
        const next = prev.messages.slice();
        next[existing] = incoming;
        return { kind: "ready", messages: next };
      }
      // Maintain oldest -> newest order. Realtime almost always delivers in
      // order, but if a late INSERT arrives we still slot it by created_at.
      const next = [...prev.messages, incoming];
      next.sort((a, b) => a.created_at.localeCompare(b.created_at));
      return { kind: "ready", messages: next };
    });
  }, []);

  const removeMessage = useCallback((id: string) => {
    setState((prev) => {
      if (prev.kind !== "ready") return prev;
      return {
        kind: "ready",
        messages: prev.messages.filter((m) => m.id !== id),
      };
    });
  }, []);

  // Initial fetch.
  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/team-messages")
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as {
          messages?: TeamMessage[];
          error?: string;
        } | null;
        if (cancelled) return;
        if (!res.ok) {
          setState({
            kind: "error",
            error: body?.error ?? `Couldn't load feed (${res.status}).`,
          });
          return;
        }
        setState({ kind: "ready", messages: body?.messages ?? [] });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          error:
            err instanceof Error ? err.message : "Couldn't load feed.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Realtime subscription. One channel per page mount; cleaned up on unmount
  // so navigating away closes the websocket subscription cleanly.
  useEffect(() => {
    const channel = supabase
      .channel(TEAM_MESSAGES_CHANNEL)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: TEAM_MESSAGES_TABLE },
        (payload) => {
          const row = payload.new as TeamMessage;
          if (row.is_deleted) return;
          upsertMessage(row);
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: TEAM_MESSAGES_TABLE },
        (payload) => {
          const row = payload.new as TeamMessage;
          if (row.is_deleted) {
            removeMessage(row.id);
            return;
          }
          upsertMessage(row);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [upsertMessage, removeMessage]);

  return (
    <>
      <Composer onPosted={upsertMessage} />
      <FeedList
        state={state}
        currentUserId={currentUserId}
        isAdmin={isAdmin}
        onDeleted={removeMessage}
      />
    </>
  );
}

function Composer({ onPosted }: { onPosted: (message: TeamMessage) => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = text.trim();
  const canSubmit = trimmed.length > 0 && !sending;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSending(true);
    setError(null);

    let res: Response;
    try {
      res = await apiFetch("/api/team-messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
      });
    } catch (err) {
      setSending(false);
      setError(err instanceof Error ? err.message : "Network error.");
      return;
    }

    const body = (await res.json().catch(() => null)) as {
      message?: TeamMessage;
      error?: string;
    } | null;

    setSending(false);

    if (!res.ok || !body?.message) {
      setError(body?.error ?? `Couldn't post (${res.status}).`);
      return;
    }

    // Optimistic merge — the realtime INSERT will also fire for this row;
    // upsertMessage dedups by id so it's a no-op the second time.
    onPosted(body.message);
    setText("");
  };

  return (
    <Card size="sm">
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-3">
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Share a win, intro, or shoutout…"
            rows={2}
            maxLength={MESSAGE_MAX_LENGTH}
            disabled={sending}
            className="w-full resize-none rounded-md border border-input bg-background/40 px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <div className="flex items-center justify-between gap-2">
            <p
              className={`text-xs ${
                trimmed.length > MESSAGE_MAX_LENGTH - 100
                  ? "text-muted-foreground"
                  : "text-muted-foreground/60"
              }`}
            >
              {trimmed.length}/{MESSAGE_MAX_LENGTH}
            </p>
            <Button
              type="submit"
              size="sm"
              disabled={!canSubmit}
              className="gap-1.5"
            >
              <Send aria-hidden="true" className="size-3.5" />
              {sending ? "Posting…" : "Post"}
            </Button>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </form>
      </CardContent>
    </Card>
  );
}

function FeedList({
  state,
  currentUserId,
  isAdmin,
  onDeleted,
}: {
  state: FeedState;
  currentUserId: string;
  isAdmin: boolean;
  onDeleted: (id: string) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const messageCount =
    state.kind === "ready" ? state.messages.length : 0;

  // Keep the feed pinned to the bottom as new posts arrive. Smooth on
  // realtime updates, instant on initial load.
  const firstScrollRef = useRef(true);
  useEffect(() => {
    if (messageCount === 0) return;
    bottomRef.current?.scrollIntoView({
      behavior: firstScrollRef.current ? "auto" : "smooth",
      block: "end",
    });
    firstScrollRef.current = false;
  }, [messageCount]);

  if (state.kind === "loading") {
    return (
      <p className="px-1 text-sm text-muted-foreground">Loading feed…</p>
    );
  }
  if (state.kind === "error") {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-destructive">
          Couldn&apos;t load the feed: {state.error}
        </CardContent>
      </Card>
    );
  }

  return (
    <section className="space-y-3">
      <h2 className="px-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Feed
      </h2>
      {state.messages.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No posts yet. Be the first to share a win.
          </CardContent>
        </Card>
      ) : (
        state.messages.map((m) => (
          <FeedCard
            key={m.id}
            message={m}
            isMine={m.salesperson_id === currentUserId}
            isAdmin={isAdmin}
            onDeleted={onDeleted}
          />
        ))
      )}
      <div ref={bottomRef} aria-hidden="true" />
    </section>
  );
}

function FeedCard({
  message,
  isMine,
  isAdmin,
  onDeleted,
}: {
  message: TeamMessage;
  isMine: boolean;
  isAdmin: boolean;
  onDeleted: (id: string) => void;
}) {
  const timeAgo = useMemo(
    () => formatDistanceToNow(new Date(message.created_at), { addSuffix: true }),
    [message.created_at],
  );

  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    setError(null);

    let res: Response;
    try {
      res = await apiFetch(`/api/team-messages/${message.id}`, {
        method: "DELETE",
      });
    } catch (err) {
      setDeleting(false);
      setError(err instanceof Error ? err.message : "Network error.");
      return;
    }

    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      setDeleting(false);
      setError(body?.error ?? `Couldn't delete (${res.status}).`);
      return;
    }

    // Realtime will also send an UPDATE event for the soft-delete; the local
    // removal makes the action feel immediate to the admin who clicked it.
    onDeleted(message.id);
  };

  return (
    <Card>
      <CardContent className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar name={message.salesperson_name} />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">
                {message.salesperson_name}
                {isMine && (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    (you)
                  </span>
                )}
              </p>
              <p className="text-xs text-muted-foreground">{timeAgo}</p>
            </div>
          </div>
          {isAdmin && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              aria-label="Delete post"
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2 aria-hidden="true" className="size-4" />
            </button>
          )}
        </div>
        <p className="whitespace-pre-wrap text-sm leading-relaxed">
          {message.message}
        </p>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

function Avatar({ name }: { name: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <div
      aria-hidden="true"
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary ring-1 ring-primary/30"
    >
      {initial}
    </div>
  );
}
