import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError, parseBody, requireAdmin } from "@/lib/server/auth";
import {
  FollowupGenerationError,
  generateFollowupEmail,
} from "@/lib/ai/followup-email";
import {
  isFollowupStale,
  loadFollowupContext,
} from "@/lib/server/followup-context";
import {
  assertInProgress,
  FollowupRevisionConflict,
  requireMeeting,
  saveGeneratedFollowup,
  toConflictResponse,
} from "@/lib/server/one-on-one-meetings";

// GET  /api/admin/one-on-one-meetings/[id]/followup
//        -> { has_email, stale, generated_at }
// POST /api/admin/one-on-one-meetings/[id]/followup
//        body: { expected_subject_revision, expected_body_revision }
//        -> { subject, body, subject_revision, body_revision, generated_at }
//
// Admin-only. The AE follow-up email: an AI-drafted, manager-edited recap the
// manager copies into Outlook themselves. NOTHING IS SENT from the app.
//
// PRIVACY: the AI input is loadFollowupContext()'s output — an allowlist of
// shareable meeting content. The manager's PRIVATE NOTES are never selected,
// so they cannot be in the request (see server/followup-context.ts).
//
// POST generates and REPLACES the draft — it is only ever called on an
// explicit Generate / Regenerate click. It persists in one compare-and-set
// against both email revisions, so it can't overwrite an edit made in
// another tab (409 + both current values) and can't land after completion.
// If the AI is unavailable the route answers 502 { error, retryable } and
// changes NOTHING: the meeting, the notes and any existing draft are intact,
// and completing the 1:1 never depends on this route.
//
// GET recomputes the fingerprint of the meeting's shareable content and says
// whether the stored email was generated from something different ("Meeting
// details changed since this email was generated").

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Generation can take a while; the SDK call has its own 45s timeout.
export const maxDuration = 60;

const GenerateSchema = z.object({
  expected_subject_revision: z.number().int().min(0),
  expected_body_revision: z.number().int().min(0),
});

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireAdmin(req);
    const { id } = await params;
    const supabase = getServerSupabase();
    const meeting = await requireMeeting(supabase, id, me);
    const hasEmail = Boolean(meeting.followup_subject || meeting.followup_body);
    let stale = false;
    if (meeting.status === "in_progress" && meeting.followup_body) {
      const { contentHash } = await loadFollowupContext(supabase, meeting.id);
      stale = isFollowupStale(meeting, contentHash);
    }
    return Response.json(
      { has_email: hasEmail, stale, generated_at: meeting.followup_generated_at },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireAdmin(req);
    const { id } = await params;
    const body = await parseBody(req, GenerateSchema);
    const supabase = getServerSupabase();
    const meeting = await requireMeeting(supabase, id, me);
    assertInProgress(meeting);

    // Cheap early refusal: if the email already moved on in another tab, say so
    // BEFORE spending a generation. (The save below re-checks atomically.)
    if (
      meeting.followup_subject_rev !== body.expected_subject_revision ||
      meeting.followup_body_rev !== body.expected_body_revision
    ) {
      throw new FollowupRevisionConflict(
        { value: meeting.followup_subject, revision: meeting.followup_subject_rev },
        { value: meeting.followup_body, revision: meeting.followup_body_rev },
      );
    }

    const { context, contentHash } = await loadFollowupContext(supabase, meeting.id);

    let generated;
    try {
      generated = await generateFollowupEmail(context);
    } catch (err) {
      if (err instanceof FollowupGenerationError) {
        return Response.json(
          { error: err.message, retryable: err.retryable },
          { status: err.retryable ? 502 : 503 },
        );
      }
      throw err;
    }

    const saved = await saveGeneratedFollowup(
      supabase,
      meeting.id,
      { ...generated, contextHash: contentHash },
      { subject: body.expected_subject_revision, body: body.expected_body_revision },
    );
    return Response.json({
      subject: saved.followup_subject,
      body: saved.followup_body,
      subject_revision: saved.followup_subject_rev,
      body_revision: saved.followup_body_rev,
      generated_at: saved.followup_generated_at,
    });
  } catch (err) {
    return toConflictResponse(err) ?? handleApiError(err);
  }
}
