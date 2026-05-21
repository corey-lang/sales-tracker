import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  handleApiError,
  notFound,
  parseBody,
  requireAdmin,
} from "@/lib/server/auth";
import {
  NOTES_MAX_LENGTH,
  ONE_ON_ONES_TABLE,
  ONE_ON_ONE_VISIBILITIES,
  type OneOnOne,
} from "@/lib/one-on-ones";

// PATCH /api/admin/one-on-ones/[id]   -> { one_on_one: OneOnOne }
// DELETE /api/admin/one-on-ones/[id]  -> { ok: true }
//
// Admin-only. Update notes/visibility/meeting_date or remove a 1:1
// entirely (cascade clears its commitments). Body fields are all
// optional — only the keys present in the request body are written.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notesField = z
  .string()
  .max(NOTES_MAX_LENGTH, `Note exceeds ${NOTES_MAX_LENGTH} chars.`)
  .nullish();

const UpdateSchema = z.object({
  meeting_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "meeting_date must be YYYY-MM-DD.")
    .optional(),
  visibility: z.enum(ONE_ON_ONE_VISIBILITIES).optional(),
  notes_wins: notesField,
  notes_opportunities: notesField,
  notes_focus: notesField,
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin(req);
    const { id } = await params;
    const body = await parseBody(req, UpdateSchema);

    const patch: Record<string, unknown> = {};
    if (body.meeting_date !== undefined) patch.meeting_date = body.meeting_date;
    if (body.visibility !== undefined) patch.visibility = body.visibility;
    if (body.notes_wins !== undefined) patch.notes_wins = body.notes_wins ?? null;
    if (body.notes_opportunities !== undefined)
      patch.notes_opportunities = body.notes_opportunities ?? null;
    if (body.notes_focus !== undefined)
      patch.notes_focus = body.notes_focus ?? null;
    if (Object.keys(patch).length === 0) {
      return Response.json({ error: "No fields to update." }, { status: 400 });
    }

    const supabase = getServerSupabase();
    const res = await supabase
      .from(ONE_ON_ONES_TABLE)
      .update(patch)
      .eq("id", id)
      .select("*")
      .maybeSingle();
    if (res.error) throw new Error(res.error.message);
    if (!res.data) throw notFound("1:1 not found.");
    return Response.json({ one_on_one: res.data as OneOnOne });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin(req);
    const { id } = await params;
    const supabase = getServerSupabase();
    const res = await supabase.from(ONE_ON_ONES_TABLE).delete().eq("id", id);
    if (res.error) throw new Error(res.error.message);
    return Response.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
