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
  ONE_ON_ONES_TABLE,
  ONE_ON_ONE_COMMITMENTS_TABLE,
  type OneOnOneCommitment,
} from "@/lib/one-on-ones";

// POST /api/admin/one-on-ones/[id]/commitments
//   body: { content: string, due_date?: YYYY-MM-DD | null }
//   -> { commitment: OneOnOneCommitment }
//
// Admin-only. Adds a single commitment to a specific 1:1. The commitment's
// `ae_id` is denormalized from the parent meeting so per-AE queries don't
// have to join through one_on_ones.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, "Commitment cannot be empty.")
    .max(COMMITMENT_CONTENT_MAX_LENGTH),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "due_date must be YYYY-MM-DD.")
    .nullish(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin(req);
    const { id } = await params;
    const body = await parseBody(req, CreateSchema);

    const supabase = getServerSupabase();
    const parent = await supabase
      .from(ONE_ON_ONES_TABLE)
      .select("id, ae_id")
      .eq("id", id)
      .maybeSingle();
    if (parent.error) throw new Error(parent.error.message);
    if (!parent.data) throw notFound("1:1 not found.");
    const { ae_id } = parent.data as { id: string; ae_id: string };

    const res = await supabase
      .from(ONE_ON_ONE_COMMITMENTS_TABLE)
      .insert({
        one_on_one_id: id,
        ae_id,
        content: body.content,
        due_date: body.due_date ?? null,
      })
      .select("*")
      .single();
    if (res.error || !res.data) {
      throw new Error(res.error?.message ?? "Could not create commitment.");
    }
    return Response.json({ commitment: res.data as OneOnOneCommitment });
  } catch (err) {
    return handleApiError(err);
  }
}
