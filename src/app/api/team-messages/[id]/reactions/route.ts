import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  badRequest,
  handleApiError,
  notFound,
  parseBody,
} from "@/lib/server/auth";
import { requireJuiceBoxAccess } from "@/lib/server/juice-box";
import {
  isAllowedReaction,
  TEAM_MESSAGES_TABLE,
  TEAM_MESSAGE_REACTIONS_TABLE,
} from "@/lib/team-messages";

// Juice Box — toggle an emoji reaction on a single message.
//
//   POST /api/team-messages/:id/reactions   body: { emoji }
//                                            -> { added: boolean }
//
// SEMANTICS
//   Toggle: if the caller already has a (message, emoji) row, the row is
//   removed and `added: false` is returned; otherwise the row is inserted
//   and `added: true` is returned. The client does not need to track this
//   state separately — it can derive `reacted` from realtime echoes.
//
// ACCESS
//   Admin OR test only (requireJuiceBoxAccess). Identity from the signed
//   session — the route never reads salesperson_id from the request body.
//
// EMOJI WHITELIST
//   isAllowedReaction() is the single source of truth for which emoji are
//   accepted (Pass 4 picks 😂 🔥 👏 💪 🍊 ❤️ 🧡 ‼️). The route refuses
//   anything else with a 400; there is no emoji picker yet.
//
// PARENT MESSAGE GATE
//   Reactions on a soft-deleted message are refused — the message wouldn't
//   render in the feed anyway, and an admin who just removed a post should
//   not see new reactions arrive on it.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ToggleSchema = z.object({
  emoji: z.string().min(1),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireJuiceBoxAccess(req);
    const { id: messageId } = await params;
    const body = await parseBody(req, ToggleSchema);

    if (!isAllowedReaction(body.emoji)) {
      throw badRequest("That reaction isn't available.");
    }

    const supabase = getServerSupabase();

    // Guard: parent must exist and not be soft-deleted. The realtime echo
    // for a stale row would otherwise leak through to other clients.
    const parentRes = await supabase
      .from(TEAM_MESSAGES_TABLE)
      .select("id, is_deleted")
      .eq("id", messageId)
      .maybeSingle();

    if (parentRes.error) {
      throw new Error(
        `Failed to look up message: ${parentRes.error.message}`,
      );
    }
    if (!parentRes.data || parentRes.data.is_deleted) {
      throw notFound("Message not found.");
    }

    // Toggle: try to find an existing row. If present, delete it (= remove
    // the reaction). If absent, insert it (= add the reaction). Both
    // branches are idempotent against the realtime echo because INSERT and
    // DELETE both fire postgres_changes events with full row data
    // (team_message_reactions has REPLICA IDENTITY FULL).
    const existingRes = await supabase
      .from(TEAM_MESSAGE_REACTIONS_TABLE)
      .select("id")
      .eq("message_id", messageId)
      .eq("salesperson_id", me.id)
      .eq("emoji", body.emoji)
      .maybeSingle();

    if (existingRes.error) {
      throw new Error(
        `Failed to look up reaction: ${existingRes.error.message}`,
      );
    }

    if (existingRes.data) {
      const delRes = await supabase
        .from(TEAM_MESSAGE_REACTIONS_TABLE)
        .delete()
        .eq("id", (existingRes.data as { id: string }).id);

      if (delRes.error) {
        throw new Error(
          `Failed to remove reaction: ${delRes.error.message}`,
        );
      }
      return Response.json({ added: false });
    }

    const insRes = await supabase
      .from(TEAM_MESSAGE_REACTIONS_TABLE)
      .insert({
        message_id: messageId,
        salesperson_id: me.id,
        salesperson_name: me.first_name,
        emoji: body.emoji,
      });

    if (insRes.error) {
      // 23505 = unique_violation — a duplicate race between two tabs.
      // Treat as "already reacted, nothing to do" so the UI stays
      // truthful instead of flashing an error.
      if (/duplicate|23505/i.test(insRes.error.message)) {
        return Response.json({ added: true });
      }
      throw new Error(`Failed to add reaction: ${insRes.error.message}`);
    }

    return Response.json({ added: true }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
