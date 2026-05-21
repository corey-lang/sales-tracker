import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  handleApiError,
  parseBody,
  requireAeToolAccess,
} from "@/lib/server/auth";
import { isTaskStatus } from "@/lib/ae-tasks";

// AE To-Do tasks — list + create.
//   GET  /api/tasks            -> { tasks: AeTask[] }   (optional ?status=open)
//   POST /api/tasks            -> { task: AeTask }
//
// OWNERSHIP
//   Every query is scoped to requireAeToolAccess(req).id — the salesperson
//   from the signed session token. An AE only ever sees or creates their own
//   tasks; salesperson_id is never read from the request body or query string.
//
// ACCESS
//   AE-only. juice_box_only accounts (Travis, Rizz, …) have no To-Do
//   surface — requireAeToolAccess rejects them with a 403 so a direct
//   fetch can't bypass the UI redirect.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Columns returned for a task — matches the AeTask shape in lib/ae-tasks.ts. */
const TASK_COLUMNS =
  "id, salesperson_id, title, description, due_date, status, created_at, updated_at, completed_at";

/** A yyyy-mm-dd date string that also parses to a real calendar date. */
const dueDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "due_date must be in YYYY-MM-DD format.")
  .refine((value) => !Number.isNaN(Date.parse(value)), "due_date is not a real date.");

const CreateTaskSchema = z.object({
  title: z.string().trim().min(1, "Title is required.").max(200),
  description: z.string().trim().max(2000).nullish(),
  due_date: dueDateSchema.nullish(),
});

export async function GET(req: Request) {
  try {
    const me = await requireAeToolAccess(req);
    const supabase = getServerSupabase();

    const statusParam = new URL(req.url).searchParams.get("status");
    if (statusParam !== null && !isTaskStatus(statusParam)) {
      return Response.json(
        { error: "Invalid status filter — expected open, done, or cancelled." },
        { status: 400 },
      );
    }

    let query = supabase
      .from("ae_tasks")
      .select(TASK_COLUMNS)
      .eq("salesperson_id", me.id);

    if (statusParam !== null) {
      query = query.eq("status", statusParam);
    }

    // Soonest due first; tasks with no due date last; newest created as tiebreak.
    const res = await query
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false });

    if (res.error) {
      throw new Error(`Failed to load tasks: ${res.error.message}`);
    }
    return Response.json({ tasks: res.data ?? [] });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const me = await requireAeToolAccess(req);
    const body = await parseBody(req, CreateTaskSchema);
    const supabase = getServerSupabase();

    const res = await supabase
      .from("ae_tasks")
      .insert({
        // Owner is the authenticated salesperson — never a client-supplied id.
        salesperson_id: me.id,
        title: body.title,
        description: body.description ?? null,
        due_date: body.due_date ?? null,
        status: "open",
      })
      .select(TASK_COLUMNS)
      .single();

    if (res.error || !res.data) {
      throw new Error(res.error?.message ?? "Failed to create task.");
    }
    return Response.json({ task: res.data }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
