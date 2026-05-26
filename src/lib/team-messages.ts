// Shared types + constants for the Juice Box team feed.
// Pure module — safe to import from server routes and "use client" components.

/** Identity slice of a reactor, denormalized on the reaction row so the
 *  client can render reactor names in the chip-detail popover without a
 *  second round-trip per chip. */
export type TeamMessageReactor = {
  salesperson_id: string;
  salesperson_name: string;
};

/**
 * One aggregate emoji reaction as rendered on a message card: which emoji,
 * how many people reacted with it, whether the current viewer is one of
 * them, and the list of reactor names for the chip-detail popover.
 * Hydrated server-side from team_message_reactions; updated locally as
 * realtime INSERT/UPDATE/DELETE events arrive (each carries the full row
 * with salesperson_name thanks to REPLICA IDENTITY FULL).
 */
export type TeamMessageReaction = {
  emoji: string;
  count: number;
  reacted: boolean;
  /** Names of all users who reacted with this emoji on this message.
   *  Length == count. Ordered by created_at when hydrated from the
   *  server; new reactors are appended as realtime events arrive. */
  reactors: TeamMessageReactor[];
};

/**
 * Closed set of media kinds Juice Box posts can carry. Mirrors the
 * team_messages_media_type_allowed CHECK constraint in
 * juice_box_pass5_media.sql.
 */
export type MediaType = "image" | "gif";

export const isMediaType = (s: string | null | undefined): s is MediaType =>
  s === "image" || s === "gif";

/** UI-facing slice of a post's media. Null when the post is text-only. */
export type TeamMessageMedia = {
  type: MediaType;
  url: string;
  thumb_url: string | null;
  width: number | null;
  height: number | null;
  alt: string | null;
  provider: string | null;
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
  /** Truncated body of the quoted post (REPLY_PREVIEW_MAX_LENGTH chars).
   *  When the parent had no text (media-only post), the server fills this
   *  with a localized placeholder like "📷 Image" / "🎬 GIF" so the
   *  quoted block isn't empty. */
  reply_to_message_preview: string | null;
  /** Media attachment fields. All null on text-only posts; the two
   *  required halves (type, url) are CHECK-paired in the DB so the wire
   *  shape is always consistent. */
  media_type: MediaType | null;
  media_url: string | null;
  media_thumb_url: string | null;
  media_width: number | null;
  media_height: number | null;
  media_alt: string | null;
  media_provider: string | null;
};

/** Returns the post's media as a single slice if it has one, else null. */
export function teamMessageMedia(m: TeamMessage): TeamMessageMedia | null {
  if (!m.media_type || !m.media_url) return null;
  return {
    type: m.media_type,
    url: m.media_url,
    thumb_url: m.media_thumb_url,
    width: m.media_width,
    height: m.media_height,
    alt: m.media_alt,
    provider: m.media_provider,
  };
}

/** Max client-accepted file size for image uploads. Mirrors the bucket's
 *  file_size_limit in juice_box_pass5_media.sql so the client can reject
 *  oversized files BEFORE round-tripping to the signed-upload route. */
export const MEDIA_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

/** Allowed image MIME types. Mirrors the bucket's allowed_mime_types so
 *  the client can pre-validate and `<input accept="">` matches what the
 *  server (and Storage) will actually accept. */
export const MEDIA_ALLOWED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

/** Single GIF search/trending result, normalized for the UI. The server
 *  proxy flattens the provider's response (currently GIPHY) into a
 *  provider-neutral shape that fits the composer's grid + composer-
 *  preview without further unpacking. Renaming or swapping providers
 *  should stay localized to src/lib/server/<provider>.ts. */
export type GifResult = {
  /** Provider id (currently a GIPHY result id). The client posts this
   *  back as `gif_id` and the server re-fetches by id to derive the
   *  authoritative media fields — never trusts a client-supplied URL. */
  id: string;
  /** Alt text — provider's alt_text/title with a "GIF" fallback. */
  alt: string;
  /** Full-size GIF URL for the lightbox view. */
  full_url: string;
  /** Smaller URL for the picker grid + in-feed render. Always set so
   *  the picker doesn't have to fall back to the full URL on a slow
   *  connection. */
  preview_url: string;
  width: number;
  height: number;
};

/** Bucket name for Juice Box image uploads — kept in one place so the
 *  SQL migration, signed-upload route, and client never drift. */
export const JUICE_BOX_MEDIA_BUCKET = "juice-box-media";

/** Maximum number of characters per post. Enforced server-side; mirrored in the UI. */
export const MESSAGE_MAX_LENGTH = 1000;

/**
 * Page size for the feed. The initial load fetches the most-recent N
 * messages; "Load older posts" pages backwards by the same amount using a
 * `before=<ISO>` query parameter. Kept on the small side because a long
 * mobile feed is the wrong default for a team chat.
 */
export const FEED_PAGE_SIZE = 50;

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
 *
 * 👍 was added in the one-reaction-per-user revision. 🎉 / 🚀 / 🙌 / 🏆
 * were appended in the culture-polish pass to give the team more
 * Elevate-flavored ways to react (Celebrate / Momentum / Let's Go /
 * Winner). Existing emojis kept their slots so historical reactions
 * still render in the same position. The DB CHECK constraint is kept in
 * lockstep — first in juice_box_pass4_conversations.sql, then expanded
 * in juice_box_expand_reactions.sql.
 */
export const ALLOWED_REACTIONS = [
  "👍",
  "😂",
  "🔥",
  "👏",
  "💪",
  "🍊",
  "❤️",
  "🧡",
  "‼️",
  "🎉",
  "🚀",
  "🙌",
  "🏆",
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

/** Raw reaction row as it arrives from the DB / realtime payload. The
 *  realtime postgres_changes events include salesperson_name (it's a
 *  column on team_message_reactions, denormalized at insert time), so the
 *  client can keep its reactor-name map current without a refetch. */
export type TeamMessageReactionRow = {
  message_id: string;
  salesperson_id: string;
  salesperson_name: string;
  emoji: string;
};
