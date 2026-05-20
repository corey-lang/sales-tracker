import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError, notFound, requireAdmin } from "@/lib/server/auth";
import { TEAM_MESSAGES_TABLE, type TeamMessage } from "@/lib/team-messages";

// Juice Box — admin moderation. Soft-delete a single post.
//   DELETE /api/team-messages/:id   -> { message: TeamMessage }
//
// Admin-only. Soft delete (flipping is_deleted to true) is the wire format
// for moderation so the row stays around for any future audit needs; the
// realtime UPDATE event fires on flip and subscribed clients drop the
// message from view instantly without a separate delete signal.

export const runtime = "nodejs";

const MESSAGE_COLUMNS =
  "id, created_at, salesperson_id, salesperson_name, message, is_deleted";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin(req);
    const { id } = await params;
    const supabase = getServerSupabase();

    // The `is_deleted = false` filter makes the call idempotent and avoids a
    // no-op UPDATE that would still fire a realtime event for an already-
    // deleted row.
    const res = await supabase
      .from(TEAM_MESSAGES_TABLE)
      .update({ is_deleted: true })
      .eq("id", id)
      .eq("is_deleted", false)
      .select(MESSAGE_COLUMNS);

    if (res.error) {
      throw new Error(`Failed to delete message: ${res.error.message}`);
    }
    if (!res.data || res.data.length === 0) {
      throw notFound("Message not found.");
    }

    return Response.json({ message: res.data[0] as TeamMessage });
  } catch (err) {
    return handleApiError(err);
  }
}
