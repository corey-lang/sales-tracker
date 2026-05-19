/**
 * Build 3 — server-side helpers for the verified business card contact layer.
 *
 * This module owns the logic that turns a `business_card_scans` row into a
 * permanent `business_card_contacts` row: contact creation, the safe
 * auto-approval rule, and the foundation of duplicate detection.
 *
 * Invariants enforced here:
 *  - The original scan is NEVER deleted. A contact links back via `scan_id`,
 *    and the scan links forward via `verified_contact_id`.
 *  - Business card images are never deleted; `image_url` is copied, not moved.
 *  - Nothing here merges or overwrites an existing contact.
 *
 * Server-only: imports the service-role Supabase client path. Never import
 * this from a `"use client"` component.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizeScanContactType } from "@/lib/contact-type";

/** Minimum AI confidence (as a 0–100 percentage) required to auto-approve. */
export const AUTO_APPROVE_MIN_CONFIDENCE = 90;

/**
 * Columns selected from `business_card_scans` when loading a scan for contact
 * creation or workflow routes. Includes the Build 3 verification columns so
 * callers can guard against double-processing.
 */
export const SCAN_SELECT_COLUMNS = [
  "id",
  "salesperson_id",
  "salesperson_name",
  "image_url",
  "storage_path",
  "normalized_email",
  "normalized_phone",
  "extracted_first_name",
  "extracted_last_name",
  "extracted_full_name",
  "extracted_company",
  "extracted_title",
  "extracted_email",
  "extracted_phone",
  "extracted_website",
  "extracted_address",
  "extracted_contact_type",
  "ai_confidence",
  "ai_notes",
  "raw_ocr_text",
  "extraction_status",
  "verification_status",
  "verified_contact_id",
  "duplicate_status",
].join(", ");

/** The scan fields this module reads when building / classifying a contact. */
export type ContactScan = {
  id: string;
  salesperson_id: string | null;
  salesperson_name: string | null;
  image_url: string | null;
  /** Stable Storage object path. Optional: present on rows scanned after the
   *  CRM-hardening migration / backfilled for older rows. */
  storage_path?: string | null;
  /** Persisted normalized email/phone (CRM-hardening migration). Optional so
   *  callers selecting an older column set still type-check. */
  normalized_email?: string | null;
  normalized_phone?: string | null;
  extracted_first_name: string | null;
  extracted_last_name: string | null;
  extracted_full_name: string | null;
  extracted_company: string | null;
  extracted_title: string | null;
  extracted_email: string | null;
  extracted_phone: string | null;
  extracted_website: string | null;
  extracted_address: string | null;
  extracted_contact_type: string | null;
  ai_confidence: number | null;
  ai_notes: string | null;
  raw_ocr_text: string | null;
  extraction_status: string | null;
  /** Present once the Build 3 migration has run; guards double-processing. */
  verified_contact_id?: string | null;
};

/** A scan loaded via {@link SCAN_SELECT_COLUMNS}, including workflow columns. */
export type LoadedScan = ContactScan & {
  verification_status: string | null;
  verified_contact_id: string | null;
  duplicate_status: string | null;
};

/** Verification states a freshly created contact can be given. */
export type ContactVerificationStatus =
  | "auto_approved"
  | "approved"
  | "needs_review";

export type CreateContactOptions = {
  verificationStatus: ContactVerificationStatus;
  /** Who approved it — stored in `approved_by` for approved/auto_approved. */
  approvedBy?: string | null;
  /** Duplicate state to record on the new contact. Defaults to "unchecked". */
  duplicateStatus?: string;
  /** If this contact is a known duplicate of another, its id. */
  duplicateOfContactId?: string | null;
};

export type CreateContactResult = {
  contactId: string;
  contact: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Value normalization helpers
// ---------------------------------------------------------------------------

/** Normalizes the AI confidence to a 0–100 percentage (raw values may be 0–1). */
export function confidenceToPercent(value: number | null): number | null {
  if (value === null || Number.isNaN(value)) return null;
  return value <= 1 ? value * 100 : value;
}

/** Normalized email for storage + duplicate matching: lowercase, trimmed. */
export function normalizeEmail(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/** Normalized phone for storage + duplicate matching: digits only. */
export function normalizePhone(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

function normalizeName(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase().replace(/\s+/g, " ");
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Contact creation
// ---------------------------------------------------------------------------

/**
 * Creates a `business_card_contacts` row from a scan and links the scan to it.
 *
 * The contact's fields are copied verbatim from the scan's CURRENTLY STORED
 * `extracted_*` columns — there is no field-override path. An admin corrects a
 * scan beforehand via the admin-only POST /api/business-card/update-scan; a
 * reviewer/assistant approving here can never alter field values. The
 * originating scan is never modified beyond `verified_contact_id` +
 * `verification_status`, and is never deleted.
 *
 * Throws if the insert fails or if the scan link-back fails.
 */
export async function createContactFromScan(
  supabase: SupabaseClient,
  scan: ContactScan,
  options: CreateContactOptions,
): Promise<CreateContactResult> {
  const now = new Date().toISOString();
  const isApproved =
    options.verificationStatus === "auto_approved" ||
    options.verificationStatus === "approved";

  // Built ONLY from the scan's stored extracted fields — no overrides.
  const insertRow = {
    scan_id: scan.id,
    salesperson_id: scan.salesperson_id,
    salesperson_name: scan.salesperson_name,
    contact_bucket: normalizeScanContactType(scan),
    contact_type_raw: scan.extracted_contact_type,
    first_name: scan.extracted_first_name,
    last_name: scan.extracted_last_name,
    full_name: scan.extracted_full_name,
    company: scan.extracted_company,
    title: scan.extracted_title,
    email: scan.extracted_email,
    phone: scan.extracted_phone,
    website: scan.extracted_website,
    address: scan.extracted_address,
    // Normalized copies for reliable CRM-side duplicate matching.
    normalized_email: normalizeEmail(scan.extracted_email),
    normalized_phone: normalizePhone(scan.extracted_phone),
    // Copy the scan's stable Storage object path. image_path mirrors it for
    // backward compatibility (the column predates storage_path and was always
    // NULL before the CRM-hardening migration).
    storage_path: scan.storage_path ?? null,
    image_path: scan.storage_path ?? null,
    image_url: scan.image_url,
    ai_confidence: scan.ai_confidence,
    verification_status: options.verificationStatus,
    duplicate_status: options.duplicateStatus ?? "unchecked",
    duplicate_of_contact_id: options.duplicateOfContactId ?? null,
    approved_by: isApproved ? (options.approvedBy ?? null) : null,
    approved_at: isApproved ? now : null,
  };

  const insertRes = await supabase
    .from("business_card_contacts")
    .insert(insertRow)
    .select()
    .single();

  if (insertRes.error || !insertRes.data) {
    throw new Error(
      `Failed to create contact: ${
        insertRes.error?.message ?? "no row returned"
      }`,
    );
  }

  const contact = insertRes.data as Record<string, unknown>;
  const contactId = String(contact.id);

  // Link the scan to its verified contact. The scan row itself is preserved —
  // only these two workflow columns change.
  const scanUpd = await supabase
    .from("business_card_scans")
    .update({
      verified_contact_id: contactId,
      verification_status: options.verificationStatus,
    })
    .eq("id", scan.id)
    .select("id");

  if (scanUpd.error) {
    throw new Error(
      `Contact ${contactId} created but linking it to scan ${scan.id} failed: ${scanUpd.error.message}`,
    );
  }

  return { contactId, contact };
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

/** Contact columns the duplicate matcher compares against. */
export type ContactDupRow = {
  id: string;
  scan_id: string | null;
  email: string | null;
  phone: string | null;
  /** Persisted normalized values (CRM-hardening migration); may be null on
   *  contacts created before the backfill ran. */
  normalized_email: string | null;
  normalized_phone: string | null;
  full_name: string | null;
  last_name: string | null;
  company: string | null;
};

/** SELECT list for loading {@link ContactDupRow}s from business_card_contacts. */
export const CONTACT_DUP_COLUMNS =
  "id, scan_id, email, phone, normalized_email, normalized_phone, full_name, last_name, company";

/**
 * Minimal scan shape the duplicate matcher reads. {@link ContactScan} satisfies
 * it structurally, and so does a verification-route scan row — so the matcher
 * can be reused to re-check old auto-duplicates.
 */
export type DuplicateScanInput = {
  id: string;
  extracted_email: string | null;
  extracted_phone: string | null;
  extracted_full_name: string | null;
  extracted_last_name: string | null;
  extracted_company: string | null;
  normalized_email?: string | null;
  normalized_phone?: string | null;
};

/** How decisive a duplicate match is. */
export type DuplicateStrength = "strong" | "possible";

export type DuplicateMatch = {
  /** The existing contact this scan appears to duplicate. */
  contactId: string;
  /** Which signal combination matched. */
  matchType:
    | "email"
    | "name_company"
    | "name_phone"
    | "company_phone"
    | "lastname_company"
    | "phone_only";
  /**
   * "strong" → confident duplicate (auto-marked, no review needed).
   * "possible" → ambiguous; routed to manual review, never auto-marked.
   */
  strength: DuplicateStrength;
  /** Human-readable explanation of what matched. */
  reason: string;
};

/**
 * Matches a scan against an already-fetched list of contacts. Deliberately
 * conservative about phone numbers — an office / shared line matching is NOT
 * enough to call a confident duplicate.
 *
 * STRONG (confident duplicate):
 *  - same email address
 *  - OR same normalized full name + same normalized company
 *  - OR same normalized full name + same phone number
 *
 * POSSIBLE (ambiguous — needs a human, never auto-marked):
 *  - same company + same phone, different name (likely a shared office line)
 *  - same last name + same company, but not an exact full-name match
 *  - same phone only, different name
 *
 * A phone-only match never escalates to STRONG. Returns the strongest match
 * (a STRONG match short-circuits; otherwise the first POSSIBLE), or null.
 * Pure — no I/O, no mutation. Reused for live detection (findDuplicateContact)
 * and for re-checking old auto-duplicates in bulk.
 */
export function matchScanAgainstContacts(
  scan: DuplicateScanInput,
  rows: ContactDupRow[],
): DuplicateMatch | null {
  // Prefer the scan's persisted normalized_* values; fall back to normalizing
  // the raw extracted values. normalizeEmail / normalizePhone are idempotent.
  const email = normalizeEmail(scan.normalized_email ?? scan.extracted_email);
  const phone = normalizePhone(scan.normalized_phone ?? scan.extracted_phone);
  const fullName = normalizeName(scan.extracted_full_name);
  const lastName = normalizeName(scan.extracted_last_name);
  const company = normalizeName(scan.extracted_company);

  // The first POSSIBLE match is remembered while we keep scanning — a STRONG
  // match anywhere outranks it.
  let possible: DuplicateMatch | null = null;

  for (const row of rows) {
    // A contact already derived from this same scan is not a "duplicate".
    if (row.scan_id && row.scan_id === scan.id) continue;

    // Prefer each contact's persisted normalized value; fall back to its raw
    // column for contacts created before the normalized columns existed.
    const rowEmail = normalizeEmail(row.normalized_email ?? row.email);
    const rowPhone = normalizePhone(row.normalized_phone ?? row.phone);
    const rowName = normalizeName(row.full_name);
    const rowLast = normalizeName(row.last_name);
    const rowCompany = normalizeName(row.company);

    const emailEq = !!email && rowEmail === email;
    const phoneEq = !!phone && rowPhone === phone;
    const nameEq = !!fullName && rowName === fullName;
    const lastEq = !!lastName && rowLast === lastName;
    const companyEq = !!company && rowCompany === company;

    // --- STRONG: decisive — return immediately. ---------------------------
    if (emailEq) {
      return {
        contactId: row.id,
        matchType: "email",
        strength: "strong",
        reason: `Same email address (${scan.extracted_email}).`,
      };
    }
    if (nameEq && companyEq) {
      return {
        contactId: row.id,
        matchType: "name_company",
        strength: "strong",
        reason: `Same name and company (${scan.extracted_full_name} @ ${scan.extracted_company}).`,
      };
    }
    if (nameEq && phoneEq) {
      return {
        contactId: row.id,
        matchType: "name_phone",
        strength: "strong",
        reason: `Same name and phone number (${scan.extracted_full_name}).`,
      };
    }

    // --- POSSIBLE: ambiguous — keep the first, keep looking for a STRONG. --
    if (!possible) {
      if (companyEq && phoneEq) {
        possible = {
          contactId: row.id,
          matchType: "company_phone",
          strength: "possible",
          reason:
            "Same company and phone number but a different name — possibly a shared office line. Review manually.",
        };
      } else if (lastEq && companyEq) {
        possible = {
          contactId: row.id,
          matchType: "lastname_company",
          strength: "possible",
          reason:
            "Same last name and company, but not an exact name match. Review manually.",
        };
      } else if (phoneEq) {
        possible = {
          contactId: row.id,
          matchType: "phone_only",
          strength: "possible",
          reason:
            "Phone number matches another contact, but the name is different — review manually.",
        };
      }
    }
  }

  return possible;
}

/**
 * Live duplicate check: fetches existing contacts and runs
 * {@link matchScanAgainstContacts}. Detection only — never merges/deletes.
 */
export async function findDuplicateContact(
  supabase: SupabaseClient,
  scan: ContactScan,
): Promise<DuplicateMatch | null> {
  const email = normalizeEmail(scan.normalized_email ?? scan.extracted_email);
  const phone = normalizePhone(scan.normalized_phone ?? scan.extracted_phone);
  const fullName = normalizeName(scan.extracted_full_name);
  const lastName = normalizeName(scan.extracted_last_name);
  const company = normalizeName(scan.extracted_company);

  // No matchable signal combination — skip the contacts query entirely.
  if (!email && !phone && !(fullName && company) && !(lastName && company)) {
    return null;
  }

  const res = await supabase
    .from("business_card_contacts")
    .select(CONTACT_DUP_COLUMNS);
  if (res.error) {
    throw new Error(`Duplicate check failed: ${res.error.message}`);
  }

  return matchScanAgainstContacts(scan, (res.data ?? []) as ContactDupRow[]);
}

// ---------------------------------------------------------------------------
// Auto-approval
// ---------------------------------------------------------------------------

/** Does the scan have at least one usable identity field? */
function hasUsableIdentity(scan: ContactScan): boolean {
  const fields = [
    scan.extracted_email,
    scan.extracted_phone,
    scan.extracted_full_name,
    scan.extracted_company,
  ];
  return fields.some(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
}

export type AutoApprovalResult =
  | { outcome: "auto_approved"; contactId: string }
  | { outcome: "needs_review"; reason: string }
  | {
      outcome: "auto_duplicate";
      reason: string;
      duplicateOfContactId: string;
    }
  | {
      outcome: "duplicate_review";
      reason: string;
      duplicateOfContactId: string;
    };

/**
 * Safe auto-approval rule, run after AI extraction completes.
 *
 * A contact is auto-created (verification_status = auto_approved) ONLY when:
 *  - extraction_status = "completed"
 *  - ai_confidence >= {@link AUTO_APPROVE_MIN_CONFIDENCE} (90)
 *  - no duplicate risk is found
 *  - the scan has at least one usable identity field (email / phone /
 *    full_name / company)
 *
 * Duplicate handling (a contact is never created in either case):
 *  - A STRONG match (see findDuplicateContact — email, name+company, or
 *    name+phone) is auto-marked: duplicate_status = confirmed_duplicate,
 *    verification_status = auto_duplicate. Tonja does NOT need to review it.
 *  - A POSSIBLE match (phone-only, company+phone, last-name+company) is left
 *    for manual review: duplicate_status = possible_duplicate,
 *    verification_status = duplicate_review. A phone-number match alone is
 *    never decisive — a shared office line must not auto-mark a duplicate.
 *
 * In every other case the scan is left as needs_review. The scan row and its
 * image are never deleted.
 */
export async function maybeAutoApproveScan(
  supabase: SupabaseClient,
  scan: ContactScan,
): Promise<AutoApprovalResult> {
  // Never create a second contact for a scan that already produced one.
  if (scan.verified_contact_id) {
    return {
      outcome: "needs_review",
      reason: "scan already has a verified contact",
    };
  }

  if ((scan.extraction_status ?? "").toLowerCase().trim() !== "completed") {
    return { outcome: "needs_review", reason: "extraction not completed" };
  }

  const confidence = confidenceToPercent(scan.ai_confidence);
  if (confidence === null || confidence < AUTO_APPROVE_MIN_CONFIDENCE) {
    return {
      outcome: "needs_review",
      reason: `ai_confidence ${
        confidence ?? "unknown"
      } below auto-approve threshold of ${AUTO_APPROVE_MIN_CONFIDENCE}`,
    };
  }

  if (!hasUsableIdentity(scan)) {
    return {
      outcome: "needs_review",
      reason: "no usable identity field (email / phone / full name / company)",
    };
  }

  const duplicate = await findDuplicateContact(supabase, scan);
  if (duplicate) {
    if (duplicate.strength === "strong") {
      // A strong match (email, name+company, or name+phone) is decisive —
      // auto-mark the scan as a confirmed duplicate. No contact, no review.
      const notes = `Auto-marked duplicate of contact ${duplicate.contactId} — ${duplicate.reason}`;
      await supabase
        .from("business_card_scans")
        .update({
          verification_status: "auto_duplicate",
          duplicate_status: "confirmed_duplicate",
          duplicate_notes: notes,
          // Structured link to the matched contact, alongside the readable
          // duplicate_notes above — lets the Verification Center load the
          // contact for a side-by-side comparison (Build 5).
          duplicate_of_contact_id: duplicate.contactId,
        })
        .eq("id", scan.id);
      return {
        outcome: "auto_duplicate",
        reason: notes,
        duplicateOfContactId: duplicate.contactId,
      };
    }

    // A POSSIBLE match (phone-only, company+phone, last-name+company) — too
    // ambiguous to auto-mark. Flag for manual duplicate review; do NOT
    // auto-approve, do NOT create a contact, do NOT touch the original.
    const notes = `Possible duplicate of contact ${duplicate.contactId} — ${duplicate.reason}`;
    await supabase
      .from("business_card_scans")
      .update({
        verification_status: "duplicate_review",
        duplicate_status: "possible_duplicate",
        duplicate_notes: notes,
        // Structured link to the matched contact (see auto_duplicate branch).
        duplicate_of_contact_id: duplicate.contactId,
      })
      .eq("id", scan.id);
    return {
      outcome: "duplicate_review",
      reason: notes,
      duplicateOfContactId: duplicate.contactId,
    };
  }

  const { contactId } = await createContactFromScan(supabase, scan, {
    verificationStatus: "auto_approved",
    approvedBy: "system:auto",
  });

  return { outcome: "auto_approved", contactId };
}
