import {
  DEFAULT_JUICE_BOX_CHANNEL,
  FEED_PAGE_SIZE,
  type JuiceBoxChannel,
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
//   * Per-signed-in-salesperson AND per-channel — the key includes both the
//     salesperson_id and the channel id, so different users on the same device
//     never share state and switching channels can't paint the previous
//     channel's posts. There is no unscoped fallback key.
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
  /** Pins the cache to one channel. Belt-and-braces next to the per-channel
   *  key: a blob that somehow lands under the wrong key is discarded rather
   *  than rendered in the wrong tab. */
  channel: JuiceBoxChannel;
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
 * v3: channels. Messages gained `channel` and the key gained a channel
 *     segment. A v2 blob has neither, so bumping (rather than migrating it
 *     into General) keeps the invalidation trivial — the next fetch repaints
 *     within a few hundred ms.
 */
const CACHE_VERSION = 3;

/**
 * Cache TTL. 12 hours hits the spec target — long enough that returning
 * users in the same day get an instant paint, short enough that a stale
 * snapshot never lingers across days when the team's been active.
 */
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

function cacheKey(salespersonId: string, channel: JuiceBoxChannel): string {
  return `${CACHE_KEY_PREFIX}${salespersonId}:${channel}`;
}

/** The pre-channels key shape (`juice-box:feed:<id>`). Its v2 blobs can never
 *  be read again after the version bump, so the General read path deletes it
 *  once to reclaim the quota instead of leaving it to rot. */
function legacyCacheKey(salespersonId: string): string {
  return `${CACHE_KEY_PREFIX}${salespersonId}`;
}

function isCachedFeed(
  x: unknown,
  salespersonId: string,
  channel: JuiceBoxChannel,
): x is CachedFeed {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    o.version === CACHE_VERSION &&
    typeof o.cachedAt === "number" &&
    o.salespersonId === salespersonId &&
    o.channel === channel &&
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
export function readCachedFeed(
  salespersonId: string,
  channel: JuiceBoxChannel = DEFAULT_JUICE_BOX_CHANNEL,
): CachedFeed | null {
  if (typeof window === "undefined") return null;
  if (!salespersonId) return null;
  const key = cacheKey(salespersonId, channel);

  // One-time cleanup of the pre-channels blob. Only attempted on the General
  // read (the channel that key used to represent) so it runs once per open,
  // not three times.
  if (channel === DEFAULT_JUICE_BOX_CHANNEL) {
    safeRemove(legacyCacheKey(salespersonId));
  }

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
  if (!isCachedFeed(parsed, salespersonId, channel)) {
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
  channel: JuiceBoxChannel,
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
    channel,
    hasMore,
    messages: trimmed,
  };
  try {
    window.localStorage.setItem(
      cacheKey(salespersonId, channel),
      JSON.stringify(payload),
    );
  } catch {
    // Quota / disabled — cache is an optimization, not a requirement.
  }
}

/** Best-effort cache removal for one channel — used on sign-out flows if/when
 *  wired. Pass no channel to clear General. */
export function clearCachedFeed(
  salespersonId: string,
  channel: JuiceBoxChannel = DEFAULT_JUICE_BOX_CHANNEL,
): void {
  if (typeof window === "undefined") return;
  if (!salespersonId) return;
  safeRemove(cacheKey(salespersonId, channel));
}

function safeRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore — see write rationale.
  }
}
