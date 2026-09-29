import { z } from "zod";

import { dateSchema } from "@/lib/gold-list-validation";
import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  handleApiError,
  parseBody,
  requireAdmin,
} from "@/lib/server/auth";
import {
  COMMITMENT_OWNERS,
  MEETING_COMMITMENT_MAX_LENGTH,
  MEETING_COMMITMENTS_TABLE,
  type MeetingCommitment,
} from "@/lib/one-on-one-meetings";
import {
  assertInProgress,
  requireMeeting,
  throwIfFrozen,
} from "@/lib/server/one-on-one-meetings";

// POST /api/admin/one-on-one-meetings/[id]/commitments
//   body: { description, owner?: "ae" | "manager", due_date?: yyyy-mm-dd | null }
//   -> { commitment }
//
// Admin-only. Adds a commitment/follow-up to an IN-PROGRESS 1:1. The
// commitment's AE is always the meeting's AE (never read from the body), and
// the meeting becomes its permanent `origin_meeting_id`. Open commitments
// surface automatically as carryover in the AE's next 1:1.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  description: z
    .string()
    .trim()
    .min(1, "Commitment cannot be empty.")
    .max(MEETING_COMMITMENT_MAX_LENGTH),
  owner: z.enum(COMMITMENT_OWNERS).default("ae"),
  due_date: dateSchema.nullish(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireAdmin(req);
    const { id } = await params;
    const body = await parseBody(req, CreateSchema);
    const supabase = getServerSupabase();
    const meeting = await requireMeeting(supabase, id, me);
    assertInProgress(meeting);

    const res = await supabase
      .from(MEETING_COMMITMENTS_TABLE)
      .insert({
        ae_id: meeting.ae_id,
        origin_meeting_id: meeting.id,
        description: body.description,
        owner: body.owner,
        due_date: body.due_date ?? null,
        status: "open",
      })
      .select("*")
      .single();
    // The DB trigger refuses a meeting that completed after our check above.
    throwIfFrozen(res.error);
    if (res.error || !res.data) {
      throw new ApiError(
        500,
        `Could not add the commitment: ${res.error?.message ?? "unknown error"}`,
      );
    }
    return Response.json(
      { commitment: res.data as MeetingCommitment },
      { status: 201 },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
