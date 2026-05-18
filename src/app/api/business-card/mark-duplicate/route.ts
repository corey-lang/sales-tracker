import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  handleApiError,
  parseBody,
  requireReviewer,
} from "@/lib/server/auth";

// Build 3: confirm a business card scan as a duplicate by a reviewer.
// POST /api/business-card/mark-duplicate
//   body: { scanId: string, duplicateOfContactId?: string }
//
// AUTHORIZATION (Phase 0): restricted to reviewers (admin or assistant).
//
// Flags the scan as a confirmed duplicate. It does NOT merge contacts, does
// NOT delete the scan, and does NOT delete the business card image.

export const runtime = "nodejs";

const MarkDuplicateSchema = z.object({
  scanId: z.string().min(1, "scanId is required."),
  duplicateOfContactId: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    await requireReviewer(req);
    const { scanId, duplicateOfContactId } = await parseBody(
      req,
      MarkDuplicateSchema,
    );
    const dupContactId = duplicateOfContactId?.trim()
      ? duplicateOfContactId.trim()
      : null;

    const supabase = getServerSupabase();

    const duplicateNotes = dupContactId
      ? `Confirmed duplicate of contact ${dupContactId}`
      : "Confirmed duplicate (no specific original contact recorded)";

    // A confirmed duplicate is removed from the active contact pipeline:
    // duplicate_status = confirmed_duplicate, verification_status =
    // rejected_duplicate. The scan and its image are preserved.
    const updatePayload: Record<string, unknown> = {
      duplicate_status: "confirmed_duplicate",
      verification_status: "rejected_duplicate",
      duplicate_notes: duplicateNotes,
    };
    // Only write the structured link when a contact id was supplied — omitting
    // it preserves any duplicate_of_contact_id set earlier by auto-detection.
    if (dupContactId) {
      updatePayload.duplicate_of_contact_id = dupContactId;
    }

    const upd = await supabase
      .from("business_card_scans")
      .update(updatePayload)
      .eq("id", scanId)
      .select("id");

    if (upd.error) {
      return Response.json({ error: upd.error.message, scanId }, { status: 500 });
    }
    if (!upd.data || upd.data.length === 0) {
      return Response.json(
        { error: "Scan not found", scanId },
        { status: 404 },
      );
    }

    return Response.json({
      status: "marked_duplicate",
      scanId,
      duplicateStatus: "confirmed_duplicate",
      verificationStatus: "rejected_duplicate",
      duplicateOfContactId: dupContactId,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
