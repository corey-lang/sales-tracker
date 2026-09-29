import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError, requireAdmin } from "@/lib/server/auth";
import {
  completeMeeting,
  loadMeetingRecord,
  requireMeeting,
} from "@/lib/server/one-on-one-meetings";

// POST /api/admin/one-on-one-meetings/[id]/complete  -> MeetingRecord
//
// Admin-only. Finalizes an in-progress 1:1 into a durable, read-only record:
// freezes the Last Week / This Week comparison (with the goals and scores
// that applied), snapshots every Gold List agent discussed and the actions
// explicitly attributed to this 1:1, writes a frozen review of every
// commitment, and flips the status — all in one database transaction
// (complete_one_on_one_meeting). A failed attempt leaves a retryable draft.
//
// IDEMPOTENT: completing an already-completed meeting returns its existing
// record (200, unchanged), so a retry after a lost response is safe.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireAdmin(req);
    const { id } = await params;
    const supabase = getServerSupabase();
    const meeting = await requireMeeting(supabase, id);
    const completed = await completeMeeting(supabase, meeting, me);
    return Response.json(await loadMeetingRecord(supabase, completed));
  } catch (err) {
    return handleApiError(err);
  }
}
