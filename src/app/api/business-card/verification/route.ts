import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError, requireReviewer } from "@/lib/server/auth";

// Phase 0: data feed for the Verification Center.
// GET /api/business-card/verification
//   200: { scans, exportContacts, duplicateContacts }
//
// WHY THIS ROUTE EXISTS
//   The Verification Center used to read business_card_scans and
//   business_card_contacts straight from the browser with the anon key. That
//   meant every scanned card — names, emails, phones, OCR text — was readable
//   by any client, and the verification UI's data access was not gated by
//   role at all.
//
//   This route runs with the service-role key behind requireReviewer(), so
//   only an admin or the assistant can load verification data. The browser no
//   longer queries those tables directly.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Columns the Verification Center renders for each scan. */
const SCAN_COLUMNS =
  "id, salesperson_id, salesperson_name, image_url, status, is_test_data, created_at, extracted_full_name, extracted_company, extracted_title, extracted_email, extracted_phone, extracted_website, extracted_address, extracted_contact_type, ai_confidence, extraction_status, raw_ocr_text, ai_notes, verification_status, verified_contact_id, duplicate_status, duplicate_notes, duplicate_of_contact_id, rejection_reason";

/** Columns needed to render a matched duplicate contact side-by-side. */
const DUPLICATE_CONTACT_COLUMNS =
  "id, full_name, company, title, email, phone, website, address, contact_bucket, salesperson_name, verification_status, created_at";

export async function GET(req: Request) {
  try {
    await requireReviewer(req);
    const supabase = getServerSupabase();

    // 1. All scans, newest first.
    const scansRes = await supabase
      .from("business_card_scans")
      .select(SCAN_COLUMNS)
      .order("created_at", { ascending: false });
    if (scansRes.error) {
      throw new Error(`Failed to load scans: ${scansRes.error.message}`);
    }
    const scans = (scansRes.data ?? []) as Record<string, unknown>[];

    // 2. CRM-ready contacts for the per-AE export summary. Non-fatal: an error
    //    here just yields an empty summary, matching the prior client behavior.
    const exportRes = await supabase
      .from("business_card_contacts")
      .select("salesperson_id, salesperson_name, verification_status, exported_at")
      .in("verification_status", ["auto_approved", "approved"]);
    const exportContacts = exportRes.error ? [] : (exportRes.data ?? []);

    // 3. The contacts that flagged scans are duplicates of — one batched query.
    const matchedIds = [
      ...new Set(
        scans
          .map((scan) => scan.duplicate_of_contact_id)
          .filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          ),
      ),
    ];
    let duplicateContacts: Record<string, unknown>[] = [];
    if (matchedIds.length > 0) {
      const contactsRes = await supabase
        .from("business_card_contacts")
        .select(DUPLICATE_CONTACT_COLUMNS)
        .in("id", matchedIds);
      if (!contactsRes.error) {
        duplicateContacts = (contactsRes.data ?? []) as Record<
          string,
          unknown
        >[];
      }
    }

    return Response.json(
      { scans, exportContacts, duplicateContacts },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
