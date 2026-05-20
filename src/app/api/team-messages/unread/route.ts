import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError } from "@/lib/server/auth";
import { requireJuiceBoxAccess } from "@/lib/server/juice-box";
import {
  TEAM_MESSAGES_TABLE,
  TEAM_MESSAGE_READS_TABLE,
  type TeamMessageUnreadSummary,
} from "@/lib/team-messages";

// Juice Box — unread summary for the caller.
//
//   GET /api/team-messages/unread -> { count: number, last_read_at: string | null }
//
// The bottom-nav badge calls this on mount to seed its count. Realtime
// INSERT/UPDATE handlers maintain the count locally between fetches and
// fall back to this endpoint on DELETE (where the client can't tell
// whether the removed message was unread from realtime payload alone).
//
// ACCESS
//   Admin OR test only (requireJuiceBoxAccess). Identity from the signed
//   session — the route never reads salesperson_id from the request.
//
// COUNT SEMANTICS
//   - Non-deleted messages (is_deleted = false).
//   - created_at > last_read_at, or every visible message if the user has
//     never marked read (last_read_at is null).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const me = await requireJuiceBoxAccess(req);
    const supabase = getServerSupabase();

    // One round-trip for the marker; second one for the count.
    const readRes = await supabase
      .from(TEAM_MESSAGE_READS_TABLE)
      .select("last_read_at")
      .eq("salesperson_id", me.id)
      .maybeSingle();

    if (readRes.error) {
      throw new Error(`Failed to load read marker: ${readRes.error.message}`);
    }

    const lastReadAt =
      (readRes.data?.last_read_at as string | undefined) ?? null;

    // Pure HEAD count — no row data shipped back, matches the
    // idx_team_messages_live_created_at partial index path.
    let query = supabase
      .from(TEAM_MESSAGES_TABLE)
      .select("id", { count: "exact", head: true })
      .eq("is_deleted", false);

    if (lastReadAt) {
      query = query.gt("created_at", lastReadAt);
    }

    const countRes = await query;
    if (countRes.error) {
      throw new Error(
        `Failed to count unread messages: ${countRes.error.message}`,
      );
    }

    const payload: TeamMessageUnreadSummary = {
      count: countRes.count ?? 0,
      last_read_at: lastReadAt,
    };
    return Response.json(payload);
  } catch (err) {
    return handleApiError(err);
  }
}
