import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  handleApiError,
  parseBody,
  requireAdmin,
} from "@/lib/server/auth";
import { requireCoachableAe } from "@/lib/server/coaching";
import {
  COMMITMENT_CONTENT_MAX_LENGTH,
  TRAINING_COMMITMENTS_TABLE,
  type TrainingCommitment,
} from "@/lib/one-on-ones";

// POST /api/admin/coaching/[ae_id]/training
//   body: { content: string, due_date?: YYYY-MM-DD | null }
//   -> { training: TrainingCommitment }
//
// Admin-only. Adds a standing training/coaching assignment for the AE.
// Not tied to any specific 1:1 — these are the AE's running development
// commitments (shadow a presentation, practice objection handling, etc.).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, "Training item cannot be empty.")
    .max(COMMITMENT_CONTENT_MAX_LENGTH),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "due_date must be YYYY-MM-DD.")
    .nullish(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ ae_id: string }> },
) {
  try {
    await requireAdmin(req);
    const { ae_id } = await params;
    const body = await parseBody(req, CreateSchema);

    const supabase = getServerSupabase();
    await requireCoachableAe(supabase, ae_id);

    const res = await supabase
      .from(TRAINING_COMMITMENTS_TABLE)
      .insert({
        ae_id,
        content: body.content,
        due_date: body.due_date ?? null,
      })
      .select("*")
      .single();
    if (res.error || !res.data) {
      throw new Error(res.error?.message ?? "Could not create training item.");
    }
    return Response.json({ training: res.data as TrainingCommitment });
  } catch (err) {
    return handleApiError(err);
  }
}
