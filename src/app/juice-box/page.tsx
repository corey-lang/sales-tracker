"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  CornerUpLeft,
  MoreVertical,
  Send,
  SmilePlus,
  Trash2,
  X,
} from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { supabase } from "@/lib/supabase/client";
import { useSalesperson } from "@/lib/use-salesperson";
import { cn } from "@/lib/utils";
import {
  BottomNav,
  BOTTOM_NAV_SPACER,
  canSeeJuiceBox,
} from "@/components/bottom-nav";
import { useJuiceBoxUnread } from "@/components/juice-box-unread-provider";
import {
  ALLOWED_REACTIONS,
  MESSAGE_MAX_LENGTH,
  REPLY_PREVIEW_MAX_LENGTH,
  TEAM_MESSAGES_CHANNEL,
  TEAM_MESSAGES_TABLE,
  TEAM_MESSAGE_REACTIONS_CHANNEL,
  TEAM_MESSAGE_REACTIONS_TABLE,
  type ReactionEmoji,
  type TeamMessage,
  type TeamMessageReaction,
  type TeamMessageReactionRow,
} from "@/lib/team-messages";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// Long-press duration (ms) to enter Reply mode from a message card.
// Tuned to fire before iOS Safari's text-selection menu (~600ms) so the
// reply trigger feels like the dominant gesture on phones. The card also
// uses `select-none` on mobile so the selection UI never appears.
const LONG_PRESS_MS = 500;

/**
 * Reactions state — one entry per (message, emoji). `reactors` is the set
 * of salesperson_ids we've observed reacting (used for idempotency against
 * the realtime echo of the user's own optimistic toggle). `count` and
 * `reacted` are what the UI actually renders.
 *
 * The initial bootstrap aggregate (from GET /api/team-messages) only tells
 * us "the current user reacted" — not the ids of other reactors — so
 * `reactors` is seeded with just the current user when reacted=true.
 * Realtime DELETE events for previously-anonymous reactors fall through
 * to a `count--` fallback in `applyRemove`.
 */
type ReactionEntry = {
  count: number;
  reacted: boolean;
  reactors: Set<string>;
};
type ReactionsByEmoji = Map<string, ReactionEntry>;
type ReactionsState = Map<string, ReactionsByEmoji>;

// "New messages" divider grace timing. After mark-read clears the unread
// count, the divider stays put for DIVIDER_GRACE_MS so the user has a
// moment to orient to what was new, then fades out over the last
// DIVIDER_FADE_DURATION_MS before unmounting. The unread badge and
// server-side last_read_at are NOT delayed by these — only the divider's
// in-feed visual is held back. Tuned to 6 s total, with the last 1 s as
// a CSS opacity fade.
const DIVIDER_GRACE_MS = 6000;
const DIVIDER_FADE_DURATION_MS = 1000;

// Trailing-edge debounce. Returned trigger schedules `fn` to fire `delay`
// ms after the most recent call; rapid re-invocations only fire once at
// the end. Used to coalesce mark-read pings as messages stream in.
function useDebouncedCallback(fn: () => void, delay: number) {
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  return useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      fnRef.current();
    }, delay);
  }, [delay]);
}

// ---------------------------------------------------------------------------
// Reaction state helpers (pure)
// ---------------------------------------------------------------------------
// React state must be replaced by new references on every update so renders
// run. These helpers return a NEW root Map (and a new per-message Map for the
// touched message) without mutating the input. Untouched per-message Maps
// are shared by reference for stable shallow equality in child components.

function cloneReactionsAtMessage(
  prev: ReactionsState,
  messageId: string,
): { next: ReactionsState; perMsg: ReactionsByEmoji } {
  const next = new Map(prev);
  const existing = next.get(messageId);
  const perMsg = existing ? new Map(existing) : new Map();
  next.set(messageId, perMsg);
  return { next, perMsg };
}

/**
 * Records that `userId` reacted with `emoji` to message `messageId`. Idempotent
 * against duplicate dispatch — if `userId` is already in the entry's reactors
 * set, no change. This is what dedupes the realtime echo of the user's own
 * optimistic toggle: the optimistic apply adds the current user; the echoed
 * INSERT hits the same path and short-circuits.
 */
function applyReactionAdd(
  prev: ReactionsState,
  messageId: string,
  emoji: string,
  userId: string,
  currentUserId: string,
): ReactionsState {
  const { next, perMsg } = cloneReactionsAtMessage(prev, messageId);
  const existing = perMsg.get(emoji);
  if (existing && existing.reactors.has(userId)) return prev;
  const reactors = new Set(existing?.reactors ?? []);
  reactors.add(userId);
  perMsg.set(emoji, {
    count: (existing?.count ?? 0) + 1,
    reacted:
      userId === currentUserId ? true : (existing?.reacted ?? false),
    reactors,
  });
  return next;
}

/**
 * Removes a reaction by `userId` on `messageId`/`emoji`. Two cases:
 *   1. `userId` is in the entry's reactors set (we've seen them react) —
 *      remove them and decrement count.
 *   2. `userId` is NOT in the set (a pre-bootstrap "anonymous" reactor that
 *      was only counted in aggregate) — trust the realtime event and just
 *      decrement count. The exception is the CURRENT user: if we don't have
 *      them in the set, it means our optimistic remove already ran, and the
 *      realtime echo is idempotent.
 */
function applyReactionRemove(
  prev: ReactionsState,
  messageId: string,
  emoji: string,
  userId: string,
  currentUserId: string,
): ReactionsState {
  const existing = prev.get(messageId)?.get(emoji);
  if (!existing) return prev;

  const { next, perMsg } = cloneReactionsAtMessage(prev, messageId);
  const reactors = new Set(existing.reactors);

  if (reactors.has(userId)) {
    reactors.delete(userId);
    const count = Math.max(0, existing.count - 1);
    if (count === 0) {
      perMsg.delete(emoji);
      if (perMsg.size === 0) next.delete(messageId);
    } else {
      perMsg.set(emoji, {
        count,
        reacted: userId === currentUserId ? false : existing.reacted,
        reactors,
      });
    }
    return next;
  }

  // Not in our reactors set. If it's the current user, the optimistic
  // remove already applied — the realtime echo is a no-op.
  if (userId === currentUserId) return prev;

  // Pre-bootstrap anonymous reactor — trust the event, decrement count.
  const count = Math.max(0, existing.count - 1);
  if (count === 0) {
    perMsg.delete(emoji);
    if (perMsg.size === 0) next.delete(messageId);
  } else {
    perMsg.set(emoji, {
      count,
      reacted: existing.reacted,
      reactors,
    });
  }
  return next;
}

/**
 * Builds the initial reactions state from a server-side aggregate. We don't
 * have other reactors' ids in the aggregate (privacy isn't the concern; the
 * payload just doesn't ship that detail) — `reactors` holds only the current
 * user when reacted=true. `applyReactionRemove`'s pre-bootstrap fallback
 * keeps the count truthful when other users later un-react.
 */
function buildInitialReactions(
  aggregates: Map<string, TeamMessageReaction[]>,
  currentUserId: string,
): ReactionsState {
  const root: ReactionsState = new Map();
  for (const [messageId, items] of aggregates) {
    if (items.length === 0) continue;
    const perMsg: ReactionsByEmoji = new Map();
    for (const r of items) {
      const reactors = new Set<string>();
      if (r.reacted) reactors.add(currentUserId);
      perMsg.set(r.emoji, { count: r.count, reacted: r.reacted, reactors });
    }
    root.set(messageId, perMsg);
  }
  return root;
}

/**
 * Renders the reactions Map for a single message into the sorted array the
 * UI expects: count desc, emoji asc as the stable tiebreaker. Returns the
 * empty array when the message has no reactions so consumers can render
 * without a guard.
 */
function renderReactions(
  perMsg: ReactionsByEmoji | undefined,
): TeamMessageReaction[] {
  if (!perMsg || perMsg.size === 0) return [];
  const arr: TeamMessageReaction[] = [];
  for (const [emoji, entry] of perMsg) {
    if (entry.count <= 0) continue;
    arr.push({ emoji, count: entry.count, reacted: entry.reacted });
  }
  arr.sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
  return arr;
}

/**
 * Smooth-scrolls to a message DOM node by id and applies a short highlight
 * pulse via `data-juice-highlight`. The CSS for the pulse lives in
 * globals.css (or is handled inline below). No-op if the message isn't in
 * the loaded window — it may be older than FEED_LIMIT.
 */
function scrollToMessage(messageId: string) {
  const el = document.getElementById(`juice-message-${messageId}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.setAttribute("data-juice-highlight", "true");
  window.setTimeout(() => el.removeAttribute("data-juice-highlight"), 1600);
}

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
  // useScrollToTop is intentionally NOT called here. The feed's own scroll
  // effect lands the viewport on the most recent post once initial data
  // resolves — see FeedList. Calling useScrollToTop would race with that.

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

  // Unread state from the global provider. lastReadAt is the server-confirmed
  // marker for the current user; markAllRead bumps it to NOW() optimistically.
  // We pass these straight through to FeedList — the divider position derives
  // directly from the live lastReadAt, so when markAllRead advances it past
  // every visible message the divider disappears on the next render. Earlier
  // versions froze a divider anchor for the page lifetime, which kept stale
  // "New messages" markers visible after the user had already caught up.
  const {
    lastReadAt,
    loaded: unreadLoaded,
    markAllRead,
  } = useJuiceBoxUnread();

  // Debounced mark-read — collapses bursts (e.g., the initial scroll snap
  // plus an inbound realtime message hitting within the same second) into
  // one POST. 600ms feels snappy without spamming the API.
  const markAllReadDebounced = useDebouncedCallback(markAllRead, 600);

  // One-shot signal flipped on by handleSelfPosted and consumed by the
  // FeedList scroll effect. When the local user pressed Post (vs. a
  // teammate's realtime INSERT), we always scroll to the bottom even if
  // they were reading older posts — they expect to see what they wrote.
  // Other inbound messages honor the "only stick to bottom if already
  // near bottom" rule.
  const forceScrollRef = useRef(false);

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

  const handleSelfPosted = useCallback(
    (m: TeamMessage) => {
      forceScrollRef.current = true;
      upsertMessage(m);
      // Posting implies "I have seen everything up to and including my own
      // message" — clear the unread count after the round-trip settles.
      markAllReadDebounced();
    },
    [upsertMessage, markAllReadDebounced],
  );

  const removeMessage = useCallback((id: string) => {
    setState((prev) => {
      if (prev.kind !== "ready") return prev;
      return {
        kind: "ready",
        messages: prev.messages.filter((m) => m.id !== id),
      };
    });
  }, []);

  // Reactions: one map keyed by message_id -> emoji -> { count, reacted, reactors }.
  // Lives at the feed level (not per-card) so the realtime subscription can
  // update any card from one place and the initial bootstrap is hydrated
  // from the same GET that loaded the messages.
  const [reactions, setReactions] = useState<ReactionsState>(new Map());

  // Reply state: when set, the composer renders in reply mode and the POST
  // body includes reply_to_message_id. Cleared on successful post or X.
  const [replyTo, setReplyTo] = useState<TeamMessage | null>(null);
  const clearReply = useCallback(() => setReplyTo(null), []);

  // Initial fetch.
  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/team-messages")
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as {
          messages?: (TeamMessage & { reactions?: TeamMessageReaction[] })[];
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
        const hydrated = body?.messages ?? [];
        // Peel reactions off the wire payload so message state stays a clean
        // TeamMessage[] (matching the realtime row shape). Aggregates go
        // into their own map.
        const aggregates = new Map<string, TeamMessageReaction[]>();
        const messages: TeamMessage[] = hydrated.map((m) => {
          if (m.reactions && m.reactions.length > 0) {
            aggregates.set(m.id, m.reactions);
          }
          const { reactions: _unused, ...rest } = m;
          void _unused;
          return rest;
        });
        setInitialIds(new Set(messages.map((m) => m.id)));
        setReactions(buildInitialReactions(aggregates, currentUserId));
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
  }, [currentUserId]);

  // Realtime subscription — team_messages. One channel per page mount;
  // cleaned up on unmount so navigating away closes the websocket cleanly.
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

  // Realtime subscription — team_message_reactions. Independent channel so
  // it can mount/unmount alongside the messages channel without interference.
  // DELETE payloads carry the full old row thanks to REPLICA IDENTITY FULL
  // (see juice_box_pass4_conversations.sql).
  useEffect(() => {
    const channel = supabase
      .channel(TEAM_MESSAGE_REACTIONS_CHANNEL)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: TEAM_MESSAGE_REACTIONS_TABLE,
        },
        (payload) => {
          const row = payload.new as TeamMessageReactionRow;
          if (!row?.message_id || !row?.emoji || !row?.salesperson_id) return;
          setReactions((prev) =>
            applyReactionAdd(
              prev,
              row.message_id,
              row.emoji,
              row.salesperson_id,
              currentUserId,
            ),
          );
        },
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: TEAM_MESSAGE_REACTIONS_TABLE,
        },
        (payload) => {
          const row = payload.old as TeamMessageReactionRow;
          if (!row?.message_id || !row?.emoji || !row?.salesperson_id) return;
          setReactions((prev) =>
            applyReactionRemove(
              prev,
              row.message_id,
              row.emoji,
              row.salesperson_id,
              currentUserId,
            ),
          );
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [currentUserId]);

  /**
   * Toggle a reaction optimistically. If the network call fails the toggle
   * is undone by reapplying the same operation — toggling twice from the
   * original is a no-op, so this reverts cleanly even if the user fired
   * other reactions in between. The realtime echo of a SUCCESSFUL toggle is
   * idempotent via the reactors-Set membership check.
   */
  const toggleReaction = useCallback(
    (messageId: string, emoji: ReactionEmoji) => {
      const flip = (state: ReactionsState): ReactionsState => {
        const entry = state.get(messageId)?.get(emoji);
        const wasReacted = entry?.reactors.has(currentUserId) ?? false;
        return wasReacted
          ? applyReactionRemove(
              state,
              messageId,
              emoji,
              currentUserId,
              currentUserId,
            )
          : applyReactionAdd(
              state,
              messageId,
              emoji,
              currentUserId,
              currentUserId,
            );
      };
      setReactions(flip);

      void apiFetch(`/api/team-messages/${messageId}/reactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoji }),
      })
        .then((res) => {
          if (!res.ok) setReactions(flip);
        })
        .catch(() => setReactions(flip));
    },
    [currentUserId],
  );

  const handleReply = useCallback((message: TeamMessage) => {
    setReplyTo(message);
  }, []);

  return (
    <>
      {/*
        Sticky composer. -mx-4 px-4 lets the translucent backdrop bleed to
        main's horizontal edges while the inner Card stays in the padded
        column. top-0 + a 30 z-index keeps it above scrolling feed content
        (incl. the open 3-dot menu at z-20) and below the bottom nav (z-40).
        env(safe-area-inset-top) keeps it clear of the notch when the app
        is installed as a PWA.
      */}
      <div
        className="sticky top-0 z-30 -mx-4 bg-background/85 px-4 pb-2 backdrop-blur supports-[backdrop-filter]:bg-background/70"
        style={{ paddingTop: "calc(0.5rem + env(safe-area-inset-top))" }}
      >
        <Composer
          onPosted={handleSelfPosted}
          replyTo={replyTo}
          onCancelReply={clearReply}
        />
      </div>
      <FeedList
        state={state}
        currentUserId={currentUserId}
        isAdmin={isAdmin}
        onDeleted={removeMessage}
        onReply={handleReply}
        reactions={reactions}
        onToggleReaction={toggleReaction}
        initialIds={initialIds}
        forceScrollRef={forceScrollRef}
        lastReadAt={lastReadAt}
        unreadLoaded={unreadLoaded}
        onNearBottom={markAllReadDebounced}
      />
    </>
  );
}

function Composer({
  onPosted,
  replyTo,
  onCancelReply,
}: {
  onPosted: (message: TeamMessage) => void;
  /** Set when the user picked a message to reply to. The post is sent with
   *  reply_to_message_id and the textarea gains a "Replying to {name}…"
   *  header above it. null = normal compose mode. */
  replyTo: TeamMessage | null;
  /** Tears the user out of reply mode without posting. */
  onCancelReply: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Focus the textarea when entering reply mode so the user can start typing
  // immediately. Keying on `replyToId` (not the whole replyTo object) means
  // re-rendering the composer for unrelated reasons doesn't re-focus, but
  // switching the reply target does.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const replyToId = replyTo?.id ?? null;
  useEffect(() => {
    if (replyToId) textareaRef.current?.focus();
  }, [replyToId]);

  const trimmed = text.trim();
  const canSubmit = trimmed.length > 0 && !sending;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSending(true);
    setError(null);

    const payload: { message: string; reply_to_message_id?: string } = {
      message: trimmed,
    };
    if (replyTo) payload.reply_to_message_id = replyTo.id;

    let res: Response;
    try {
      res = await apiFetch("/api/team-messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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
    onCancelReply();
  };

  return (
    <Card size="sm" className="py-2.5">
      <CardContent className="px-3">
        <form onSubmit={handleSubmit} className="space-y-2">
          {replyTo && (
            <ReplyHeader replyTo={replyTo} onCancel={onCancelReply} />
          )}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (error) setError(null);
            }}
            placeholder={
              replyTo
                ? `Reply to ${replyTo.salesperson_name}…`
                : "Share a win, intro, or shoutout…"
            }
            rows={2}
            maxLength={MESSAGE_MAX_LENGTH}
            disabled={sending}
            // text-base (16px) on EVERY viewport to defeat iOS/WebKit's
            // "zoom into any focused input < 16px" behavior. A previous fix
            // bumped only mobile (sm:text-sm restored 14px from 640px up),
            // but iPhone landscape can exceed that breakpoint and was still
            // triggering auto-zoom on focus. Keeping 16px everywhere is the
            // only viewport-agnostic guard; padding/min-height/rows/button
            // sizing are left alone so the composer stays compact.
            className="min-h-[2.5rem] w-full resize-none rounded-md border border-input bg-background/40 px-3 py-1.5 text-base placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
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

/**
 * "Replying to {name}…" banner above the composer textarea. Shows a compact
 * single-line preview of the quoted post + an X to bail out of reply mode.
 * Matches the styling of the quoted block on a reply card so the user sees
 * the same shape before and after posting.
 */
function ReplyHeader({
  replyTo,
  onCancel,
}: {
  replyTo: TeamMessage;
  onCancel: () => void;
}) {
  const preview = replyTo.message.length > REPLY_PREVIEW_MAX_LENGTH
    ? `${replyTo.message.slice(0, REPLY_PREVIEW_MAX_LENGTH)}…`
    : replyTo.message;
  return (
    <div className="flex items-start gap-2 rounded-md border-l-2 border-primary bg-muted/40 px-2 py-1">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 text-[11px] font-medium text-primary">
          <CornerUpLeft aria-hidden="true" className="size-3" />
          Replying to {replyTo.salesperson_name}
        </p>
        <p className="line-clamp-1 text-xs text-muted-foreground">
          {preview}
        </p>
      </div>
      <button
        type="button"
        onClick={onCancel}
        aria-label="Cancel reply"
        className="-mr-1 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}

function FeedList({
  state,
  currentUserId,
  isAdmin,
  onDeleted,
  onReply,
  reactions,
  onToggleReaction,
  initialIds,
  forceScrollRef,
  lastReadAt,
  unreadLoaded,
  onNearBottom,
}: {
  state: FeedState;
  currentUserId: string;
  isAdmin: boolean;
  onDeleted: (id: string) => void;
  /** Fired when the user picks Reply (long-press or 3-dot menu) on a card. */
  onReply: (message: TeamMessage) => void;
  /** Live reactions map. Each card pulls its own per-message slice from this
   *  via `reactions.get(message.id)`. */
  reactions: ReactionsState;
  /** Tap handler for individual reaction chips + the inline emoji bar. */
  onToggleReaction: (messageId: string, emoji: ReactionEmoji) => void;
  initialIds: Set<string> | null;
  forceScrollRef: React.RefObject<boolean>;
  /** Live server-confirmed last_read_at for the current user; positions
   *  the "New messages" divider. null = never-read; string = ISO timestamp. */
  lastReadAt: string | null;
  /** True once the unread bootstrap has resolved at least once. The divider
   *  stays hidden until then so we don't briefly flash a divider above
   *  every message while we wait for the marker to load. */
  unreadLoaded: boolean;
  /** Fired (debounced upstream) every time the viewport is at/near the
   *  bottom of the feed — initial snap, scroll-back-down, or auto-scroll
   *  after an inbound message arrived while already near bottom. */
  onNearBottom: () => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const messageCount =
    state.kind === "ready" ? state.messages.length : 0;

  // Divider grace state.
  //   dividerAnchor lags `lastReadAt` so the "New messages" marker stays
  //   visible for DIVIDER_GRACE_MS after the user catches up. The unread
  //   badge and server marker are unaffected — only the in-feed divider
  //   takes its position from this lagging value.
  //
  //   undefined = not yet synced (first paint, divider hidden)
  //   null      = never read (every message is "new")
  //   string    = anchor ISO timestamp
  const [dividerAnchor, setDividerAnchor] = useState<
    string | null | undefined
  >(undefined);
  // Toggled true for the last DIVIDER_FADE_DURATION_MS of the grace window
  // so the divider opacity-transitions to 0 before being unmounted.
  const [dividerFading, setDividerFading] = useState(false);

  useEffect(() => {
    if (!unreadLoaded) return;
    // No-op when the lagging anchor is already in sync with the live value.
    if (dividerAnchor === lastReadAt) return;

    if (dividerAnchor === undefined) {
      // First sync after the unread bootstrap resolves — adopt the live
      // marker immediately so we don't briefly flash a divider in the
      // wrong place. Single setState, no cascade.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDividerAnchor(lastReadAt);
      return;
    }

    // lastReadAt moved forward (mark-read happened). Hold the existing
    // anchor for the grace window, fade for the final second, then
    // catch up so the divider unmounts cleanly.
    const fadeStart = setTimeout(
      () => setDividerFading(true),
      DIVIDER_GRACE_MS - DIVIDER_FADE_DURATION_MS,
    );
    const advance = setTimeout(() => {
      setDividerAnchor(lastReadAt);
      setDividerFading(false);
    }, DIVIDER_GRACE_MS);
    return () => {
      clearTimeout(fadeStart);
      clearTimeout(advance);
    };
  }, [lastReadAt, dividerAnchor, unreadLoaded]);

  // Position the divider against the lagging anchor — not the live
  // lastReadAt — so a successful markAllRead doesn't snap it away.
  // -1 = no divider (anchor not yet synced, or every message is read).
  const dividerIndex = useMemo(() => {
    if (state.kind !== "ready") return -1;
    if (state.messages.length === 0) return -1;
    if (dividerAnchor === undefined) return -1;
    if (dividerAnchor === null) return 0;
    return state.messages.findIndex((m) => m.created_at > dividerAnchor);
  }, [state, dividerAnchor]);

  // Keep `onNearBottom` reachable from the scroll listener (which is set up
  // once on mount) without restarting the listener every time the upstream
  // identity changes.
  const onNearBottomRef = useRef(onNearBottom);
  useEffect(() => {
    onNearBottomRef.current = onNearBottom;
  }, [onNearBottom]);

  // Scroll-position discipline:
  //   * On the very first arrival of messages, snap to the bottom (latest
  //     post) so the page lands where chat-style feeds always land.
  //   * For each subsequent message, only auto-scroll if either
  //       (a) the user just hit Post themselves (forceScrollRef), or
  //       (b) they are currently within NEAR_BOTTOM_PX of the bottom.
  //     Otherwise — they have scrolled up to read older posts — leave them
  //     alone. No yanking the viewport while they're reading.
  const NEAR_BOTTOM_PX = 200;
  const firstScrollRef = useRef(true);
  const nearBottomRef = useRef(true);

  useEffect(() => {
    const update = () => {
      const wasNear = nearBottomRef.current;
      const doc = document.documentElement;
      const remaining = doc.scrollHeight - window.scrollY - window.innerHeight;
      const isNear = remaining < NEAR_BOTTOM_PX;
      nearBottomRef.current = isNear;
      // Mark-read trigger: the user manually scrolled back into the
      // near-bottom band. Edge-triggered so simply being near bottom while
      // scrolling around doesn't fire repeatedly.
      if (!wasNear && isNear) {
        onNearBottomRef.current();
      }
    };
    // Seed once in case the user never scrolls; passive listener avoids
    // blocking the scroll thread.
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  useEffect(() => {
    if (messageCount === 0) return;
    const shouldScroll =
      firstScrollRef.current ||
      forceScrollRef.current ||
      nearBottomRef.current;
    if (shouldScroll) {
      bottomRef.current?.scrollIntoView({
        behavior: firstScrollRef.current ? "auto" : "smooth",
        block: "end",
      });
      // We just landed (or stayed) at the bottom — mark everything as read.
      // Debounced upstream so the initial snap + an inbound realtime hit
      // collapse into one POST.
      onNearBottomRef.current();
    }
    firstScrollRef.current = false;
    // Consume the one-shot self-post signal whether or not it fired the
    // scroll — once handled, future inbound messages go back to the
    // "near-bottom only" rule.
    forceScrollRef.current = false;
  }, [messageCount, forceScrollRef]);

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
        state.messages.map((m, i) => {
          const isFresh = initialIds !== null && !initialIds.has(m.id);
          return (
            <Fragment key={m.id}>
              {i === dividerIndex && (
                <NewMessagesDivider fading={dividerFading} />
              )}
              <FeedCard
                message={m}
                isMine={m.salesperson_id === currentUserId}
                isAdmin={isAdmin}
                isFresh={isFresh}
                onDeleted={onDeleted}
                onReply={onReply}
                reactions={renderReactions(reactions.get(m.id))}
                onToggleReaction={onToggleReaction}
              />
            </Fragment>
          );
        })
      )}
      {/*
        Comfort gap above the bottom-nav clearance. BOTTOM_NAV_SPACER on main
        already reserves space for the nav + iOS safe area, but in practice
        scrollIntoView({block:"end"}) lands the latest message flush against
        that reserve, leaving it visually crowded against (and on shorter
        viewports partially obscured by) the nav. h-20 (5rem / 80px) buys
        comfortable breathing room without feeling like dead space at the
        bottom of the feed.
      */}
      <div aria-hidden="true" className="h-20" />
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
  onReply,
  reactions,
  onToggleReaction,
}: {
  message: TeamMessage;
  isMine: boolean;
  isAdmin: boolean;
  isFresh: boolean;
  onDeleted: (id: string) => void;
  onReply: (message: TeamMessage) => void;
  reactions: TeamMessageReaction[];
  onToggleReaction: (messageId: string, emoji: ReactionEmoji) => void;
}) {
  const timeAgo = useMemo(
    () => formatDistanceToNow(new Date(message.created_at), { addSuffix: true }),
    [message.created_at],
  );

  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Inline emoji bar — kept on the card so multiple bars can never be open
  // at once on screen (tap-outside closes the previous via the bar's own
  // effect; see ReactionBar).
  const [reactionBarOpen, setReactionBarOpen] = useState(false);

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

  // Long-press → reply. Fires after LONG_PRESS_MS unless the user lifts,
  // moves significantly (scrolling), or cancels. Light haptic feedback on
  // browsers that support it. The 3-dot menu's Reply item is the explicit
  // alternative for accessibility / keyboard users.
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStart = useRef<{ x: number; y: number } | null>(null);
  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current !== null) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    longPressStart.current = null;
  }, []);
  useEffect(() => {
    // Cancel any pending timer if the card unmounts mid-press.
    return () => {
      if (longPressTimer.current !== null) clearTimeout(longPressTimer.current);
    };
  }, []);

  const startLongPress = (e: React.PointerEvent<HTMLDivElement>) => {
    // Only touch + primary mouse trigger long-press; pen/etc. fall through
    // to the explicit menu path.
    if (e.pointerType !== "touch" && e.pointerType !== "mouse") return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    longPressStart.current = { x: e.clientX, y: e.clientY };
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = null;
      onReply(message);
      if (typeof navigator !== "undefined" && "vibrate" in navigator) {
        try {
          navigator.vibrate(12);
        } catch {
          // Some browsers throw on vibrate() from non-user-gestures; ignore.
        }
      }
    }, LONG_PRESS_MS);
  };
  const moveLongPress = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = longPressStart.current;
    if (!start) return;
    // ~6px slop tolerates a small finger drift but cancels real scrolls.
    if (Math.abs(e.clientX - start.x) > 6 || Math.abs(e.clientY - start.y) > 6) {
      cancelLongPress();
    }
  };

  const hasReactions = reactions.length > 0;
  const hasReply = Boolean(
    message.reply_to_message_id && message.reply_to_message_preview,
  );

  return (
    <Card
      // Stable DOM id used by reply previews to scroll-to + highlight the
      // original post. The data-juice-highlight attribute is set/cleared
      // by scrollToMessage and styled in globals.css.
      id={`juice-message-${message.id}`}
      size="sm"
      className={cn(
        // Slightly brighter ring + soft orange glow on hover so adjacent
        // posts read as separate cards without screaming for attention.
        "py-2.5 ring-foreground/15 transition-shadow hover:shadow-[0_0_0_1px_var(--color-primary)/0.18,0_8px_24px_-12px_color-mix(in_oklab,var(--color-primary)_25%,transparent)]",
        // tw-animate-css: short fade + slide for posts that arrived after
        // the initial load. Initial cards do not animate.
        isFresh &&
          "animate-in fade-in-0 slide-in-from-bottom-2 duration-300 ease-out",
        // Disable text selection on mobile so a long-press triggers reply
        // instead of bringing up the iOS selection menu; restore at sm:+
        // so desktop users can still copy quotes.
        "select-none sm:select-text",
      )}
      onPointerDown={startLongPress}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onPointerMove={moveLongPress}
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
            onReply={() => onReply(message)}
          />
        </div>
        {hasReply && (
          <QuotedReply
            replyToId={message.reply_to_message_id!}
            authorName={
              message.reply_to_salesperson_name ?? "Unknown teammate"
            }
            preview={message.reply_to_message_preview!}
          />
        )}
        <p className="whitespace-pre-wrap pl-[2.625rem] text-sm leading-relaxed">
          {message.message}
        </p>
        {error && (
          <p className="pl-[2.625rem] text-xs text-destructive">{error}</p>
        )}
        <ReactionsRow
          messageId={message.id}
          reactions={reactions}
          onToggle={onToggleReaction}
          onOpenBar={() => setReactionBarOpen(true)}
          hasAny={hasReactions}
        />
        {reactionBarOpen && (
          <ReactionBar
            messageId={message.id}
            currentReactions={reactions}
            onToggle={(emoji) => {
              onToggleReaction(message.id, emoji);
              setReactionBarOpen(false);
            }}
            onClose={() => setReactionBarOpen(false)}
          />
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Compact quoted block above the message body on a reply. Tapping it
 * smooth-scrolls to the original post and applies a short highlight pulse.
 * If the original is older than FEED_LIMIT and not in the loaded window,
 * the tap is a no-op — by design (no lazy loading older posts in Pass 4).
 */
function QuotedReply({
  replyToId,
  authorName,
  preview,
}: {
  replyToId: string;
  authorName: string;
  preview: string;
}) {
  return (
    <button
      type="button"
      onClick={() => scrollToMessage(replyToId)}
      className="ml-[2.625rem] block w-[calc(100%-2.625rem)] rounded-md border-l-2 border-primary bg-muted/40 px-2 py-1 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      aria-label={`Replying to ${authorName} — tap to view original`}
    >
      <p className="flex items-center gap-1 text-[11px] font-medium text-primary">
        <CornerUpLeft aria-hidden="true" className="size-3" />
        {authorName}
      </p>
      <p className="line-clamp-2 text-xs text-muted-foreground">{preview}</p>
    </button>
  );
}

/**
 * Row of reaction chips (existing reactions) plus a "+ react" pill that opens
 * the inline emoji bar. Always renders the + pill so reacting stays
 * discoverable even on posts that have no reactions yet. Tapping a chip
 * toggles that reaction.
 */
function ReactionsRow({
  messageId,
  reactions,
  onToggle,
  onOpenBar,
  hasAny,
}: {
  messageId: string;
  reactions: TeamMessageReaction[];
  onToggle: (messageId: string, emoji: ReactionEmoji) => void;
  onOpenBar: () => void;
  hasAny: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 pl-[2.625rem]">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          onClick={() => onToggle(messageId, r.emoji as ReactionEmoji)}
          aria-pressed={r.reacted}
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
            r.reacted
              ? "bg-primary/15 text-primary ring-1 ring-primary/40"
              : "bg-muted/60 text-foreground/80 ring-1 ring-border hover:bg-muted",
          )}
        >
          <span className="text-sm leading-none">{r.emoji}</span>
          <span className="tabular-nums">{r.count}</span>
        </button>
      ))}
      <button
        type="button"
        onClick={onOpenBar}
        aria-label="Add reaction"
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs leading-none text-muted-foreground/80 ring-1 ring-border transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
          // De-emphasize when there are reactions; promote when there
          // aren't, so a totally empty row still has a clear affordance.
          !hasAny && "bg-muted/40",
        )}
      >
        <SmilePlus aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}

/**
 * Inline emoji bar — eight allowed emoji laid out as a horizontal row. Not
 * a picker; the closed Pass-4 emoji set is hard-coded in ALLOWED_REACTIONS.
 * Tap-outside closes via a document-level mousedown / touchstart listener;
 * Escape also closes for keyboard users.
 */
function ReactionBar({
  messageId,
  currentReactions,
  onToggle,
  onClose,
}: {
  messageId: string;
  currentReactions: TeamMessageReaction[];
  onToggle: (emoji: ReactionEmoji) => void;
  onClose: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointer = (e: MouseEvent | TouchEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("touchstart", handlePointer, { passive: true });
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("touchstart", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  const reactedSet = useMemo(
    () => new Set(currentReactions.filter((r) => r.reacted).map((r) => r.emoji)),
    [currentReactions],
  );

  return (
    <div
      ref={wrapRef}
      role="toolbar"
      aria-label="Pick a reaction"
      // Same indent as the body / chips column so it visually belongs to
      // the same message — avoids the bar dangling under the avatar.
      className="ml-[2.625rem] flex flex-wrap items-center gap-1 rounded-md border border-border bg-popover/95 p-1 shadow-lg animate-in fade-in-0 zoom-in-95 duration-150"
    >
      {ALLOWED_REACTIONS.map((emoji) => {
        const active = reactedSet.has(emoji);
        return (
          <button
            key={emoji}
            type="button"
            onClick={() => onToggle(emoji)}
            aria-pressed={active}
            aria-label={`React with ${emoji}`}
            className={cn(
              "flex size-8 items-center justify-center rounded-md text-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
              active
                ? "bg-primary/15 ring-1 ring-primary/40"
                : "hover:bg-muted",
            )}
          >
            {emoji}
          </button>
        );
      })}
      {/* messageId is only here to make the React-key/debug context obvious;
          the toggle handler is already bound by the parent. */}
      <span className="sr-only">Reactions for message {messageId}</span>
    </div>
  );
}

/**
 * Lightweight 3-dot menu. Reply is exposed to everyone (the explicit,
 * keyboard-accessible alternative to long-press). Delete is admin-only.
 */
function FeedCardMenu({
  isAdmin,
  deleting,
  onDelete,
  onReply,
}: {
  isAdmin: boolean;
  deleting: boolean;
  onDelete: () => void;
  onReply: () => void;
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
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onReply();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted"
          >
            <CornerUpLeft aria-hidden="true" className="size-3.5" />
            Reply
          </button>
          {isAdmin && (
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
          )}
        </div>
      )}
    </div>
  );
}

/**
 * "New messages" separator slotted in between the last read post and the
 * first unread one. Visually a thin orange hairline + a small pill label —
 * tasteful enough to read as a marker, not a banner.
 *
 * `fading` toggles a CSS opacity transition just before the divider is
 * unmounted by FeedList's grace timer. The component itself stays in the
 * DOM during the transition so the fade has a starting frame to animate
 * from — FeedList drops it from the tree the moment the timer expires.
 */
function NewMessagesDivider({ fading }: { fading: boolean }) {
  return (
    <div
      aria-label="New messages below"
      className={cn(
        "flex items-center gap-2 px-0.5 py-0.5 ease-out",
        // Duration must match DIVIDER_FADE_DURATION_MS so the visual fade
        // finishes right as the parent's advance timer unmounts the node.
        "transition-opacity duration-1000",
        fading ? "opacity-0" : "opacity-100",
      )}
    >
      <span className="h-px flex-1 bg-primary/30" />
      <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary ring-1 ring-primary/20">
        New messages
      </span>
      <span className="h-px flex-1 bg-primary/30" />
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
