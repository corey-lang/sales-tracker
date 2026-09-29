import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  handleApiError,
  notFound,
  requireAdmin,
} from "@/lib/server/auth";
import { requireVisibleSalesperson } from "@/lib/server/roster";

// DELETE /api/admin/goals/[id]
//
// Admin-only. Deletes ONE historic weekly_goals row by id, paired with
// the new POST route now that `weekly_goals` is RLS-locked from the
// anon key (see supabase/weekly_goals_lockdown.sql).
//
// The goals table has no soft-archive lifecycle — it's an append-only
// history of "what was active when". Deletion here is intentional and
// matches the existing Admin Goals card's pre-lockdown behavior.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireAdmin(req);
    const { id } = await params;
    const supabase = getServerSupabase();

    // Ownership first: a goal row for someone the admin can't see (another
    // admin's private test account) is indistinguishable from a missing one.
    const found = await supabase
      .from("weekly_goals")
      .select("id, salesperson_id")
      .eq("id", id)
      .maybeSingle();
    if (found.error) {
      throw new ApiError(500, `Could not load goal: ${found.error.message}`);
    }
    const row = found.data as { salesperson_id: string | null } | null;
    if (!row) throw notFound("Goal not found.");
    if (row.salesperson_id) {
      await requireVisibleSalesperson(
        supabase,
        me,
        row.salesperson_id,
        "Goal not found.",
      );
    }

    const res = await supabase.from("weekly_goals").delete().eq("id", id);
    if (res.error) {
      throw new ApiError(500, `Could not delete goal: ${res.error.message}`);
    }
    return Response.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
