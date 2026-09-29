import { getServerSupabase } from "@/lib/supabase/server";
import { badRequest, handleApiError, requireAdmin } from "@/lib/server/auth";
import { requireCoachableAe } from "@/lib/server/coaching";
import { loadMeetingHistory } from "@/lib/server/one-on-one-meetings";

// GET /api/admin/coaching/[ae_id]/meetings/history
//       [?before=<completed_at>&before_id=<id>]
//   -> { items: MeetingHistoryItem[], has_more: boolean }
//
// Admin-only. Pages through an AE's completed 1:1s, newest first, on the
// composite keyset (completed_at, id). The workspace GET ships the first
// page; "Load older" passes the last item's `completed_at` AND `id`.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ ae_id: string }> },
) {
  try {
    await requireAdmin(req);
    const { ae_id } = await params;
    const search = new URL(req.url).searchParams;
    const before = search.get("before");
    const beforeId = search.get("before_id");
    if ((before === null) !== (beforeId === null)) {
      throw badRequest("Send both before and before_id, or neither.");
    }
    if (before !== null && Number.isNaN(Date.parse(before))) {
      throw badRequest("before must be a timestamp.");
    }
    if (beforeId !== null && !UUID.test(beforeId)) {
      throw badRequest("before_id must be a 1:1 id.");
    }
    const supabase = getServerSupabase();
    const ae = await requireCoachableAe(supabase, ae_id);
    const page = await loadMeetingHistory(
      supabase,
      ae.id,
      before && beforeId ? { completed_at: before, id: beforeId } : null,
    );
    return Response.json(page, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
