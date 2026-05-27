import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  badRequest,
  handleApiError,
  parseBody,
  requireAeToolAccess,
} from "@/lib/server/auth";
import { isTaskStatus } from "@/lib/ae-tasks";
import {
  assertCallerOwnsOffice,
  enrichTasksWithOfficeName,
  isOfficeLinkForeignKeyError,
} from "@/lib/server/ae-tasks";

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
//
// OFFICE LINK
//   A task may carry an optional `office_id` (added in
//   ae_tasks_office_link.sql). Set on create from the office-detail
//   page's "Also add to my AE To-Dos" checkbox. The route enriches
//   every response with `office_name` so the UI can render a tappable
//   "From office: <name>" line without a second round trip per task.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Columns returned for a task — matches the AeTask shape in lib/ae-tasks.ts.
 *  `office_id` was added in migration #31 (ae_tasks_office_link.sql);
 *  `office_name` is synthesized below via enrichTasksWithOfficeName. */
const TASK_COLUMNS =
  "id, salesperson_id, title, description, due_date, status, office_id, created_at, updated_at, completed_at";

/** A yyyy-mm-dd date string that also parses to a real calendar date. */
const dueDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "due_date must be in YYYY-MM-DD format.")
  .refine((value) => !Number.isNaN(Date.parse(value)), "due_date is not a real date.");

const CreateTaskSchema = z.object({
  title: z.string().trim().min(1, "Title is required.").max(200),
  description: z.string().trim().max(2000).nullish(),
  due_date: dueDateSchema.nullish(),
  /** Optional back-link to the source office. The DB enforces it
   *  resolves to a real `offices` row via the FK; we only validate
   *  shape here. */
  office_id: z.uuid().nullish(),
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
    const enriched = await enrichTasksWithOfficeName(supabase, res.data ?? []);
    return Response.json({ tasks: enriched });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const me = await requireAeToolAccess(req);
    const body = await parseBody(req, CreateTaskSchema);
    const supabase = getServerSupabase();

    // Pre-validate the office link BEFORE the insert. Without this
    // check a bad UUID would only be caught by the FK constraint
    // (Postgres 23503) and surface as a generic 500 with raw DB
    // text. assertCallerOwnsOffice replaces that with a uniform
    // 400 "Office link is invalid or no longer available." for the
    // bad-link case and a sanitized 500 for transient DB errors.
    // Null / undefined office_id (the common manual-task case)
    // skips the check entirely so manual tasks pay no extra round
    // trip.
    if (typeof body.office_id === "string") {
      await assertCallerOwnsOffice(supabase, body.office_id, me.id);
    }

    const res = await supabase
      .from("ae_tasks")
      .insert({
        // Owner is the authenticated salesperson — never a client-supplied id.
        salesperson_id: me.id,
        title: body.title,
        description: body.description ?? null,
        due_date: body.due_date ?? null,
        status: "open",
        // Office back-link, pre-validated above when present. The DB
        // FK is still in place as belt-and-braces for a race where
        // the office is deleted between the assert and the insert.
        office_id: body.office_id ?? null,
      })
      .select(TASK_COLUMNS)
      .single();

    if (res.error) {
      // Race condition: the office passed the pre-check but was
      // deleted (or RLS-pruned) before the INSERT landed. The DB FK
      // catches it as 23503; we map back to the same uniform 400
      // the pre-check uses so the client never sees raw FK text.
      if (isOfficeLinkForeignKeyError(res.error)) {
        throw badRequest("Office link is invalid or no longer available.");
      }
      // Any other DB error — sanitize and log server-side. Raw
      // provider text (schema names, query fragments, connection
      // state) never reaches the client.
      console.warn(
        `[ae-tasks] insert failed caller=${me.id} code=${res.error.code ?? "?"} msg=${res.error.message}`,
      );
      throw new ApiError(500, "Could not create task.");
    }
    if (!res.data) {
      console.warn(`[ae-tasks] insert returned no data caller=${me.id}`);
      throw new ApiError(500, "Could not create task.");
    }
    const [enriched] = await enrichTasksWithOfficeName(supabase, [res.data]);
    return Response.json({ task: enriched }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
