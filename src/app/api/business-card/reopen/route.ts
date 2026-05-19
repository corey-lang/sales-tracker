import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  badRequest,
  handleApiError,
  parseBody,
  requireReviewer,
} from "@/lib/server/auth";

// Send an auto-marked duplicate back to MANUAL duplicate review.
// POST /api/business-card/reopen   body: { scanId: string }
//   200: { ok: true, scanId }
//
// WHY THIS EXISTS
//   Cards auto-marked `auto_duplicate` under the old phone-only logic may be
//   false positives (a shared office line, different person). This route lets
//   a reviewer move ONE such scan into `duplicate_review` so the normal
//   approve / confirm-duplicate / reject actions become available and a human
//   makes the call. It is deliberately one-at-a-time — there is no bulk
//   re-approval, and true duplicates are preserved until a human confirms.
//
//   No contact is created and no existing contact is touched here; the scan
//   keeps its `duplicate_of_contact_id` so the side-by-side comparison still
//   works in the Verification Center.
//
// AUTHORIZATION
//   requireReviewer() — admin or the assistant (Tonja).

export const runtime = "nodejs";

const ReopenSchema = z.object({
  scanId: z.string().min(1, "scanId is required."),
});

export async function POST(req: Request) {
  try {
    const reviewer = await requireReviewer(req);
    const { scanId } = await parseBody(req, ReopenSchema);

    const supabase = getServerSupabase();

    const scanRes = await supabase
      .from("business_card_scans")
      .select("id, verification_status, verified_contact_id, duplicate_notes")
      .eq("id", scanId)
      .maybeSingle();
    if (scanRes.error) {
      return Response.json({ error: scanRes.error.message }, { status: 500 });
    }
    if (!scanRes.data) {
      return Response.json({ error: "Scan not found." }, { status: 404 });
    }

    const scan = scanRes.data;
    // Only auto-marked duplicates can be reopened — never an approved,
    // rejected, or already-in-review scan.
    if (
      (scan.verification_status ?? "").toLowerCase().trim() !==
      "auto_duplicate"
    ) {
      throw badRequest(
        "Only auto-marked duplicates can be sent back to review.",
      );
    }
    if (scan.verified_contact_id) {
      // Defensive: an auto_duplicate never has a contact, but never reopen one.
      throw badRequest("This scan already has a verified contact.");
    }

    const note = `Sent back to manual review by ${reviewer.first_name}.`;
    const existing = (scan.duplicate_notes ?? "").trim();

    const upd = await supabase
      .from("business_card_scans")
      .update({
        verification_status: "duplicate_review",
        duplicate_status: "possible_duplicate",
        duplicate_notes: existing ? `${existing} · ${note}` : note,
      })
      .eq("id", scanId)
      .select("id")
      .single();

    if (upd.error || !upd.data) {
      return Response.json(
        { error: upd.error?.message ?? "Failed to reopen scan." },
        { status: 500 },
      );
    }

    return Response.json({ ok: true, scanId });
  } catch (err) {
    return handleApiError(err);
  }
}
