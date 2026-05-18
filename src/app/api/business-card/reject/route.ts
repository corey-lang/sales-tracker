import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  handleApiError,
  parseBody,
  requireReviewer,
} from "@/lib/server/auth";

// Build 3: manual rejection of a business card scan by a reviewer.
// POST /api/business-card/reject   body: { scanId: string, reason?: string }
//
// AUTHORIZATION (Phase 0): restricted to reviewers (admin or assistant).
//
// Marks the scan as rejected and records the reason. It does NOT create a
// contact, and it never deletes the scan or its business card image.

export const runtime = "nodejs";

const RejectSchema = z.object({
  scanId: z.string().min(1, "scanId is required."),
  reason: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    await requireReviewer(req);
    const { scanId, reason } = await parseBody(req, RejectSchema);
    const trimmedReason = reason?.trim() ? reason.trim() : null;

    const supabase = getServerSupabase();

    // Update only the workflow columns. The scan row and image are preserved.
    const upd = await supabase
      .from("business_card_scans")
      .update({
        verification_status: "rejected",
        rejection_reason: trimmedReason,
      })
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

    return Response.json({ status: "rejected", scanId, reason: trimmedReason });
  } catch (err) {
    return handleApiError(err);
  }
}
