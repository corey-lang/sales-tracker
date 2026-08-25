import { ApiError } from "@/lib/server/auth";

// Recognizes "the Juice Box channels migration has not been applied yet".
//
// WHY THIS EXISTS
//   supabase/juice_box_channels.sql (migration #45) is applied by hand, and the
//   channel-aware code needs three things it adds: the `team_messages.channel`
//   column, the `team_message_channel_reads` table, and the two mark-read RPCs.
//   Against a database that predates it, PostgREST answers with a missing-
//   object error and every Juice Box request became an opaque
//   "Something went wrong." — which reads like a bug in the app and gives a
//   developer previewing the branch locally nothing to act on.
//
//   Mapping that ONE specific condition to a clear 503 keeps the failure honest
//   (no messages are invented, no unread state is faked, the feed still shows an
//   error state) while saying exactly what to do. Every other database error
//   keeps its existing generic 500.
//
// AFTER THE MIGRATION
//   Unreachable — the objects exist, so the error never occurs. This is not a
//   fallback data path and it never returns content; it only rewrites the error
//   a caller sees.
//
// Server-only.

/** Shown verbatim to the caller, so it has to be actionable. */
export const JUICE_BOX_MIGRATION_REQUIRED_MESSAGE =
  "Juice Box channels aren't set up on this database yet. Apply supabase/juice_box_channels.sql (migration #45), then reload.";

/** The objects migration #45 introduces. A missing-object error only counts as
 *  "migration required" when it names one of these — so an unrelated missing
 *  column elsewhere is never swallowed by this branch. */
const MIGRATION_OBJECTS = [
  "channel",
  "team_message_channel_reads",
  "juice_box_mark_channel_read",
  "juice_box_mark_legacy_read",
  "juice_box_move_conversation",
  "juice_box_conversation_moves",
];

/**
 * PostgREST / Postgres codes for "the thing you named does not exist":
 *   42703   undefined_column          (team_messages.channel)
 *   42883   undefined_function        (the mark-read RPCs, direct call)
 *   PGRST202 function not found in the schema cache
 *   PGRST204 column not found in the schema cache
 *   PGRST205 table not found in the schema cache
 */
const MISSING_OBJECT_CODES = new Set([
  "42703",
  "42883",
  "PGRST202",
  "PGRST204",
  "PGRST205",
]);

/**
 * True when `err` is a Supabase/PostgREST error saying one of migration #45's
 * objects is missing. Requires BOTH a missing-object code and a mention of one
 * of our new objects, so a coincidental error can't be misreported as
 * "migration required".
 */
export function isMissingChannelsMigration(
  err: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!err) return false;
  const code = err.code ?? "";
  if (!MISSING_OBJECT_CODES.has(code)) return false;
  const message = (err.message ?? "").toLowerCase();
  return MIGRATION_OBJECTS.some((object) => message.includes(object));
}

/** The 503 to throw for that condition. 503 (not 500) marks it as "this
 *  deployment isn't configured yet" rather than "the request broke". */
export function migrationRequiredError(): ApiError {
  return new ApiError(503, JUICE_BOX_MIGRATION_REQUIRED_MESSAGE);
}
