import { updateActivitySchema } from "@/lib/gold-list-validation";
import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError, parseBody, requireAdmin } from "@/lib/server/auth";
import { updateAgentActivity } from "@/lib/server/gold-list";
import {
  assertInProgress,
  loadWorkspaceGoldList,
  requireManagedAgent,
  requireMeeting,
} from "@/lib/server/one-on-one-meetings";

// PATCH /api/admin/one-on-one-meetings/[id]/gold-list/[agentId]/activities/[aid]
//   body: same as PATCH /api/gold-list/agents/:id/activities/:aid
//   -> { activity, agent }
//
// Admin-only. Completes / reschedules / cancels the open activity on the AE's
// REAL Gold List from inside an in-progress 1:1 with that AE. Same narrow
// gate as the POST sibling; the write is the shared updateAgentActivity() the
// AE route runs (finished history stays immutable). The same UPDATE stamps
// `completed_by` and `closed_in_meeting_id` / `rescheduled_in_meeting_id`
// with this 1:1, and the DB refuses it if the meeting has completed.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; agentId: string; aid: string }> },
) {
  try {
    const me = await requireAdmin(req);
    const { id, agentId, aid } = await params;
    const body = await parseBody(req, updateActivitySchema);
    const supabase = getServerSupabase();
    const meeting = await requireMeeting(supabase, id, me);
    assertInProgress(meeting);
    const agent = await requireManagedAgent(supabase, meeting, agentId);

    const activity = await updateAgentActivity(
      supabase,
      agent,
      aid,
      body,
      me.id,
      // Actor + the 1:1 this action is taken from, written in the same
      // statement as the Gold List change (see ManagerMeetingAction).
      { actorId: me.id, meetingId: meeting.id },
    );
    const [decorated] = await loadWorkspaceGoldList(supabase, [agent], me, true);
    return Response.json({ activity, agent: decorated });
  } catch (err) {
    return handleApiError(err);
  }
}
