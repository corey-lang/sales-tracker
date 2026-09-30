import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError, parseBody, requireAdmin } from "@/lib/server/auth";
import { GOLD_LIST_DISCUSSION_NOTE_MAX_LENGTH } from "@/lib/one-on-one-meetings";
import { managerUpdateAgentSchema } from "@/lib/gold-list-validation";
import { updateGoldListAgent } from "@/lib/server/gold-list";
import { notFound } from "@/lib/server/auth";
import {
  loadWorkspaceGoldList,
  assertInProgress,
  requireManagedAgent,
  requireMeeting,
  saveGoldListDiscussionNote,
  toConflictResponse,
} from "@/lib/server/one-on-one-meetings";

// PUT /api/admin/one-on-one-meetings/[id]/gold-list/[agentId]
//   body: { note: string | null, expected_revision }
//   -> { note: GoldListDiscussionNote }   (409 + conflict on a stale revision)
//
// PATCH /api/admin/one-on-one-meetings/[id]/gold-list/[agentId]
//   body: { agent_name?, brokerage?, phone?, email?, notes? }
//   -> { agent }
//
// Admin-only. Edits the agent's details on the AE's REAL Gold List from an
// in-progress 1:1 (the shared updateGoldListAgent() the AE route runs, minus
// archiving). The UPDATE stamps `edited_by` / `edited_in_meeting_id` /
// `edited_at` in the same statement; the DB refuses it if the meeting is
// completing or completed.
//
// PUT saves the manager's 1:1 DISCUSSION NOTE about one Gold List
// agent for this meeting. This is meeting-specific, manager-only data kept
// in `one_on_one_gold_list_notes` — it is NOT written to the Gold List
// (agent notes / activity notes / outcome notes are untouched) and the AE's
// Gold List endpoints never read it. The agent must belong to the meeting's
// AE; the meeting must be in progress.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Schema = z.object({
  note: z.string().trim().max(GOLD_LIST_DISCUSSION_NOTE_MAX_LENGTH).nullable(),
  /** The note revision this save is based on (0 = no note yet). */
  expected_revision: z.number().int().min(0),
});

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string; agentId: string }> },
) {
  try {
    const me = await requireAdmin(req);
    const { id, agentId } = await params;
    const body = await parseBody(req, Schema);
    const supabase = getServerSupabase();
    const meeting = await requireMeeting(supabase, id, me);
    assertInProgress(meeting);
    const agent = await requireManagedAgent(supabase, meeting, agentId);
    const note = await saveGoldListDiscussionNote(
      supabase,
      meeting,
      agent,
      body.note,
      body.expected_revision,
    );
    return Response.json({ note });
  } catch (err) {
    return toConflictResponse(err) ?? handleApiError(err);
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; agentId: string }> },
) {
  try {
    const me = await requireAdmin(req);
    const { id, agentId } = await params;
    const body = await parseBody(req, managerUpdateAgentSchema);
    const supabase = getServerSupabase();
    const meeting = await requireMeeting(supabase, id, me);
    assertInProgress(meeting);
    const agent = await requireManagedAgent(supabase, meeting, agentId);
    const saved = await updateGoldListAgent(supabase, agent, body, me.id, {
      actorId: me.id,
      meetingId: meeting.id,
    });
    if (!saved) throw notFound("Gold List agent not found.");
    const [decorated] = await loadWorkspaceGoldList(supabase, [saved], me, true);
    return Response.json({ agent: decorated });
  } catch (err) {
    return handleApiError(err);
  }
}
