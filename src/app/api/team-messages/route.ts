import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import { badRequest, handleApiError, parseBody } from "@/lib/server/auth";
import { requireJuiceBoxAccess } from "@/lib/server/juice-box";
import {
  FEED_PAGE_SIZE,
  MESSAGE_MAX_LENGTH,
  REPLY_PREVIEW_MAX_LENGTH,
  TEAM_MESSAGES_TABLE,
  TEAM_MESSAGE_REACTIONS_TABLE,
  type TeamMessage,
  type TeamMessageReaction,
  type TeamMessageReactionRow,
  type TeamMessageReactor,
} from "@/lib/team-messages";

// Juice Box live team feed — list + create.
//   GET  /api/team-messages[?before=ISO&limit=N]
//                              -> { messages: …[], hasMore: boolean }
//                                 oldest -> newest within the page
//   POST /api/team-messages    -> { message: TeamMessage & { reactions: [] } }
//
// PAGINATION
//   The feed is paginated backwards. The initial load fetches the most
//   recent FEED_PAGE_SIZE messages. The client supplies `?before=<ISO>`
//   (the created_at of the oldest currently-loaded message) on subsequent
//   "Load older" calls; the route returns up to `limit` messages older
//   than that timestamp. `hasMore` is true when the page returned exactly
//   `limit` rows — a heuristic that resolves to false on the empty page
//   the next click produces.
//
// ACCESS
//   Both verbs require the caller to be an admin OR the test account
//   (requireJuiceBoxAccess). Regular AEs receive 403 — matching the UI gate.
//
// IDENTITY
//   salesperson_id and salesperson_name come from the server-validated
//   session (me.id / me.first_name) — never from the request body. The
//   client cannot impersonate a teammate even by editing the POST payload.
//
// REPLY METADATA (Pass 4)
//   reply_to_salesperson_name and reply_to_message_preview are derived
//   server-side from the parent row — clients send only reply_to_message_id.
//   That way a teammate can't spoof "in reply to X" with arbitrary text.
//
// REACTION REACTORS (Pass 4 polish)
//   Each aggregated reaction now ships with the list of reactor names so
//   the "who reacted" detail popover can render without a second
//   round-trip per chip. Names are denormalized on team_message_reactions
//   at insert time, so this is just an extra column in the SELECT below.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MESSAGE_COLUMNS =
  "id, created_at, salesperson_id, salesperson_name, message, is_deleted, reply_to_message_id, reply_to_salesperson_name, reply_to_message_preview";

const CreateMessageSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1, "Message cannot be empty.")
    .max(MESSAGE_MAX_LENGTH, `Keep posts under ${MESSAGE_MAX_LENGTH} characters.`),
  reply_to_message_id: z.uuid().optional(),
});

/** Wire shape returned by both verbs — DB row plus the aggregated reactions. */
export type TeamMessageWithReactions = TeamMessage & {
  reactions: TeamMessageReaction[];
};

/**
 * Aggregates raw reaction rows into the per-message UI shape. Reactors are
 * grouped by message → emoji → name list. `reacted` is true if the caller
 * has a row in that (message, emoji) bucket. The route returns reactors
 * sorted by created_at (the SELECT below applies that order) so the chip-
 * detail popover lists names in the order people reacted.
 */
function aggregateReactions(
  rows: (TeamMessageReactionRow & { created_at?: string })[],
  callerId: string,
): Map<string, TeamMessageReaction[]> {
  // messageId -> emoji -> { count, reacted, reactors }
  const grouped = new Map<
    string,
    Map<
      string,
      {
        count: number;
        reacted: boolean;
        reactors: TeamMessageReactor[];
      }
    >
  >();

  for (const row of rows) {
    let perMessage = grouped.get(row.message_id);
    if (!perMessage) {
      perMessage = new Map();
      grouped.set(row.message_id, perMessage);
    }
    const reactor: TeamMessageReactor = {
      salesperson_id: row.salesperson_id,
      salesperson_name: row.salesperson_name,
    };
    const existing = perMessage.get(row.emoji);
    if (existing) {
      existing.count += 1;
      existing.reactors.push(reactor);
      if (row.salesperson_id === callerId) existing.reacted = true;
    } else {
      perMessage.set(row.emoji, {
        count: 1,
        reacted: row.salesperson_id === callerId,
        reactors: [reactor],
      });
    }
  }

  const result = new Map<string, TeamMessageReaction[]>();
  for (const [messageId, perMessage] of grouped) {
    const arr: TeamMessageReaction[] = [];
    for (const [emoji, agg] of perMessage) {
      arr.push({
        emoji,
        count: agg.count,
        reacted: agg.reacted,
        reactors: agg.reactors,
      });
    }
    // Stable chip ordering: count desc, emoji asc.
    arr.sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
    result.set(messageId, arr);
  }
  return result;
}

export async function GET(req: Request) {
  try {
    const me = await requireJuiceBoxAccess(req);
    const supabase = getServerSupabase();

    // Pagination — accept `?before=<ISO>&limit=N`. Both optional; the
    // initial page omits `before` and the route returns the most recent
    // FEED_PAGE_SIZE messages. `limit` is clamped to [1, 100] to keep a
    // single page bounded.
    const url = new URL(req.url);
    const beforeStr = url.searchParams.get("before");
    const limitStr = url.searchParams.get("limit");

    const parsedLimit = limitStr ? Number.parseInt(limitStr, 10) : NaN;
    const limit = Number.isFinite(parsedLimit)
      ? Math.max(1, Math.min(100, parsedLimit))
      : FEED_PAGE_SIZE;

    if (beforeStr && Number.isNaN(Date.parse(beforeStr))) {
      throw badRequest("Invalid 'before' query parameter.");
    }

    let query = supabase
      .from(TEAM_MESSAGES_TABLE)
      .select(MESSAGE_COLUMNS)
      .eq("is_deleted", false)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (beforeStr) {
      query = query.lt("created_at", beforeStr);
    }

    const res = await query;
    if (res.error) {
      throw new Error(`Failed to load messages: ${res.error.message}`);
    }

    const messages = ((res.data ?? []) as TeamMessage[]).slice().reverse();

    // Hydrate reactions for this page in one round-trip. Order by
    // created_at ASC so the aggregate's reactor list reads chronologically
    // — first to react appears first.
    let reactionsByMessage: Map<string, TeamMessageReaction[]> = new Map();
    if (messages.length > 0) {
      const ids = messages.map((m) => m.id);
      const reactionsRes = await supabase
        .from(TEAM_MESSAGE_REACTIONS_TABLE)
        .select("message_id, salesperson_id, salesperson_name, emoji, created_at")
        .in("message_id", ids)
        .order("created_at", { ascending: true });

      if (reactionsRes.error) {
        throw new Error(
          `Failed to load reactions: ${reactionsRes.error.message}`,
        );
      }

      reactionsByMessage = aggregateReactions(
        (reactionsRes.data ?? []) as (TeamMessageReactionRow & {
          created_at: string;
        })[],
        me.id,
      );
    }

    const hydrated: TeamMessageWithReactions[] = messages.map((m) => ({
      ...m,
      reactions: reactionsByMessage.get(m.id) ?? [],
    }));

    return Response.json({
      messages: hydrated,
      // Heuristic — when a full page came back, assume there's another
      // older page behind it. The next call returns either more rows or
      // nothing, which is when the client flips hasMore false.
      hasMore: hydrated.length === limit,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const me = await requireJuiceBoxAccess(req);
    const body = await parseBody(req, CreateMessageSchema);
    const supabase = getServerSupabase();

    // Reply metadata is server-derived from the parent so the client cannot
    // forge "in reply to X" with arbitrary text. The reply pointer is also
    // refused if the parent is gone — soft-deleted parents would otherwise
    // surface a misleading "(deleted)" preview.
    let replyMetadata: {
      reply_to_message_id: string;
      reply_to_salesperson_name: string;
      reply_to_message_preview: string;
    } | null = null;

    if (body.reply_to_message_id) {
      const parentRes = await supabase
        .from(TEAM_MESSAGES_TABLE)
        .select("id, salesperson_name, message, is_deleted")
        .eq("id", body.reply_to_message_id)
        .maybeSingle();

      if (parentRes.error) {
        throw new Error(`Failed to look up parent: ${parentRes.error.message}`);
      }
      if (!parentRes.data || parentRes.data.is_deleted) {
        throw badRequest("The post you tried to reply to is no longer available.");
      }

      const parent = parentRes.data as {
        id: string;
        salesperson_name: string;
        message: string;
      };

      replyMetadata = {
        reply_to_message_id: parent.id,
        reply_to_salesperson_name: parent.salesperson_name,
        reply_to_message_preview: parent.message.slice(
          0,
          REPLY_PREVIEW_MAX_LENGTH,
        ),
      };
    }

    const insertPayload: {
      salesperson_id: string;
      salesperson_name: string;
      message: string;
      reply_to_message_id: string | null;
      reply_to_salesperson_name: string | null;
      reply_to_message_preview: string | null;
    } = {
      salesperson_id: me.id,
      salesperson_name: me.first_name,
      message: body.message,
      reply_to_message_id: replyMetadata?.reply_to_message_id ?? null,
      reply_to_salesperson_name: replyMetadata?.reply_to_salesperson_name ?? null,
      reply_to_message_preview: replyMetadata?.reply_to_message_preview ?? null,
    };

    const res = await supabase
      .from(TEAM_MESSAGES_TABLE)
      .insert(insertPayload)
      .select(MESSAGE_COLUMNS)
      .single();

    if (res.error || !res.data) {
      throw new Error(res.error?.message ?? "Failed to post message.");
    }

    const message: TeamMessageWithReactions = {
      ...(res.data as TeamMessage),
      reactions: [],
    };

    return Response.json({ message }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
