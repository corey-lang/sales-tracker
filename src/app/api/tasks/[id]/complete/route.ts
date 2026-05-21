import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError, requireAeToolAccess } from "@/lib/server/auth";

// AE To-Do tasks — mark one task complete.
//   POST /api/tasks/:id/complete   -> { task: AeTask }
//
// A convenience endpoint equivalent to PATCH { status: "done" }. AE-only:
// requireAeToolAccess rejects juice_box_only callers up front. Scoped to
// both the task id AND the authenticated salesperson, so an AE can only
// complete their own tasks; a missing or other-owned task returns 404.

export const runtime = "nodejs";

const TASK_COLUMNS =
  "id, salesperson_id, title, description, due_date, status, created_at, updated_at, completed_at";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireAeToolAccess(req);
    const { id } = await params;
    const supabase = getServerSupabase();

    const res = await supabase
      .from("ae_tasks")
      .update({ status: "done", completed_at: new Date().toISOString() })
      .eq("id", id)
      .eq("salesperson_id", me.id)
      .select(TASK_COLUMNS);

    if (res.error) {
      throw new Error(`Failed to complete task: ${res.error.message}`);
    }
    if (!res.data || res.data.length === 0) {
      return Response.json({ error: "Task not found." }, { status: 404 });
    }
    return Response.json({ task: res.data[0] });
  } catch (err) {
    return handleApiError(err);
  }
}
