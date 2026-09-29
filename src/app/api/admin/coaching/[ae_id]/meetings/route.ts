import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError, requireAdmin } from "@/lib/server/auth";
import { requireCoachableAe } from "@/lib/server/coaching";
import {
  loadWorkspace,
  startOrResumeMeeting,
} from "@/lib/server/one-on-one-meetings";

// GET  /api/admin/coaching/[ae_id]/meetings  -> OneOnOneWorkspace
// POST /api/admin/coaching/[ae_id]/meetings  -> { meeting, created }
//
// Admin-only. The 1:1 workspace for one AE.
//
// GET is READ-ONLY: it never creates a meeting (unlike the legacy Weekly
// Focus GET, which auto-created a week row). It returns the in-progress
// draft if one exists, the last COMPLETED 1:1 (whenever it was), the
// completed history newest-first, the live Last Week / This Week comparison,
// the AE's live Gold List, open carryover commitments, and goal state for the
// collapsed goal editor.
//
// POST is "Start 1:1": it resumes the AE's in-progress meeting when there is
// one and creates it otherwise. Safe to call repeatedly — a refresh or double
// tap returns the same meeting (created: false).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ ae_id: string }> },
) {
  try {
    const me = await requireAdmin(req);
    const { ae_id } = await params;
    const supabase = getServerSupabase();
    const ae = await requireCoachableAe(supabase, ae_id, me);
    const workspace = await loadWorkspace(supabase, ae, me);
    return Response.json(workspace, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ ae_id: string }> },
) {
  try {
    const me = await requireAdmin(req);
    const { ae_id } = await params;
    const supabase = getServerSupabase();
    const ae = await requireCoachableAe(supabase, ae_id, me);
    const { meeting, created } = await startOrResumeMeeting(supabase, ae, me);
    return Response.json({ meeting, created }, { status: created ? 201 : 200 });
  } catch (err) {
    return handleApiError(err);
  }
}
