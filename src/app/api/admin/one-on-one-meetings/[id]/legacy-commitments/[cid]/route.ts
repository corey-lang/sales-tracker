import {
  LEGACY_DROP_PATCH,
  LegacyCommitmentUpdateSchema,
  buildLegacyCommitmentPatch,
} from "@/lib/legacy-commitments";
import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  handleApiError,
  notFound,
  parseBody,
  requireAdmin,
} from "@/lib/server/auth";
import type { WeeklyFocusCommitment } from "@/lib/one-on-ones";
import {
  assertInProgress,
  requireMeeting,
  throwIfFrozen,
} from "@/lib/server/one-on-one-meetings";

// PATCH  /api/admin/one-on-one-meetings/[id]/legacy-commitments/[cid]
// DELETE /api/admin/one-on-one-meetings/[id]/legacy-commitments/[cid]
//   -> { commitment: WeeklyFocusCommitment }
//
// Admin-only. A legacy Weekly Focus commitment (listed as carryover in the
// 1:1) checked off, reopened, edited, or dropped FROM the in-progress 1:1
// `[id]`. Same body and rules as the original
// /api/admin/one-on-ones/[week]/commitments/[cid] route
// (lib/legacy-commitments.ts); DELETE is the same soft drop.
//
// The difference is WHEN it may land: the write runs inside
// update_legacy_commitment_in_one_on_one(), which takes the 1:1's lock first.
// So it either commits before that 1:1 is completed (and is in its frozen
// snapshot) or is refused with 409 once completion has started — it can never
// land after the snapshot as part of the meeting. The commitment must belong
// to the meeting's AE.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function apply(
  params: Promise<{ id: string; cid: string }>,
  patch: Record<string, unknown>,
  me: { id: string },
): Promise<Response> {
  const { id, cid } = await params;
  const supabase = getServerSupabase();
  const meeting = await requireMeeting(supabase, id, me);
  assertInProgress(meeting);
  const res = await supabase.rpc("update_legacy_commitment_in_one_on_one", {
    p_meeting_id: meeting.id,
    p_commitment_id: cid,
    p_patch: patch,
  });
  if (res.error) {
    if (res.error.code === "P0002") throw notFound("Commitment not found.");
    throwIfFrozen(res.error);
    throw new ApiError(500, `Could not save the commitment: ${res.error.message}`);
  }
  if (!res.data) throw notFound("Commitment not found.");
  return Response.json({ commitment: res.data as WeeklyFocusCommitment });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; cid: string }> },
) {
  try {
    const me = await requireAdmin(req);
    const body = await parseBody(req, LegacyCommitmentUpdateSchema);
    const patch = buildLegacyCommitmentPatch(body);
    if (!patch) throw new ApiError(400, "No fields to update.");
    return await apply(params, patch, me);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; cid: string }> },
) {
  try {
    const me = await requireAdmin(req);
    return await apply(params, { ...LEGACY_DROP_PATCH }, me);
  } catch (err) {
    return handleApiError(err);
  }
}
