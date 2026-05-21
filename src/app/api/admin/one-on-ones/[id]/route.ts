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
  WEEKLY_FOCUS_PRIVATE_NOTES_TABLE,
  WEEKLY_FOCUS_TABLE,
  WEEKLY_FOCUS_VISIBILITIES,
  type WeeklyFocus,
} from "@/lib/one-on-ones";

// PATCH /api/admin/one-on-ones/[id]      -> { weekly_focus, manager_notes }
// DELETE /api/admin/one-on-ones/[id]     -> { ok: true }
//
// Admin-only. Update any of the Weekly Focus note panes, the visibility
// flag, or the legacy `meeting_date` label — or remove the Weekly Focus
// row entirely (cascade clears its commitments and private notes).
//
// PRIVATE-NOTES BOUNDARY
//   `notes_manager` is stored in a SEPARATE table (weekly_focus_private_notes)
//   so a future AE-facing surface that reads `one_on_ones` rows can never
//   accidentally serve the manager's private notes. The PATCH here accepts
//   `notes_manager` as a convenience and routes it to that table; the
//   response includes `manager_notes` so the client knows it landed.
//
// Path note: the URL keeps the `/one-on-ones/` prefix for back-compat
// (existing client fetches and any external bookmarks still resolve).

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
  visibility: z.enum(WEEKLY_FOCUS_VISIBILITIES).optional(),
  notes_focus: notesField,
  notes_wins: notesField,
  notes_opportunities: notesField,
  notes_training: notesField,
  /**
   * Manager-only notes pane. Routed to the private-notes table on the
   * server side — see file header.
   */
  notes_manager: notesField,
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin(req);
    const { id } = await params;
    const body = await parseBody(req, UpdateSchema);

    // Split shared-row fields from the private-notes field. Private notes
    // get their own roundtrip below.
    const focusPatch: Record<string, unknown> = {};
    if (body.meeting_date !== undefined)
      focusPatch.meeting_date = body.meeting_date;
    if (body.visibility !== undefined) focusPatch.visibility = body.visibility;
    if (body.notes_focus !== undefined)
      focusPatch.notes_focus = body.notes_focus ?? null;
    if (body.notes_wins !== undefined)
      focusPatch.notes_wins = body.notes_wins ?? null;
    if (body.notes_opportunities !== undefined)
      focusPatch.notes_opportunities = body.notes_opportunities ?? null;
    if (body.notes_training !== undefined)
      focusPatch.notes_training = body.notes_training ?? null;

    const hasPrivateUpdate = body.notes_manager !== undefined;
    if (Object.keys(focusPatch).length === 0 && !hasPrivateUpdate) {
      return Response.json({ error: "No fields to update." }, { status: 400 });
    }

    const supabase = getServerSupabase();

    // Always read the focus row so we can return a consistent shape and
    // resolve ae_id for the private-notes upsert. When there's a shared
    // update, do it through PATCH to capture the bumped updated_at; when
    // there isn't, a SELECT is fine.
    let focusRow: WeeklyFocus;
    if (Object.keys(focusPatch).length > 0) {
      const res = await supabase
        .from(WEEKLY_FOCUS_TABLE)
        .update(focusPatch)
        .eq("id", id)
        .select("*")
        .maybeSingle();
      if (res.error) throw new Error(res.error.message);
      if (!res.data) throw notFound("Weekly focus not found.");
      focusRow = res.data as WeeklyFocus;
    } else {
      const res = await supabase
        .from(WEEKLY_FOCUS_TABLE)
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (res.error) throw new Error(res.error.message);
      if (!res.data) throw notFound("Weekly focus not found.");
      focusRow = res.data as WeeklyFocus;
    }

    let managerNotes: string | null = null;
    if (hasPrivateUpdate) {
      const nextNotes = body.notes_manager ?? null;
      const upsertRes = await supabase
        .from(WEEKLY_FOCUS_PRIVATE_NOTES_TABLE)
        .upsert(
          {
            weekly_focus_id: focusRow.id,
            ae_id: focusRow.ae_id,
            notes: nextNotes,
          },
          { onConflict: "weekly_focus_id" },
        )
        .select("notes")
        .maybeSingle();
      if (upsertRes.error) throw new Error(upsertRes.error.message);
      managerNotes = (upsertRes.data as { notes: string | null } | null)
        ?.notes ?? null;
    } else {
      // No write — fetch current value so the response is complete.
      const readRes = await supabase
        .from(WEEKLY_FOCUS_PRIVATE_NOTES_TABLE)
        .select("notes")
        .eq("weekly_focus_id", focusRow.id)
        .maybeSingle();
      // Best-effort: a missing row is normal (no notes yet).
      if (!readRes.error && readRes.data) {
        managerNotes = (readRes.data as { notes: string | null }).notes;
      }
    }

    return Response.json({
      weekly_focus: focusRow,
      manager_notes: managerNotes,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

// DELETE on a Weekly Focus row was intentionally removed.
//
// Coaching history matters — a single accidental tap shouldn't wipe a
// week of notes + commitments + (cascade) the private-notes row. There
// is no UI affordance that calls this, and the soft-archive flows on
// commitments (status='dropped') and relationships (archived_at) cover
// the legitimate "remove from active focus" use cases.
//
// A service-role caller can still hard-delete a row directly against
// the DB if a future need arises (e.g. a test-data purge); that path
// is deliberately not reachable from the public API.
