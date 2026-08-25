import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  badRequest,
  handleApiError,
  notFound,
  parseBody,
  requireAdmin,
} from "@/lib/server/auth";
import {
  isJuiceBoxChannel,
  JUICE_BOX_MOVE_CONVERSATION_RPC,
  type MoveConversationResult,
} from "@/lib/team-messages";
import {
  isMissingChannelsMigration,
  migrationRequiredError,
} from "@/lib/server/juice-box-migration";

// Juice Box — admin moderation: move a whole CONVERSATION between channels.
//
//   POST /api/team-messages/:id/move   body { to_channel }
//     -> { root_message_id, from_channel, to_channel, message_count, moved_at }
//
// WHY A WHOLE CONVERSATION
//   Replies chain through `reply_to_message_id` and can nest arbitrarily, so a
//   conversation is a tree. Moving one message would leave replies pointing at
//   a parent in another channel — unreachable in the UI and a violation of the
//   server's own rule that a reply lives in its parent's channel. The RPC
//   therefore resolves the ROOT from whatever message was clicked and moves the
//   entire descendant tree in one transaction.
//
// AUTHORIZATION — server-side, not the menu
//   `requireAdmin` verifies the signed token, RE-READS the `salespeople` row
//   (so a demoted or deactivated admin loses this immediately) and 403s any
//   non-admin. Hiding the menu item is only cosmetic; this is the boundary.
//
//   NOTHING about the actor comes from the request: the audited administrator
//   is `me.id` from the session. A body claiming `salesperson_id`,
//   `moved_by`, `is_admin`, `from_channel` or `root_message_id` is rejected
//   outright by the strict schema — there is no field to smuggle them in.
//
//   The SOURCE channel and the ROOT id are likewise never accepted from the
//   client: the RPC derives both from the database under a row lock, so a
//   stale or hostile client cannot redirect the move or fake its origin.
//
// STATUS MAPPING (the RPC signals with SQLSTATEs — see the migration)
//   P0002 → 404  conversation missing, or soft-deleted (not visible)
//   JB001 → 409  already in the destination channel
//   JB002 → 409  the thread spans channels (unexpected split)
//   JB003 → 409  a reply was added mid-move; the whole move rolled back
//   JB004 → 400  invalid destination (also caught by zod below)
//   JB005 → 400  missing acting administrator (unreachable via this route)
//
// SIDE EFFECTS
//   None beyond the channel column and one audit row. No message is inserted or
//   deleted, so there are no duplicates and NO push notification — push only
//   fires from the create path in /api/team-messages.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RFC 4122, same shape the other message routes validate. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `.strict()` is load-bearing: it rejects any attempt to supply the actor, the
 *  source channel, or the root id. */
const MoveSchema = z
  .object({
    to_channel: z.enum(["general", "product_help", "social_media_hub"]),
  })
  .strict();

/** Maps the RPC's SQLSTATE to an HTTP error. Unknown codes stay a 500. */
function mapRpcError(err: { code?: string | null; message?: string | null }) {
  switch (err.code) {
    case "P0002":
      return notFound("That conversation is no longer available.");
    case "JB001":
      return new ApiError(409, "That conversation is already in that channel.");
    case "JB002":
      return new ApiError(
        409,
        "That conversation is split across channels — reload and try again.",
      );
    case "JB003":
      return new ApiError(
        409,
        "Someone replied while the move was running. Nothing was changed — try again.",
      );
    case "JB004":
      return badRequest("Unknown channel.");
    case "JB005":
      return badRequest("Missing acting administrator.");
    default:
      return null;
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Admin-only, re-read from the DB on every request.
    const me = await requireAdmin(req);
    const { id } = await params;
    if (!UUID_RE.test(id)) {
      throw badRequest("Invalid message id.");
    }

    const body = await parseBody(req, MoveSchema);
    const supabase = getServerSupabase();

    const res = await supabase.rpc(JUICE_BOX_MOVE_CONVERSATION_RPC, {
      p_message_id: id,
      p_to_channel: body.to_channel,
      // From the verified session — never the request.
      p_actor_salesperson_id: me.id,
    });

    if (res.error) {
      // Provider text can carry schema detail: logged, never returned.
      console.warn(
        `[team-messages] move failed admin=${me.id} message_id=${id} to=${body.to_channel} code=${res.error.code ?? "?"} msg=${res.error.message}`,
      );
      if (isMissingChannelsMigration(res.error)) throw migrationRequiredError();
      const mapped = mapRpcError(res.error);
      if (mapped) throw mapped;
      throw new ApiError(500, "Couldn't move that conversation.");
    }

    const data = res.data as MoveConversationResult | null;
    if (
      !data ||
      typeof data.root_message_id !== "string" ||
      !isJuiceBoxChannel(data.from_channel) ||
      !isJuiceBoxChannel(data.to_channel)
    ) {
      console.warn(
        `[team-messages] move returned an unexpected payload admin=${me.id} message_id=${id}`,
      );
      throw new ApiError(500, "Couldn't move that conversation.");
    }

    console.log(
      `[team-messages] conversation moved admin=${me.id} root=${data.root_message_id} ${data.from_channel}→${data.to_channel} messages=${data.message_count}`,
    );

    // Exactly the fields the client needs to reconcile its feeds. No message
    // bodies, no audit-table internals.
    const payload: MoveConversationResult = {
      root_message_id: data.root_message_id,
      from_channel: data.from_channel,
      to_channel: data.to_channel,
      message_count: Number(data.message_count) || 0,
      moved_at: data.moved_at,
    };
    return Response.json(payload, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
