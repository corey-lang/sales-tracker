import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  handleApiError,
  parseBody,
  requireAeToolAccess,
} from "@/lib/server/auth";
import { TASK_STATUSES } from "@/lib/ae-tasks";

// AE To-Do tasks — update one task.
//   PATCH /api/tasks/:id   body: { title?, description?, due_date?, status? }
//
// ACCESS
//   AE-only via requireAeToolAccess. juice_box_only callers (Travis,
//   Rizz, …) are rejected on the role check before the DB is touched.
//
// OWNERSHIP
//   The update is scoped to BOTH the task id AND
//   requireAeToolAccess(req).id, so an AE can only modify their own tasks.
//   A task that does not exist, or belongs to someone else, returns 404 —
//   the two cases are deliberately indistinguishable.

export const runtime = "nodejs";

const TASK_COLUMNS =
  "id, salesperson_id, title, description, due_date, status, created_at, updated_at, completed_at";

const dueDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "due_date must be in YYYY-MM-DD format.")
  .refine((value) => !Number.isNaN(Date.parse(value)), "due_date is not a real date.");

const UpdateTaskSchema = z.object({
  title: z.string().trim().min(1, "Title cannot be empty.").max(200).optional(),
  description: z.string().trim().max(2000).nullish(),
  due_date: dueDateSchema.nullish(),
  status: z.enum(TASK_STATUSES).optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireAeToolAccess(req);
    const { id } = await params;
    const body = await parseBody(req, UpdateTaskSchema);
    const supabase = getServerSupabase();

    // Only write fields the request actually included. `undefined` means
    // "not provided"; an explicit null clears description / due_date.
    const patch: Record<string, unknown> = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.description !== undefined) {
      patch.description = body.description ?? null;
    }
    if (body.due_date !== undefined) patch.due_date = body.due_date ?? null;
    if (body.status !== undefined) {
      patch.status = body.status;
      // completed_at tracks the 'done' state and is cleared when re-opened.
      patch.completed_at =
        body.status === "done" ? new Date().toISOString() : null;
    }

    if (Object.keys(patch).length === 0) {
      return Response.json(
        { error: "No fields to update." },
        { status: 400 },
      );
    }

    const res = await supabase
      .from("ae_tasks")
      .update(patch)
      .eq("id", id)
      .eq("salesperson_id", me.id)
      .select(TASK_COLUMNS);

    if (res.error) {
      throw new Error(`Failed to update task: ${res.error.message}`);
    }
    if (!res.data || res.data.length === 0) {
      return Response.json({ error: "Task not found." }, { status: 404 });
    }
    return Response.json({ task: res.data[0] });
  } catch (err) {
    return handleApiError(err);
  }
}
