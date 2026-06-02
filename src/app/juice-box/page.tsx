"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  CornerUpLeft,
  Download,
  ImagePlus,
  Loader2,
  MoreVertical,
  Search,
  Send,
  Settings,
  SmilePlus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { supabase } from "@/lib/supabase/client";
import { useSalesperson } from "@/lib/use-salesperson";
import { cn } from "@/lib/utils";
import { BottomNav } from "@/components/bottom-nav";
import { useJuiceBoxUnread } from "@/components/juice-box-unread-provider";
import {
  ALLOWED_REACTIONS,
  FEED_PAGE_SIZE,
  JUICE_BOX_MEDIA_BUCKET,
  MAX_IMAGES_PER_POST,
  MEDIA_ALLOWED_IMAGE_MIME_TYPES,
  MEDIA_MAX_FILE_SIZE_BYTES,
  MESSAGE_MAX_LENGTH,
  REPLY_PREVIEW_MAX_LENGTH,
  TEAM_MESSAGES_CHANNEL,
  TEAM_MESSAGES_TABLE,
  TEAM_MESSAGE_REACTIONS_CHANNEL,
  TEAM_MESSAGE_REACTIONS_TABLE,
  teamMessageMediaList,
  type ReactionEmoji,
  type TeamMessage,
  type TeamMessageMedia,
  type TeamMessageReaction,
  type TeamMessageReactionRow,
  type TeamMessageReactor,
  type GifResult,
} from "@/lib/team-messages";
import {
  readCachedFeed,
  writeCachedFeed,
  type CachedFeedMessage,
} from "@/lib/juice-box-cache";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LinkPreviewCard } from "@/components/link-preview-card";
import { AutoLinkText } from "@/components/auto-link-text";
import { extractFirstUrl } from "@/lib/url-detection";

// Long-press duration (ms) to enter Reply mode from a message card.
// Tuned to fire before iOS Safari's text-selection menu (~600ms) so the
// reply trigger feels like the dominant gesture on phones. The card also
// uses `select-none` on mobile so the selection UI never appears.
const LONG_PRESS_MS = 500;

/**
 * Reactions state — one entry per (message, emoji). `reactors` is a map
 * from salesperson_id to salesperson_name for everyone we've observed
 * reacting; the keys also drive idempotency for the realtime echo of the
 * user's own optimistic toggle. `count` and `reacted` are what the chip
 * row renders; the values of `reactors` feed the chip-detail popover.
 *
 * The initial bootstrap aggregate ships reactor names alongside counts,
 * so unlike the prior set-of-ids design we know every reactor's name from
 * the first paint. Realtime INSERT/UPDATE/DELETE events carry the full
 * row (including salesperson_name) thanks to REPLICA IDENTITY FULL, so
 * the map stays current as reactions stream in.
 */
type ReactionEntry = {
  count: number;
  reacted: boolean;
  reactors: Map<string, string>;
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

// Generous comfort offset above the composer's TOP edge after auto-
// scroll. Lands the targeted message in the lower-middle of visible feed
// rather than just above the composer. ~6rem feels right on phone
// viewports; main's pb-[18rem+safe] is sized to make this reachable
// without browser-side scrollTop clamping. Module-scoped so both the
// FeedList auto-scroll effects and the JuiceBoxFeed Jump-to-latest
// handler share a single source of truth.
const AUTO_SCROLL_COMFORT_PX = 96;

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
 * Records that `userId` (`userName`) reacted with `emoji` to message
 * `messageId`. Idempotent — if the user is already in the entry's
 * reactors map, no change. This dedupes the realtime echo of the user's
 * own optimistic toggle: the optimistic apply adds the current user; the
 * echoed INSERT hits the same path and short-circuits.
 */
function applyReactionAdd(
  prev: ReactionsState,
  messageId: string,
  emoji: string,
  userId: string,
  userName: string,
  currentUserId: string,
): ReactionsState {
  const { next, perMsg } = cloneReactionsAtMessage(prev, messageId);
  const existing = perMsg.get(emoji);
  if (existing && existing.reactors.has(userId)) return prev;
  const reactors = new Map(existing?.reactors ?? []);
  reactors.set(userId, userName);
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
 *   1. `userId` is in the entry's reactors map — remove them and
 *      decrement count.
 *   2. `userId` is NOT in the map. If it's the CURRENT user, the
 *      optimistic remove already ran and the realtime echo is a no-op.
 *      Otherwise trust the event and decrement count anyway (defensive
 *      against stale state during a reconnect).
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
  const reactors = new Map(existing.reactors);

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

  // Not in our reactors map. Current user → echo already applied.
  if (userId === currentUserId) return prev;

  // Defensive fallback for any other user who isn't in our map — decrement
  // count anyway. With name-bearing aggregates we shouldn't hit this in
  // practice, but it keeps the count truthful if a realtime event arrives
  // before bootstrap or for a row we somehow missed.
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
 * Builds the initial reactions state from a server-side aggregate. The
 * aggregate now ships every reactor's name (denormalized on the join
 * row), so the in-memory map matches the server one-to-one.
 */
function buildInitialReactions(
  aggregates: Map<string, TeamMessageReaction[]>,
): ReactionsState {
  const root: ReactionsState = new Map();
  for (const [messageId, items] of aggregates) {
    if (items.length === 0) continue;
    const perMsg: ReactionsByEmoji = new Map();
    for (const r of items) {
      const reactors = new Map<string, string>();
      for (const rt of r.reactors) {
        reactors.set(rt.salesperson_id, rt.salesperson_name);
      }
      perMsg.set(r.emoji, { count: r.count, reacted: r.reacted, reactors });
    }
    root.set(messageId, perMsg);
  }
  return root;
}

/**
 * Merges newly-fetched aggregates into existing state without overwriting
 * messages we already track. Used by the "Load older posts" path — older
 * messages are strictly disjoint from what we have, so this is just a
 * per-key insert.
 */
function mergeReactions(
  prev: ReactionsState,
  aggregates: Map<string, TeamMessageReaction[]>,
): ReactionsState {
  if (aggregates.size === 0) return prev;
  const next = new Map(prev);
  for (const [messageId, items] of aggregates) {
    if (next.has(messageId)) continue;
    if (items.length === 0) continue;
    const perMsg: ReactionsByEmoji = new Map();
    for (const r of items) {
      const reactors = new Map<string, string>();
      for (const rt of r.reactors) {
        reactors.set(rt.salesperson_id, rt.salesperson_name);
      }
      perMsg.set(r.emoji, { count: r.count, reacted: r.reacted, reactors });
    }
    next.set(messageId, perMsg);
  }
  return next;
}

/**
 * Renders the reactions Map for a single message into the sorted array the
 * UI expects: count desc, emoji asc as the stable tiebreaker. Each
 * aggregate ships the full reactor list so the chip-detail popover can
 * read names without consulting the store again.
 */
function renderReactions(
  perMsg: ReactionsByEmoji | undefined,
): TeamMessageReaction[] {
  if (!perMsg || perMsg.size === 0) return [];
  const arr: TeamMessageReaction[] = [];
  for (const [emoji, entry] of perMsg) {
    if (entry.count <= 0) continue;
    const reactors: TeamMessageReactor[] = [];
    for (const [salesperson_id, salesperson_name] of entry.reactors) {
      reactors.push({ salesperson_id, salesperson_name });
    }
    arr.push({
      emoji,
      count: entry.count,
      reacted: entry.reacted,
      reactors,
    });
  }
  arr.sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
  return arr;
}

/**
 * Returns the emoji the current user has reacted with on `messageId`, or
 * null when they have no reaction there. Because of the one-reaction-per-
 * user rule, the answer is unique. Reads `reactors` rather than `reacted`
 * so it works correctly even for messages we've only seen via realtime
 * INSERTs (where reactors is the authoritative source).
 */
function getCurrentUserEmoji(
  state: ReactionsState,
  messageId: string,
  currentUserId: string,
): string | null {
  const perMsg = state.get(messageId);
  if (!perMsg) return null;
  for (const [emoji, entry] of perMsg) {
    if (entry.reactors.has(currentUserId)) return emoji;
  }
  return null;
}

/**
 * Applies "user transitions from `fromEmoji` to `toEmoji` on `messageId`".
 * Either may be null:
 *   from=null, to=X      -> brand-new reaction
 *   from=X,    to=null   -> toggle off
 *   from=X,    to=Y      -> switch in place
 *   from=to              -> no-op
 * Composes `applyReactionRemove` + `applyReactionAdd`, which each remain
 * idempotent against realtime echoes via the reactors-Map key check.
 *
 * `userName` is only needed for the add side. For pure removes (toEmoji
 * null) callers may pass an empty string; we never read it.
 */
function applyReactionTransition(
  state: ReactionsState,
  messageId: string,
  fromEmoji: string | null,
  toEmoji: string | null,
  userId: string,
  userName: string,
  currentUserId: string,
): ReactionsState {
  if (fromEmoji === toEmoji) return state;
  let next = state;
  if (fromEmoji) {
    next = applyReactionRemove(
      next,
      messageId,
      fromEmoji,
      userId,
      currentUserId,
    );
  }
  if (toEmoji) {
    next = applyReactionAdd(
      next,
      messageId,
      toEmoji,
      userId,
      userName,
      currentUserId,
    );
  }
  return next;
}

/**
 * Smooth-scrolls to a message DOM node by id and applies a short highlight
 * pulse via `data-juice-highlight`. The CSS for the pulse lives in
 * globals.css (or is handled inline below). No-op if the message isn't in
 * the loaded window — it may be older than the loaded pages.
 */
function scrollToMessage(messageId: string) {
  const el = document.getElementById(`juice-message-${messageId}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.setAttribute("data-juice-highlight", "true");
  window.setTimeout(() => el.removeAttribute("data-juice-highlight"), 1600);
}

/**
 * Merges a fresh-from-server window into the current state.messages
 * without dropping realtime-during-fetch arrivals OR pre-existing
 * older messages (e.g., from Load Older). Strategy:
 *   * Everything in `fresh` is authoritative for its time range.
 *   * State messages OLDER than fresh's oldest are preserved.
 *   * State messages NEWER than fresh's newest are preserved (these
 *     are realtime arrivals that fired between the fetch's snapshot
 *     and its response).
 *   * State messages WITHIN fresh's range but not in fresh are dropped
 *     (server says they're not part of the current window — e.g.,
 *     admin soft-deleted them).
 */
function mergeFreshFeed(
  state: TeamMessage[],
  fresh: TeamMessage[],
): TeamMessage[] {
  if (fresh.length === 0) return state;
  const freshIds = new Set(fresh.map((m) => m.id));
  const freshOldest = fresh[0].created_at;
  const freshNewest = fresh[fresh.length - 1].created_at;
  const older: TeamMessage[] = [];
  const newer: TeamMessage[] = [];
  for (const m of state) {
    if (freshIds.has(m.id)) continue;
    if (m.created_at < freshOldest) older.push(m);
    else if (m.created_at > freshNewest) newer.push(m);
  }
  return [...older, ...fresh, ...newer];
}

/**
 * Replaces reactions for every id present in `fresh` with the server-
 * authoritative aggregate. Ids NOT in fresh keep whatever the local
 * state already has — covers realtime-during-fetch arrivals whose
 * reactions came in via the realtime subscription. An empty
 * `reactions` array on a fresh message means "no reactions" and DROPS
 * any stale cached entry.
 */
function mergeFreshReactions(
  prev: ReactionsState,
  fresh: Array<TeamMessage & { reactions?: TeamMessageReaction[] }>,
): ReactionsState {
  const next = new Map(prev);
  for (const m of fresh) {
    if (m.reactions && m.reactions.length > 0) {
      const perMsg: ReactionsByEmoji = new Map();
      for (const r of m.reactions) {
        const reactors = new Map<string, string>();
        for (const rt of r.reactors) {
          reactors.set(rt.salesperson_id, rt.salesperson_name);
        }
        perMsg.set(r.emoji, {
          count: r.count,
          reacted: r.reacted,
          reactors,
        });
      }
      next.set(m.id, perMsg);
    } else {
      next.delete(m.id);
    }
  }
  return next;
}

/**
 * Renders the current state back into the cache-on-disk shape so the
 * visibilitychange handler can persist the latest snapshot, including
 * realtime additions that arrived after the bootstrap fetch's write.
 */
function snapshotForCache(
  messages: TeamMessage[],
  reactions: ReactionsState,
): CachedFeedMessage[] {
  return messages.map((m) => ({
    ...m,
    reactions: renderReactions(reactions.get(m.id)),
  }));
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
  const [searchOpen, setSearchOpen] = useState(false);
  // useScrollToTop is intentionally NOT called here. The feed's own scroll
  // effect lands the viewport on the most recent post once initial data
  // resolves — see FeedList. Calling useScrollToTop would race with that.

  // One gate: signed-out users go to /. Juice Box is otherwise open
  // to the whole team — the prior admin/test eligibility redirect was
  // removed when the feature graduated out of pilot.
  useEffect(() => {
    if (!loaded) return;
    if (!salesperson) {
      router.replace("/");
    }
  }, [loaded, salesperson, router]);

  if (!loaded || !salesperson) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  return (
    <>
      <main
        // This page has TWO pieces of fixed bottom chrome — the BottomNav
        // (~5rem + safe area) and the fixed Composer above it (~7rem) —
        // so the shared BOTTOM_NAV_SPACER isn't enough. We also reserve
        // an extra 6rem of room below the last message so the manual
        // window.scrollTo computation in FeedList can actually scroll the
        // latest message to a "lower-middle" landing position above the
        // composer. Without this headroom, scrollTop is clamped at
        // scrollTop_max and the latest message lands flush against the
        // composer regardless of how aggressive the target is.
        //   nav 5rem + composer 7rem + lower-middle comfort 6rem
        //   = 18rem + env(safe-area-inset-bottom)
        // pwa-safe-top is intentionally NOT applied here — the sticky
        // header below owns top-safe-area padding itself (via the inline
        // paddingTop on its container) so the translucent backdrop
        // covers the notch area both at scroll=0 and while stuck.
        className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-3 p-4 pb-[calc(18rem+env(safe-area-inset-bottom))]"
      >
        {/*
          Sticky header. -mx-4 px-4 lets the translucent backdrop bleed
          to main's horizontal edges while the centered title/subtitle
          stay in the padded column. z-20 sits above feed content
          (default z) and below the fixed bottom composer (z-30) and
          BottomNav (z-40), so modals at z-50 still cover the header.
          paddingTop folds env(safe-area-inset-top) into the header's
          own padding so the backdrop continues into the iOS status-bar
          area while the visible title text sits below the notch.
        */}
        <header
          className="sticky top-0 z-20 -mx-4 border-b border-border/60 bg-background/85 px-4 pb-2 text-center backdrop-blur supports-[backdrop-filter]:bg-background/70"
          style={{ paddingTop: "calc(0.5rem + env(safe-area-inset-top))" }}
        >
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Juice Box 🍊
          </h1>
          <div className="flex items-center justify-center gap-2">
            <p className="text-sm text-muted-foreground">Live team feed</p>
            <LiveBadge />
          </div>
          <div
            className="absolute right-3 top-1/2 inline-flex -translate-y-1/2 items-center gap-1"
            style={{ top: "calc(50% + env(safe-area-inset-top) / 2)" }}
          >
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              aria-label="Search Juice Box history"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <Search aria-hidden="true" className="size-5" />
            </button>
            {/* juice_box_only users have no Home tab — and therefore no
                Home-header settings gear — so the only path to /more
                (notifications opt-in, sign-in summary, log out) lives
                right here in the Juice Box header. Other roles still
                reach /more via the gear on /dashboard. */}
            {salesperson.role === "juice_box_only" && (
              <Link
                href="/more"
                aria-label="Account and notification settings"
                className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <Settings aria-hidden="true" className="size-5" />
              </Link>
            )}
          </div>
        </header>

        <JuiceBoxFeed
          currentUserId={salesperson.id}
          currentUserName={salesperson.first_name}
          isAdmin={salesperson.role === "admin"}
          searchOpen={searchOpen}
          onSearchOpenChange={setSearchOpen}
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
  currentUserName,
  isAdmin,
  searchOpen,
  onSearchOpenChange,
}: {
  currentUserId: string;
  /** The current user's first_name. Passed through to optimistic reaction
   *  applies so the local reactors map carries the right display name
   *  before the realtime echo arrives. */
  currentUserName: string;
  isAdmin: boolean;
  searchOpen: boolean;
  onSearchOpenChange: (next: boolean) => void;
}) {
  // Local cache read once at mount. Subsequent state initializers below
  // pull from this single shared object so we don't hit localStorage
  // three times (state + reactions + hasMore). Returns null on cache
  // miss / expired / wrong-version / disabled storage, in which case
  // every initializer falls back to the previous defaults.
  //
  // The seed is wrapped in useState so React holds onto it for the
  // mount's lifetime — useState's lazy initializer runs exactly once.
  const [cachedSeed] = useState<{ cached: ReturnType<typeof readCachedFeed> }>(
    () => ({ cached: readCachedFeed(currentUserId) }),
  );
  const cached = cachedSeed.cached;

  const [state, setState] = useState<FeedState>(() => {
    if (!cached) return { kind: "loading" };
    // Peel reactions off the cached wire shape so state.messages is a
    // pure TeamMessage[] — same layout as a fresh fetch produces.
    const messages: TeamMessage[] = cached.messages.map(
      ({ reactions: _u, ...rest }) => {
        void _u;
        return rest;
      },
    );
    return { kind: "ready", messages };
  });

  // Snapshot of message IDs present at initial load. Anything NOT in this set
  // was added after first render (optimistic post or realtime INSERT) and
  // therefore animates in. Seeded from the cached message ids so cards
  // already on screen don't animate as fresh on hydration; the bootstrap
  // fetch later folds fresh ids into this set too.
  const [initialIds, setInitialIds] = useState<Set<string> | null>(() =>
    cached ? new Set(cached.messages.map((m) => m.id)) : null,
  );

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
  // from the same GET that loaded the messages. Seeded from the cached
  // aggregates so the chip rows render instantly on hydration.
  const [reactions, setReactions] = useState<ReactionsState>(() => {
    if (!cached) return new Map();
    const aggregates = new Map<string, TeamMessageReaction[]>();
    for (const m of cached.messages) {
      if (m.reactions && m.reactions.length > 0) {
        aggregates.set(m.id, m.reactions);
      }
    }
    return buildInitialReactions(aggregates);
  });

  // True while the bootstrap fetch is in flight AFTER hydrating from
  // cache — drives the small "Refreshing…" pill above the feed. Lazy-
  // initialized true on cache hit so we never sync-setState inside the
  // bootstrap effect (react-hooks/set-state-in-effect).
  const [refreshing, setRefreshing] = useState<boolean>(() => cached !== null);

  // Flips to true the moment the bootstrap fetch settles (success OR
  // error). Distinct from cache hydration — cache rendering on its own
  // never sets this. It's the signal the final-landing effect in
  // FeedList waits on so the initial scroll only runs once the server
  // window is known. Without this separation a fast cache hydration
  // would land at the cached "latest" before fresh data revealed
  // newer messages, and the existing nearBottom-based catch-up was
  // racy (the browser's async scroll event hadn't yet updated
  // nearBottomRef when the merge effect re-fired).
  const [freshFeedLoaded, setFreshFeedLoaded] = useState(false);

  // Reply state: when set, ReplyModal opens overlaying the feed. Cleared on
  // successful post or Cancel. The sticky composer is intentionally NOT
  // hijacked into a "reply mode" anymore — that pattern was hard to notice
  // on mobile once the user scrolled away from the top of the feed.
  const [replyTo, setReplyTo] = useState<TeamMessage | null>(null);
  const clearReply = useCallback(() => setReplyTo(null), []);

  // Reaction detail popover state — keyed by (messageId, emoji). Tapping
  // an existing chip opens a small sheet listing the reactor names; null
  // when no chip detail is open.
  const [reactionDetails, setReactionDetails] = useState<
    { messageId: string; emoji: string } | null
  >(null);
  const closeReactionDetails = useCallback(
    () => setReactionDetails(null),
    [],
  );

  // Lightbox state — set when the user taps any inline image/GIF in the
  // feed. We carry the whole media list for the post + the index the
  // user tapped so multi-image posts can paginate left/right inside the
  // lightbox without re-opening. For single-image / GIF posts the list
  // is one entry and the chevrons stay hidden.
  const [lightbox, setLightbox] = useState<{
    items: TeamMessageMedia[];
    index: number;
  } | null>(null);
  const closeLightbox = useCallback(() => setLightbox(null), []);
  const openLightbox = useCallback(
    (items: TeamMessageMedia[], index: number) =>
      setLightbox({ items, index }),
    [],
  );

  // "Jump to latest" pill visibility. Mirrors FeedList's nearBottomRef
  // via onNearBottomChange — the pill renders only when the user is
  // NOT within NEAR_BOTTOM_PX of the document end. Default false so
  // the pill doesn't flash on mount; the scroll listener's seed flips
  // it correctly within a microtask.
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const onNearBottomChange = useCallback((nearBottom: boolean) => {
    setShowJumpToLatest(!nearBottom);
  }, []);

  // Pagination state. `hasMore` defaults to true so the "Load older" button
  // is available until the first server response tells us otherwise (or
  // the page returns fewer than the requested limit). Seeded from the
  // cached snapshot so the button's state is correct on hydration too.
  // `loadingMore` disables the button while the fetch is in flight.
  const [hasMore, setHasMore] = useState<boolean>(() => cached?.hasMore ?? true);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  useEffect(() => {
    loadingMoreRef.current = loadingMore;
  }, [loadingMore]);

  // Scroll-anchor restoration for "Load older". When the user prepends
  // older posts, we want their CURRENT top message to stay at the same
  // viewport y-coordinate so the page doesn't yank under them. The ref
  // captures `{ anchorId, anchorTopBefore }` before the prepend; a
  // useLayoutEffect compares the post-prepend position and corrects.
  const restoreAnchorRef = useRef<{
    anchorId: string;
    anchorTopBefore: number;
  } | null>(null);
  useLayoutEffect(() => {
    const pending = restoreAnchorRef.current;
    if (!pending) return;
    restoreAnchorRef.current = null;
    const el = document.getElementById(`juice-message-${pending.anchorId}`);
    if (!el) return;
    const anchorTopAfter = el.getBoundingClientRect().top;
    const delta = anchorTopAfter - pending.anchorTopBefore;
    if (delta !== 0) window.scrollBy(0, delta);
  });

  // Initial fetch — pulls the most-recent FEED_PAGE_SIZE messages and
  // refreshes whatever the cache hydrated. Older pages are paged in on
  // demand via `handleLoadOlder` below.
  //
  // CACHE-AWARE FLOW
  //   * If `cached` exists, state.messages already rendered before this
  //     effect ran. The fetch is a background refresh; on resolve we
  //     merge fresh into state (preserving realtime arrivals and Load
  //     Older history) and clear the `refreshing` indicator.
  //   * If `cached` is null, this is a cold start — state.kind is
  //     "loading" and we replace it with the fetch result.
  //   * Network errors after a successful cache hydration are SILENT:
  //     the user already has a feed, no need to surface "Couldn't load."
  //     Cold-start errors go to state.kind === "error" as before.
  //
  // Every successful response is written back to the cache so the next
  // open is also instant.
  useEffect(() => {
    let cancelled = false;
    apiFetch(`/api/team-messages?limit=${FEED_PAGE_SIZE}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as {
          messages?: CachedFeedMessage[];
          hasMore?: boolean;
          error?: string;
        } | null;
        if (cancelled) return;
        if (!res.ok) {
          if (!cached) {
            setState({
              kind: "error",
              error: body?.error ?? `Couldn't load feed (${res.status}).`,
            });
          }
          // Cached path → swallow; the visible feed stays usable.
          return;
        }
        const hydrated = body?.messages ?? [];
        const freshHasMore = body?.hasMore === true;
        // Peel reactions off the wire payload so message state stays a
        // clean TeamMessage[] (matching the realtime row shape).
        const freshMessages: TeamMessage[] = hydrated.map((m) => {
          const { reactions: _u, ...rest } = m;
          void _u;
          return rest;
        });

        // Persist this snapshot for the next open. Trimmed inside
        // writeCachedFeed if larger than FEED_PAGE_SIZE.
        writeCachedFeed(currentUserId, hydrated, freshHasMore);

        // Merge into existing state (no-op when state is "loading"; a
        // real merge when we hydrated from cache + maybe accumulated
        // realtime arrivals during the fetch).
        setState((prev) => {
          if (prev.kind !== "ready") {
            return { kind: "ready", messages: freshMessages };
          }
          return {
            kind: "ready",
            messages: mergeFreshFeed(prev.messages, freshMessages),
          };
        });
        // Fold fresh ids into initialIds (don't replace) so realtime
        // arrivals after this fetch keep their fresh-animation behavior.
        setInitialIds((prev) => {
          const next = new Set(prev ?? []);
          for (const m of freshMessages) next.add(m.id);
          return next;
        });
        setReactions((prev) => mergeFreshReactions(prev, hydrated));
        setHasMore(freshHasMore);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (cached) return; // user already has feed; swallow background error
        setState({
          kind: "error",
          error:
            err instanceof Error ? err.message : "Couldn't load feed.",
        });
      })
      .finally(() => {
        if (cancelled) return;
        setRefreshing(false);
        // Flip the "bootstrap settled" signal regardless of success
        // or error. The final-landing effect uses this to decide
        // when to perform the one-shot initial scroll; if we left it
        // false on error the user would stay at scroll=0 of a cached
        // feed forever after a transient bootstrap failure.
        setFreshFeedLoaded(true);
      });
    return () => {
      cancelled = true;
    };
    // `cached` is stable across renders (useState lazy initializer
    // runs once on mount), so including it doesn't widen the effect's
    // re-run cadence — it just satisfies react-hooks/exhaustive-deps.
  }, [currentUserId, cached]);

  // Mirror the latest state into refs so the visibilitychange handler
  // can read them without re-binding (the listener is bound once for
  // the lifetime of the component).
  const cacheSnapshotRef = useRef<{
    messages: TeamMessage[];
    reactions: ReactionsState;
    hasMore: boolean;
  }>({ messages: [], reactions: new Map(), hasMore: true });
  useEffect(() => {
    cacheSnapshotRef.current = {
      messages: state.kind === "ready" ? state.messages : [],
      reactions,
      hasMore,
    };
  }, [state, reactions, hasMore]);

  // Persist the latest snapshot when the user backgrounds the tab so a
  // subsequent open paints from a near-current cache including realtime
  // additions that arrived after the bootstrap fetch wrote its
  // snapshot. visibilitychange → hidden is the canonical "I'm done for
  // now" signal across iOS Safari, PWA standalone, and desktop.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      const snap = cacheSnapshotRef.current;
      if (snap.messages.length === 0) return;
      writeCachedFeed(
        currentUserId,
        snapshotForCache(snap.messages, snap.reactions),
        snap.hasMore,
      );
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () =>
      document.removeEventListener("visibilitychange", onVisibility);
  }, [currentUserId]);

  /**
   * Prepend an older page of messages. Triggered by the "Load older posts"
   * button at the top of the feed. Captures the current top message's
   * y-position BEFORE the state update so the layout effect can correct
   * the scroll offset after React commits — without this, prepending
   * would visually slam the viewport to the top of the page.
   */
  const handleLoadOlder = useCallback(async () => {
    const snapshot = cacheSnapshotRef.current;
    if (loadingMoreRef.current || !snapshot.hasMore) return;
    const topMessage = snapshot.messages[0];
    if (!topMessage) return;
    // Synchronous mutex for callers that invoke handleLoadOlder in tight
    // async loops. The loadingMore state/effect path is still used for UI,
    // but this ref lock prevents same-tick re-entry.
    loadingMoreRef.current = true;

    // Snapshot anchor BEFORE setState so the layout effect has a stable
    // pre-prepend y-coordinate to restore against.
    const anchorEl = document.getElementById(
      `juice-message-${topMessage.id}`,
    );
    if (anchorEl) {
      restoreAnchorRef.current = {
        anchorId: topMessage.id,
        anchorTopBefore: anchorEl.getBoundingClientRect().top,
      };
    }

    setLoadingMore(true);
    try {
      const beforeParam = encodeURIComponent(topMessage.created_at);
      const res = await apiFetch(
        `/api/team-messages?before=${beforeParam}&limit=${FEED_PAGE_SIZE}`,
      );
      const body = (await res.json().catch(() => null)) as {
        messages?: (TeamMessage & { reactions?: TeamMessageReaction[] })[];
        hasMore?: boolean;
      } | null;
      if (!res.ok || !body?.messages) {
        // Drop the anchor snapshot so the layout effect doesn't try to
        // correct against a render that never happened.
        restoreAnchorRef.current = null;
        return;
      }

      const aggregates = new Map<string, TeamMessageReaction[]>();
      const olderRaw: TeamMessage[] = body.messages.map((m) => {
        if (m.reactions && m.reactions.length > 0) {
          aggregates.set(m.id, m.reactions);
        }
        const { reactions: _unused, ...rest } = m;
        void _unused;
        return rest;
      });

      const seen = new Set(snapshot.messages.map((m) => m.id));
      const older = olderRaw.filter((m) => !seen.has(m.id));

      if (olderRaw.length === 0) {
        setHasMore(false);
        restoreAnchorRef.current = null;
        return;
      }

      if (older.length === 0) {
        restoreAnchorRef.current = null;
        return;
      }

      // Older messages are strictly disjoint from current — merge their
      // reactions into the existing map without overwriting newer ones.
      setReactions((prev) => mergeReactions(prev, aggregates));
      setState((prev) =>
        prev.kind === "ready"
          ? { kind: "ready", messages: [...older, ...prev.messages] }
          : prev,
      );
      // Mark every older id as part of the "initial" set so newly-prepended
      // posts don't run the fresh-message slide-in animation.
      setInitialIds((prev) => {
        if (!prev) return prev;
        const next = new Set(prev);
        for (const m of older) next.add(m.id);
        return next;
      });
      setHasMore(body.hasMore === true);
      // Keep the in-memory snapshot fresh synchronously so repeated
      // await handleLoadOlder() calls in a single async loop advance
      // their cursor even before useEffect mirrors state back to refs.
      cacheSnapshotRef.current = {
        ...cacheSnapshotRef.current,
        messages: [...older, ...snapshot.messages],
        hasMore: body.hasMore === true,
      };
    } catch {
      // Network error — leave state untouched, drop the anchor.
      restoreAnchorRef.current = null;
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, []);

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
  // UPDATE and DELETE payloads carry the full old row thanks to REPLICA
  // IDENTITY FULL (see juice_box_pass4_conversations.sql), so the client
  // can apply the (remove old emoji, add new emoji) delta on a switch
  // without a refetch.
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
          if (
            !row?.message_id ||
            !row?.emoji ||
            !row?.salesperson_id ||
            !row?.salesperson_name
          ) {
            return;
          }
          setReactions((prev) =>
            applyReactionAdd(
              prev,
              row.message_id,
              row.emoji,
              row.salesperson_id,
              row.salesperson_name,
              currentUserId,
            ),
          );
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: TEAM_MESSAGE_REACTIONS_TABLE,
        },
        (payload) => {
          // Switching reactions is the only UPDATE that fires today: the
          // row's emoji column changed. Apply the delta as (remove old,
          // add new). Both halves are individually idempotent against the
          // user's own optimistic update.
          const oldRow = payload.old as Partial<TeamMessageReactionRow>;
          const newRow = payload.new as TeamMessageReactionRow;
          if (
            !newRow?.message_id ||
            !newRow?.emoji ||
            !newRow?.salesperson_id ||
            !newRow?.salesperson_name ||
            !oldRow?.emoji
          ) {
            return;
          }
          setReactions((prev) =>
            applyReactionTransition(
              prev,
              newRow.message_id,
              oldRow.emoji ?? null,
              newRow.emoji,
              newRow.salesperson_id,
              newRow.salesperson_name,
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

  // Mirror `reactions` into a ref so toggleReaction can snapshot the
  // user's current emoji synchronously, OUTSIDE the setState updater.
  // Reading state inside the updater and assigning to an outer variable
  // would be impure (React strict-mode dev re-invokes updaters to catch
  // exactly that pattern) and would corrupt the snapshot used by revert.
  const reactionsRef = useRef<ReactionsState>(reactions);
  useEffect(() => {
    reactionsRef.current = reactions;
  }, [reactions]);

  /**
   * Tap an emoji to set/switch/clear the user's reaction on a message.
   * Mirrors the server's three branches:
   *   no prior          -> add `emoji`
   *   prior == emoji    -> clear (toggle off)
   *   prior != emoji    -> switch from prior to `emoji`
   *
   * Optimistic apply runs first; the realtime echo of a successful change
   * is idempotent via the reactors-Set membership check. On network
   * failure we revert by transitioning back from the optimistic target to
   * the snapshotted prior, guarded by a check that the optimistic state
   * is still the current state — that way a rapid follow-up toggle isn't
   * clobbered by a delayed revert.
   */
  const toggleReaction = useCallback(
    (messageId: string, emoji: ReactionEmoji) => {
      // Pure read of the user's emoji BEFORE applying the optimistic
      // transition. The ref reflects the latest committed render.
      const prevEmoji = getCurrentUserEmoji(
        reactionsRef.current,
        messageId,
        currentUserId,
      );
      const optimisticEmoji = prevEmoji === emoji ? null : emoji;

      setReactions((state) =>
        applyReactionTransition(
          state,
          messageId,
          prevEmoji,
          optimisticEmoji,
          currentUserId,
          currentUserName,
          currentUserId,
        ),
      );

      const revert = () =>
        setReactions((state) => {
          // Only revert if the optimistic emoji is still the current emoji.
          // If the user fired another toggle in the meantime, leave their
          // newer choice alone — its own success/failure path will reconcile.
          const current = getCurrentUserEmoji(
            state,
            messageId,
            currentUserId,
          );
          if (current !== optimisticEmoji) return state;
          return applyReactionTransition(
            state,
            messageId,
            optimisticEmoji,
            prevEmoji,
            currentUserId,
            currentUserName,
            currentUserId,
          );
        });

      void apiFetch(`/api/team-messages/${messageId}/reactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoji }),
      })
        .then((res) => {
          if (!res.ok) revert();
        })
        .catch(() => revert());
    },
    [currentUserId, currentUserName],
  );

  const handleReply = useCallback((message: TeamMessage) => {
    setReplyTo(message);
  }, []);

  /**
   * Tap handler for the floating "Jump to latest" pill. Uses the same
   * composer-aware scroll math the final-landing + ongoing-scroll
   * effects use, so the latest message lands above the composer with
   * the standard comfort gap regardless of compact / expanded composer
   * height. Also fires the debounced mark-read since landing at latest
   * implies the user has seen everything.
   */
  const handleJumpToLatest = useCallback(() => {
    if (state.kind !== "ready" || state.messages.length === 0) return;
    const latestId = state.messages[state.messages.length - 1].id;
    const messageEl = document.getElementById(`juice-message-${latestId}`);
    const composer = document.getElementById("juice-composer-bar");
    if (!messageEl || !composer) return;
    const messageBottom = messageEl.getBoundingClientRect().bottom;
    const composerTop = composer.getBoundingClientRect().top;
    const target = Math.max(
      0,
      window.scrollY + messageBottom - composerTop + AUTO_SCROLL_COMFORT_PX,
    );
    window.scrollTo({ top: target, behavior: "smooth" });
    markAllReadDebounced();
  }, [state, markAllReadDebounced]);

  // For the reaction-detail sheet: pluck the live aggregate for the chip
  // the user tapped so the popover renders fresh reactor names even when
  // the underlying reaction state changes mid-view (e.g., someone reacts
  // while the sheet is open).
  const reactionDetailAggregate = useMemo(() => {
    if (!reactionDetails) return null;
    const perMsg = reactions.get(reactionDetails.messageId);
    const entry = perMsg?.get(reactionDetails.emoji);
    if (!entry || entry.count === 0) return null;
    const reactors: TeamMessageReactor[] = [];
    for (const [salesperson_id, salesperson_name] of entry.reactors) {
      reactors.push({ salesperson_id, salesperson_name });
    }
    return {
      emoji: reactionDetails.emoji,
      count: entry.count,
      reactors,
    };
  }, [reactionDetails, reactions]);

  const handleSelectSearchResult = useCallback(
    async (messageId: string) => {
      onSearchOpenChange(false);

      const elementId = `juice-message-${messageId}`;
      const hasTargetInDom = () =>
        typeof document !== "undefined" &&
        document.getElementById(elementId) !== null;

      let attempts = 0;
      while (!hasTargetInDom() && cacheSnapshotRef.current.hasMore && attempts < 8) {
        await handleLoadOlder();
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        });
        attempts += 1;
      }

      scrollToMessage(messageId);
    },
    [handleLoadOlder, onSearchOpenChange],
  );

  // The sheet is rendered only when BOTH `reactionDetails` and a live
  // aggregate are present, so if the chip's last reactor un-reacts while
  // the sheet is open it naturally disappears without a setState-in-effect
  // ping-pong. The stale `reactionDetails` lingers in state until the
  // user opens another chip or dismisses; harmless and quiet.

  return (
    <>
      <FeedList
        state={state}
        currentUserId={currentUserId}
        isAdmin={isAdmin}
        onDeleted={removeMessage}
        onReply={handleReply}
        reactions={reactions}
        onToggleReaction={toggleReaction}
        onShowReactionDetails={(messageId, emoji) =>
          setReactionDetails({ messageId, emoji })
        }
        onOpenMedia={openLightbox}
        initialIds={initialIds}
        forceScrollRef={forceScrollRef}
        lastReadAt={lastReadAt}
        unreadLoaded={unreadLoaded}
        onNearBottom={markAllReadDebounced}
        onNearBottomChange={onNearBottomChange}
        onLoadOlder={handleLoadOlder}
        hasMore={hasMore}
        loadingMore={loadingMore}
        refreshing={refreshing}
        freshFeedLoaded={freshFeedLoaded}
      />
      {/*
        Composer moved to a FIXED position above the BottomNav for messaging-
        app feel. z-30 sits between feed content (default) and the nav
        (z-40); the ReplyModal at z-50 still covers both. Bottom offset
        clears the nav (~5rem) plus its iOS safe-area inset. Border-top +
        backdrop blur give the visual separation from feed scroll content.

        The stable `id` lets FeedList's auto-scroll measure the composer's
        actual top edge via getBoundingClientRect — that's how the
        latest-message landing math works without prop-drilling a ref.
      */}
      <div
        id="juice-composer-bar"
        className="fixed inset-x-0 z-30 border-t border-border bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70"
        style={{ bottom: "calc(5rem + env(safe-area-inset-bottom))" }}
      >
        {/* Floating "Jump to latest" pill. Positioned `absolute` above
            this fixed composer wrapper so its offset automatically
            adapts to the composer's current height (compact vs
            expanded). pointer-events-none on the centering wrapper
            means the empty area on either side of the pill doesn't
            block feed taps; only the pill itself is interactive. */}
        {showJumpToLatest && state.kind === "ready" && state.messages.length > 0 && (
          <div className="pointer-events-none absolute inset-x-0 -top-12 flex justify-center">
            <button
              type="button"
              onClick={handleJumpToLatest}
              className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-lg shadow-primary/30 ring-1 ring-primary/40 transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 animate-in fade-in-0 slide-in-from-bottom-1 duration-200"
            >
              <ArrowDown aria-hidden="true" className="size-3.5" />
              Jump to latest
            </button>
          </div>
        )}
        <div className="mx-auto w-full max-w-2xl px-3 py-2">
          <Composer onPosted={handleSelfPosted} />
        </div>
      </div>
      {replyTo && (
        <ReplyModal
          replyTo={replyTo}
          onPosted={handleSelfPosted}
          onClose={clearReply}
        />
      )}
      {reactionDetails && reactionDetailAggregate && (
        <ReactionDetailSheet
          emoji={reactionDetailAggregate.emoji}
          count={reactionDetailAggregate.count}
          reactors={reactionDetailAggregate.reactors}
          currentUserId={currentUserId}
          onClose={closeReactionDetails}
        />
      )}
      {lightbox && (
        <MediaLightbox
          items={lightbox.items}
          index={lightbox.index}
          onIndexChange={(next) =>
            setLightbox((prev) => (prev ? { ...prev, index: next } : prev))
          }
          onClose={closeLightbox}
        />
      )}
      <JuiceBoxSearchSheet
        open={searchOpen}
        onOpenChange={onSearchOpenChange}
        onSelectMessage={handleSelectSearchResult}
      />
    </>
  );
}

function JuiceBoxSearchSheet({
  open,
  onOpenChange,
  onSelectMessage,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onSelectMessage: (messageId: string) => Promise<void> | void;
}) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [peopleOnly, setPeopleOnly] = useState(false);
  const [recentOnly, setRecentOnly] = useState(false);
  const [mediaOnly, setMediaOnly] = useState(false);
  const [mentionsMeOnly, setMentionsMeOnly] = useState(false);
  const [results, setResults] = useState<TeamMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebouncedQuery("");
      setPeopleOnly(false);
      setRecentOnly(false);
      setMediaOnly(false);
      setMentionsMeOnly(false);
      setResults([]);
      setError(null);
      setLoading(false);
      setLoadingMore(false);
      setHasMore(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 220);
    return () => window.clearTimeout(id);
  }, [open, query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  const runSearch = useCallback(
    async ({ append, before }: { append: boolean; before?: string }) => {
      const requestId = ++requestIdRef.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({ limit: "30" });
        if (debouncedQuery.length > 0) params.set("q", debouncedQuery);
        if (peopleOnly) params.set("peopleOnly", "true");
        if (recentOnly) params.set("recentOnly", "true");
        if (mediaOnly) params.set("hasMedia", "true");
        if (mentionsMeOnly) params.set("mentionsMe", "true");
        if (before) params.set("before", before);

        const res = await apiFetch(`/api/team-messages/search?${params.toString()}`);
        const body = (await res.json().catch(() => null)) as {
          messages?: TeamMessage[];
          hasMore?: boolean;
          error?: string;
        } | null;

        if (requestId !== requestIdRef.current) return;
        if (!res.ok) {
          throw new Error(body?.error ?? `Search failed (${res.status}).`);
        }

        const fetched = body?.messages ?? [];
        setResults((prev) => {
          if (!append) return fetched;
          const seen = new Set(prev.map((m) => m.id));
          const unique = fetched.filter((m) => !seen.has(m.id));
          return [...prev, ...unique];
        });
        setHasMore(body?.hasMore === true);
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof Error ? err.message : "Couldn't search Juice Box.");
        if (!append) {
          setResults([]);
          setHasMore(false);
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [debouncedQuery, mediaOnly, mentionsMeOnly, peopleOnly, recentOnly],
  );

  useEffect(() => {
    if (!open) return;
    void runSearch({ append: false });
  }, [open, runSearch]);

  const handleLoadMore = useCallback(() => {
    if (loading || loadingMore || !hasMore || results.length === 0) return;
    const last = results[results.length - 1];
    if (!last) return;
    void runSearch({ append: true, before: last.created_at });
  }, [hasMore, loading, loadingMore, results, runSearch]);

  const searchResults = useMemo(() => {
    const mapped: Array<{ message: TeamMessage; hasMedia: boolean }> = [];
    for (const message of results) {
      const hasMedia = teamMessageMediaList(message).length > 0;
      mapped.push({ message, hasMedia });
    }
    return mapped;
  }, [results]);

  const grouped = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    const buckets = new Map<string, JuiceBoxSearchResult[]>();
    for (const result of searchResults) {
      const key = formatter.format(new Date(result.message.created_at));
      const arr = buckets.get(key);
      if (arr) arr.push(result);
      else buckets.set(key, [result]);
    }
    return [...buckets.entries()];
  }, [searchResults]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Search Juice Box"
      className="fixed inset-0 z-50 flex flex-col bg-background"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          aria-label="Back"
          className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <ChevronLeft aria-hidden="true" className="size-5" />
        </button>
        <p className="text-sm font-semibold">Search Juice Box</p>
      </div>

      <div className="border-b border-border/60 px-3 py-3">
        <label className="relative block">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search messages, names, keywords..."
            className="h-10 w-full rounded-lg border border-border bg-background pl-9 pr-9 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-primary"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-1 top-1 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          )}
        </label>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setPeopleOnly((v) => !v)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
              peopleOnly
                ? "border-primary/50 bg-primary/15 text-primary"
                : "border-border/70 text-muted-foreground hover:bg-muted",
            )}
          >
            People
          </button>
          <button
            type="button"
            onClick={() => setRecentOnly((v) => !v)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
              recentOnly
                ? "border-primary/50 bg-primary/15 text-primary"
                : "border-border/70 text-muted-foreground hover:bg-muted",
            )}
          >
            Date 30d
          </button>
          <button
            type="button"
            onClick={() => setMediaOnly((v) => !v)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
              mediaOnly
                ? "border-primary/50 bg-primary/15 text-primary"
                : "border-border/70 text-muted-foreground hover:bg-muted",
            )}
          >
            Has media
          </button>
          <button
            type="button"
            onClick={() => setMentionsMeOnly((v) => !v)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
              mentionsMeOnly
                ? "border-primary/50 bg-primary/15 text-primary"
                : "border-border/70 text-muted-foreground hover:bg-muted",
            )}
          >
            Mentions me
          </button>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Full history search across Juice Box messages.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {error ? (
          <div className="rounded-lg border border-destructive/35 bg-destructive/10 px-3 py-4 text-sm text-destructive">
            {error}
          </div>
        ) : loading ? (
          <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-4 text-sm text-muted-foreground">
            Searching Juice Box history...
          </div>
        ) : grouped.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 px-3 py-4 text-sm text-muted-foreground">
            No matches yet. Try a name, keyword, or turn off one of the filters.
          </div>
        ) : (
          <div className="space-y-4">
            {grouped.map(([label, items]) => (
              <section key={label}>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {label}
                </p>
                <div className="space-y-2">
                  {items.map(({ message, hasMedia }) => {
                    const hasText = message.message.trim().length > 0;
                    const preview = hasText
                      ? message.message
                      : hasMedia
                        ? "Media post"
                        : "Message";
                    return (
                      <button
                        key={message.id}
                        type="button"
                        onClick={() => {
                          void onSelectMessage(message.id);
                        }}
                        className="w-full rounded-lg border border-border/70 bg-card px-3 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      >
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-semibold text-foreground">
                            {message.salesperson_name}
                          </span>
                          <span className="text-muted-foreground">
                            {formatDistanceToNow(new Date(message.created_at), {
                              addSuffix: true,
                            })}
                          </span>
                          {hasMedia && (
                            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                              Media
                            </span>
                          )}
                        </div>
                        <p className="mt-1 line-clamp-2 text-sm text-foreground/90">
                          {preview}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
        {!loading && !error && grouped.length > 0 && (
          <div className="pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={handleLoadMore}
              disabled={loadingMore || !hasMore}
              className="w-full"
            >
              {loadingMore ? (
                <>
                  <Loader2 aria-hidden="true" className="mr-2 size-4 animate-spin" />
                  Loading more
                </>
              ) : hasMore ? (
                "Load older results"
              ) : (
                "No more results"
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One pending image in the composer. We hold the raw File + an objectURL
 * preview until the user hits Post (which triggers a per-file signed
 * upload). `width`/`height` are populated asynchronously once the
 * preview Image() loads; both are nullable until then.
 *
 * `id` is a stable per-attachment key (random UUID) so React lists +
 * the X-to-remove button track each pending image across re-orderings.
 */
type PendingImage = {
  id: string;
  file: File;
  previewUrl: string;
  width: number | null;
  height: number | null;
};

/**
 * Composer state for a pending attachment. Multi-image flow stores an
 * array of PendingImage; the GIF flow stores a single GifResult since
 * GIFs are mutually exclusive with images (server-side too — the POST
 * route refuses a payload that mixes the two).
 */
type PendingMedia =
  | { kind: "images"; items: PendingImage[] }
  | { kind: "gif"; gif: GifResult };

// ---------------------------------------------------------------------------
// GIF picker module-level cache
// ---------------------------------------------------------------------------
// Persists across mount/unmount of GifPickerSheet so closing and reopening
// the sheet — or retyping a recently-seen query — is instant. Keys are
// normalized (`q.trim().toLowerCase()`); "" is the trending bucket.
// Bounded so a session that types many queries doesn't hold unbounded
// memory; LRU-ish via Map iteration order on writes.

const GIF_CACHE_MAX = 16;
const gifCache = new Map<string, GifResult[]>();

function gifCacheKey(query: string): string {
  return query.trim().toLowerCase();
}

function readGifCache(key: string): GifResult[] | null {
  return gifCache.get(key) ?? null;
}

function writeGifCache(key: string, results: GifResult[]): void {
  // Re-inserting moves the entry to the most-recent end; evicting from
  // the start is then a true LRU eviction.
  gifCache.delete(key);
  gifCache.set(key, results);
  while (gifCache.size > GIF_CACHE_MAX) {
    const oldest = gifCache.keys().next().value;
    if (oldest === undefined) break;
    gifCache.delete(oldest);
  }
}

function Composer({ onPosted }: { onPosted: (message: TeamMessage) => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [media, setMedia] = useState<PendingMedia | null>(null);
  const [gifPickerOpen, setGifPickerOpen] = useState(false);
  // True while the user is actively composing — drives the compact /
  // expanded layout swap. Tap or focus the textarea → expanded.
  // Textarea blur → 150 ms grace period (see handleBlur) → collapse,
  // unless there's text, media, an active modal, or an error.
  const [focused, setFocused] = useState(false);

  // Hidden <input> for the image picker. On iOS this surfaces the
  // native sheet with Photo Library / Take Photo / Choose Files. No
  // `capture` attribute so the camera isn't forced.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Pending blur timeout. We DON'T flip `focused` to false the instant
  // the textarea loses focus — tapping the Image or GIF button briefly
  // shifts focus off the textarea, and we don't want a fleeting
  // collapse-then-expand flash when a media attachment lands. 150 ms
  // is long enough for the new control's click to land + (potentially)
  // attach media, short enough that a real "click outside" feels prompt.
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    };
  }, []);

  const handleTextareaFocus = () => {
    if (blurTimerRef.current) {
      clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
    setFocused(true);
  };
  const handleTextareaBlur = () => {
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    blurTimerRef.current = setTimeout(() => {
      blurTimerRef.current = null;
      setFocused(false);
    }, 150);
  };

  const trimmed = text.trim();
  // Either text or media is enough to submit (server enforces the same
  // rule); both is fine.
  const canSubmit = (trimmed.length > 0 || media !== null) && !sending;

  // Derived "expand" decision. Composer is expanded whenever there's a
  // reason for the user to see the full UI (typing, attached media,
  // posting, error, GIF picker open) — otherwise it sits compact.
  // Pure derivation = no extra state to keep in sync, and the
  // transitions are determined entirely by the underlying signals
  // they react to.
  const isExpanded =
    focused ||
    text.length > 0 ||
    media !== null ||
    sending ||
    error !== null ||
    gifPickerOpen;

  // Revoke any objectURL when the attached images change or the
  // composer unmounts, so we don't leak blob handles between attaches.
  // For multi-image posts this revokes every preview in the batch on
  // teardown; per-image revocation also happens on remove (see
  // removeImage / clearMedia below) so individual previews don't leak
  // between picks.
  useEffect(() => {
    return () => {
      if (media?.kind === "images") {
        for (const img of media.items) URL.revokeObjectURL(img.previewUrl);
      }
    };
  }, [media]);

  // Prefetch trending GIFs once per Composer mount so opening the GIF
  // picker for the first time feels instant. Skipped if we've already
  // warmed the cache earlier this session.
  useEffect(() => {
    if (readGifCache("") !== null) return;
    let cancelled = false;
    apiFetch("/api/juice-box/gifs?limit=24")
      .then(async (res) => {
        if (!res.ok || cancelled) return;
        const body = (await res.json().catch(() => null)) as {
          results?: GifResult[];
        } | null;
        if (!cancelled && body && Array.isArray(body.results)) {
          writeGifCache("", body.results);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Local-only validation + preview generation for a batch of image
   * picks. Each file in `files` runs the same MIME / size checks the
   * single-image flow used; the first failure short-circuits and
   * reports its problem (so the user gets a precise error rather than
   * silent omission). Successful picks are APPENDED to the current
   * pending list when the existing media is also images — otherwise
   * (no media, or a GIF was attached) the new list replaces whatever
   * was there.
   *
   * Caps the cumulative count at MAX_IMAGES_PER_POST (same limit the
   * server enforces) so the user can't queue more than the route will
   * accept. Reads intrinsic dims off an Image() per-file so the
   * inserted record carries width/height; the async load updates
   * media state by matching `previewUrl` so reorders or removes can't
   * apply stale dims to the wrong entry.
   */
  const attachImageFiles = (files: File[]) => {
    if (files.length === 0) return;

    for (const file of files) {
      if (!(MEDIA_ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
        setError("Pick JPG, PNG, WebP, or GIF images.");
        return;
      }
      if (file.size > MEDIA_MAX_FILE_SIZE_BYTES) {
        const mb = Math.round(MEDIA_MAX_FILE_SIZE_BYTES / (1024 * 1024));
        setError(`Each image must be under ${mb} MB.`);
        return;
      }
    }

    const newImages: PendingImage[] = files.map((file) => ({
      // crypto.randomUUID is available in every browser we support
      // (Chrome 92+, Safari 15.4+, Firefox 95+). The id only needs
      // to be unique within this composer mount.
      id: crypto.randomUUID(),
      file,
      previewUrl: URL.createObjectURL(file),
      width: null,
      height: null,
    }));

    setMedia((prev) => {
      const existing = prev?.kind === "images" ? prev.items : [];
      const combined = [...existing, ...newImages];
      if (combined.length > MAX_IMAGES_PER_POST) {
        // Revoke the previews we won't keep so the blob handles
        // don't dangle. We trim from the END of the new picks (the
        // earliest existing images are preserved) since that matches
        // a user mental model of "I added too many, drop the latest."
        const overflow = combined.length - MAX_IMAGES_PER_POST;
        const dropped = combined.slice(MAX_IMAGES_PER_POST);
        for (const img of dropped) URL.revokeObjectURL(img.previewUrl);
        setError(
          `You can attach up to ${MAX_IMAGES_PER_POST} images per post. Dropped the last ${overflow}.`,
        );
        return { kind: "images", items: combined.slice(0, MAX_IMAGES_PER_POST) };
      }
      // Replacing a GIF? revoke nothing — GIFs don't hold blob handles.
      return { kind: "images", items: combined };
    });
    setError(null);

    // Resolve intrinsic dimensions for each new pick. Matched back to
    // the right pending entry by previewUrl so async loads in any
    // order land on the correct record (or are dropped if the user
    // removed that entry before its onload fired).
    for (const img of newImages) {
      const probe = new window.Image();
      probe.onload = () => {
        setMedia((cur) => {
          if (cur?.kind !== "images") return cur;
          let changed = false;
          const next = cur.items.map((it) => {
            if (it.previewUrl !== img.previewUrl) return it;
            changed = true;
            return {
              ...it,
              width: probe.naturalWidth,
              height: probe.naturalHeight,
            };
          });
          return changed ? { kind: "images", items: next } : cur;
        });
      };
      probe.src = img.previewUrl;
    }
  };

  const onImageInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    // Reset so picking the same files twice re-fires onChange.
    e.target.value = "";
    if (files.length > 0) attachImageFiles(files);
  };

  /** Remove a single pending image by id; clears media entirely when the
   *  last image is removed so the composer collapses back to text-only. */
  const removeImage = (id: string) => {
    setMedia((prev) => {
      if (prev?.kind !== "images") return prev;
      const dropped = prev.items.find((it) => it.id === id);
      if (dropped) URL.revokeObjectURL(dropped.previewUrl);
      const remaining = prev.items.filter((it) => it.id !== id);
      if (remaining.length === 0) return null;
      return { kind: "images", items: remaining };
    });
  };

  const clearMedia = () => {
    setMedia((prev) => {
      if (prev?.kind === "images") {
        for (const img of prev.items) URL.revokeObjectURL(img.previewUrl);
      }
      return null;
    });
  };

  const onGifSelected = (gif: GifResult) => {
    setMedia((prev) => {
      if (prev?.kind === "images") {
        for (const img of prev.items) URL.revokeObjectURL(img.previewUrl);
      }
      return { kind: "gif", gif };
    });
    setError(null);
    setGifPickerOpen(false);
  };

  /**
   * Two-phase image upload:
   *   1. Ask the server for a one-time signed upload URL scoped to a
   *      <salesperson_id>/<uuid>.<ext> path.
   *   2. PUT the file via supabase-js's uploadToSignedUrl. Bucket-level
   *      MIME + size limits enforce the file matches the declared shape.
   * Returns the public URL of the uploaded object on success.
   */
  const uploadImage = async (
    file: File,
  ): Promise<{ publicUrl: string }> => {
    const signRes = await apiFetch("/api/juice-box/media/sign-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content_type: file.type,
        size: file.size,
      }),
    });
    if (!signRes.ok) {
      const body = (await signRes.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(body?.error ?? `Couldn't prepare upload (${signRes.status}).`);
    }
    const signBody = (await signRes.json()) as {
      token: string;
      path: string;
      public_url: string;
    };
    const upload = await supabase.storage
      .from(JUICE_BOX_MEDIA_BUCKET)
      .uploadToSignedUrl(signBody.path, signBody.token, file, {
        contentType: file.type,
      });
    if (upload.error) {
      throw new Error(`Upload failed: ${upload.error.message}`);
    }
    // The server-known `path` is intentionally NOT returned to the
    // caller — the create-message route re-derives it from public_url
    // and pins it to me.id, so trusting a client-passed path would
    // re-introduce the spoofing surface we just closed.
    return { publicUrl: signBody.public_url };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSending(true);
    setError(null);

    // The wire shape is intentionally minimal: for images we send each
    // public URL + intrinsic dims as an `images` array, for GIFs we
    // send only the provider id. The server derives every other media
    // field (storage_path from each URL, every GIF field by re-
    // fetching the provider by id) so a manually-crafted POST can't
    // smuggle in foreign URLs.
    type ImagesPayload = {
      images: Array<{
        url: string;
        width: number;
        height: number;
        alt?: string;
      }>;
    };
    type GifPayload = { gif_id: string };
    let mediaPayload: ImagesPayload | GifPayload | null = null;

    try {
      if (media?.kind === "images") {
        // Upload images sequentially so we don't slam the device's
        // mobile upload bandwidth and so the user-visible failure on
        // a bad pick reports the FIRST bad pick rather than whichever
        // of N parallel uploads raced to fail first.
        const uploaded: Array<{
          url: string;
          width: number;
          height: number;
          alt?: string;
        }> = [];
        for (const img of media.items) {
          const { publicUrl } = await uploadImage(img.file);
          // If dims didn't resolve in time (probe.onload still in
          // flight when the user hit Post), fall back to 1×1 — the
          // server requires positive integers but the rendered card
          // re-computes layout from the loaded <img> anyway, so the
          // dim metadata is only used as a CLS hint.
          uploaded.push({
            url: publicUrl,
            width: img.width ?? 1,
            height: img.height ?? 1,
            alt: img.file.name,
          });
        }
        mediaPayload = { images: uploaded };
      } else if (media?.kind === "gif") {
        mediaPayload = { gif_id: media.gif.id };
      }
    } catch (err) {
      setSending(false);
      setError(err instanceof Error ? err.message : "Upload failed.");
      return;
    }

    let res: Response;
    try {
      res = await apiFetch("/api/team-messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          ...(mediaPayload ?? {}),
        }),
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
    clearMedia();
    // Collapse the composer back to its compact resting state.
    // Cancel any pending blur-grace timer first so it can't fire
    // later and re-collapse mid-transition.
    if (blurTimerRef.current) {
      clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
    setFocused(false);
    // Drop the OS keyboard on mobile by blurring the textarea
    // explicitly — without this iOS keeps the keyboard up after a
    // post, which feels stuck.
    textareaRef.current?.blur();
  };

  return (
    <Card size="sm" className="py-2.5">
      <CardContent className="px-3">
        <form onSubmit={handleSubmit} className="space-y-2">
          {/* Media preview only appears when something is attached
              (which always implies isExpanded via the derivation). The
              preview component handles both shapes: a horizontal
              thumbnail strip for the images batch (with per-thumb X
              to remove), and a single-row preview for a picked GIF. */}
          {media && (
            <MediaAttachmentPreview
              media={media}
              disabled={sending}
              onRemoveImage={removeImage}
              onClear={clearMedia}
            />
          )}
          {/* Two layouts share the same textarea + buttons-container
              DOM nodes — only the flex direction + sizing change with
              isExpanded — so focus is preserved across the transition.
                * Compact: row layout. Textarea grows (flex-1), buttons
                  ride along the right. No chars counter, no Post.
                * Expanded: column layout. Textarea full-width above a
                  buttons row that includes chars counter and Post. */}
          <div
            className={cn(
              "flex gap-2",
              isExpanded ? "flex-col" : "items-end",
            )}
          >
            <textarea
              ref={textareaRef}
              value={text}
              onFocus={handleTextareaFocus}
              onBlur={handleTextareaBlur}
              onChange={(e) => {
                setText(e.target.value);
                if (error) setError(null);
              }}
              placeholder={
                media
                  ? "Add a caption…"
                  : "Drop some juice... a win, meme, GIF, or shoutout"
              }
              rows={isExpanded ? 2 : 1}
              maxLength={MESSAGE_MAX_LENGTH}
              disabled={sending}
              // text-base (16px) on EVERY viewport to defeat iOS/WebKit's
              // "zoom into any focused input < 16px" behavior.
              className={cn(
                "resize-none rounded-md border border-input bg-background/40 px-3 py-1.5 text-base placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60",
                isExpanded
                  ? "w-full min-h-[2.5rem]"
                  : "min-w-0 flex-1 min-h-[2.25rem]",
              )}
            />
            <div
              className={cn(
                "flex items-center gap-1",
                isExpanded ? "justify-between" : "shrink-0",
              )}
            >
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label={
                    media?.kind === "images"
                      ? media.items.length >= MAX_IMAGES_PER_POST
                        ? `Image limit reached (${MAX_IMAGES_PER_POST})`
                        : "Attach more images"
                      : "Attach images"
                  }
                  onClick={() => fileInputRef.current?.click()}
                  disabled={
                    sending ||
                    (media?.kind === "images" &&
                      media.items.length >= MAX_IMAGES_PER_POST)
                  }
                  className="inline-flex size-8 items-center justify-center rounded-md bg-muted/60 text-foreground/85 ring-1 ring-border transition-colors hover:bg-muted hover:text-primary hover:ring-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ImagePlus aria-hidden="true" className="size-4" />
                </button>
                <button
                  type="button"
                  aria-label="Pick a GIF"
                  // Dismiss the iOS soft keyboard before opening the picker.
                  // Otherwise the fixed composer stays lifted by the visual
                  // viewport, leaving it floating awkwardly above the GIF
                  // grid. We blur both the textarea (the usual focused
                  // element) and any other active text input as a defence
                  // for iOS Safari, which has been known to leave focus on
                  // a hidden helper input across rerenders. The picker's
                  // search input is no longer autofocused for the same
                  // reason — typing is opt-in, the keyboard stays down.
                  onClick={() => {
                    textareaRef.current?.blur();
                    const active = document.activeElement;
                    if (
                      active instanceof HTMLElement &&
                      active !== document.body
                    ) {
                      active.blur();
                    }
                    setGifPickerOpen(true);
                  }}
                  disabled={sending}
                  className="inline-flex h-8 items-center rounded-md bg-muted/60 px-2 text-[11px] font-bold tracking-wide text-foreground/85 ring-1 ring-border transition-colors hover:bg-muted hover:text-primary hover:ring-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  GIF
                </button>
                {isExpanded && (
                  <p
                    className={cn(
                      "pl-1 text-[11px]",
                      trimmed.length > MESSAGE_MAX_LENGTH - 100
                        ? "text-muted-foreground"
                        : "text-muted-foreground/60",
                    )}
                  >
                    {trimmed.length}/{MESSAGE_MAX_LENGTH}
                  </p>
                )}
              </div>
              {isExpanded && (
                <Button
                  type="submit"
                  size="sm"
                  disabled={!canSubmit}
                  className="h-8 gap-1.5 px-3 text-xs"
                >
                  {sending ? (
                    <Loader2
                      aria-hidden="true"
                      className="size-3.5 animate-spin"
                    />
                  ) : (
                    <Send aria-hidden="true" className="size-3.5" />
                  )}
                  {sending ? "Posting…" : "Post"}
                </Button>
              )}
            </div>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <input
            ref={fileInputRef}
            type="file"
            // `multiple` lets the user select several images at once
            // from the native picker. iOS Photos and Android Files
            // both honor this; the per-file MIME / size checks in
            // attachImageFiles still run, and the cumulative cap is
            // MAX_IMAGES_PER_POST.
            multiple
            accept={MEDIA_ALLOWED_IMAGE_MIME_TYPES.join(",")}
            onChange={onImageInputChange}
            className="sr-only"
            aria-hidden="true"
            tabIndex={-1}
          />
        </form>
      </CardContent>
      {gifPickerOpen && (
        <GifPickerSheet
          onSelect={onGifSelected}
          onClose={() => setGifPickerOpen(false)}
        />
      )}
    </Card>
  );
}

/**
 * Composer preview for whatever's currently attached.
 *
 *   GIF: small row with one thumbnail + label + X to clear.
 *   Images: horizontally-scrollable thumbnail strip, each with its own
 *           X to remove. The image-attach button on the row below
 *           appends MORE images while under the cap, so this strip is
 *           the source of truth for "what's about to be posted."
 *
 * The strip uses `overflow-x-auto` so 4+ images on a narrow phone
 * scroll horizontally without breaking the composer layout; the
 * thumbnails are a fixed 14×14 (rem) to keep the row visually compact.
 */
function MediaAttachmentPreview({
  media,
  disabled,
  onRemoveImage,
  onClear,
}: {
  media: PendingMedia;
  disabled: boolean;
  /** Remove a single image from the pending batch (images flow only). */
  onRemoveImage: (id: string) => void;
  /** Drop the entire attachment (used by the GIF row's X — GIFs are atomic). */
  onClear: () => void;
}) {
  if (media.kind === "gif") {
    return (
      <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-1.5">
        <div className="relative shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element -- GIPHY CDN host */}
          <img
            src={media.gif.preview_url}
            alt={media.gif.alt}
            className="size-14 rounded-sm object-cover"
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            GIF attached
          </p>
          <p className="line-clamp-1 text-xs text-foreground/80">
            {media.gif.alt}
          </p>
        </div>
        <button
          type="button"
          aria-label="Remove attachment"
          onClick={onClear}
          disabled={disabled}
          className="-mr-0.5 -mt-0.5 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      </div>
    );
  }

  const { items } = media;
  return (
    <div className="rounded-md border border-border bg-muted/30 p-1.5">
      <p className="mb-1 px-0.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {items.length === 1
          ? "1 image attached"
          : `${items.length} images attached`}
      </p>
      <div className="flex gap-1.5 overflow-x-auto pb-0.5">
        {items.map((img) => (
          <div key={img.id} className="relative shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element -- object URL preview */}
            <img
              src={img.previewUrl}
              alt={img.file.name}
              className="size-14 rounded-sm object-cover ring-1 ring-border"
            />
            <button
              type="button"
              aria-label={`Remove ${img.file.name}`}
              onClick={() => onRemoveImage(img.id)}
              disabled={disabled}
              // Floating X over the corner of each thumb. Slightly
              // larger tap target on touch via the absolute-positioned
              // icon button (24×24 visual / generous hit area).
              className="absolute -right-1 -top-1 inline-flex size-5 items-center justify-center rounded-full bg-background text-foreground/80 shadow ring-1 ring-border transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Bottom-sheet GIF picker backed by /api/juice-box/gifs (which proxies
 * GIPHY). On open, fetches trending GIFs; a debounced search input
 * issues new queries. Tapping a result closes the sheet and attaches
 * the GIF to the composer state.
 */
function GifPickerSheet({
  onSelect,
  onClose,
}: {
  onSelect: (gif: GifResult) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  // Seed the visible grid from the module-level cache so the user sees
  // last session's trending (or whatever was last viewed) the instant
  // the sheet mounts — no skeleton flash, no flicker.
  const [results, setResults] = useState<GifResult[]>(
    () => readGifCache("") ?? [],
  );
  // `fetching` is true whenever a network request is in flight; the UI
  // ONLY shows the skeleton when fetching AND we have nothing to show.
  // If results are already visible (from cache or a prior query), they
  // stay visible during the refetch — no clear, no flicker.
  const [fetching, setFetching] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Esc-to-close + body scroll lock for the lifetime of the picker.
  //
  // The picker is rendered with `position: fixed`, so the underlying
  // feed is still the document's primary scroller. Without locking
  // body overflow, a touch-scroll on the GIF grid that hits the top
  // or bottom of the (often short) results region — or any touchmove
  // outside the results region itself — propagates to the document
  // and scrolls the Juice Box feed behind the picker. Setting
  // `document.body.style.overflow = "hidden"` while the picker is
  // mounted matches the existing pattern in VerificationCenter and
  // ScanBizCardSheet and reliably blocks the leak on iOS Safari,
  // Android Chrome, and desktop. Cleanup restores the previous
  // overflow value so we don't clobber anything a future caller may
  // have set on `<body>`.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  // Debounced fetch on query changes. CACHE HIT shortcuts the debounce
  // to zero delay and paints cached results in the same task that fires
  // the network refresh — perceived latency is one frame, well under
  // the visual threshold. All state writes are scoped inside the
  // setTimeout body so the effect itself stays free of synchronous
  // state writes (react-hooks/set-state-in-effect).
  const queryKey = gifCacheKey(query);
  useEffect(() => {
    let cancelled = false;
    const cached = readGifCache(queryKey);
    const delay = cached ? 0 : 250;

    const handle = window.setTimeout(() => {
      if (cancelled) return;
      if (cached) {
        // Paint cached results immediately so the user sees them while
        // the network request below silently refreshes them.
        setResults(cached);
      }
      setFetching(true);
      setError(null);
      const params = new URLSearchParams({ limit: "24" });
      if (queryKey) params.set("q", queryKey);
      apiFetch(`/api/juice-box/gifs?${params.toString()}`)
        .then(async (res) => {
          const body = (await res.json().catch(() => null)) as {
            configured?: boolean;
            results?: GifResult[];
            error?: string;
          } | null;
          if (cancelled) return;
          if (!res.ok || !body) {
            // Don't blow away visible results on error — surface the
            // message but keep the prior grid so the picker doesn't
            // visually crash mid-typing.
            setError(body?.error ?? `Couldn't load GIFs (${res.status}).`);
            return;
          }
          setConfigured(body.configured !== false);
          const fresh = body.results ?? [];
          setResults(fresh);
          writeGifCache(queryKey, fresh);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : "Couldn't load GIFs.");
        })
        .finally(() => {
          if (!cancelled) setFetching(false);
        });
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [queryKey]);

  // Skeleton applies only when there's literally nothing to show AND a
  // request is in flight; once results land they stay visible across
  // all subsequent query changes.
  const showSkeleton = fetching && results.length === 0;
  const showEmpty =
    !fetching && results.length === 0 && error === null && configured !== false;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="gif-picker-title"
      className="fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center"
      style={{
        paddingTop: "calc(0.75rem + env(safe-area-inset-top))",
        paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))",
      }}
    >
      <button
        type="button"
        aria-label="Close GIF picker"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm focus:outline-none"
      />
      <Card
        size="sm"
        className="relative flex w-full max-w-md flex-col overflow-hidden animate-in fade-in-0 zoom-in-95 duration-150"
        style={{ maxHeight: "min(70vh, 32rem)" }}
      >
        <CardContent className="flex flex-1 flex-col gap-2 overflow-hidden px-3 py-3">
          <header className="flex items-center justify-between gap-2">
            <h2
              id="gif-picker-title"
              className="flex items-center gap-1.5 text-sm font-semibold"
            >
              <Sparkles aria-hidden="true" className="size-4 text-primary" />
              GIFs
              {/* Subtle "refreshing" spinner — only appears when a fetch
                  is in flight AND we already have results visible. The
                  initial-load skeleton handles the "nothing to show" case. */}
              {fetching && results.length > 0 && (
                <Loader2
                  aria-hidden="true"
                  className="size-3.5 animate-spin text-muted-foreground/70"
                />
              )}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-1 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </header>
          {/* Scrollable results region. Pinned ABOVE the search input now
              so the grid reads as the picker's primary content and the
              input feels like a docked composer at the bottom — closer
              to the thumb on phones, and visually connected to the
              "Powered by GIPHY" footer beneath it.
              `overscroll-contain` stops iOS rubber-band scrolling from
              chaining into the document (body scroll is also locked
              while the picker is mounted) so the grid is the only
              scroller responding to touch within the picker. */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {configured === false ? (
              <p className="px-1 py-6 text-center text-sm text-muted-foreground">
                GIF search isn&apos;t configured yet. Ask an admin to set
                the <code className="font-mono text-xs">GIPHY_API_KEY</code> env var.
              </p>
            ) : error && results.length === 0 ? (
              <p className="px-1 py-6 text-center text-sm text-destructive">
                {error}
              </p>
            ) : showSkeleton ? (
              <GifSkeletonGrid />
            ) : showEmpty ? (
              <p className="px-1 py-6 text-center text-sm text-muted-foreground">
                No GIFs found.
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-1">
                {results.map((gif) => (
                  <button
                    key={gif.id}
                    type="button"
                    onClick={() => onSelect(gif)}
                    className="overflow-hidden rounded-md ring-1 ring-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- external GIPHY CDN host */}
                    <img
                      src={gif.preview_url}
                      alt={gif.alt}
                      loading="lazy"
                      className="h-24 w-full object-cover"
                    />
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* Bottom-docked search + GIPHY attribution. The thin top
              border separates the input from the scrollable grid above
              so it reads as a docked composer; the attribution sits
              directly under the input so the credit stays visible
              without competing with the grid for vertical space. */}
          <div className="-mx-3 -mb-3 mt-1 space-y-1.5 border-t border-border/60 bg-card/60 px-3 pb-3 pt-2">
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="search"
                // No autoFocus: tapping into the search input is opt-in
                // so the iOS keyboard stays dismissed when the picker
                // opens. Tapping the field naturally raises the
                // keyboard and the input — anchored at the bottom of
                // the card — sits right above it like a chat composer.
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search GIPHY…"
                className="w-full rounded-md border border-input bg-background/40 py-2 pl-8 pr-3 text-base placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              />
            </div>
            <p className="text-center text-[10px] text-muted-foreground/70">
              Powered by GIPHY
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Placeholder grid shown ONLY on first open with no cached results.
 * Once any results have been visible, subsequent query changes reuse
 * the prior grid while the new request is in flight — see the cache /
 * fetching logic in GifPickerSheet.
 */
function GifSkeletonGrid() {
  return (
    <div className="grid grid-cols-3 gap-1" aria-hidden="true">
      {Array.from({ length: 12 }).map((_, i) => (
        <div
          key={i}
          className="h-24 w-full animate-pulse rounded-md bg-muted/40"
        />
      ))}
    </div>
  );
}

/**
 * Mobile-friendly modal that opens when the user picks Reply on a message.
 * Title + original message preview + a dedicated textarea. Replaces the
 * earlier "reply mode on the sticky top composer" UX, which was hard to
 * notice on phones once the user scrolled the feed.
 *
 * Mounted as `position: fixed` over the whole viewport; backdrop click and
 * Escape both cancel. The reply post still flows through the same
 * /api/team-messages POST + reply_to_message_id path, and the optimistic
 * onPosted hand-off lets the parent's smart-scroll behavior land the new
 * reply at the bottom of the feed.
 */
function ReplyModal({
  replyTo,
  onPosted,
  onClose,
}: {
  replyTo: TeamMessage;
  onPosted: (message: TeamMessage) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Autofocus the textarea when the modal mounts. Deferred to a microtask
  // so iOS reliably triggers the keyboard (focus during the same frame as
  // mount sometimes loses the keyboard pop on first paint).
  useEffect(() => {
    const id = window.setTimeout(() => textareaRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, []);

  // Escape closes — only when not actively sending. Letting Escape cancel
  // mid-submit would leave a half-finished optimistic post hanging.
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !sending) onClose();
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [sending, onClose]);

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
        body: JSON.stringify({
          message: trimmed,
          reply_to_message_id: replyTo.id,
        }),
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

    if (!res.ok || !body?.message) {
      setSending(false);
      setError(body?.error ?? `Couldn't post (${res.status}).`);
      return;
    }

    // Hand off to the feed — same optimistic + smart-scroll path the
    // top composer uses, so the new reply lands at the bottom and the
    // unread divider clears.
    onPosted(body.message);
    onClose();
  };

  const preview = replyTo.message.length > REPLY_PREVIEW_MAX_LENGTH
    ? `${replyTo.message.slice(0, REPLY_PREVIEW_MAX_LENGTH)}…`
    : replyTo.message;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="reply-modal-title"
      // z-50 sits above the bottom nav (z-40) and sticky composer (z-30).
      // viewport-fit=cover means env(safe-area-inset-top) is non-zero on
      // standalone iPhones with a notch — pad both sides so the card never
      // jams against the status bar / home indicator.
      className="fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center"
      style={{
        paddingTop: "calc(0.75rem + env(safe-area-inset-top))",
        paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))",
      }}
    >
      <button
        type="button"
        aria-label="Cancel reply"
        onClick={() => {
          if (!sending) onClose();
        }}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm focus:outline-none"
      />
      <Card
        size="sm"
        className="relative w-full max-w-md overflow-hidden animate-in fade-in-0 zoom-in-95 duration-150"
      >
        <CardContent className="space-y-3 px-4 py-3">
          <header className="flex items-start justify-between gap-2">
            <h2
              id="reply-modal-title"
              className="flex items-center gap-1.5 text-sm font-semibold"
            >
              <CornerUpLeft aria-hidden="true" className="size-4 text-primary" />
              Reply to {replyTo.salesperson_name}
            </h2>
            <button
              type="button"
              onClick={onClose}
              disabled={sending}
              aria-label="Close"
              className="-mr-1 -mt-0.5 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </header>
          <div className="rounded-md border-l-2 border-primary bg-muted/40 px-2.5 py-1.5">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Original
            </p>
            <p className="line-clamp-3 whitespace-pre-wrap text-xs text-foreground/80">
              {preview}
            </p>
          </div>
          <form onSubmit={handleSubmit} className="space-y-2">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                if (error) setError(null);
              }}
              placeholder={`Reply to ${replyTo.salesperson_name}…`}
              rows={3}
              maxLength={MESSAGE_MAX_LENGTH}
              disabled={sending}
              // text-base (16px) keeps iOS Safari from auto-zooming when the
              // textarea focuses — same guard the sticky composer uses.
              className="min-h-[5rem] w-full resize-none rounded-md border border-input bg-background/40 px-3 py-2 text-base placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
            />
            <div className="flex items-center justify-between gap-2">
              <p
                className={cn(
                  "text-[11px]",
                  trimmed.length > MESSAGE_MAX_LENGTH - 100
                    ? "text-muted-foreground"
                    : "text-muted-foreground/60",
                )}
              >
                {trimmed.length}/{MESSAGE_MAX_LENGTH}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={sending}
                  onClick={onClose}
                  className="h-8 px-3 text-xs"
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!canSubmit}
                  className="h-8 gap-1.5 px-3 text-xs"
                >
                  <Send aria-hidden="true" className="size-3.5" />
                  {sending ? "Posting…" : "Post Reply"}
                </Button>
              </div>
            </div>
            {error && (
              <p className="text-xs text-destructive">{error}</p>
            )}
          </form>
        </CardContent>
      </Card>
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
  onShowReactionDetails,
  onOpenMedia,
  initialIds,
  forceScrollRef,
  lastReadAt,
  unreadLoaded,
  onNearBottom,
  onNearBottomChange,
  onLoadOlder,
  hasMore,
  loadingMore,
  refreshing,
  freshFeedLoaded,
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
  /** Fired when the user taps a chip — opens the reactor-list popover. */
  onShowReactionDetails: (messageId: string, emoji: string) => void;
  /** Fired when the user taps an inline image/GIF in the feed — opens
   *  the lightbox at JuiceBoxFeed level. The handler receives the full
   *  list of media slices for the post + the index the user tapped so
   *  the lightbox can paginate through a multi-image post. */
  onOpenMedia: (items: TeamMessageMedia[], index: number) => void;
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
  /** Edge-triggered callback fired with the new value whenever the
   *  scroll listener detects nearBottom flipping. Surfaces the state
   *  to JuiceBoxFeed so the floating "Jump to latest" pill knows when
   *  to render. */
  onNearBottomChange?: (nearBottom: boolean) => void;
  /** Triggers a paginate-back fetch for older posts. The button at the
   *  top of the feed wires straight into this. */
  onLoadOlder: () => void;
  /** True while more pages exist behind what's already loaded. Hides the
   *  button when we've reached the start of the history. */
  hasMore: boolean;
  /** True while a Load Older fetch is in flight; disables the button. */
  loadingMore: boolean;
  /** True while the bootstrap fetch is running AFTER cache hydration —
   *  drives the subtle "Refreshing…" pill above the feed. */
  refreshing: boolean;
  /** Flips to true the moment the bootstrap fetch settles. The
   *  final-landing effect waits on this so cache hydration alone
   *  never causes a one-shot scroll — the initial landing always
   *  happens against fresh server data. */
  freshFeedLoaded: boolean;
}) {
  const messageCount =
    state.kind === "ready" ? state.messages.length : 0;

  // Latest-message scroll target id — built off the existing per-card id
  // pattern. We look the element up via document.getElementById from the
  // scroll effect; no forwardRef needed on FeedCard.
  const latestMessageId =
    state.kind === "ready" && state.messages.length > 0
      ? state.messages[state.messages.length - 1].id
      : null;

  // First-unread scroll target id. Used for the INITIAL auto-scroll only
  // — when the user opens Juice Box with new messages waiting, we land
  // them at the top of the unread block rather than at the latest.
  //
  // Returns null (= "use the latest target instead") when:
  //   - feed isn't ready yet,
  //   - unread bootstrap hasn't resolved (we don't know lastReadAt yet),
  //   - everything is already read,
  //   - or the first unread IS the latest (the two targets collapse, so
  //     landing at "first unread" gives no UX benefit and skips the
  //     mark-read that landing at latest triggers).
  //
  // Uses the live lastReadAt prop (not the grace-lagged dividerAnchor)
  // because we care about the actual unread frontier, not the visual
  // divider's fade timing.
  const firstUnreadMessageId = useMemo(() => {
    if (state.kind !== "ready") return null;
    if (state.messages.length === 0) return null;
    if (!unreadLoaded) return null;
    const idx =
      lastReadAt === null
        ? 0
        : state.messages.findIndex((m) => m.created_at > lastReadAt);
    if (idx < 0 || idx >= state.messages.length - 1) return null;
    return state.messages[idx].id;
  }, [state, lastReadAt, unreadLoaded]);


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
  //   * INITIAL LANDING is owned by a SEPARATE effect (see "Final
  //     initial landing" below) — gated on the bootstrap fetch having
  //     settled, NOT on cache hydration. Cache rendering paints
  //     content but never causes a scroll, so the one-shot landing
  //     always targets fresh server data.
  //   * For each subsequent message, only auto-scroll if either
  //       (a) the user just hit Post themselves (forceScrollRef), or
  //       (b) they are currently within NEAR_BOTTOM_PX of the bottom.
  //     Otherwise — they have scrolled up to read older posts — leave them
  //     alone. No yanking the viewport while they're reading.
  const NEAR_BOTTOM_PX = 200;
  const nearBottomRef = useRef(true);

  // Stable callback ref for onNearBottomChange — the listener is bound
  // once on mount and reads through the ref so a parent-level prop
  // identity change doesn't require re-binding the listener.
  const onNearBottomChangeRef = useRef(onNearBottomChange);
  useEffect(() => {
    onNearBottomChangeRef.current = onNearBottomChange;
  }, [onNearBottomChange]);

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
      // Surface the boolean to JuiceBoxFeed so the Jump-to-latest pill
      // can toggle visibility. Edge-triggered — we only fire the
      // callback when the value actually changes, not on every scroll
      // tick, which prevents a re-render storm during smooth scrolls.
      if (wasNear !== isNear) {
        onNearBottomChangeRef.current?.(isNear);
      }
    };
    // Seed via microtask so the initial state surface to the parent
    // happens AFTER the effect body returns — keeps setState out of
    // the effect's synchronous path (react-hooks/set-state-in-effect).
    const seed = () => {
      const doc = document.documentElement;
      const remaining = doc.scrollHeight - window.scrollY - window.innerHeight;
      const isNear = remaining < NEAR_BOTTOM_PX;
      nearBottomRef.current = isNear;
      onNearBottomChangeRef.current?.(isNear);
    };
    queueMicrotask(seed);
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  // ─── Final initial landing ────────────────────────────────────────────
  // Distinct ref, distinct effect. Cache hydration NEVER consumes this;
  // the only paths that consume it are:
  //   (a) the dedicated final-landing effect successfully scrolling,
  //   (b) the user scrolling manually before (a) gets to fire.
  //
  // The previous design reused `firstScrollRef` for both initial
  // landing and the "is this the first scroll ever?" gate inside the
  // generic scroll effect. With cache hydration, an unlucky timing
  // where the bootstrap merge raced the async scroll-event update
  // could leave nearBottomRef stale (=false) and the merge-triggered
  // effect would skip the re-land. Splitting the responsibilities
  // means the final landing depends ONLY on data signals
  // (freshFeedLoaded + unreadLoaded + DOM), not on a side-effected
  // ref the browser hadn't refreshed yet.
  const finalLandingPendingRef = useRef(true);

  // Cancel listener: a real user wheel/touchmove before final landing
  // → consume the pending flag so we don't yank them. Programmatic
  // scrolls (window.scrollTo / scrollIntoView) don't fire these, so
  // self-cancel is impossible.
  useEffect(() => {
    if (!finalLandingPendingRef.current) return;
    const cancel = () => {
      finalLandingPendingRef.current = false;
    };
    document.addEventListener("wheel", cancel, { passive: true, once: true });
    document.addEventListener("touchmove", cancel, {
      passive: true,
      once: true,
    });
    return () => {
      document.removeEventListener("wheel", cancel);
      document.removeEventListener("touchmove", cancel);
    };
  }, []);

  // Detect "Load older" prepends so the generic scroll effect skips its
  // own auto-scroll while the layout effect restores the pre-prepend
  // scroll position. Structural signal: first message id changed AND
  // length grew. Append-merge (cache→bootstrap) keeps first id
  // unchanged; admin-delete-of-oldest shrinks length — neither qualifies.
  const prevLengthRef = useRef(0);
  const prevFirstIdRef = useRef<string | null>(null);
  const firstMessageId =
    state.kind === "ready" && state.messages.length > 0
      ? state.messages[0].id
      : null;

  // Generic ongoing scroll effect — handles self-post + realtime-while-
  // near-bottom ONLY. Defers entirely to the final-landing effect for
  // the initial scroll.
  useEffect(() => {
    if (messageCount === 0) {
      prevLengthRef.current = 0;
      prevFirstIdRef.current = null;
      return;
    }
    const prevLength = prevLengthRef.current;
    const prevFirstId = prevFirstIdRef.current;
    prevLengthRef.current = messageCount;
    prevFirstIdRef.current = firstMessageId;

    const wasPrepend =
      prevFirstId !== null &&
      firstMessageId !== prevFirstId &&
      messageCount > prevLength;

    if (wasPrepend) {
      // Layout effect upstream is correcting scroll position.
      forceScrollRef.current = false;
      return;
    }

    // Defer to the dedicated final-landing effect while it's still
    // pending. This prevents a "scroll to latest twice" glitch when
    // bootstrap merges arrive and the user happens to already be
    // near the bottom.
    if (finalLandingPendingRef.current) return;

    const shouldScroll =
      forceScrollRef.current || nearBottomRef.current;

    if (shouldScroll && latestMessageId) {
      const messageEl = document.getElementById(
        `juice-message-${latestMessageId}`,
      );
      const composer = document.getElementById("juice-composer-bar");
      if (messageEl && composer) {
        const messageBottom = messageEl.getBoundingClientRect().bottom;
        const composerTop = composer.getBoundingClientRect().top;
        const target = Math.max(
          0,
          window.scrollY + messageBottom - composerTop + AUTO_SCROLL_COMFORT_PX,
        );
        window.scrollTo({ top: target, behavior: "smooth" });
      }
      onNearBottomRef.current();
    }

    // Consume the one-shot self-post signal whether or not it fired the
    // scroll — once handled, future inbound messages go back to the
    // "near-bottom only" rule.
    forceScrollRef.current = false;
  }, [messageCount, latestMessageId, firstMessageId, forceScrollRef]);

  // ─── Final-landing effect ─────────────────────────────────────────────
  // Fires AT MOST ONCE per mount. Waits for the bootstrap fetch to
  // settle AND the unread bootstrap to resolve AND messages to be
  // rendered, then picks the target:
  //   * firstUnread if any unread exists,
  //   * latest otherwise.
  //
  // Independent of nearBottomRef so the cache→bootstrap race is gone:
  // the scroll fires based on data readiness alone, not on a stale
  // scroll-listener reading.
  useEffect(() => {
    if (!finalLandingPendingRef.current) return;
    if (!freshFeedLoaded) return;
    if (!unreadLoaded) return;
    if (messageCount === 0) return;

    const targetId = firstUnreadMessageId ?? latestMessageId;
    if (!targetId) return;

    const messageEl = document.getElementById(`juice-message-${targetId}`);
    const composer = document.getElementById("juice-composer-bar");
    // DOM might not be painted on this exact render (rare). Don't
    // consume the flag — the next dep change (or messageCount tick)
    // will retry.
    if (!messageEl || !composer) return;

    const messageBottom = messageEl.getBoundingClientRect().bottom;
    const composerTop = composer.getBoundingClientRect().top;
    const target = Math.max(
      0,
      window.scrollY + messageBottom - composerTop + AUTO_SCROLL_COMFORT_PX,
    );
    window.scrollTo({ top: target, behavior: "auto" });

    finalLandingPendingRef.current = false;

    // Mark-read only on "land at latest." Landing at first unread
    // leaves newer unreads hidden below the composer — those should
    // stay unread until the user scrolls into them.
    if (firstUnreadMessageId === null) {
      onNearBottomRef.current();
    }
  }, [
    freshFeedLoaded,
    unreadLoaded,
    messageCount,
    firstUnreadMessageId,
    latestMessageId,
  ]);

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
    // space-y-2.5 (10px) instead of space-y-2 (8px) — a small bump that
    // makes adjacent message cards read as distinct without bloating the
    // feed when conversations get active. Polish-only.
    <section className="space-y-2.5">
      {/* Subtle "Refreshing…" pill. Only shows after a cache-hydration
          first paint while the bootstrap fetch is still in flight — so
          the user knows the feed is being updated without a full
          skeleton state. Disappears on fetch resolution. */}
      {refreshing && (
        <div className="flex justify-center pt-1">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground ring-1 ring-border">
            <Loader2 aria-hidden="true" className="size-3 animate-spin" />
            Refreshing…
          </span>
        </div>
      )}
      {/* "Load older posts" sits at the top of the feed so the user has
          a clear, scroll-to-find affordance for pagination. Hidden once
          the server tells us we've reached the start of history. */}
      {hasMore && state.messages.length > 0 && (
        <div className="flex justify-center pt-1">
          <button
            type="button"
            onClick={onLoadOlder}
            disabled={loadingMore}
            className="rounded-full bg-muted/60 px-3 py-1 text-[11px] font-medium text-muted-foreground ring-1 ring-border transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loadingMore ? "Loading…" : "Load older posts"}
          </button>
        </div>
      )}
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
                onShowReactionDetails={onShowReactionDetails}
                onOpenMedia={onOpenMedia}
              />
            </Fragment>
          );
        })
      )}
      {/*
        Auto-scroll is now driven by a manual window.scrollTo() in the
        scroll effect, which reads the latest message's getBoundingClientRect
        directly. We rely on main's pb-[18rem+safe] to give the document
        enough scrollable range for that target to land in the lower-middle
        of visible feed. No sentinel element here.
      */}
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
  onShowReactionDetails,
  onOpenMedia,
}: {
  message: TeamMessage;
  isMine: boolean;
  isAdmin: boolean;
  isFresh: boolean;
  onDeleted: (id: string) => void;
  onReply: (message: TeamMessage) => void;
  reactions: TeamMessageReaction[];
  onToggleReaction: (messageId: string, emoji: ReactionEmoji) => void;
  onShowReactionDetails: (messageId: string, emoji: string) => void;
  onOpenMedia: (items: TeamMessageMedia[], index: number) => void;
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
  const mediaList = teamMessageMediaList(message);
  const hasText = message.message.length > 0;
  // First http(s) URL in the body, if any. Server-side /api/link-preview
  // fetches metadata and the card renders nothing on failure, so this is
  // safe to compute optimistically here.
  const previewUrl = hasText ? extractFirstUrl(message.message) : null;

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
        // border-foreground/15 brightens the resting card edge from the
        // default --border charcoal — still tasteful, but the cards
        // read as distinct surfaces on a dark feed instead of melting
        // into the background. Hover keeps the orange-tinted glow.
        "py-2.5 transition-shadow hover:shadow-[0_0_0_1px_var(--color-primary)/0.18,0_8px_24px_-12px_color-mix(in_oklab,var(--color-primary)_25%,transparent)]",
        // Mine: very subtle warmth. The card background blends ~6% of
        // the orange primary into --color-card so the charcoal stays
        // dark but reads warmer, and the resting border picks up a
        // slightly stronger orange tint. Combined the effect is
        // recognizable without ever feeling like a chat bubble.
        isMine
          ? "bg-[color-mix(in_oklab,var(--color-primary)_6%,var(--color-card))] border-primary/25 ring-1 ring-inset ring-primary/10"
          : "border-foreground/15",
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
      {/* space-y-1.5 (6px) between header / body / reactions — a small
          increase from space-y-1 that gives the body room to breathe at
          its slightly larger size without making the card feel taller. */}
      <CardContent className="space-y-1.5 px-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <Avatar name={message.salesperson_name} />
            {/* Sender row uses text-base (16px) to match the body so the
                header no longer reads visually smaller than the message
                content. Hierarchy is preserved via font-bold on the
                sender name + the muted timestamp. */}
            <p className="min-w-0 truncate text-base leading-tight">
              <span className="font-bold">{message.salesperson_name}</span>
              {isMine && (
                <span className="ml-1.5 inline-flex items-center rounded-full bg-primary/15 px-1.5 py-px align-[1px] text-[10px] font-semibold uppercase tracking-wide text-primary ring-1 ring-inset ring-primary/25">
                  You
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
        {hasText && (
          // Body bumped from text-[15px] to text-base (16px) — the iOS
          // browser default — and leading nudged from snug (1.375) to
          // normal (1.5) for noticeably easier reading on mobile. The
          // pl-[2.625rem] indent still aligns to the sender name because
          // avatar size + header gap are unchanged.
          //
          // AutoLinkText converts http(s) URLs into clickable <a> tags
          // while keeping non-URL spans as plain text — so newlines in
          // the source message still render normally via the
          // whitespace-pre-wrap class above.
          <p className="whitespace-pre-wrap break-words pl-[2.625rem] text-base font-medium leading-normal text-foreground">
            <AutoLinkText text={message.message} />
          </p>
        )}
        {previewUrl && (
          // Sits in the same indented column as the body so the preview
          // reads as part of the message, not a peer card. The card
          // self-hides if the server can't produce a preview.
          <LinkPreviewCard url={previewUrl} className="ml-[2.625rem]" />
        )}
        {mediaList.length > 0 && (
          <FeedMedia
            items={mediaList}
            onOpen={(index) => onOpenMedia(mediaList, index)}
          />
        )}
        {error && (
          <p className="pl-[2.625rem] text-xs text-destructive">{error}</p>
        )}
        <ReactionsRow
          messageId={message.id}
          reactions={reactions}
          onShowDetails={onShowReactionDetails}
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
 * If the original is older than the loaded pages and not in the loaded window,
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
 * Derives a download filename for a Juice Box image. We prefer the
 * basename of the URL path (which is "<uuid>.<ext>" for our Supabase
 * uploads — opaque but harmless), falling back to the alt text or a
 * generic name when the URL doesn't parse. Strips query strings and
 * forces an extension so the saved file has a sensible suffix even
 * when the browser would otherwise drop it.
 */
function deriveDownloadFilename(media: TeamMessageMedia): string {
  try {
    const parsed = new URL(media.url);
    const tail = parsed.pathname.split("/").filter(Boolean).pop();
    if (tail && tail.length > 0) return tail;
  } catch {
    // Fall through to the fallback below.
  }
  const ext = media.type === "gif" ? ".gif" : ".jpg";
  const safeAlt = (media.alt ?? "").replace(/[^a-z0-9._-]+/gi, "_").slice(0, 64);
  return safeAlt.length > 0 ? `${safeAlt}${ext}` : `juice-box${ext}`;
}

/**
 * Save an image to the user's device. We can't just rely on
 * `<a download>` because the storage URLs are cross-origin (the
 * download hint is ignored cross-origin and the browser just navigates
 * to the image). Strategy:
 *
 *   1. fetch the image → Blob (Supabase storage and GIPHY both allow
 *      cross-origin GETs from a browser).
 *   2. Create a same-origin object URL and click a synthetic anchor
 *      with `download` set — that gets honored.
 *   3. If the fetch fails for any reason (CORS edge case, offline,
 *      etc.), open the URL in a new tab as a graceful fallback so the
 *      user can save it via the browser's own image context menu.
 */
async function downloadMediaToDevice(media: TeamMessageMedia): Promise<void> {
  const filename = deriveDownloadFilename(media);
  try {
    const res = await fetch(media.url, { credentials: "omit" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    // Some browsers require the anchor to be in the DOM for the
    // synthetic click to count as a user-initiated download.
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Give the browser a tick to start the download before revoking.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch {
    // Fallback: open in a new tab so the user can long-press / right-
    // click to save. noopener+noreferrer mirror our usual a target=_blank.
    window.open(media.url, "_blank", "noopener,noreferrer");
  }
}

/**
 * Inline image grid rendered below the message text.
 *   1 image: single full-width preview (matches the prior single-image
 *            layout 1:1 so the feed feels unchanged for those posts).
 *   2+ images: 2-column grid of square-cropped thumbnails. Each
 *            thumbnail is independently tappable to open the lightbox
 *            at that index.
 *
 * Every image carries a small floating Download button so anyone in
 * the team can save a copy of a teammate's image without a context-
 * menu detour. The button is `e.stopPropagation()`'d so tapping it
 * never bubbles into the open-lightbox click.
 *
 * Width is capped by the body column; intrinsic `width`/`height` attrs
 * are passed on the single-image path so the browser can reserve the
 * right aspect-ratio box and avoid CLS. The card itself is
 * `select-none` on mobile (kills iOS long-press menu) so we also
 * disable text-selection on the underlying <img> and set
 * `draggable={false}` to keep long-press = reply intact.
 */
function FeedMedia({
  items,
  onOpen,
}: {
  items: TeamMessageMedia[];
  onOpen: (index: number) => void;
}) {
  if (items.length === 1) {
    const media = items[0];
    return (
      <div className="pl-[2.625rem]">
        <div className="relative inline-block max-w-[min(20rem,100%)]">
          <button
            type="button"
            onClick={() => onOpen(0)}
            aria-label={`Open ${media.type === "gif" ? "GIF" : "image"} full screen`}
            className="block w-full overflow-hidden rounded-md border border-border/60 bg-muted/40 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- external Supabase Storage / GIPHY host */}
            <img
              src={media.thumb_url ?? media.url}
              alt={media.alt ?? ""}
              width={media.width ?? undefined}
              height={media.height ?? undefined}
              loading="lazy"
              draggable={false}
              className="h-auto w-full max-h-80 object-contain"
            />
          </button>
          <DownloadMediaButton media={media} />
        </div>
      </div>
    );
  }

  return (
    <div className="pl-[2.625rem]">
      <div className="grid max-w-[min(24rem,100%)] grid-cols-2 gap-1.5">
        {items.map((media, i) => (
          <div key={`${media.url}-${i}`} className="relative">
            <button
              type="button"
              onClick={() => onOpen(i)}
              aria-label={`Open image ${i + 1} of ${items.length} full screen`}
              className="block aspect-square w-full overflow-hidden rounded-md border border-border/60 bg-muted/40 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- external Supabase Storage / GIPHY host */}
              <img
                src={media.thumb_url ?? media.url}
                alt={media.alt ?? ""}
                loading="lazy"
                draggable={false}
                className="size-full object-cover"
              />
            </button>
            <DownloadMediaButton media={media} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Subtle floating Download button used in both the inline grid and the
 * lightbox. Renders as a small icon-only chip in the top-right corner
 * of its container; click triggers downloadMediaToDevice which prefers
 * the in-browser download path and falls back to opening the image in
 * a new tab.
 *
 * stopPropagation is critical here — without it, taps in the inline
 * grid would also fire the surrounding "open lightbox" button.
 */
function DownloadMediaButton({
  media,
  large,
}: {
  media: TeamMessageMedia;
  /** Slightly larger variant used inside the lightbox. */
  large?: boolean;
}) {
  const [working, setWorking] = useState(false);
  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (working) return;
    setWorking(true);
    try {
      await downloadMediaToDevice(media);
    } finally {
      setWorking(false);
    }
  };
  return (
    <button
      type="button"
      onClick={handleClick}
      onPointerDown={(e) => e.stopPropagation()}
      disabled={working}
      aria-label={`Download ${media.type === "gif" ? "GIF" : "image"}`}
      title="Download"
      className={cn(
        "absolute right-1.5 top-1.5 inline-flex items-center justify-center rounded-full bg-black/55 text-white shadow ring-1 ring-white/15 backdrop-blur-sm transition-colors hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60",
        large ? "size-9" : "size-7",
      )}
    >
      {working ? (
        <Loader2 aria-hidden="true" className={large ? "size-4 animate-spin" : "size-3.5 animate-spin"} />
      ) : (
        <Download aria-hidden="true" className={large ? "size-4" : "size-3.5"} />
      )}
    </button>
  );
}

/**
 * Fullscreen viewer for an inline image / GIF. Backdrop tap, the X
 * button, or Escape all close. For multi-image posts the chevrons
 * paginate between items; ←/→ on the keyboard do the same. Scaled to
 * fit the viewport while respecting iOS safe areas at top/bottom;
 * aspect ratio comes from the intrinsic width/height attrs on the
 * <img>. The Download button is the same component the inline grid
 * uses, anchored to the top-right just under the close X.
 */
function MediaLightbox({
  items,
  index,
  onIndexChange,
  onClose,
}: {
  items: TeamMessageMedia[];
  index: number;
  onIndexChange: (next: number) => void;
  onClose: () => void;
}) {
  // Clamp defensively — handler-side prevents out-of-range writes but
  // the items array could shrink between renders in pathological cases.
  const safeIndex = Math.max(0, Math.min(index, items.length - 1));
  const media = items[safeIndex];
  const hasMany = items.length > 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (hasMany && e.key === "ArrowLeft") {
        onIndexChange((safeIndex - 1 + items.length) % items.length);
      } else if (hasMany && e.key === "ArrowRight") {
        onIndexChange((safeIndex + 1) % items.length);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, onIndexChange, safeIndex, items.length, hasMany]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={media.type === "gif" ? "GIF preview" : "Image preview"}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{
        paddingTop: "calc(1rem + env(safe-area-inset-top))",
        paddingBottom: "calc(1rem + env(safe-area-inset-bottom))",
      }}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/85 focus:outline-none"
      />
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute right-3 top-3 z-10 inline-flex size-9 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-sm transition-colors hover:bg-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        style={{ top: "calc(0.75rem + env(safe-area-inset-top))" }}
      >
        <X aria-hidden="true" className="size-5" />
      </button>
      {hasMany && (
        <>
          <button
            type="button"
            aria-label="Previous image"
            onClick={(e) => {
              e.stopPropagation();
              onIndexChange((safeIndex - 1 + items.length) % items.length);
            }}
            className="absolute left-3 top-1/2 z-10 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-sm transition-colors hover:bg-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <ChevronLeft aria-hidden="true" className="size-6" />
          </button>
          <button
            type="button"
            aria-label="Next image"
            onClick={(e) => {
              e.stopPropagation();
              onIndexChange((safeIndex + 1) % items.length);
            }}
            className="absolute right-3 top-1/2 z-10 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-sm transition-colors hover:bg-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <ChevronRight aria-hidden="true" className="size-6" />
          </button>
          <span
            className="absolute left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/40 px-2.5 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm"
            style={{ top: "calc(0.95rem + env(safe-area-inset-top))" }}
          >
            {safeIndex + 1} / {items.length}
          </span>
        </>
      )}
      {/* Wrapper so the Download chip can absolute-position relative to
          the image rather than the whole dialog (which would float it
          in dead corners on portrait phones). */}
      <div className="relative max-h-full max-w-full">
        {/* eslint-disable-next-line @next/next/no-img-element -- external Supabase Storage / GIPHY host */}
        <img
          // `key` resets the <img> on index changes so the browser
          // unloads the previous frame cleanly and the new image
          // doesn't briefly inherit the prior aspect ratio.
          key={media.url}
          src={media.url}
          alt={media.alt ?? ""}
          width={media.width ?? undefined}
          height={media.height ?? undefined}
          className="relative max-h-[85vh] max-w-full object-contain"
          draggable={false}
        />
        <DownloadMediaButton media={media} large />
      </div>
    </div>
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
  onShowDetails,
  onOpenBar,
  hasAny,
}: {
  messageId: string;
  reactions: TeamMessageReaction[];
  /** Tapping a chip opens the reactor-name popover. Toggling a reaction
   *  is handled exclusively by the + react bar (one entry point per
   *  intent — taps on chips never accidentally remove your reaction). */
  onShowDetails: (messageId: string, emoji: string) => void;
  onOpenBar: () => void;
  hasAny: boolean;
}) {
  return (
    // Indent halved (was pl-[2.625rem] aligned to message body). Sits
    // closer to the card's left edge so the reaction row reads as a
    // tight footer, not a second body column. Smaller gap between chips,
    // less vertical padding inside each chip.
    <div className="flex flex-wrap items-center gap-1 pl-[1.25rem]">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          onClick={() => onShowDetails(messageId, r.emoji)}
          aria-label={`${r.count} reacted with ${r.emoji} — tap to see who`}
          className={cn(
            "inline-flex h-5 items-center gap-0.5 rounded-full px-1.5 text-[11px] leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
            r.reacted
              ? "bg-primary/15 text-primary ring-1 ring-primary/40"
              : "bg-muted/60 text-foreground/80 ring-1 ring-border hover:bg-muted",
          )}
        >
          <span className="text-[13px] leading-none">{r.emoji}</span>
          <span className="tabular-nums">{r.count}</span>
        </button>
      ))}
      <button
        type="button"
        onClick={onOpenBar}
        aria-label="Add reaction"
        className={cn(
          "inline-flex h-5 items-center gap-1 rounded-full px-1.5 text-[11px] leading-none text-muted-foreground/80 ring-1 ring-border transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
          // De-emphasize when there are reactions; promote when there
          // aren't, so a totally empty row still has a clear affordance.
          !hasAny && "bg-muted/40",
        )}
      >
        <SmilePlus aria-hidden="true" className="size-3" />
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
 * Tap-to-see-who popover. Opens when the user taps an existing reaction
 * chip; shows the emoji, the count, and the list of reactor names pulled
 * straight from the live reactions Map. Read-only — the user toggles via
 * the inline + react bar, so this never doubles as an action surface.
 *
 * Mobile-first bottom sheet on phones (centers on `sm:+`). Backdrop tap
 * and Escape both dismiss. The parent component auto-closes if the chip
 * loses all reactors while the sheet is open.
 */
function ReactionDetailSheet({
  emoji,
  count,
  reactors,
  currentUserId,
  onClose,
}: {
  emoji: string;
  count: number;
  reactors: TeamMessageReactor[];
  currentUserId: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="reaction-details-title"
      // z-50 over the bottom Composer (z-30) and the BottomNav (z-40).
      // viewport-fit=cover means env(safe-area-inset-*) is non-zero on
      // standalone iPhones — pad to keep the card clear of notch/home bar.
      className="fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center"
      style={{
        paddingTop: "calc(0.75rem + env(safe-area-inset-top))",
        paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))",
      }}
    >
      <button
        type="button"
        aria-label="Close reaction details"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm focus:outline-none"
      />
      <Card
        size="sm"
        className="relative w-full max-w-xs overflow-hidden animate-in fade-in-0 zoom-in-95 duration-150"
      >
        <CardContent className="space-y-2 px-3 py-2.5">
          <header className="flex items-center justify-between gap-2">
            <h2
              id="reaction-details-title"
              className="flex items-center gap-2 text-sm font-semibold"
            >
              <span className="text-xl leading-none">{emoji}</span>
              <span className="text-muted-foreground">
                {count} {count === 1 ? "reaction" : "reactions"}
              </span>
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-1 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </header>
          {reactors.length === 0 ? (
            <p className="px-1 text-xs text-muted-foreground">
              No one yet.
            </p>
          ) : (
            <ul className="space-y-1">
              {reactors.map((r) => (
                <li
                  key={r.salesperson_id}
                  className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm"
                >
                  <ReactorAvatar name={r.salesperson_name} />
                  <span className="min-w-0 flex-1 truncate">
                    {r.salesperson_name}
                  </span>
                  {r.salesperson_id === currentUserId && (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      you
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Same shape as Avatar, slightly smaller for the reactor list. */
function ReactorAvatar({ name }: { name: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <div
      aria-hidden="true"
      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary ring-1 ring-primary/30"
    >
      {initial}
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
