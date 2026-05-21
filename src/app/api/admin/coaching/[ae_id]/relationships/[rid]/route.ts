import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  handleApiError,
  notFound,
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

// PATCH  /api/admin/coaching/[ae_id]/relationships/[rid]   -> { relationship }
// DELETE /api/admin/coaching/[ae_id]/relationships/[rid]   -> { relationship }
//
// Admin-only.
//
// LIFECYCLE
//   Gold List relationships are a persistent layer (eventually evolving
//   into CRM). Hard-delete loses longitudinal context, so the DELETE
//   endpoint SOFT-ARCHIVES: it stamps `archived_at` and returns the
//   updated row. Archived rows stay queryable for future history /
//   reactivation but drop out of the active Gold List by default.
//
//   PATCH also accepts an explicit `archived` boolean toggle so a future
//   "restore" affordance can flip a previously archived contact back to
//   active without re-typing them.
//
// OWNERSHIP
//   The DB lookup pins BOTH `rid` and `ae_id` so the URL's parent segment
//   is enforced as a real ownership check, not just documentation. An
//   admin (or a future hand-rolled request) hitting
//   /admin/coaching/<wrong_ae>/relationships/<rid> gets a 404 instead of
//   silently updating a row that belongs to a different AE.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const field = z.string().trim().max(RELATIONSHIP_FIELD_MAX_LENGTH).nullish();
const notesField = z.string().trim().max(RELATIONSHIP_NOTES_MAX_LENGTH).nullish();

const UpdateSchema = z.object({
  contact_name: z
    .string()
    .trim()
    .min(1, "Contact name is required.")
    .max(RELATIONSHIP_FIELD_MAX_LENGTH)
    .optional(),
  company: field,
  title: field,
  status: field,
  next_step: notesField,
  notes: notesField,
  /**
   * Explicit archive toggle. true = archive, false = restore. Omitting
   * this leaves the archive state alone, so a normal edit doesn't
   * unintentionally reactivate an archived row.
   */
  archived: z.boolean().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ ae_id: string; rid: string }> },
) {
  try {
    await requireAdmin(req);
    const { ae_id, rid } = await params;
    const body = await parseBody(req, UpdateSchema);

    const supabase = getServerSupabase();
    // Gate on role='ae' so the URL's ae_id can't be a stale id that
    // happens to still resolve in salespeople under a different role.
    await requireCoachableAe(supabase, ae_id);

    const patch: Record<string, unknown> = {};
    if (body.contact_name !== undefined) patch.contact_name = body.contact_name;
    if (body.company !== undefined) patch.company = body.company ?? null;
    if (body.title !== undefined) patch.title = body.title ?? null;
    if (body.status !== undefined) patch.status = body.status ?? null;
    if (body.next_step !== undefined) patch.next_step = body.next_step ?? null;
    if (body.notes !== undefined) patch.notes = body.notes ?? null;
    if (body.archived !== undefined) {
      patch.archived_at = body.archived ? new Date().toISOString() : null;
    }
    if (Object.keys(patch).length === 0) {
      return Response.json({ error: "No fields to update." }, { status: 400 });
    }

    const res = await supabase
      .from(COACHING_RELATIONSHIPS_TABLE)
      .update(patch)
      .eq("id", rid)
      .eq("ae_id", ae_id)
      .select("*")
      .maybeSingle();
    if (res.error) {
      // Same partial-unique index as POST — an edit that renames an
      // active relationship into a collision with another active one
      // surfaces as 409.
      if (res.error.code === "23505") {
        throw new ApiError(
          409,
          "Another active relationship already matches that contact / company / title.",
        );
      }
      throw new Error(res.error.message);
    }
    if (!res.data) throw notFound("Relationship not found.");
    return Response.json({ relationship: res.data as CoachingRelationship });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ ae_id: string; rid: string }> },
) {
  try {
    await requireAdmin(req);
    const { ae_id, rid } = await params;
    const supabase = getServerSupabase();
    await requireCoachableAe(supabase, ae_id);
    // Soft archive — preserves longitudinal Gold List history. To truly
    // delete, a service-role caller can act on the row directly; the UI
    // never does.
    const res = await supabase
      .from(COACHING_RELATIONSHIPS_TABLE)
      .update({ archived_at: new Date().toISOString() })
      .eq("id", rid)
      .eq("ae_id", ae_id)
      .select("*")
      .maybeSingle();
    if (res.error) throw new Error(res.error.message);
    if (!res.data) throw notFound("Relationship not found.");
    return Response.json({ relationship: res.data as CoachingRelationship });
  } catch (err) {
    return handleApiError(err);
  }
}
