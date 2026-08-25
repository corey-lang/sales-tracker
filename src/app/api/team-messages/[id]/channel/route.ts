import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  badRequest,
  handleApiError,
  notFound,
  requireSalesperson,
} from "@/lib/server/auth";
import {
  normalizeChannel,
  TEAM_MESSAGES_TABLE,
  type JuiceBoxChannel,
} from "@/lib/team-messages";

// Juice Box — which channel does this message live in?
//
//   GET /api/team-messages/:id/channel -> { id, channel }
//
// WHY THIS EXISTS
//   A deep link can name a message without naming its channel —
//   `/juice-box?message=<id>` from a copied URL, an older notification, or
//   anywhere a bare id gets shared. The client cannot guess: defaulting to
//   General and paging back through General's history will never find a
//   Product Help post, so the jump silently fails. This route answers the one
//   question the client needs before it mounts a feed.
//
// ACCESS / DISCLOSURE
//   * requireSalesperson — the SAME gate as the feed itself
//     (GET /api/team-messages), so this exposes nothing a caller couldn't
//     already read by opening Juice Box. Juice Box is a single team-wide feed;
//     there is no per-channel membership to enforce.
//   * The response carries ONLY the id and the channel — no author, no body,
//     no timestamps. A caller probing random ids learns at most "a live
//     message with this id exists, in this channel", which is strictly less
//     than the feed already tells them.
//   * Soft-deleted messages are treated as absent (404), matching every other
//     read path — a moderated post must not be locatable.
//
// The client must not trust a channel from anywhere else: the URL's own
// `channel` param is accepted only when it is one of the three known ids, and
// a bare `?message=` link resolves its channel HERE, through the session.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RFC 4122 form, same shape the feed's `reply_to_message_id` validates. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireSalesperson(req);
    const { id } = await params;

    // Validate the shape before touching the database — an unparseable id
    // would otherwise surface as a provider error (22P02) rather than a clean
    // 400, and the client's fallback should distinguish "bad link" from
    // "lookup failed".
    if (!UUID_RE.test(id)) {
      throw badRequest("Invalid message id.");
    }

    const supabase = getServerSupabase();
    const res = await supabase
      .from(TEAM_MESSAGES_TABLE)
      // Only the channel is selected. Nothing about the post's content or
      // author leaves the server.
      .select("id, channel, is_deleted")
      .eq("id", id)
      .maybeSingle();

    if (res.error) {
      // Provider text can carry schema/connection detail — logged, not
      // returned. Same posture as the rest of /api/team-messages.
      console.warn(
        `[team-messages] channel lookup failed caller=${me.id} message_id=${id} code=${res.error.code ?? "?"} msg=${res.error.message}`,
      );
      throw new ApiError(500, "Couldn't locate that message.");
    }

    const row = res.data as
      | { id: string; channel: string | null; is_deleted: boolean }
      | null;
    if (!row || row.is_deleted) {
      throw notFound("Message not found.");
    }

    // A post written before the channel column existed reads as General —
    // the same value the migration's DEFAULT gave every historical row.
    const channel: JuiceBoxChannel = normalizeChannel(row.channel);

    return Response.json(
      { id: row.id, channel },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
