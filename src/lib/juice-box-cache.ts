import {
  FEED_PAGE_SIZE,
  type TeamMessage,
  type TeamMessageReaction,
} from "@/lib/team-messages";

// Local feed cache for /juice-box.
//
// PURPOSE
//   Make Juice Box feel instant on open. We persist the most recent
//   feed window to localStorage so a returning user paints content on
//   the first frame, then the background fetch refreshes server-truth.
//
// SCOPE
//   * Per-signed-in-salesperson — the key includes salesperson_id so
//     different users on the same device don't share state.
//   * Most-recent FEED_PAGE_SIZE messages (~50) only. Anything Load-Older
//     surfaced is intentionally NOT persisted; cache is for the first
//     view, not the entire scroll history.
//
// SAFETY
//   * Versioned. Bump CACHE_VERSION on shape changes; mismatched blobs
//     are discarded on read (silent invalidation, no migration code).
//   * TTL'd. Expired blobs are discarded.
//   * Defensive against quota / disabled storage / corrupt JSON — every
//     localStorage call is wrapped, and the cache is treated as an
//     OPTIONAL optimization. A failed read or write never breaks the
//     feed, it just falls back to the network path.

/**
 * Wire shape of a cached message. Matches the server GET response —
 * a TeamMessage row plus the per-message reaction aggregate. Stored
 * as-is so hydration runs the same peel logic as a fresh fetch.
 */
export type CachedFeedMessage = TeamMessage & {
  reactions: TeamMessageReaction[];
};

export type CachedFeed = {
  /** Schema version. Bump when CachedFeedMessage changes shape. */
  version: number;
  /** Epoch ms. Used by readCachedFeed to enforce the TTL. */
  cachedAt: number;
  /** Pins the cache to a specific signed-in user. Guards against a
   *  shared device showing the wrong user's content. */
  salespersonId: string;
  /** Mirrors the server's `hasMore` so the "Load older posts" button
   *  is correct at first paint. */
  hasMore: boolean;
  /** Most-recent FEED_PAGE_SIZE messages, oldest → newest. */
  messages: CachedFeedMessage[];
};

const CACHE_KEY_PREFIX = "juice-box:feed:";

/**
 * Bump on any change to CachedFeedMessage / CachedFeed shape that would
 * make older blobs misrender. Bumping silently invalidates the cache
 * on read; no migration code needed.
 *
 * v2: `TeamMessage` gained `media_attachments` for multi-image posts.
 *     v1 blobs don't carry the field — the rendering helper
 *     (teamMessageMediaList) treats missing as null so rendering is
 *     fine, but bumping is the conservative choice.
 */
const CACHE_VERSION = 2;

/**
 * Cache TTL. 12 hours hits the spec target — long enough that returning
 * users in the same day get an instant paint, short enough that a stale
 * snapshot never lingers across days when the team's been active.
 */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

function cacheKey(salespersonId: string): string {
  return `${CACHE_KEY_PREFIX}${salespersonId}`;
}

function isCachedFeed(x: unknown, salespersonId: string): x is CachedFeed {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    o.version === CACHE_VERSION &&
    typeof o.cachedAt === "number" &&
    o.salespersonId === salespersonId &&
    typeof o.hasMore === "boolean" &&
    Array.isArray(o.messages)
  );
}

/**
 * Reads + validates the cached feed for `salespersonId`. Returns null
 * for cache miss, expired, wrong-version, corrupt JSON, disabled
 * storage, or wrong-user blob. The caller treats null as "no cache,
 * use the network path."
 *
 * Side effect: invalid / expired blobs are removed on read so they
 * don't pile up in storage.
 */
export function readCachedFeed(salespersonId: string): CachedFeed | null {
  if (typeof window === "undefined") return null;
  if (!salespersonId) return null;
  const key = cacheKey(salespersonId);

  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    // Private mode / storage disabled — treat as miss.
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupted entry — drop and miss.
    safeRemove(key);
    return null;
  }
  if (!isCachedFeed(parsed, salespersonId)) {
    safeRemove(key);
    return null;
  }
  if (Date.now() - parsed.cachedAt > CACHE_TTL_MS) {
    safeRemove(key);
    return null;
  }
  return parsed;
}

/**
 * Writes the most-recent FEED_PAGE_SIZE messages (oldest → newest) to
 * the cache. Silently no-ops on storage errors (quota, disabled).
 * Called from:
 *   - Bootstrap fetch success — primes the next session.
 *   - visibilitychange → hidden — captures latest realtime additions
 *     before the user backgrounds the tab.
 */
export function writeCachedFeed(
  salespersonId: string,
  messages: CachedFeedMessage[],
  hasMore: boolean,
): void {
  if (typeof window === "undefined") return;
  if (!salespersonId) return;
  // Bound the payload so localStorage quota stays comfortable even if
  // the user has Load-Older'd hundreds of messages into state.
  const trimmed =
    messages.length > FEED_PAGE_SIZE
      ? messages.slice(-FEED_PAGE_SIZE)
      : messages;
  const payload: CachedFeed = {
    version: CACHE_VERSION,
    cachedAt: Date.now(),
    salespersonId,
    hasMore,
    messages: trimmed,
  };
  try {
    window.localStorage.setItem(cacheKey(salespersonId), JSON.stringify(payload));
  } catch {
    // Quota / disabled — cache is an optimization, not a requirement.
  }
}

/** Best-effort cache removal — used on sign-out flows if/when wired. */
export function clearCachedFeed(salespersonId: string): void {
  if (typeof window === "undefined") return;
  if (!salespersonId) return;
  safeRemove(cacheKey(salespersonId));
}

function safeRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore — see write rationale.
  }
}
