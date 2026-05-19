import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  handleApiError,
  parseBody,
  requireReviewer,
} from "@/lib/server/auth";
import {
  createContactFromScan,
  SCAN_SELECT_COLUMNS,
  type LoadedScan,
} from "@/lib/server/business-card-contacts";

// Build 3: manual approval of a business card scan into a verified contact.
// POST /api/business-card/approve   body: { scanId: string }
//
// AUTHORIZATION (Phase 0)
//   Restricted to reviewers (admin or assistant) via requireReviewer(). The
//   `approved_by` audit value is the authenticated reviewer's name.
//
// Creates a verified business_card_contacts row from the scan's CURRENTLY
// STORED extracted fields, and links the scan to it. This route accepts NO
// field overrides — a reviewer/assistant cannot alter contact values here.
// To correct extracted fields first, an admin uses the admin-only route
// POST /api/business-card/update-scan; approve then reads the updated scan.
// The scan and its image are never deleted.

export const runtime = "nodejs";

const ApproveSchema = z.object({
  scanId: z.string().min(1, "scanId is required."),
});

export async function POST(req: Request) {
  try {
    const reviewer = await requireReviewer(req);
    const { scanId } = await parseBody(req, ApproveSchema);

    const supabase = getServerSupabase();

    const scanRes = await supabase
      .from("business_card_scans")
      .select(SCAN_SELECT_COLUMNS)
      .eq("id", scanId)
      .single();

    if (scanRes.error || !scanRes.data) {
      return Response.json(
        { error: scanRes.error?.message ?? "Scan not found" },
        { status: 404 },
      );
    }

    const scan = scanRes.data as unknown as LoadedScan;

    // Guard against creating a second contact for the same scan.
    if (scan.verified_contact_id) {
      return Response.json(
        {
          error: "Scan already has a verified contact",
          scanId,
          contactId: scan.verified_contact_id,
        },
        { status: 409 },
      );
    }

    const { contactId, contact } = await createContactFromScan(
      supabase,
      scan,
      {
        verificationStatus: "approved",
        approvedBy: reviewer.first_name,
      },
    );

    return Response.json({ status: "approved", scanId, contactId, contact });
  } catch (err) {
    return handleApiError(err);
  }
}
