import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  forbidden,
  handleApiError,
  parseBody,
  requireScanAccess,
} from "@/lib/server/auth";
import {
  findDuplicateContact,
  normalizeEmail,
  normalizePhone,
  type ContactScan,
} from "@/lib/server/business-card-contacts";
import { normalizeScanContactType } from "@/lib/contact-type";

// "Scan & Add to Phone Contacts" — saves an AE-verified contact.
// POST /api/business-card/ae-contact
//   body: { scanId: string, contact: { firstName, lastName, ... notes } }
//   200:  { contactId, contact, duplicate }
//
// This is the SECOND business card path, alongside the admin/Tonja review
// flow. It is deliberately isolated from that flow:
//
//   - It owns its own business_card_contacts row, keyed by
//     (scan_id, contact_save_mode = 'phone_contact'). Saving again updates
//     that same row — it never creates a second AE contact for one scan.
//   - It never touches business_card_scans.verification_status /
//     verified_contact_id, so the admin Verification Center and the
//     auto-approval pipeline are unaffected.
//   - The row is written with verification_status = 'ae_verified', which is
//     NOT in the admin CSV export filter ('auto_approved' / 'approved') — so
//     AE phone contacts never leak into Tonja's export.
//
// Duplicates never block: a match is reported back as a warning, but the
// contact is still saved (the AE decides).
//
// AUTHORIZATION
//   requireScanAccess() — the AE who owns the scan, or any reviewer.
//
// TEMPORARY GATE — limited live testing before rollout.
//   The whole phone-contact feature is gated to the test account for now.
//   Beyond requireScanAccess(), this route also rejects any caller whose
//   me.is_test is false. Remove this check when the feature ships broadly.

export const runtime = "nodejs";

/** The editable contact fields the AE reviews before saving. */
const ContactFieldsSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  fullName: z.string().optional(),
  company: z.string().optional(),
  title: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  website: z.string().optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
});

const AeContactSchema = z.object({
  scanId: z.string().min(1, "scanId is required."),
  contact: ContactFieldsSchema,
});

/** Trims a value to a non-empty string, or null. */
function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export async function POST(req: Request) {
  try {
    const { scanId, contact } = await parseBody(req, AeContactSchema);

    // Authorize: AE who owns the scan, or a reviewer.
    const { me } = await requireScanAccess(req, scanId);

    // TEMPORARY — phone-contact feature is in limited testing. Only the test
    // account may use it; remove this gate at full rollout.
    if (!me.is_test) {
      throw forbidden("The Add to Phone Contacts feature is still in testing.");
    }

    const supabase = getServerSupabase();

    // Load the scan for the fields the contact row copies from it.
    const scanRes = await supabase
      .from("business_card_scans")
      .select(
        "id, salesperson_id, salesperson_name, image_url, storage_path, ai_confidence, extracted_contact_type, extracted_title, extracted_company, extracted_full_name, raw_ocr_text, ai_notes",
      )
      .eq("id", scanId)
      .single();

    if (scanRes.error || !scanRes.data) {
      return Response.json(
        { error: scanRes.error?.message ?? "Scan not found" },
        { status: 404 },
      );
    }
    const scan = scanRes.data;

    // Resolve the AE-edited fields. full_name falls back to first + last.
    const firstName = clean(contact.firstName);
    const lastName = clean(contact.lastName);
    const fullName =
      clean(contact.fullName) ??
      clean([firstName, lastName].filter(Boolean).join(" "));
    const company = clean(contact.company);
    const title = clean(contact.title);
    const phone = clean(contact.phone);
    const email = clean(contact.email);
    const website = clean(contact.website);
    const address = clean(contact.address);
    const notes = clean(contact.notes);

    // Classify into a bucket from the AE's final values + the scan's signals.
    const contactBucket = normalizeScanContactType({
      extracted_contact_type: scan.extracted_contact_type,
      extracted_title: title ?? scan.extracted_title,
      extracted_company: company ?? scan.extracted_company,
      extracted_full_name: fullName,
      raw_ocr_text: scan.raw_ocr_text,
      ai_notes: scan.ai_notes,
    });

    // Duplicate detection — runs against the AE's edited values, reported as a
    // non-blocking warning. findDuplicateContact skips contacts derived from
    // this same scan, so the AE's own row (on a re-save) is never self-matched.
    const dupScan: ContactScan = {
      id: scan.id,
      salesperson_id: scan.salesperson_id,
      salesperson_name: scan.salesperson_name,
      image_url: scan.image_url,
      extracted_first_name: firstName,
      extracted_last_name: lastName,
      extracted_full_name: fullName,
      extracted_company: company,
      extracted_title: title,
      extracted_email: email,
      extracted_phone: phone,
      extracted_website: website,
      extracted_address: address,
      extracted_contact_type: scan.extracted_contact_type,
      ai_confidence: null,
      ai_notes: null,
      raw_ocr_text: null,
      extraction_status: "completed",
    };
    let duplicate = null;
    try {
      duplicate = await findDuplicateContact(supabase, dupScan);
    } catch {
      // Non-fatal: a failed duplicate check must never block the save.
      duplicate = null;
    }

    // Fields shared by insert and update.
    const now = new Date().toISOString();
    const fields = {
      contact_bucket: contactBucket,
      contact_type_raw: scan.extracted_contact_type,
      first_name: firstName,
      last_name: lastName,
      full_name: fullName,
      company,
      title,
      email,
      phone,
      website,
      address,
      notes,
      normalized_email: normalizeEmail(email),
      normalized_phone: normalizePhone(phone),
      duplicate_status: duplicate ? "possible_duplicate" : "unchecked",
      verified_by_ae_at: now,
    };

    // The AE flow owns exactly one row per scan: (scan_id, 'phone_contact').
    const existingRes = await supabase
      .from("business_card_contacts")
      .select("id")
      .eq("scan_id", scanId)
      .eq("contact_save_mode", "phone_contact")
      .maybeSingle();

    if (existingRes.error) {
      return Response.json(
        { error: `Contact lookup failed: ${existingRes.error.message}` },
        { status: 500 },
      );
    }

    let contactId: string;
    let savedContact: Record<string, unknown>;

    if (existingRes.data) {
      // Re-save: update the AE's existing contact in place.
      const updRes = await supabase
        .from("business_card_contacts")
        .update(fields)
        .eq("id", existingRes.data.id)
        .select()
        .single();
      if (updRes.error || !updRes.data) {
        return Response.json(
          { error: updRes.error?.message ?? "Failed to update contact" },
          { status: 500 },
        );
      }
      contactId = String(updRes.data.id);
      savedContact = updRes.data as Record<string, unknown>;
    } else {
      // First save: create the AE contact. storage_path / image are copied
      // from the scan; image_path mirrors storage_path (see CRM hardening).
      const insRes = await supabase
        .from("business_card_contacts")
        .insert({
          ...fields,
          scan_id: scan.id,
          salesperson_id: scan.salesperson_id,
          salesperson_name: scan.salesperson_name,
          storage_path: scan.storage_path ?? null,
          image_path: scan.storage_path ?? null,
          image_url: scan.image_url,
          ai_confidence: scan.ai_confidence,
          // 'ae_verified' is intentionally NOT in the admin export filter, so
          // AE phone contacts stay out of Tonja's CSV export.
          verification_status: "ae_verified",
          contact_save_mode: "phone_contact",
        })
        .select()
        .single();
      if (insRes.error || !insRes.data) {
        return Response.json(
          { error: insRes.error?.message ?? "Failed to save contact" },
          { status: 500 },
        );
      }
      contactId = String(insRes.data.id);
      savedContact = insRes.data as Record<string, unknown>;
    }

    return Response.json({
      contactId,
      contact: savedContact,
      duplicate: duplicate
        ? { matchType: duplicate.matchType, reason: duplicate.reason }
        : null,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
