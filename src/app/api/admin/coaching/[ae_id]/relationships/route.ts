import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  handleApiError,
  parseBody,
  requireAdmin,
} from "@/lib/server/auth";
import { requireCoachableAe } from "@/lib/server/coaching";
import {
  COACHING_RELATIONSHIPS_TABLE,
  RELATIONSHIP_FIELD_MAX_LENGTH,
  RELATIONSHIP_NOTES_MAX_LENGTH,
  type CoachingRelationship,
} from "@/lib/one-on-ones";

// POST /api/admin/coaching/[ae_id]/relationships
//   -> { relationship: CoachingRelationship }
//
// Adds a per-AE key relationship the manager is coaching the AE around.
// `contact_name` is required; everything else is optional. Distinct from
// the AE-facing gold_list_targets table (that's the AE's personal touch
// list — see CLAUDE.md). Admin-only.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const field = z.string().trim().max(RELATIONSHIP_FIELD_MAX_LENGTH).nullish();
const notesField = z.string().trim().max(RELATIONSHIP_NOTES_MAX_LENGTH).nullish();

const CreateSchema = z.object({
  contact_name: z
    .string()
    .trim()
    .min(1, "Contact name is required.")
    .max(RELATIONSHIP_FIELD_MAX_LENGTH),
  company: field,
  title: field,
  status: field,
  next_step: notesField,
  notes: notesField,
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
      .from(COACHING_RELATIONSHIPS_TABLE)
      .insert({
        ae_id,
        contact_name: body.contact_name,
        company: body.company ?? null,
        title: body.title ?? null,
        status: body.status ?? null,
        next_step: body.next_step ?? null,
        notes: body.notes ?? null,
      })
      .select("*")
      .single();
    if (res.error || !res.data) {
      throw new Error(res.error?.message ?? "Could not create relationship.");
    }
    return Response.json({ relationship: res.data as CoachingRelationship });
  } catch (err) {
    return handleApiError(err);
  }
}
