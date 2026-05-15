import { getServerSupabase } from "@/lib/supabase/server";

// Build 3: manual rejection of a business card scan by Tonja / an admin.
// POST /api/business-card/reject   body: { scanId: string, reason?: string }
//
// Marks the scan as rejected and records the reason. It does NOT create a
// contact, and it never deletes the scan or its business card image.

export const runtime = "nodejs";

export async function POST(req: Request) {
  let scanId: string | undefined;
  let reason: string | null = null;

  try {
    const body = (await req.json()) as { scanId?: unknown; reason?: unknown };
    if (typeof body.scanId === "string" && body.scanId.length > 0) {
      scanId = body.scanId;
    }
    if (typeof body.reason === "string" && body.reason.trim()) {
      reason = body.reason.trim();
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

  // Update only the workflow columns. The scan row and image are preserved.
  const upd = await supabase
    .from("business_card_scans")
    .update({
      verification_status: "rejected",
      rejection_reason: reason,
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

  return Response.json({ status: "rejected", scanId, reason });
}
