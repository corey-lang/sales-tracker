import { getServerSupabase } from "@/lib/supabase/server";
import {
  createContactFromScan,
  SCAN_SELECT_COLUMNS,
  type EditableContactFields,
  type LoadedScan,
} from "@/lib/server/business-card-contacts";

// Build 3: manual approval of a business card scan by Tonja / an admin.
// POST /api/business-card/approve   body: { scanId: string, editedFields?, approvedBy? }
//
// Creates a verified business_card_contacts row from the scan, optionally with
// admin edits applied, and links the scan to it. The scan and its image are
// never deleted.

export const runtime = "nodejs";

export async function POST(req: Request) {
  let scanId: string | undefined;
  let editedFields: EditableContactFields | undefined;
  let approvedBy: string | null = null;

  try {
    const body = (await req.json()) as {
      scanId?: unknown;
      editedFields?: unknown;
      approvedBy?: unknown;
    };
    if (typeof body.scanId === "string" && body.scanId.length > 0) {
      scanId = body.scanId;
    }
    if (
      body.editedFields &&
      typeof body.editedFields === "object" &&
      !Array.isArray(body.editedFields)
    ) {
      editedFields = body.editedFields as EditableContactFields;
    }
    if (typeof body.approvedBy === "string" && body.approvedBy.trim()) {
      approvedBy = body.approvedBy.trim();
    }
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!scanId) {
    return Response.json(
      { error: "Missing scanId in request body" },
      { status: 400 },
    );
  }

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

  try {
    const { contactId, contact } = await createContactFromScan(supabase, scan, {
      verificationStatus: "approved",
      approvedBy,
      editedFields,
    });

    return Response.json({
      status: "approved",
      scanId,
      contactId,
      contact,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message, scanId }, { status: 500 });
  }
}
