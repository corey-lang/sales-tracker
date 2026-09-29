import { getServerSupabase } from "@/lib/supabase/server";
import { ApiError, handleApiError, requireAdmin } from "@/lib/server/auth";
import { requireVisibleSalesperson } from "@/lib/server/roster";

// DELETE /api/admin/working-day-adjustments/[id]
//
// Admin-only. Removes one working_day_adjustments row by id. Deleting a future
// adjustment simply restores those days; deleting a past one re-opens that
// historical week's pace — both are intentional admin corrections.

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

    // Ownership first: an adjustment for someone the admin can't see (another
    // admin's private test account) answers exactly like a missing one.
    const found = await supabase
      .from("working_day_adjustments")
      .select("id, salesperson_id")
      .eq("id", id)
      .maybeSingle();
    if (found.error) {
      console.error(
        `[working-days] delete lookup failed id=${id} code=${found.error.code ?? "?"} msg=${found.error.message}`,
      );
      throw new ApiError(500, "Could not delete working day adjustment.");
    }
    const row = found.data as { salesperson_id: string | null } | null;
    if (!row) throw new ApiError(404, "That adjustment no longer exists.");
    if (row.salesperson_id) {
      await requireVisibleSalesperson(
        supabase,
        me,
        row.salesperson_id,
        "That adjustment no longer exists.",
      );
    }
    // `.select()` returns the deleted rows so we can tell a real delete from a
    // no-op (id not found / already gone) and answer 404 instead of a
    // misleading ok:true.
    const res = await supabase
      .from("working_day_adjustments")
      .delete()
      .eq("id", id)
      .select("id");
    if (res.error) {
      // Raw provider text logged server-side only; caller gets a safe message.
      console.error(
        `[working-days] delete failed id=${id} code=${res.error.code ?? "?"} msg=${res.error.message}`,
      );
      throw new ApiError(500, "Could not delete working day adjustment.");
    }
    if (!res.data || res.data.length === 0) {
      throw new ApiError(404, "That adjustment no longer exists.");
    }
    return Response.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
