import { createAgentSchema } from "@/lib/gold-list-validation";
import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError, parseBody, requireAdmin } from "@/lib/server/auth";
import { createGoldListAgent } from "@/lib/server/gold-list";
import {
  assertInProgress,
  loadWorkspaceGoldList,
  requireMeeting,
} from "@/lib/server/one-on-one-meetings";

// POST /api/admin/one-on-one-meetings/[id]/gold-list
//   body: same as POST /api/gold-list/agents (agent_name, brokerage, phone,
//         email, notes, request_id, confirm_duplicate)
//   -> { agent } (201 created / 200 replay)  or  { duplicates }
//
// Admin-only. Adds an agent to the 1:1's AE's REAL Gold List while the manager
// is in a 1:1 with them — not a meeting-only copy. Deliberately narrow:
//   * the caller must be an admin who can see the meeting's AE
//     (requireMeeting — another admin's private test AE is a 404);
//   * the meeting must be in progress;
//   * the owner is the MEETING'S AE, never anything in the request body.
// The write is the shared createGoldListAgent() the AE route runs (same
// validation, duplicate check and idempotent request_id). The INSERT stamps
// `created_by` (the manager) and `created_in_meeting_id` (this 1:1) in the
// same statement; the DB takes the meeting lock in a trigger and refuses it
// if the meeting is completing or completed. That attribution is what the
// completed record shows as "Added during this 1:1".

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireAdmin(req);
    const { id } = await params;
    const body = await parseBody(req, createAgentSchema);
    const supabase = getServerSupabase();
    const meeting = await requireMeeting(supabase, id, me);
    assertInProgress(meeting);

    const result = await createGoldListAgent(supabase, meeting.ae_id, body, me.id, {
      actorId: me.id,
      meetingId: meeting.id,
    });
    if (result.kind === "duplicates") {
      return Response.json({ duplicates: result.duplicates });
    }
    const [agent] = await loadWorkspaceGoldList(supabase, [result.agent], me, true);
    return Response.json({ agent }, { status: result.kind === "created" ? 201 : 200 });
  } catch (err) {
    return handleApiError(err);
  }
}
