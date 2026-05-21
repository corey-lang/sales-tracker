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
  ONE_ON_ONE_COMMITMENTS_TABLE,
  type OneOnOneCommitment,
} from "@/lib/one-on-ones";

// PATCH /api/admin/one-on-ones/[id]/commitments/[cid]   -> { commitment: ... }
// DELETE /api/admin/one-on-ones/[id]/commitments/[cid]  -> { ok: true }
//
// Admin-only. The DB lookup pins BOTH `cid` and `one_on_one_id = id` so
// the URL's parent segment is enforced as a real ownership check — a
// mismatched pair returns 404 instead of silently editing a commitment
// that lives on a different meeting.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UpdateSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, "Commitment cannot be empty.")
    .max(COMMITMENT_CONTENT_MAX_LENGTH)
    .optional(),
  completed: z.boolean().optional(),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "due_date must be YYYY-MM-DD.")
    .nullish(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; cid: string }> },
) {
  try {
    await requireAdmin(req);
    const { id, cid } = await params;
    const body = await parseBody(req, UpdateSchema);

    const patch: Record<string, unknown> = {};
    if (body.content !== undefined) patch.content = body.content;
    if (body.due_date !== undefined) patch.due_date = body.due_date ?? null;
    if (body.completed !== undefined) {
      patch.completed = body.completed;
      // Stamp completed_at on the transition so an undone item drops the
      // timestamp too — useful for any future "completed this week" stat.
      patch.completed_at = body.completed ? new Date().toISOString() : null;
    }
    if (Object.keys(patch).length === 0) {
      return Response.json({ error: "No fields to update." }, { status: 400 });
    }

    const supabase = getServerSupabase();
    const res = await supabase
      .from(ONE_ON_ONE_COMMITMENTS_TABLE)
      .update(patch)
      .eq("id", cid)
      .eq("one_on_one_id", id)
      .select("*")
      .maybeSingle();
    if (res.error) throw new Error(res.error.message);
    if (!res.data) throw notFound("Commitment not found.");
    return Response.json({ commitment: res.data as OneOnOneCommitment });
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
    const res = await supabase
      .from(ONE_ON_ONE_COMMITMENTS_TABLE)
      .delete()
      .eq("id", cid)
      .eq("one_on_one_id", id);
    if (res.error) throw new Error(res.error.message);
    return Response.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
