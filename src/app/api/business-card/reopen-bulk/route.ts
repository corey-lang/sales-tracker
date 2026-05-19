import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError, parseBody, requireReviewer } from "@/lib/server/auth";

// Bulk-send auto-marked duplicates back to MANUAL duplicate review.
// POST /api/business-card/reopen-bulk   body: { scanIds: string[] }
//   200: { ok: true, reopened: number, skipped: number }
//
// WHY THIS EXISTS
//   Old cards auto-flagged `auto_duplicate` under the phone-only logic can
//   number in the hundreds; reopening them one-by-one is impractical. This
//   moves a selected set into `duplicate_review` in a single statement so
//   Tonja can clean up the false positives quickly.
//
// SAFETY (this route never approves anything)
//   - The UPDATE is filtered to verification_status = 'auto_duplicate' AND
//     verified_contact_id IS NULL, so it can ONLY touch genuine auto-duplicate
//     scans. Approved contacts and rejected scans are untouchable here, even if
//     their ids are passed. Ineligible ids are simply counted as "skipped".
//   - No contact is created; no existing contact is modified.
//   - Reopened scans become duplicate_review / possible_duplicate — a human
//     still decides approve / confirm-duplicate / reject afterwards.
//
// AUTHORIZATION
//   requireReviewer() — admin or the assistant (Tonja).

export const runtime = "nodejs";

const ReopenBulkSchema = z.object({
  // Cap the batch so one request can't scan-update the whole table.
  scanIds: z
    .array(z.string().min(1))
    .min(1, "scanIds must not be empty.")
    .max(500, "Too many scans in one request (max 500)."),
});

const REOPEN_NOTE =
  "Reopened from auto-duplicate for manual review (bulk cleanup) — was " +
  "auto-flagged on a phone-number match under the old logic.";

export async function POST(req: Request) {
  try {
    await requireReviewer(req);
    const { scanIds } = await parseBody(req, ReopenBulkSchema);
    const uniqueIds = [...new Set(scanIds)];

    const supabase = getServerSupabase();

    // The status + verified_contact_id filters are the safety boundary: only
    // genuine auto-duplicates with no contact are ever updated.
    const upd = await supabase
      .from("business_card_scans")
      .update({
        verification_status: "duplicate_review",
        duplicate_status: "possible_duplicate",
        duplicate_notes: REOPEN_NOTE,
      })
      .in("id", uniqueIds)
      .eq("verification_status", "auto_duplicate")
      .is("verified_contact_id", null)
      .select("id");

    if (upd.error) {
      return Response.json(
        { error: `Failed to reopen scans: ${upd.error.message}` },
        { status: 500 },
      );
    }

    const reopened = upd.data?.length ?? 0;
    return Response.json({
      ok: true,
      reopened,
      skipped: uniqueIds.length - reopened,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
