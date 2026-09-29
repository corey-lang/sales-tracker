import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError, requireReviewer } from "@/lib/server/auth";
import { selectAllPages, selectAllPagesForIds } from "@/lib/server/paginate";
import {
  hiddenTestSalespersonIds,
  ownedTestSalespersonIds,
} from "@/lib/server/roster";
import {
  CONTACT_DUP_COLUMNS,
  matchScanAgainstContacts,
  type ContactDupRow,
  type DuplicateMatch,
  type DuplicateScanInput,
} from "@/lib/server/business-card-contacts";

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
  "id, salesperson_id, salesperson_name, image_url, image_rotation_degrees, status, is_test_data, created_at, extracted_first_name, extracted_last_name, extracted_full_name, extracted_company, extracted_title, extracted_email, extracted_phone, extracted_website, extracted_address, extracted_contact_type, ai_confidence, extraction_status, raw_ocr_text, ai_notes, verification_status, verified_contact_id, duplicate_status, duplicate_notes, duplicate_of_contact_id, rejection_reason";

/** Columns needed to render a matched duplicate contact side-by-side. */
const DUPLICATE_CONTACT_COLUMNS =
  "id, full_name, company, title, email, phone, website, address, contact_bucket, salesperson_name, verification_status, created_at";

/** Short, human label for why an auto-duplicate (re-)matched. */
const AUTO_DUP_REASON_LABELS: Record<DuplicateMatch["matchType"], string> = {
  email: "Same email",
  name_company: "Same name + company",
  name_phone: "Same name + direct phone",
  company_phone: "Same office phone, different name",
  lastname_company: "Same last name + company",
  phone_only: "Phone-only match",
};

function autoDupReasonLabel(match: DuplicateMatch | null): string {
  return match
    ? AUTO_DUP_REASON_LABELS[match.matchType]
    : "No current duplicate match found";
}

export async function GET(req: Request) {
  try {
    const me = await requireReviewer(req);
    const supabase = getServerSupabase();
    // Test accounts' scans/contacts are shown only to the test account's
    // owner (workflow visibility); other reviewers never see them.
    const hidden = await hiddenTestSalespersonIds(supabase, me);
    const visible = (row: Record<string, unknown>) =>
      !(typeof row.salesperson_id === "string" && hidden.has(row.salesperson_id));

    // In-query scope: real rows, plus rows of test accounts this reviewer OWNS.
    // (Filtering AFTER a capped fetch would let test rows crowd real ones out.)
    const ownTestIds = await ownedTestSalespersonIds(supabase, me);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inScope = (q: any) =>
      ownTestIds.length
        ? q.or(`is_test_data.eq.false,salesperson_id.in.(${ownTestIds.join(",")})`)
        : q.eq("is_test_data", false);

    // 1. All in-scope scans, newest first (paged to completion).
    const scansRes = await selectAllPages<Record<string, unknown>>(() =>
      inScope(supabase.from("business_card_scans").select(SCAN_COLUMNS))
        .order("created_at", { ascending: false })
        .order("id", { ascending: true }),
    );
    if (scansRes.error) {
      throw new Error(`Failed to load scans: ${scansRes.error.message}`);
    }
    const scans = scansRes.data.filter(visible);

    // 2. CRM-ready contacts for the per-AE export summary. Non-fatal: an error
    //    here just yields an empty summary, matching the prior client behavior.
    const exportRes = await selectAllPages<Record<string, unknown>>(() =>
      inScope(
        supabase
          .from("business_card_contacts")
          .select(
            "id, salesperson_id, salesperson_name, verification_status, exported_at",
          )
          .in("verification_status", ["auto_approved", "approved"]),
      ).order("id", { ascending: true }),
    );
    const exportContacts = (exportRes.error ? [] : exportRes.data).filter(visible);

    // 3. The contacts that flagged scans are duplicates of. A STORED
    //    duplicate_of_contact_id is never trusted on its own: the contact must
    //    be visible to this reviewer AND on the same side of the test/real
    //    line as the scan, or the link is dropped from the response.
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
      const contactsRes = await selectAllPagesForIds<Record<string, unknown>>(
        matchedIds,
        (chunk) =>
          supabase
            .from("business_card_contacts")
            .select(`${DUPLICATE_CONTACT_COLUMNS}, salesperson_id, is_test_data`)
            .in("id", chunk)
            .order("id", { ascending: true }),
      );
      const byId = new Map<string, Record<string, unknown>>();
      if (!contactsRes.error) {
        for (const c of contactsRes.data) {
          if (visible(c)) byId.set(c.id as string, c);
        }
      }
      const linked = new Set<string>();
      for (const scan of scans) {
        const id = scan.duplicate_of_contact_id;
        if (typeof id !== "string" || id.length === 0) continue;
        const c = byId.get(id);
        if (c && (c.is_test_data === true) === (scan.is_test_data === true)) {
          linked.add(id);
        } else {
          scan.duplicate_of_contact_id = null;
        }
      }
      duplicateContacts = [...linked].map((id) => {
        const { salesperson_id: _sp, is_test_data: _t, ...rest } = byId.get(id)!;
        void _sp;
        void _t;
        return rest;
      });
    }

    // 4. Re-classify auto-marked duplicates under the CURRENT conservative
    //    rules. This lets the Verification Center split old auto_duplicate
    //    scans into "likely false" (phone / shared-office-line matches — safe
    //    to send back to review) and "likely true" (email, name+company,
    //    name+phone). Read-only: no scan or contact is changed here.
    const autoDupScans = scans.filter(
      (scan) =>
        (typeof scan.verification_status === "string"
          ? scan.verification_status.toLowerCase().trim()
          : "") === "auto_duplicate",
    );
    if (autoDupScans.length > 0) {
      // Auto-duplicates are re-classified against contacts on their own side
      // of the test/real line only: real scans vs real contacts, this
      // reviewer's own test scans vs their own test contacts.
      const poolRes = await selectAllPages<ContactDupRow>(() =>
        inScope(
          supabase.from("business_card_contacts").select(`is_test_data, salesperson_id, ${CONTACT_DUP_COLUMNS}`),
        ).order("id", { ascending: true }),
      );
      const pool = (poolRes.error ? [] : poolRes.data).filter((c) =>
        visible(c as unknown as Record<string, unknown>),
      );
      const realPool = pool.filter(
        (c) => (c as unknown as { is_test_data: boolean }).is_test_data !== true,
      );
      const testPool = pool.filter(
        (c) => (c as unknown as { is_test_data: boolean }).is_test_data === true,
      );
      for (const scan of autoDupScans) {
        const match = matchScanAgainstContacts(
          scan as unknown as DuplicateScanInput,
          scan.is_test_data === true ? testPool : realPool,
        );
        // Strong = likely a real duplicate; anything weaker (or no current
        // match) = likely false, safe for the bulk send-back-to-review.
        scan.auto_duplicate_category =
          match?.strength === "strong" ? "likely_true" : "likely_false";
        scan.auto_duplicate_reason = autoDupReasonLabel(match);
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
