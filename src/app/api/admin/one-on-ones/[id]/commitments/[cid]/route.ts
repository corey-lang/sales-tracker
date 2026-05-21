import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  handleApiError,
  notFound,
  parseBody,
  requireAdmin,
} from "@/lib/server/auth";
import {
  COMMITMENT_CONTENT_MAX_LENGTH,
  COMMITMENT_STATUSES,
  WEEKLY_FOCUS_COMMITMENTS_TABLE,
  type WeeklyFocusCommitment,
} from "@/lib/one-on-ones";

// PATCH /api/admin/one-on-ones/[id]/commitments/[cid]   -> { commitment: ... }
// DELETE /api/admin/one-on-ones/[id]/commitments/[cid]  -> { commitment: ... }
//
// Admin-only.
//
// PATCH accepts:
//   - status:    'open' | 'completed' | 'dropped'   (authoritative lifecycle)
//   - completed: boolean                            (LEGACY — maps to status)
//   - content:   string
//   - due_date:  YYYY-MM-DD | null
//
// DELETE never hard-deletes. Coaching history matters, so "remove from
// active focus" is modeled as `status = 'dropped'` — the row stays
// queryable but stops surfacing as active/carryover. To truly delete a
// commitment a service-role caller can act on the row directly; the UI
// never does.
//
// The DB lookup pins BOTH `cid` and `one_on_one_id = id` so the URL's
// parent segment is enforced as a real ownership check — a mismatched
// pair returns 404 instead of silently editing a commitment that lives
// on a different week.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UpdateSchema = z
  .object({
    content: z
      .string()
      .trim()
      .min(1, "Commitment cannot be empty.")
      .max(COMMITMENT_CONTENT_MAX_LENGTH)
      .optional(),
    status: z.enum(COMMITMENT_STATUSES).optional(),
    completed: z.boolean().optional(),
    due_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "due_date must be YYYY-MM-DD.")
      .nullish(),
  })
  .refine(
    // Disallow both fields at once — they describe the same lifecycle
    // axis and an inconsistent pair (status=dropped + completed=true)
    // would be ambiguous. Status is authoritative; clients should send
    // that going forward.
    (b) => !(b.status !== undefined && b.completed !== undefined),
    { message: "Send either `status` or `completed`, not both." },
  );

/**
 * Translates a PATCH body into the columns to write. Status is the
 * authoritative lifecycle field; the legacy `completed` boolean and
 * `completed_at` timestamp are kept in sync from it so any external
 * report query that still filters on `completed = true` stays correct.
 */
function buildLifecyclePatch(input: {
  status?: (typeof COMMITMENT_STATUSES)[number];
  completed?: boolean;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let nextStatus: (typeof COMMITMENT_STATUSES)[number] | undefined;
  if (input.status !== undefined) {
    nextStatus = input.status;
  } else if (input.completed !== undefined) {
    nextStatus = input.completed ? "completed" : "open";
  }
  if (nextStatus === undefined) return out;
  out.status = nextStatus;
  out.completed = nextStatus === "completed";
  // Stamp completed_at on the transition so an undone item drops the
  // timestamp too. Dropped commitments never set completed_at.
  out.completed_at =
    nextStatus === "completed" ? new Date().toISOString() : null;
  return out;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; cid: string }> },
) {
  try {
    await requireAdmin(req);
    const { id, cid } = await params;
    const body = await parseBody(req, UpdateSchema);

    const patch: Record<string, unknown> = {
      ...buildLifecyclePatch(body),
    };
    if (body.content !== undefined) patch.content = body.content;
    if (body.due_date !== undefined) patch.due_date = body.due_date ?? null;
    if (Object.keys(patch).length === 0) {
      return Response.json({ error: "No fields to update." }, { status: 400 });
    }

    const supabase = getServerSupabase();
    const res = await supabase
      .from(WEEKLY_FOCUS_COMMITMENTS_TABLE)
      .update(patch)
      .eq("id", cid)
      .eq("one_on_one_id", id)
      .select("*")
      .maybeSingle();
    if (res.error) throw new Error(res.error.message);
    if (!res.data) throw notFound("Commitment not found.");
    return Response.json({ commitment: res.data as WeeklyFocusCommitment });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; cid: string }> },
) {
  try {
    await requireAdmin(req);
    const { id, cid } = await params;
    const supabase = getServerSupabase();
    // Soft-delete: mark status='dropped' instead of removing the row.
    // Preserves coaching history; the UI's trash affordance is really
    // "remove from active focus", not "erase from history".
    const res = await supabase
      .from(WEEKLY_FOCUS_COMMITMENTS_TABLE)
      .update({ status: "dropped", completed: false, completed_at: null })
      .eq("id", cid)
      .eq("one_on_one_id", id)
      .select("*")
      .maybeSingle();
    if (res.error) throw new Error(res.error.message);
    if (!res.data) throw notFound("Commitment not found.");
    return Response.json({ commitment: res.data as WeeklyFocusCommitment });
  } catch (err) {
    return handleApiError(err);
  }
}
