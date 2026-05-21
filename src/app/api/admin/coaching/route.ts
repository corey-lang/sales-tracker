import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError, requireAdmin } from "@/lib/server/auth";
import { buildAeSummaries } from "@/lib/server/coaching";

// GET /api/admin/coaching
//
// Admin-only list of every AE plus the manager-coaching summary shown on
// the /admin/coaching index page (the AE picker). Sorted by current-week
// percent desc, then name. Excludes admins, assistants, and the test
// account — they don't get their own 1:1 surface.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const { summaries, error } = await buildAeSummaries(getServerSupabase());
    if (error) {
      return Response.json({ error }, { status: 500 });
    }
    return Response.json({ summaries });
  } catch (err) {
    return handleApiError(err);
  }
}
