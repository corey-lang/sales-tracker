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

// Juice Box — set / switch / clear a user's reaction on a single message.
//
//   POST /api/team-messages/:id/reactions   body: { emoji }
//                                            -> { reacted: string | null }
//
// SEMANTICS (one reaction per (message, user))
//   Each user can have AT MOST ONE reaction on a given message. The route
//   branches on the user's current row for that message:
//
//     no existing row                -> INSERT(emoji)   -> reacted = emoji
//     existing row, same emoji       -> DELETE(row)     -> reacted = null
//     existing row, different emoji  -> UPDATE(emoji)   -> reacted = emoji
//
//   The DB enforces the half of this rule that matters for integrity
//   (uq_team_message_reactions_one_per_user); this route enforces the
//   choice between insert/update/delete.
//
// ACCESS
//   Admin OR test only (requireJuiceBoxAccess). Identity from the signed
//   session — the route never reads salesperson_id from the request body.
//
// EMOJI WHITELIST
//   isAllowedReaction() is the single source of truth for which emoji are
//   accepted. The route refuses anything else with a 400 before any DB
//   call.
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

    // Lookup the caller's current reaction on this message — at most one
    // row thanks to uq_team_message_reactions_one_per_user. The realtime
    // INSERT/UPDATE/DELETE event that follows carries the full row data
    // (REPLICA IDENTITY FULL), so subscribed clients can reconcile counts
    // without a refetch regardless of which branch we take.
    const existingRes = await supabase
      .from(TEAM_MESSAGE_REACTIONS_TABLE)
      .select("id, emoji")
      .eq("message_id", messageId)
      .eq("salesperson_id", me.id)
      .maybeSingle();

    if (existingRes.error) {
      throw new Error(
        `Failed to look up reaction: ${existingRes.error.message}`,
      );
    }

    const existing = existingRes.data as
      | { id: string; emoji: string }
      | null;

    // --- Branch 1: no prior reaction → INSERT -------------------------------
    if (!existing) {
      const insRes = await supabase
        .from(TEAM_MESSAGE_REACTIONS_TABLE)
        .insert({
          message_id: messageId,
          salesperson_id: me.id,
          salesperson_name: me.first_name,
          emoji: body.emoji,
        });

      if (insRes.error) {
        // 23505 = unique_violation — a concurrent insert from another tab
        // beat us. Treat as success: the user ends with a reaction on this
        // message, which is the intent.
        if (/duplicate|23505/i.test(insRes.error.message)) {
          return Response.json({ reacted: body.emoji });
        }
        throw new Error(`Failed to add reaction: ${insRes.error.message}`);
      }

      return Response.json({ reacted: body.emoji }, { status: 201 });
    }

    // --- Branch 2: tapped the same emoji → DELETE (toggle off) --------------
    if (existing.emoji === body.emoji) {
      const delRes = await supabase
        .from(TEAM_MESSAGE_REACTIONS_TABLE)
        .delete()
        .eq("id", existing.id);

      if (delRes.error) {
        throw new Error(
          `Failed to remove reaction: ${delRes.error.message}`,
        );
      }
      return Response.json({ reacted: null });
    }

    // --- Branch 3: tapped a different emoji → UPDATE in place ---------------
    const updRes = await supabase
      .from(TEAM_MESSAGE_REACTIONS_TABLE)
      .update({ emoji: body.emoji })
      .eq("id", existing.id);

    if (updRes.error) {
      throw new Error(`Failed to switch reaction: ${updRes.error.message}`);
    }

    return Response.json({ reacted: body.emoji });
  } catch (err) {
    return handleApiError(err);
  }
}
