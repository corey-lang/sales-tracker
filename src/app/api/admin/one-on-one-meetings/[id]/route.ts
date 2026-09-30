import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError, parseBody, requireAdmin } from "@/lib/server/auth";
import {
  COACHING_FOCUS_MAX_LENGTH,
  FOLLOWUP_BODY_MAX_LENGTH,
  FOLLOWUP_SUBJECT_MAX_LENGTH,
  MEETING_NOTES_MAX_LENGTH,
  PRIVATE_NOTES_MAX_LENGTH,
  revisionColumn,
} from "@/lib/one-on-one-meetings";
import {
  assertInProgress,
  loadMeetingRecord,
  requireMeeting,
  saveMeetingField,
  toConflictResponse,
} from "@/lib/server/one-on-one-meetings";

// GET   /api/admin/one-on-one-meetings/[id]  -> MeetingRecord
// PATCH /api/admin/one-on-one-meetings/[id]  -> { meeting }
//
// Admin-only.
//
// GET returns the full record — for a completed meeting that is the frozen
// history (activity snapshot, Gold List discussion notes + snapshots,
// commitment reviews), exactly as it was at completion.
//
// PATCH autosaves ONE draft text field:
//   { field, value, expected_revision }  -> { meeting, field, revision }
// It lands only if `expected_revision` is still that field's revision
// (optimistic concurrency — two tabs can't silently overwrite each other;
// other fields never conflict). A stale save gets 409 with
// `conflict: { value, revision }`. Only an IN-PROGRESS meeting accepts it;
// a completed one answers 409 (and the DB freeze trigger would refuse the
// write regardless).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Text = z.string().max(MEETING_NOTES_MAX_LENGTH).nullable();

/**
 * One field per save, with the revision the client last saw for it. A
 * stale revision → 409 with the stored text; nothing is overwritten.
 */
const UpdateSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("wins"), value: Text, expected_revision: z.number().int().min(0) }),
  z.object({ field: z.literal("activity_notes"), value: Text, expected_revision: z.number().int().min(0) }),
  z.object({
    field: z.literal("coaching_focus"),
    value: z.string().max(COACHING_FOCUS_MAX_LENGTH).nullable(),
    expected_revision: z.number().int().min(0),
  }),
  // "1:1 Notes" (the column keeps its original name).
  z.object({ field: z.literal("coaching_notes"), value: Text, expected_revision: z.number().int().min(0) }),
  // PRIVATE MANAGER NOTES — same revision protocol as every other field.
  z.object({
    field: z.literal("private_notes"),
    value: z.string().max(PRIVATE_NOTES_MAX_LENGTH).nullable(),
    expected_revision: z.number().int().min(0),
  }),
  // The AE follow-up email draft (subject + body autosave independently).
  z.object({
    field: z.literal("followup_subject"),
    value: z.string().max(FOLLOWUP_SUBJECT_MAX_LENGTH).nullable(),
    expected_revision: z.number().int().min(0),
  }),
  z.object({
    field: z.literal("followup_body"),
    value: z.string().max(FOLLOWUP_BODY_MAX_LENGTH).nullable(),
    expected_revision: z.number().int().min(0),
  }),
]);

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireAdmin(req);
    const { id } = await params;
    const supabase = getServerSupabase();
    const meeting = await requireMeeting(supabase, id, me);
    const record = await loadMeetingRecord(supabase, meeting);
    return Response.json(record, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireAdmin(req);
    const { id } = await params;
    const body = await parseBody(req, UpdateSchema);
    const supabase = getServerSupabase();
    const meeting = await requireMeeting(supabase, id, me);
    assertInProgress(meeting);
    const saved = await saveMeetingField(
      supabase,
      meeting.id,
      body.field,
      body.value,
      body.expected_revision,
    );
    return Response.json({
      meeting: saved,
      field: body.field,
      revision: saved[revisionColumn(body.field)],
    });
  } catch (err) {
    return toConflictResponse(err) ?? handleApiError(err);
  }
}
