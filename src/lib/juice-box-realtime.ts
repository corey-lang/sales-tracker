// How the Juice Box feed reacts to a realtime UPDATE, and how a burst of them
// is collapsed into one authoritative refetch.
//
// WHY THIS IS NOT "JUST UPSERT THE ROW"
//   An admin "Move conversation" UPDATEs every message in a thread. Postgres
//   Realtime makes NO ordering guarantee across those rows, so a reply's event
//   can arrive before its root's. Rendering each arriving row on its own would
//   therefore show a reply with no parent on screen — a visible orphan — until
//   the root's event happened to land.
//
//   So a channel-changing UPDATE is treated as a SIGNAL, not as data:
//     * rows leaving THIS channel are removed immediately (they are certainly
//       gone, and a departing ROOT takes its loaded descendants with it);
//     * rows arriving in this channel are NOT rendered from the event — the
//       channel is refetched from the API instead, which returns the whole
//       thread at once, in `created_at` order.
//
// Pure module — no React, no DOM, no fetch. Exported so the ordering rules are
// unit-tested rather than eyeballed inside a 5,000-line component.

import { normalizeChannel, type JuiceBoxChannel } from "@/lib/team-messages";

/** The minimum of a realtime row this decision needs. */
export type RealtimeRow = {
  id: string;
  channel?: unknown;
  reply_to_message_id?: string | null;
  is_deleted?: boolean;
};

export type RealtimeUpdatePlan =
  /** Soft-deleted: drop this id wherever it is. */
  | { kind: "delete"; reconcile: false }
  /** An edit to a row already on screen: apply it in place. */
  | { kind: "apply"; reconcile: false }
  /** A loaded ROOT left this channel: drop it AND its loaded descendants, tell
   *  the reader where it went, then reconcile (a descendant's event may not
   *  have arrived yet). */
  | { kind: "drop-conversation"; toChannel: JuiceBoxChannel; reconcile: true }
  /** A loaded REPLY left this channel: drop just it, no banner (its root's
   *  event carries the notice), then reconcile. */
  | { kind: "drop-message"; toChannel: JuiceBoxChannel; reconcile: true }
  /** A row that belongs here but isn't loaded — typically the destination side
   *  of a move. Render NOTHING from the event; rebuild from the API. */
  | { kind: "reconcile"; reconcile: true };

/**
 * Decides what a single realtime UPDATE means for the feed currently rendering
 * `activeChannel`.
 *
 * `isLoaded` is "do we already show this id?" — the signal that separates an
 * ordinary edit (safe to apply) from a row arriving from elsewhere (never safe
 * to render alone, because its ancestors may not have arrived).
 */
export function classifyRealtimeUpdate(input: {
  row: RealtimeRow;
  activeChannel: JuiceBoxChannel;
  isLoaded: boolean;
}): RealtimeUpdatePlan {
  const { row, activeChannel, isLoaded } = input;

  if (row.is_deleted === true) {
    return { kind: "delete", reconcile: false };
  }

  const rowChannel = normalizeChannel(row.channel);

  if (rowChannel !== activeChannel) {
    // Left this channel. A root's departure is the one that gets announced —
    // per-reply banners would stack up on a busy thread.
    return row.reply_to_message_id
      ? { kind: "drop-message", toChannel: rowChannel, reconcile: true }
      : { kind: "drop-conversation", toChannel: rowChannel, reconcile: true };
  }

  if (isLoaded) return { kind: "apply", reconcile: false };

  // Belongs here, not on screen: the destination side of a move (or any row
  // outside the loaded window). Reconcile rather than render a possible orphan.
  return { kind: "reconcile", reconcile: true };
}

/** The minimum of a loaded message this collection needs. */
export type ThreadMember = { id: string; reply_to_message_id?: string | null };

/**
 * Every LOADED id in the subtree rooted at `rootId`, including `rootId` itself.
 *
 * This is the set a move removes from the feed, and — the point of exporting it
 * — the set used to decide whether an open reply composer has just been
 * orphaned. Checking only the root and its direct children (which is what the
 * feed used to do) left a composer open when the user was replying to a
 * NESTED descendant: the conversation vanished, the composer stayed, and the
 * draft could only ever be rejected by the database.
 *
 * Order-independent: the closure repeats until it stops growing, so a
 * descendant appearing before its parent in the array is handled. Ids not in
 * the subtree are never included, so an unrelated conversation's composer is
 * left alone.
 *
 * Cost is O(depth × loaded) worst case on an array bounded by the feed page
 * size (~50), i.e. nothing.
 */
export function collectLoadedThread(
  messages: readonly ThreadMember[],
  rootId: string,
): Set<string> {
  const thread = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const m of messages) {
      const parent = m.reply_to_message_id;
      if (parent && thread.has(parent) && !thread.has(m.id)) {
        thread.add(m.id);
        grew = true;
      }
    }
  }
  return thread;
}

/**
 * Collapses a burst of reconcile requests into ONE run, and gives callers a
 * generation token so a response that lost a race — or that belongs to a feed
 * the user has already navigated away from — can be discarded.
 *
 *   schedule()      — request a run; repeated calls inside the window are free.
 *   generation()    — capture BEFORE an async read.
 *   isCurrent(gen)  — check AFTER it resolves; false ⇒ throw the response away.
 *   cancel()        — drop a pending run and invalidate every in-flight
 *                     response. Called on unmount, i.e. on a channel switch.
 */
export function createReconcileScheduler(opts: {
  delayMs: number;
  run: () => void | Promise<void>;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}) {
  const setT = opts.setTimeoutFn ?? setTimeout;
  const clearT = opts.clearTimeoutFn ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;

  return {
    schedule(): void {
      // Already pending — the burst is being collapsed into that run.
      if (timer !== null) return;
      timer = setT(() => {
        timer = null;
        void opts.run();
      }, opts.delayMs);
    },
    /** True while a run is queued. */
    get pending(): boolean {
      return timer !== null;
    },
    generation(): number {
      return generation;
    },
    isCurrent(captured: number): boolean {
      return captured === generation;
    },
    cancel(): void {
      if (timer !== null) {
        clearT(timer);
        timer = null;
      }
      generation += 1;
    },
  };
}

export type ReconcileScheduler = ReturnType<typeof createReconcileScheduler>;
