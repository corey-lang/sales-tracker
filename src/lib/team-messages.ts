// Shared types + constants for the Juice Box team feed.
// Pure module — safe to import from server routes and "use client" components.

export type TeamMessage = {
  id: string;
  created_at: string;
  salesperson_id: string;
  salesperson_name: string;
  message: string;
  is_deleted: boolean;
};

/** Maximum number of characters per post. Enforced server-side; mirrored in the UI. */
export const MESSAGE_MAX_LENGTH = 1000;

/** Most-recent-N rows fetched on initial load. Realtime appends after that. */
export const FEED_LIMIT = 200;

/**
 * The Supabase realtime channel + Postgres table both code paths subscribe to.
 * Kept in one place so the SQL migration, route, and client never drift.
 */
export const TEAM_MESSAGES_TABLE = "team_messages";
export const TEAM_MESSAGES_CHANNEL = "realtime:team_messages";

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
