import { getServerSupabase } from "@/lib/supabase/server";

// Build 3: confirm a business card scan as a duplicate by Tonja / an admin.
// POST /api/business-card/mark-duplicate
//   body: { scanId: string, duplicateOfContactId?: string }
//
// Flags the scan as a confirmed duplicate. It does NOT merge contacts, does
// NOT delete the scan, and does NOT delete the business card image.

export const runtime = "nodejs";

export async function POST(req: Request) {
  let scanId: string | undefined;
  let duplicateOfContactId: string | null = null;

  try {
    const body = (await req.json()) as {
      scanId?: unknown;
      duplicateOfContactId?: unknown;
    };
    if (typeof body.scanId === "string" && body.scanId.length > 0) {
      scanId = body.scanId;
    }
    if (
      typeof body.duplicateOfContactId === "string" &&
      body.duplicateOfContactId.trim()
    ) {
      duplicateOfContactId = body.duplicateOfContactId.trim();
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

  const duplicateNotes = duplicateOfContactId
    ? `Confirmed duplicate of contact ${duplicateOfContactId}`
    : "Confirmed duplicate (no specific original contact recorded)";

  // A confirmed duplicate is removed from the active contact pipeline:
  // duplicate_status = confirmed_duplicate, verification_status =
  // rejected_duplicate. The scan and its image are preserved.
  const upd = await supabase
    .from("business_card_scans")
    .update({
      duplicate_status: "confirmed_duplicate",
      verification_status: "rejected_duplicate",
      duplicate_notes: duplicateNotes,
    })
    .eq("id", scanId)
    .select("id");

  if (upd.error) {
    return Response.json(
      { error: upd.error.message, scanId },
      { status: 500 },
    );
  }
  if (!upd.data || upd.data.length === 0) {
    return Response.json({ error: "Scan not found", scanId }, { status: 404 });
  }

  return Response.json({
    status: "marked_duplicate",
    scanId,
    duplicateStatus: "confirmed_duplicate",
    verificationStatus: "rejected_duplicate",
    duplicateOfContactId,
  });
}
