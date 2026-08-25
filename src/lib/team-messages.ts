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

/**
 * One image attached to a Juice Box post. Persisted as an element of the
 * `media_attachments` JSONB array on team_messages (see
 * juice_box_multi_image.sql). Only image posts use this; GIF posts and
 * text-only posts have `media_attachments` = null.
 *
 * For posts created BEFORE juice_box_multi_image.sql ran, the array is
 * also null even when `media_type='image'` — the single image is in the
 * `media_*` columns. `teamMessageMediaList` papers over that difference.
 */
export type TeamMessageAttachment = {
  url: string;
  storage_path: string;
  width: number | null;
  height: number | null;
  alt: string | null;
};

/** Hard cap on attachments per post. Mirrors the server-side Zod check
 *  in /api/team-messages POST. Picked to keep the upload+post round trip
 *  tractable on a phone and the rendered grid readable in the feed. */
export const MAX_IMAGES_PER_POST = 10;

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/**
 * Stable channel identifier stored in `team_messages.channel` and
 * `team_message_reads.channel`. Kept in lockstep with the CHECK constraints in
 * supabase/juice_box_channels.sql — adding a value here means adding it there.
 */
export type JuiceBoxChannel = "general" | "product_help" | "social_media_hub";

/** The channel every message lives in unless told otherwise. Pre-channel posts
 *  were backfilled to this value, and any null/unknown value normalizes to it. */
export const DEFAULT_JUICE_BOX_CHANNEL: JuiceBoxChannel = "general";

/**
 * The three channels, in tab order. `label` is the tab + composer label;
 * `blurb` is the one-line purpose shown as the tab's title/tooltip and in the
 * empty state, so a newcomer can tell where a post belongs.
 */
export const JUICE_BOX_CHANNELS = [
  {
    id: "general",
    label: "General",
    blurb:
      "Team discussion, updates, announcements, celebrations, and everything else.",
  },
  {
    id: "product_help",
    label: "Product Help",
    blurb:
      "Coverage, pricing, plans, service questions, objections, and help answering agent questions.",
  },
  {
    id: "social_media_hub",
    label: "Social Media Hub",
    blurb:
      "Post ideas, captions, content requests, examples, marketing inspiration, and social wins.",
  },
] as const satisfies ReadonlyArray<{
  id: JuiceBoxChannel;
  label: string;
  blurb: string;
}>;

/** Just the ids, in tab order — handy for iterating per-channel state. */
export const JUICE_BOX_CHANNEL_IDS = JUICE_BOX_CHANNELS.map(
  (c) => c.id,
) as readonly JuiceBoxChannel[];

export const isJuiceBoxChannel = (v: unknown): v is JuiceBoxChannel =>
  v === "general" || v === "product_help" || v === "social_media_hub";

/**
 * Coerces any value into a channel, falling back to General.
 *
 * Used on every ingest boundary — DB rows, realtime payloads, cached client
 * blobs, query params — so a message written before
 * supabase/juice_box_channels.sql ran (or by an older client bundle) always
 * resolves to General rather than rendering channel-less. Server routes that
 * accept a channel from a REQUEST validate strictly (400) instead of
 * normalizing, so a typo'd channel is never silently redirected into General.
 */
export function normalizeChannel(v: unknown): JuiceBoxChannel {
  return isJuiceBoxChannel(v) ? v : DEFAULT_JUICE_BOX_CHANNEL;
}

/** Display label for a channel id (normalizes unknown input first). */
export function channelLabel(v: unknown): string {
  const id = normalizeChannel(v);
  return JUICE_BOX_CHANNELS.find((c) => c.id === id)!.label;
}

export type TeamMessage = {
  id: string;
  created_at: string;
  /** Which channel the post belongs to. Server-owned: on a reply it is copied
   *  from the parent, otherwise it is the validated channel the composer was
   *  posting in. Historical posts read as "general" (see normalizeChannel). */
  channel: JuiceBoxChannel;
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
   *  shape is always consistent. For multi-image posts the FIRST image
   *  is mirrored into these columns so historical readers + the
   *  reply-preview placeholder logic keep working unchanged. */
  media_type: MediaType | null;
  media_url: string | null;
  media_thumb_url: string | null;
  media_width: number | null;
  media_height: number | null;
  media_alt: string | null;
  media_provider: string | null;
  /** Multi-image attachments. Non-null only on image posts written after
   *  juice_box_multi_image.sql ran; null on every text-only post, every
   *  GIF post, and on historical single-image posts (the latter render
   *  from `media_*` via teamMessageMediaList's fallback branch). */
  media_attachments: TeamMessageAttachment[] | null;
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

/**
 * Returns every media slice attached to the post in display order — the
 * unified shape the feed and lightbox iterate over. Resolution order:
 *
 *   1. If `media_attachments` is non-empty, expand each entry into an
 *      image-typed slice. This is the multi-image path.
 *   2. Otherwise if `media_type` + `media_url` are set, return a single-
 *      element list built from the `media_*` columns. This covers GIFs
 *      (which never use attachments) and historical single-image posts
 *      written before juice_box_multi_image.sql.
 *   3. Otherwise return [] (text-only post).
 */
export function teamMessageMediaList(m: TeamMessage): TeamMessageMedia[] {
  if (m.media_attachments && m.media_attachments.length > 0) {
    return m.media_attachments.map((a) => ({
      type: "image" as const,
      url: a.url,
      thumb_url: null,
      width: a.width,
      height: a.height,
      alt: a.alt,
      provider: "supabase",
    }));
  }
  const single = teamMessageMedia(m);
  return single ? [single] : [];
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

/**
 * LEGACY per-user read-marker table — one row per salesperson, no channel
 * dimension (UNIQUE on `salesperson_id`).
 *
 * Left in place and untouched by the channels rollout so the previously
 * deployed bundle and any stale browser tab keep marking reads exactly as
 * before. The channel-aware code reads and writes
 * `TEAM_MESSAGE_CHANNEL_READS_TABLE` instead; this constant survives only for
 * the rollout-window compatibility write in POST /api/team-messages/reads/me.
 * It can be deleted together with the table in a future cleanup migration —
 * see supabase/juice_box_channels.sql.
 */
export const TEAM_MESSAGE_READS_TABLE = "team_message_reads";

/**
 * Per-CHANNEL read markers — one row per (salesperson_id, channel). Backs each
 * channel's "New messages" divider, its tab badge, and the combined nav badge.
 * Created and backfilled from the legacy table by
 * supabase/juice_box_channels.sql.
 */
export const TEAM_MESSAGE_CHANNEL_READS_TABLE = "team_message_channel_reads";

/**
 * ATOMIC, MONOTONIC mark-read RPCs (supabase/juice_box_channels.sql).
 *
 * Both stamp `now()` inside Postgres and apply
 * `last_read_at = GREATEST(existing, incoming)` in a single statement, so an
 * out-of-order write can never move a marker backwards — the race an
 * unconditional upsert had. Both RETURN the persisted timestamp, which is what
 * the API answers with. EXECUTE is granted to `service_role` only, so they are
 * reachable only through the server routes.
 *
 * `…LEGACY…` writes the pre-channels table and is called for GENERAL ONLY, as
 * a best-effort mirror; retire it with the legacy table.
 */
export const JUICE_BOX_MARK_CHANNEL_READ_RPC = "juice_box_mark_channel_read";
export const JUICE_BOX_MARK_LEGACY_READ_RPC = "juice_box_mark_legacy_read";

/**
 * Admin "Move conversation" RPC (supabase/juice_box_channels.sql). Moves a
 * whole reply tree between channels and writes the audit row in ONE
 * transaction. `EXECUTE` is granted to `service_role` only, so the sole caller
 * is POST /api/team-messages/:id/move behind `requireAdmin`.
 */
export const JUICE_BOX_MOVE_CONVERSATION_RPC = "juice_box_move_conversation";

/** Server-only audit table for conversation moves. No client reads it. */
export const JUICE_BOX_CONVERSATION_MOVES_TABLE = "juice_box_conversation_moves";

/**
 * What POST /api/team-messages/:id/move returns — the minimum the UI needs to
 * update itself and confirm what happened. Deliberately NO message bodies and
 * nothing administrative beyond the counts.
 */
export type MoveConversationResult = {
  /** The conversation's authoritative ROOT id, resolved server-side (the admin
   *  may have acted on a reply). */
  root_message_id: string;
  from_channel: JuiceBoxChannel;
  to_channel: JuiceBoxChannel;
  /** Root + every descendant that moved. */
  message_count: number;
  moved_at: string;
};

/** Shape of a single user's read marker for ONE channel, as returned by
 *  /api/team-messages/reads/me. */
export type TeamMessageRead = {
  channel: JuiceBoxChannel;
  last_read_at: string | null;
};

/** Per-channel unread slice: how many unread posts, and the marker they were
 *  counted against (null = this user has no read receipt for that channel). */
export type TeamMessageChannelUnread = {
  count: number;
  last_read_at: string | null;
};

/**
 * Shape of the unread summary returned by /api/team-messages/unread.
 *
 * `count` is the COMBINED total across every channel — that is what the
 * bottom-nav Juice Box badge shows. `channels` carries the per-channel
 * breakdown that the channel tabs and each channel's NEW MESSAGES divider
 * key off.
 *
 * `last_read_at` is retained as the GENERAL channel's marker so a client
 * bundle cached from before channels shipped keeps reading a sane value
 * instead of `undefined`.
 */
export type TeamMessageUnreadSummary = {
  count: number;
  last_read_at: string | null;
  channels: Record<JuiceBoxChannel, TeamMessageChannelUnread>;
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
