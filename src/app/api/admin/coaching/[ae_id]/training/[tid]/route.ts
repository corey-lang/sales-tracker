import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  handleApiError,
  notFound,
  parseBody,
  requireAdmin,
} from "@/lib/server/auth";
import { requireCoachableAe } from "@/lib/server/coaching";
import {
  COMMITMENT_CONTENT_MAX_LENGTH,
  TRAINING_COMMITMENTS_TABLE,
  type TrainingCommitment,
} from "@/lib/one-on-ones";

// PATCH /api/admin/coaching/[ae_id]/training/[tid]   -> { training: ... }
// DELETE /api/admin/coaching/[ae_id]/training/[tid]  -> { ok: true }
//
// Admin-only. Mirrors the one-on-one-commitments PATCH/DELETE shape.
// Lookup pins BOTH `tid` and `ae_id` so the URL's parent segment is a
// real ownership check — hitting a mismatched (ae_id, tid) pair returns
// 404 instead of silently editing another AE's training row.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UpdateSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, "Training item cannot be empty.")
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
  { params }: { params: Promise<{ ae_id: string; tid: string }> },
) {
  try {
    await requireAdmin(req);
    const { ae_id, tid } = await params;
    const body = await parseBody(req, UpdateSchema);

    const supabase = getServerSupabase();
    await requireCoachableAe(supabase, ae_id);

    const patch: Record<string, unknown> = {};
    if (body.content !== undefined) patch.content = body.content;
    if (body.due_date !== undefined) patch.due_date = body.due_date ?? null;
    if (body.completed !== undefined) {
      patch.completed = body.completed;
      patch.completed_at = body.completed ? new Date().toISOString() : null;
    }
    if (Object.keys(patch).length === 0) {
      return Response.json({ error: "No fields to update." }, { status: 400 });
    }

    const res = await supabase
      .from(TRAINING_COMMITMENTS_TABLE)
      .update(patch)
      .eq("id", tid)
      .eq("ae_id", ae_id)
      .select("*")
      .maybeSingle();
    if (res.error) throw new Error(res.error.message);
    if (!res.data) throw notFound("Training item not found.");
    return Response.json({ training: res.data as TrainingCommitment });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ ae_id: string; tid: string }> },
) {
  try {
    await requireAdmin(req);
    const { ae_id, tid } = await params;
    const supabase = getServerSupabase();
    await requireCoachableAe(supabase, ae_id);
    const res = await supabase
      .from(TRAINING_COMMITMENTS_TABLE)
      .delete()
      .eq("id", tid)
      .eq("ae_id", ae_id);
    if (res.error) throw new Error(res.error.message);
    return Response.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
