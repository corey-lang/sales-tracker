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
import { MoreVertical, Send, Trash2 } from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { supabase } from "@/lib/supabase/client";
import { useSalesperson } from "@/lib/use-salesperson";
import { useScrollToTop } from "@/lib/use-scroll-to-top";
import { cn } from "@/lib/utils";
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

// Juice Box — live team feed.
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
        className={`mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-3 p-4 ${BOTTOM_NAV_SPACER}`}
      >
        <header className="space-y-1 pt-1">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Juice Box 🍊
          </h1>
          <div className="flex items-center gap-2">
            <p className="text-sm text-muted-foreground">Live team feed</p>
            <LiveBadge />
          </div>
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

/**
 * Small orange "live" pill next to the page subtitle. Static dot + an
 * animate-ping ring on a sibling element gives the subtle premium pulse the
 * theme calls for without a custom keyframe.
 */
function LiveBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary ring-1 ring-primary/20">
      <span className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60" />
        <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
      </span>
      Live
    </span>
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

  // Snapshot of message IDs present at initial load. Anything NOT in this set
  // was added after first render (optimistic post or realtime INSERT) and
  // therefore animates in. Set exactly once when the initial fetch resolves;
  // React batches it with the `state` setState in the same tick.
  const [initialIds, setInitialIds] = useState<Set<string> | null>(null);

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
        const messages = body?.messages ?? [];
        setInitialIds(new Set(messages.map((m) => m.id)));
        setState({ kind: "ready", messages });
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
        initialIds={initialIds}
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
    <Card size="sm" className="py-2.5">
      <CardContent className="px-3">
        <form onSubmit={handleSubmit} className="space-y-2">
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
            className="min-h-[2.5rem] w-full resize-none rounded-md border border-input bg-background/40 px-3 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <div className="flex items-center justify-between gap-2">
            <p
              className={`text-[11px] ${
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
              className="h-7 gap-1.5 px-3 text-xs"
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
  initialIds,
}: {
  state: FeedState;
  currentUserId: string;
  isAdmin: boolean;
  onDeleted: (id: string) => void;
  initialIds: Set<string> | null;
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
    <section className="space-y-2">
      <h2 className="px-0.5 text-xs font-medium text-muted-foreground/70">
        Recent posts
      </h2>
      {state.messages.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No posts yet. Be the first to share a win.
          </CardContent>
        </Card>
      ) : (
        state.messages.map((m) => {
          const isFresh = initialIds !== null && !initialIds.has(m.id);
          return (
            <FeedCard
              key={m.id}
              message={m}
              isMine={m.salesperson_id === currentUserId}
              isAdmin={isAdmin}
              isFresh={isFresh}
              onDeleted={onDeleted}
            />
          );
        })
      )}
      <div ref={bottomRef} aria-hidden="true" />
    </section>
  );
}

function FeedCard({
  message,
  isMine,
  isAdmin,
  isFresh,
  onDeleted,
}: {
  message: TeamMessage;
  isMine: boolean;
  isAdmin: boolean;
  isFresh: boolean;
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
    <Card
      size="sm"
      className={cn(
        // Slightly brighter ring + soft orange glow on hover so adjacent
        // posts read as separate cards without screaming for attention.
        "py-2.5 ring-foreground/15 transition-shadow hover:shadow-[0_0_0_1px_var(--color-primary)/0.18,0_8px_24px_-12px_color-mix(in_oklab,var(--color-primary)_25%,transparent)]",
        // tw-animate-css: short fade + slide for posts that arrived after
        // the initial load. Initial cards do not animate.
        isFresh &&
          "animate-in fade-in-0 slide-in-from-bottom-2 duration-300 ease-out",
      )}
    >
      <CardContent className="space-y-1.5 px-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <Avatar name={message.salesperson_name} />
            <p className="min-w-0 truncate text-sm leading-tight">
              <span className="font-semibold">{message.salesperson_name}</span>
              {isMine && (
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                  (you)
                </span>
              )}
              <span className="ml-1.5 text-xs font-normal text-muted-foreground/70">
                · {timeAgo}
              </span>
            </p>
          </div>
          <FeedCardMenu
            isAdmin={isAdmin}
            deleting={deleting}
            onDelete={handleDelete}
          />
        </div>
        <p className="whitespace-pre-wrap pl-[2.625rem] text-sm leading-relaxed">
          {message.message}
        </p>
        {error && (
          <p className="pl-[2.625rem] text-xs text-destructive">{error}</p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Lightweight 3-dot menu placeholder. Visible on every card so future actions
 * (copy, pin, edit, delete-by-author) can slot in without re-flowing the
 * layout. Only admin Delete is wired today; non-admins see a "More options
 * coming soon" hint so the affordance reads as deliberate, not broken.
 */
function FeedCardMenu({
  isAdmin,
  deleting,
  onDelete,
}: {
  isAdmin: boolean;
  deleting: boolean;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handle);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handle);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Post options"
        aria-haspopup="menu"
        aria-expanded={open}
        className="rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <MoreVertical aria-hidden="true" className="size-4" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 min-w-[10rem] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg animate-in fade-in-0 zoom-in-95 duration-150"
        >
          {isAdmin ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                // Native confirm — blocking, accessible, zero new dependencies.
                // Cheap guardrail against an accidental admin tap; the actual
                // permission check still happens server-side in requireAdmin.
                if (
                  !window.confirm("Delete this Juice Box post for everyone?")
                ) {
                  return;
                }
                onDelete();
              }}
              disabled={deleting}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2 aria-hidden="true" className="size-3.5" />
              {deleting ? "Deleting…" : "Delete"}
            </button>
          ) : (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              More options coming soon
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <div
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary ring-1 ring-primary/30"
    >
      {initial}
    </div>
  );
}
