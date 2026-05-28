import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  badRequest,
  handleApiError,
  parseBody,
  requireAeToolAccess,
} from "@/lib/server/auth";
import { TASK_STATUSES } from "@/lib/ae-tasks";
import {
  assertCallerOwnsOffice,
  enrichTasksWithOfficeName,
  isOfficeLinkForeignKeyError,
} from "@/lib/server/ae-tasks";

// AE To-Do tasks — update one task.
//   PATCH /api/tasks/:id
//     body: { title?, description?, due_date?, status?, office_id? }
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
//
// OFFICE LINK
//   `office_id` is optional. Omitting it from the PATCH body PRESERVES
//   the existing back-link — a generic "save" from the AE task editor
//   that doesn't touch the link won't accidentally clear it. Sending
//   `null` explicitly clears the link.

export const runtime = "nodejs";

const TASK_COLUMNS =
  "id, salesperson_id, title, description, due_date, status, office_id, created_at, updated_at, completed_at";

const dueDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "due_date must be in YYYY-MM-DD format.")
  .refine((value) => !Number.isNaN(Date.parse(value)), "due_date is not a real date.");

const UpdateTaskSchema = z.object({
  title: z.string().trim().min(1, "Title cannot be empty.").max(200).optional(),
  description: z.string().trim().max(2000).nullish(),
  due_date: dueDateSchema.nullish(),
  status: z.enum(TASK_STATUSES).optional(),
  /** Set to a UUID to relink; set to null to explicitly clear; omit
   *  entirely to preserve the existing value. */
  office_id: z.uuid().nullish(),
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

    // Pre-validate a non-null office_id BEFORE the update — see the
    // matching block in POST /api/tasks for the rationale. Explicit
    // null (clear the link) and omission (preserve the link) both
    // skip the check; only a caller-supplied UUID needs verification.
    if (typeof body.office_id === "string") {
      await assertCallerOwnsOffice(supabase, body.office_id, me);
    }

    // Only write fields the request actually included. `undefined` means
    // "not provided"; an explicit null clears description / due_date /
    // office_id. (This is what preserves the office back-link across
    // unrelated edits — a save that only touches title doesn't send
    // office_id at all, so the column is left alone.)
    const patch: Record<string, unknown> = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.description !== undefined) {
      patch.description = body.description ?? null;
    }
    if (body.due_date !== undefined) patch.due_date = body.due_date ?? null;
    if (body.office_id !== undefined) {
      patch.office_id = body.office_id ?? null;
    }
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
      // Race condition: the office passed the pre-check but was
      // deleted (or RLS-pruned) before the UPDATE landed. Map the
      // FK violation back to the uniform 400 the pre-check uses.
      if (isOfficeLinkForeignKeyError(res.error)) {
        throw badRequest("Office link is invalid or no longer available.");
      }
      // Any other DB error — sanitize and log server-side. Raw
      // provider text never reaches the client.
      console.warn(
        `[ae-tasks] update failed task_id=${id} caller=${me.id} code=${res.error.code ?? "?"} msg=${res.error.message}`,
      );
      throw new ApiError(500, "Could not update task.");
    }
    if (!res.data || res.data.length === 0) {
      return Response.json({ error: "Task not found." }, { status: 404 });
    }
    const [enriched] = await enrichTasksWithOfficeName(supabase, [res.data[0]]);
    return Response.json({ task: enriched });
  } catch (err) {
    return handleApiError(err);
  }
}
