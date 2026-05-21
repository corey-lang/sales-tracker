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
  WEEKLY_FOCUS_COMMITMENTS_TABLE,
  WEEKLY_FOCUS_TABLE,
  type WeeklyFocusCommitment,
} from "@/lib/one-on-ones";

// POST /api/admin/one-on-ones/[id]/commitments
//   body: { content: string, due_date?: YYYY-MM-DD | null }
//   -> { commitment: WeeklyFocusCommitment }
//
// Admin-only. Adds a single commitment to a specific Weekly Focus row.
// The commitment's `ae_id` is denormalized from the parent week so per-AE
// queries don't have to join through the focus table. URL path keeps the
// legacy `/one-on-ones/` segment for back-compat.

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
      .from(WEEKLY_FOCUS_TABLE)
      .select("id, ae_id")
      .eq("id", id)
      .maybeSingle();
    if (parent.error) throw new Error(parent.error.message);
    if (!parent.data) throw notFound("Weekly focus not found.");
    const { ae_id } = parent.data as { id: string; ae_id: string };

    const res = await supabase
      .from(WEEKLY_FOCUS_COMMITMENTS_TABLE)
      .insert({
        one_on_one_id: id,
        ae_id,
        content: body.content,
        due_date: body.due_date ?? null,
        // Default `status` is set DB-side (DEFAULT 'open'), but we send
        // it explicitly so a serverless cold start doesn't accidentally
        // produce NULL on a schema that hasn't picked up the default yet.
        status: "open",
      })
      .select("*")
      .single();
    if (res.error || !res.data) {
      throw new Error(res.error?.message ?? "Could not create commitment.");
    }
    return Response.json({ commitment: res.data as WeeklyFocusCommitment });
  } catch (err) {
    return handleApiError(err);
  }
}
