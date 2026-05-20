import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError, parseBody } from "@/lib/server/auth";
import { requireJuiceBoxAccess } from "@/lib/server/juice-box";
import {
  FEED_LIMIT,
  MESSAGE_MAX_LENGTH,
  TEAM_MESSAGES_TABLE,
  type TeamMessage,
} from "@/lib/team-messages";

// Juice Box live team feed — list + create.
//   GET  /api/team-messages   -> { messages: TeamMessage[] }   oldest -> newest
//   POST /api/team-messages   -> { message: TeamMessage }
//
// ACCESS
//   Both verbs require the caller to be an admin OR the test account
//   (requireJuiceBoxAccess). Regular AEs receive 403 — matching the UI gate.
//
// IDENTITY
//   salesperson_id and salesperson_name come from the server-validated
//   session (me.id / me.first_name) — never from the request body. The
//   client cannot impersonate a teammate even by editing the POST payload.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MESSAGE_COLUMNS =
  "id, created_at, salesperson_id, salesperson_name, message, is_deleted";

const CreateMessageSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1, "Message cannot be empty.")
    .max(MESSAGE_MAX_LENGTH, `Keep posts under ${MESSAGE_MAX_LENGTH} characters.`),
});

export async function GET(req: Request) {
  try {
    await requireJuiceBoxAccess(req);
    const supabase = getServerSupabase();

    // Fetch the most recent FEED_LIMIT live (non-deleted) messages with DESC
    // order so the cap reliably keeps the newest window, then reverse before
    // returning so the client renders oldest -> newest (chat/feed style).
    const res = await supabase
      .from(TEAM_MESSAGES_TABLE)
      .select(MESSAGE_COLUMNS)
      .eq("is_deleted", false)
      .order("created_at", { ascending: false })
      .limit(FEED_LIMIT);

    if (res.error) {
      throw new Error(`Failed to load messages: ${res.error.message}`);
    }

    const messages = ((res.data ?? []) as TeamMessage[]).slice().reverse();
    return Response.json({ messages });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const me = await requireJuiceBoxAccess(req);
    const body = await parseBody(req, CreateMessageSchema);
    const supabase = getServerSupabase();

    const res = await supabase
      .from(TEAM_MESSAGES_TABLE)
      .insert({
        salesperson_id: me.id,
        salesperson_name: me.first_name,
        message: body.message,
      })
      .select(MESSAGE_COLUMNS)
      .single();

    if (res.error || !res.data) {
      throw new Error(res.error?.message ?? "Failed to post message.");
    }

    return Response.json(
      { message: res.data as TeamMessage },
      { status: 201 },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
