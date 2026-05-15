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

import {
  CONTACT_BUCKET_ORDER,
  normalizeScanContactType,
  type ContactBucket,
} from "@/lib/contact-type";

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

/**
 * Contact fields an admin may override before approval (the `editedFields`
 * body of POST /api/business-card/approve). Unknown keys are ignored; only
 * these named fields are ever written.
 */
export type EditableContactFields = {
  first_name?: unknown;
  last_name?: unknown;
  full_name?: unknown;
  company?: unknown;
  title?: unknown;
  email?: unknown;
  phone?: unknown;
  website?: unknown;
  address?: unknown;
  contact_bucket?: unknown;
  contact_type_raw?: unknown;
};

export type CreateContactOptions = {
  verificationStatus: ContactVerificationStatus;
  /** Who approved it — stored in `approved_by` for approved/auto_approved. */
  approvedBy?: string | null;
  /** Optional admin overrides applied on top of the scan's extracted fields. */
  editedFields?: EditableContactFields;
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

/**
 * Resolves an admin-edited value:
 *  - `undefined`  → field not provided, caller should fall back to the scan
 *  - `null` / ""  → field explicitly cleared
 *  - non-empty string → trimmed value
 *  - any other type → ignored (treated as not provided)
 */
function editedValue(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return undefined;
}

/** Picks the admin override if provided, otherwise the scan's extracted value. */
function resolveField(edited: unknown, fallback: string | null): string | null {
  const resolved = editedValue(edited);
  return resolved === undefined ? fallback : resolved;
}

/** Validates an admin-supplied contact bucket, else derives one from the scan. */
function resolveBucket(edited: unknown, scan: ContactScan): ContactBucket {
  if (
    typeof edited === "string" &&
    (CONTACT_BUCKET_ORDER as string[]).includes(edited)
  ) {
    return edited as ContactBucket;
  }
  return normalizeScanContactType(scan);
}

/** Normalizes the AI confidence to a 0–100 percentage (raw values may be 0–1). */
export function confidenceToPercent(value: number | null): number | null {
  if (value === null || Number.isNaN(value)) return null;
  return value <= 1 ? value * 100 : value;
}

function normalizeEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePhone(value: string | null | undefined): string | null {
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
 * The contact's fields are copied from the scan's `extracted_*` columns, with
 * any `options.editedFields` overrides applied on top. The originating scan is
 * never modified beyond `verified_contact_id` + `verification_status`, and is
 * never deleted.
 *
 * Throws if the insert fails or if the scan link-back fails.
 */
export async function createContactFromScan(
  supabase: SupabaseClient,
  scan: ContactScan,
  options: CreateContactOptions,
): Promise<CreateContactResult> {
  const edited = options.editedFields ?? {};
  const bucket = resolveBucket(edited.contact_bucket, scan);
  const now = new Date().toISOString();
  const isApproved =
    options.verificationStatus === "auto_approved" ||
    options.verificationStatus === "approved";

  const insertRow = {
    scan_id: scan.id,
    salesperson_id: scan.salesperson_id,
    salesperson_name: scan.salesperson_name,
    contact_bucket: bucket,
    contact_type_raw: resolveField(
      edited.contact_type_raw,
      scan.extracted_contact_type,
    ),
    first_name: resolveField(edited.first_name, scan.extracted_first_name),
    last_name: resolveField(edited.last_name, scan.extracted_last_name),
    full_name: resolveField(edited.full_name, scan.extracted_full_name),
    company: resolveField(edited.company, scan.extracted_company),
    title: resolveField(edited.title, scan.extracted_title),
    email: resolveField(edited.email, scan.extracted_email),
    phone: resolveField(edited.phone, scan.extracted_phone),
    website: resolveField(edited.website, scan.extracted_website),
    address: resolveField(edited.address, scan.extracted_address),
    // business_card_scans only stores a public image_url; there is no separate
    // storage path column to copy, so image_path stays null for now.
    image_path: null,
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

type ContactDupRow = {
  id: string;
  scan_id: string | null;
  email: string | null;
  phone: string | null;
  full_name: string | null;
  company: string | null;
};

export type DuplicateMatch = {
  /** The existing contact this scan appears to duplicate. */
  contactId: string;
  /**
   * Which signal matched. "email" / "phone" are strong (used for auto-marking
   * duplicates); "name_company" is weaker and is left for manual review.
   */
  matchType: "email" | "phone" | "name_company";
  /** Human-readable explanation of what matched. */
  reason: string;
};

/**
 * Foundation duplicate check. A scan is a potential duplicate of an existing
 * contact when any of these match:
 *  - normalized email          → strong  (matchType "email")
 *  - normalized phone (digits) → strong  (matchType "phone")
 *  - normalized full_name AND normalized company together → weak
 *    (matchType "name_company")
 *
 * Returns the first match found, or null. Does not merge, delete, or modify
 * anything — detection only.
 */
export async function findDuplicateContact(
  supabase: SupabaseClient,
  scan: ContactScan,
): Promise<DuplicateMatch | null> {
  const email = normalizeEmail(scan.extracted_email);
  const phone = normalizePhone(scan.extracted_phone);
  const fullName = normalizeName(scan.extracted_full_name);
  const company = normalizeName(scan.extracted_company);

  // Nothing identifying to compare on — cannot assess duplicate risk.
  if (!email && !phone && !(fullName && company)) {
    return null;
  }

  const res = await supabase
    .from("business_card_contacts")
    .select("id, scan_id, email, phone, full_name, company");

  if (res.error) {
    throw new Error(`Duplicate check failed: ${res.error.message}`);
  }

  const rows = (res.data ?? []) as ContactDupRow[];

  for (const row of rows) {
    // A contact already derived from this same scan is not a "duplicate".
    if (row.scan_id && row.scan_id === scan.id) continue;

    if (email && normalizeEmail(row.email) === email) {
      return {
        contactId: row.id,
        matchType: "email",
        reason: `matching email (${scan.extracted_email})`,
      };
    }
    if (phone && normalizePhone(row.phone) === phone) {
      return {
        contactId: row.id,
        matchType: "phone",
        reason: `matching phone (${scan.extracted_phone})`,
      };
    }
    if (
      fullName &&
      company &&
      normalizeName(row.full_name) === fullName &&
      normalizeName(row.company) === company
    ) {
      return {
        contactId: row.id,
        matchType: "name_company",
        reason: `matching name + company (${scan.extracted_full_name} @ ${scan.extracted_company})`,
      };
    }
  }

  return null;
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
 *  - A strong match (email OR phone) at >= 90 confidence is auto-marked:
 *    duplicate_status = confirmed_duplicate, verification_status =
 *    auto_duplicate. Tonja does NOT need to review it.
 *  - A weak match (full_name + company only) is left for manual review:
 *    duplicate_status = possible_duplicate, verification_status =
 *    duplicate_review.
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
    const strong =
      duplicate.matchType === "email" || duplicate.matchType === "phone";

    if (strong) {
      // Email/phone match at >= 90 confidence is decisive — auto-mark the scan
      // as a confirmed duplicate. No contact is created, no review needed.
      const notes = `Auto-marked duplicate of contact ${duplicate.contactId} — ${duplicate.reason}`;
      await supabase
        .from("business_card_scans")
        .update({
          verification_status: "auto_duplicate",
          duplicate_status: "confirmed_duplicate",
          duplicate_notes: notes,
        })
        .eq("id", scan.id);
      return {
        outcome: "auto_duplicate",
        reason: notes,
        duplicateOfContactId: duplicate.contactId,
      };
    }

    // Name + company only — weaker signal. Flag for manual duplicate review;
    // do NOT auto-approve, do NOT create a contact, do NOT touch the original.
    const notes = `Possible duplicate of contact ${duplicate.contactId} — ${duplicate.reason}`;
    await supabase
      .from("business_card_scans")
      .update({
        verification_status: "duplicate_review",
        duplicate_status: "possible_duplicate",
        duplicate_notes: notes,
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
