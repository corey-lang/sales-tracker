import { createActivitySchema } from "@/lib/gold-list-validation";
import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError, parseBody, requireAdmin } from "@/lib/server/auth";
import { scheduleAgentActivity } from "@/lib/server/gold-list";
import {
  assertInProgress,
  loadWorkspaceGoldList,
  requireManagedAgent,
  requireMeeting,
} from "@/lib/server/one-on-one-meetings";

// POST /api/admin/one-on-one-meetings/[id]/gold-list/[agentId]/activities
//   body: same as POST /api/gold-list/agents/:id/activities
//   -> { activity, agent }
//
// Admin-only. Schedules the NEXT activity on the AE's REAL Gold List while
// the manager is in a 1:1 with them. This is the one widening of the Gold
// List's owner-only write rule, and it is deliberately narrow:
//   * the caller must be an admin;
//   * the meeting must be in progress;
//   * the agent must belong to that meeting's AE.
// The write itself is the shared scheduleAgentActivity() the AE route runs
// (same validation, one-open-activity rule, archive guard, idempotent
// request_id). The insert also stamps `created_by` (the manager) and
// `created_in_meeting_id` (this 1:1) in the SAME statement; the DB refuses it
// if the meeting completed in the meantime. That explicit attribution is what
// the completed record shows as "done in this 1:1".

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; agentId: string }> },
) {
  try {
    const me = await requireAdmin(req);
    const { id, agentId } = await params;
    const body = await parseBody(req, createActivitySchema);
    const supabase = getServerSupabase();
    const meeting = await requireMeeting(supabase, id, me);
    assertInProgress(meeting);
    const agent = await requireManagedAgent(supabase, meeting, agentId);

    const { activity, created } = await scheduleAgentActivity(
      supabase,
      agent,
      body,
      me.id,
      // Actor + the 1:1 this action is taken from, written in the same
      // statement as the Gold List change (see ManagerMeetingAction).
      { actorId: me.id, meetingId: meeting.id },
    );
    const [decorated] = await loadWorkspaceGoldList(supabase, [agent], me, true);
    return Response.json(
      { activity, agent: decorated },
      { status: created ? 201 : 200 },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
