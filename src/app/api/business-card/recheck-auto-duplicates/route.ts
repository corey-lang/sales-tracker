import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError, requireReviewer } from "@/lib/server/auth";
import {
  CONTACT_DUP_COLUMNS,
  matchScanAgainstContacts,
  type ContactDupRow,
  type DuplicateScanInput,
} from "@/lib/server/business-card-contacts";

// Bulk reclassify old auto-duplicate scans under the current conservative
// duplicate rules.
//   POST /api/business-card/recheck-auto-duplicates
//   200: {
//     ok: true,
//     totalChecked, kept, movedToDuplicateReview, movedToNeedsReview,
//     skipped, hitCap,
//   }
//
// FOR EACH scan that is currently `auto_duplicate` AND has no verified contact:
//   - STRONG  match now → kept as auto_duplicate (no DB write).
//   - POSSIBLE match now → moved to duplicate_review / possible_duplicate.
//   - NO match now       → moved to needs_review / unchecked, dup link cleared.
//
// SAFETY
//   - Approved / rejected / duplicate_review / needs_review / exported records
//     are not touched: both the load and each UPDATE are filtered to
//     verification_status = 'auto_duplicate' AND verified_contact_id IS NULL.
//   - No contact is ever created. No existing contact is altered.
//   - Going-forward conservative duplicate detection is unchanged.
//   - Idempotent: re-running processes only the scans that are still
//     `auto_duplicate` at that moment.
//
// AUTHORIZATION
//   requireReviewer() — admin or the assistant (Tonja).

export const runtime = "nodejs";

/** Defensive upper bound on a single recheck batch. The UI shows hitCap=true
 *  when this is reached, so a reviewer can run it again to continue. */
const RECHECK_CAP = 5000;

const NOTE_MOVED_TO_REVIEW =
  "Rechecked with updated duplicate rules — needs manual review.";
const NOTE_MOVED_TO_NEEDS_REVIEW =
  "Rechecked with updated duplicate rules — no duplicate match found.";

export async function POST(req: Request) {
  try {
    await requireReviewer(req);
    const supabase = getServerSupabase();

    // 1. Load eligible auto-duplicate scans + all contact dup-rows in parallel.
    const [scansRes, contactsRes] = await Promise.all([
      supabase
        .from("business_card_scans")
        .select(
          "id, extracted_email, extracted_phone, extracted_full_name, extracted_last_name, extracted_company, normalized_email, normalized_phone",
        )
        .eq("verification_status", "auto_duplicate")
        .is("verified_contact_id", null)
        .limit(RECHECK_CAP),
      supabase.from("business_card_contacts").select(CONTACT_DUP_COLUMNS),
    ]);

    if (scansRes.error) {
      return Response.json(
        { error: `Failed to load auto-duplicates: ${scansRes.error.message}` },
        { status: 500 },
      );
    }
    if (contactsRes.error) {
      return Response.json(
        { error: `Failed to load contacts: ${contactsRes.error.message}` },
        { status: 500 },
      );
    }

    const scans = (scansRes.data ?? []) as unknown as DuplicateScanInput[];
    const contacts = (contactsRes.data ?? []) as ContactDupRow[];

    // 2. Classify each scan under the current matcher.
    const toDuplicateReview: string[] = [];
    const toNeedsReview: string[] = [];
    let kept = 0;
    for (const scan of scans) {
      const match = matchScanAgainstContacts(scan, contacts);
      if (!match) {
        toNeedsReview.push(scan.id);
      } else if (match.strength === "strong") {
        kept += 1; // no DB write — the row stays exactly as it is
      } else {
        toDuplicateReview.push(scan.id);
      }
    }

    // 3. Batched UPDATEs. The verification_status + verified_contact_id
    //    filters re-applied here are the race-safety boundary: if another
    //    request already moved a scan, it is simply skipped.
    let movedToDuplicateReview = 0;
    if (toDuplicateReview.length > 0) {
      const upd = await supabase
        .from("business_card_scans")
        .update({
          verification_status: "duplicate_review",
          duplicate_status: "possible_duplicate",
          duplicate_notes: NOTE_MOVED_TO_REVIEW,
        })
        .in("id", toDuplicateReview)
        .eq("verification_status", "auto_duplicate")
        .is("verified_contact_id", null)
        .select("id");
      if (upd.error) {
        return Response.json(
          { error: `Failed to update scans: ${upd.error.message}` },
          { status: 500 },
        );
      }
      movedToDuplicateReview = upd.data?.length ?? 0;
    }

    let movedToNeedsReview = 0;
    if (toNeedsReview.length > 0) {
      const upd = await supabase
        .from("business_card_scans")
        .update({
          verification_status: "needs_review",
          duplicate_status: "unchecked",
          duplicate_notes: NOTE_MOVED_TO_NEEDS_REVIEW,
          // No current match — clear the structured link.
          duplicate_of_contact_id: null,
        })
        .in("id", toNeedsReview)
        .eq("verification_status", "auto_duplicate")
        .is("verified_contact_id", null)
        .select("id");
      if (upd.error) {
        return Response.json(
          { error: `Failed to update scans: ${upd.error.message}` },
          { status: 500 },
        );
      }
      movedToNeedsReview = upd.data?.length ?? 0;
    }

    const totalChecked = scans.length;
    // Anything we expected to update but the filtered UPDATE missed (a race
    // with another route changing the status) is counted as skipped.
    const skipped =
      toDuplicateReview.length -
      movedToDuplicateReview +
      (toNeedsReview.length - movedToNeedsReview);

    return Response.json({
      ok: true,
      totalChecked,
      kept,
      movedToDuplicateReview,
      movedToNeedsReview,
      skipped,
      hitCap: scans.length === RECHECK_CAP,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
