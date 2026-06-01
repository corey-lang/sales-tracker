import { getServerSupabase } from "@/lib/supabase/server";
import { ApiError, handleApiError, requireAdmin } from "@/lib/server/auth";

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
    await requireAdmin(req);
    const { id } = await params;
    const supabase = getServerSupabase();
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
