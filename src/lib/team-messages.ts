// Shared types + constants for the Juice Box team feed.
// Pure module — safe to import from server routes and "use client" components.

/**
 * One aggregate emoji reaction as rendered on a message card: which emoji,
 * how many people reacted with it, and whether the current viewer is one
 * of them. Hydrated server-side from team_message_reactions; updated
 * locally as realtime INSERT/DELETE events arrive.
 */
export type TeamMessageReaction = {
  emoji: string;
  count: number;
  reacted: boolean;
};

export type TeamMessage = {
  id: string;
  created_at: string;
  salesperson_id: string;
  salesperson_name: string;
  message: string;
  is_deleted: boolean;
  /** Set only when this post is a reply — points back to the quoted post.
   *  Nullable so non-reply posts keep an unchanged shape. No FK in Postgres
   *  so a soft-deleted parent doesn't cascade-null this pointer. */
  reply_to_message_id: string | null;
  /** Denormalized author name of the quoted post (captured at write time
   *  so the quoted block keeps rendering even after the parent is removed). */
  reply_to_salesperson_name: string | null;
  /** Truncated body of the quoted post (REPLY_PREVIEW_MAX_LENGTH chars). */
  reply_to_message_preview: string | null;
};

/** Maximum number of characters per post. Enforced server-side; mirrored in the UI. */
export const MESSAGE_MAX_LENGTH = 1000;

/** Most-recent-N rows fetched on initial load. Realtime appends after that. */
export const FEED_LIMIT = 200;

/**
 * Hard cap on the denormalized reply preview stored on a message. The full
 * parent body could be up to MESSAGE_MAX_LENGTH (1000 chars), but the quoted
 * block in the UI only ever shows 1-2 lines. Storing more is just dead bytes.
 */
export const REPLY_PREVIEW_MAX_LENGTH = 200;

/**
 * The closed set of emoji reactions Juice Box accepts. No emoji picker —
 * tapping any other character is rejected by the API. Order here is also
 * the order they render in the inline emoji bar on a card.
 */
export const ALLOWED_REACTIONS = [
  "😂",
  "🔥",
  "👏",
  "💪",
  "🍊",
  "❤️",
  "🧡",
  "‼️",
] as const;
export type ReactionEmoji = (typeof ALLOWED_REACTIONS)[number];
export const isAllowedReaction = (s: string): s is ReactionEmoji =>
  (ALLOWED_REACTIONS as readonly string[]).includes(s);

/**
 * The Supabase realtime channel + Postgres table both code paths subscribe to.
 * Kept in one place so the SQL migration, route, and client never drift.
 */
export const TEAM_MESSAGES_TABLE = "team_messages";
export const TEAM_MESSAGES_CHANNEL = "realtime:team_messages";

/** Reactions table + the channel the feed page subscribes to for live toggles. */
export const TEAM_MESSAGE_REACTIONS_TABLE = "team_message_reactions";
export const TEAM_MESSAGE_REACTIONS_CHANNEL =
  "realtime:team_message_reactions";

/**
 * A separate channel used by the global unread context — keeps its
 * subscription independent of the page-level feed subscription so both can
 * mount simultaneously without interfering.
 */
export const TEAM_MESSAGES_UNREAD_CHANNEL = "realtime:team_messages_unread";

/** The per-user read-marker table, backing the "New messages" divider + nav badge. */
export const TEAM_MESSAGE_READS_TABLE = "team_message_reads";

/** Shape of a single user's read marker as returned by /api/team-messages/reads/me. */
export type TeamMessageRead = {
  last_read_at: string | null;
};

/** Shape of the unread summary returned by /api/team-messages/unread. */
export type TeamMessageUnreadSummary = {
  count: number;
  last_read_at: string | null;
};

/** Raw reaction row as it arrives from the DB / realtime payload. */
export type TeamMessageReactionRow = {
  message_id: string;
  salesperson_id: string;
  emoji: string;
};
