import { z } from "zod";

import { dateSchema } from "@/lib/gold-list-validation";
import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  handleApiError,
  notFound,
  parseBody,
  requireAdmin,
} from "@/lib/server/auth";
import {
  COMMITMENT_OWNERS,
  MEETING_COMMITMENT_MAX_LENGTH,
  MEETING_COMMITMENT_STATUSES,
  MEETING_COMMITMENTS_TABLE,
  resolutionFor,
  type MeetingCommitment,
} from "@/lib/one-on-one-meetings";
import {
  assertInProgress,
  requireMeeting,
  throwIfFrozen,
} from "@/lib/server/one-on-one-meetings";

// PATCH  /api/admin/one-on-one-meetings/[id]/commitments/[cid] -> { commitment }
// DELETE /api/admin/one-on-one-meetings/[id]/commitments/[cid] -> { ok: true }
//
// Admin-only. `[id]` is the IN-PROGRESS meeting the manager is working in —
// the context of the change — and `[cid]` any live commitment of that
// meeting's AE: one made in this meeting, or carryover from an earlier one.
//
// CARRYOVER RESOLUTION
//   Completing (or dropping) a carryover commitment here records THIS meeting
//   in `resolved_in_meeting_id`, while `origin_meeting_id` keeps where it was
//   made. The earlier meeting's frozen review still shows it open, as it was
//   then; this meeting's review will show it resolved. Reopening clears the
//   resolution.
//
//   A carryover commitment's wording/owner/due date belong to the meeting
//   that made it, so only its status can change here. Commitments made in
//   this meeting are fully editable, and — since nothing historical refers to
//   them yet — DELETE removes a mistaken one outright. Anything older is
//   closed with status "dropped" instead, never deleted.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UpdateSchema = z.object({
  description: z
    .string()
    .trim()
    .min(1, "Commitment cannot be empty.")
    .max(MEETING_COMMITMENT_MAX_LENGTH)
    .optional(),
  owner: z.enum(COMMITMENT_OWNERS).optional(),
  due_date: dateSchema.nullish(),
  status: z.enum(MEETING_COMMITMENT_STATUSES).optional(),
});

/** The in-progress meeting + one of its AE's commitments. Call after requireAdmin. */
async function load(params: Promise<{ id: string; cid: string }>) {
  const { id, cid } = await params;
  const supabase = getServerSupabase();
  const meeting = await requireMeeting(supabase, id);
  assertInProgress(meeting);
  // Pinned to the meeting's AE: a commitment belonging to anyone else 404s.
  const res = await supabase
    .from(MEETING_COMMITMENTS_TABLE)
    .select("*")
    .eq("id", cid)
    .eq("ae_id", meeting.ae_id)
    .maybeSingle();
  if (res.error) {
    throw new ApiError(500, `Could not load the commitment: ${res.error.message}`);
  }
  if (!res.data) throw notFound("Commitment not found.");
  return { supabase, meeting, commitment: res.data as MeetingCommitment };
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; cid: string }> },
) {
  try {
    await requireAdmin(req);
    const body = await parseBody(req, UpdateSchema);
    const { supabase, meeting, commitment } = await load(params);
    const isOwn = commitment.origin_meeting_id === meeting.id;

    const patch: Record<string, unknown> = {};
    const editsWording =
      body.description !== undefined ||
      body.owner !== undefined ||
      body.due_date !== undefined;
    if (editsWording && !isOwn) {
      throw new ApiError(
        409,
        "Carryover commitments keep their original wording. Complete or drop it, and add a new one if it changed.",
      );
    }
    if (body.description !== undefined) patch.description = body.description;
    if (body.owner !== undefined) patch.owner = body.owner;
    if (body.due_date !== undefined) patch.due_date = body.due_date ?? null;
    if (body.status !== undefined && body.status !== commitment.status) {
      patch.status = body.status;
      patch.completed_at =
        body.status === "completed" ? new Date().toISOString() : null;
      patch.resolved_in_meeting_id = resolutionFor(
        commitment,
        body.status,
        meeting.id,
      );
    }
    if (Object.keys(patch).length === 0) {
      return Response.json({ commitment });
    }

    const res = await supabase
      .from(MEETING_COMMITMENTS_TABLE)
      .update(patch)
      .eq("id", commitment.id)
      .eq("ae_id", meeting.ae_id)
      .select("*")
      .maybeSingle();
    // The DB trigger refuses a change inside a meeting that has completed,
    // even if it completed after the in-progress check above.
    throwIfFrozen(res.error);
    if (res.error) {
      throw new ApiError(500, `Could not save the commitment: ${res.error.message}`);
    }
    if (!res.data) throw notFound("Commitment not found.");
    return Response.json({ commitment: res.data as MeetingCommitment });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; cid: string }> },
) {
  try {
    await requireAdmin(req);
    const { supabase, meeting, commitment } = await load(params);
    if (commitment.origin_meeting_id !== meeting.id) {
      throw new ApiError(
        409,
        "Only commitments added in this 1:1 can be deleted. Drop older ones instead.",
      );
    }
    const res = await supabase
      .from(MEETING_COMMITMENTS_TABLE)
      .delete()
      .eq("id", commitment.id)
      .eq("origin_meeting_id", meeting.id);
    throwIfFrozen(res.error);
    if (res.error) {
      throw new ApiError(500, `Could not delete the commitment: ${res.error.message}`);
    }
    return Response.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
