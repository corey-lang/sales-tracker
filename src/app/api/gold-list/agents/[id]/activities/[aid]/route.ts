import { updateActivitySchema } from "@/lib/gold-list-validation";
import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError, parseBody } from "@/lib/server/auth";
import {
  requireGoldListAccess,
  requireOwnedAgent,
  updateAgentActivity,
} from "@/lib/server/gold-list";

// One activity on one Gold List agent.
//   PATCH /api/gold-list/agents/:id/activities/:aid
//     body: { status?, outcome_note?, description?, scheduled_for? }
//
// WHAT THIS ENDPOINT IS FOR
//   * Complete it        — { status: "completed", outcome_note?: "…" }
//   * Edit/reschedule it — { scheduled_for: "2026-10-02", description?: …,
//                           activity_note?: … }
//   * Cancel it          — { status: "cancelled" }
//   Finished activities cannot be reopened or edited.
//
//   The outcome note is OPTIONAL on completion — most completions are a tap.
//
// COMPLETING DOES NOT SCHEDULE THE NEXT ONE
//   The next activity is a separate POST to
//   /api/gold-list/agents/:id/activities, so the completed row stays in
//   history untouched. After completion the UI offers scheduling or skipping
//   the next activity; a later failure cannot undo the saved completion.
//
// OWNERSHIP
//   Owner-only, pinned on BOTH the parent agent and the activity row
//   (`updateAgentActivity` filters by id + agent_id + salesperson_id), so a
//   mismatched agent segment in the URL 404s instead of updating a row that
//   belongs to a different agent. The same writer serves the manager 1:1
//   route; only the authorization in front of it differs.
//
// completed_at
//   Set to NOW() on completion and cleared on any other status, matching the
//   DB CHECK that keeps `status` and `completed_at` from disagreeing.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; aid: string }> },
) {
  try {
    const me = await requireGoldListAccess(req);
    const { id, aid } = await params;
    const body = await parseBody(req, updateActivitySchema);
    const supabase = getServerSupabase();

    // Ownership of the parent first, so a bad agent id reads as "not found"
    // before we look at the activity at all. The shared writer then pins the
    // activity to this agent AND its owner.
    const parent = await requireOwnedAgent(supabase, id, me);
    const activity = await updateAgentActivity(supabase, parent, aid, body, me.id);
    return Response.json({ activity });
  } catch (err) {
    return handleApiError(err);
  }
}
