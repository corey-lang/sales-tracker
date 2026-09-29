import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError, parseBody, requireAdmin } from "@/lib/server/auth";
import { GOLD_LIST_DISCUSSION_NOTE_MAX_LENGTH } from "@/lib/one-on-one-meetings";
import {
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
// Admin-only. Saves the manager's 1:1 DISCUSSION NOTE about one Gold List
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
