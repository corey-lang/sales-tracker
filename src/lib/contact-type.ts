/**
 * Normalizes a raw contact-type string (from AI extraction) into one of three
 * fixed buckets used by the Verification Center.
 *
 * Matching is forgiving: input is lowercased and trimmed, and partial
 * (substring) matches are allowed.
 */

export type ContactBucket = "real_estate_agent" | "title" | "other";

/** Substrings that map a contact type to the real estate agent bucket. */
const REAL_ESTATE_AGENT_KEYWORDS = [
  "realtor associate",
  "realtor",
  "real estate agent",
  "real estate",
  "brokerage",
  "broker",
  "agent",
];

/** Substrings that map a contact type to the title bucket. */
const TITLE_KEYWORDS = [
  "title officer",
  "title company",
  "title rep",
  "title",
  "escrow officer",
  "escrow assistant",
  "escrow manager",
  "escrow",
  "first american",
  "fidelity",
  "stewart",
  "old republic",
];

/**
 * Maps a raw contact-type value to a normalized bucket.
 *
 * Returns "other" for anything unrecognized, including empty / null / undefined
 * input (e.g. lender, loan officer, inspector, contractor, vendor, unknown).
 */
export function normalizeContactType(
  value: string | null | undefined,
): ContactBucket {
  if (!value) return "other";

  const normalized = value.toLowerCase().trim();
  if (normalized.length === 0) return "other";

  // Title is checked before real estate agent so that values like
  // "title agent" land in the title bucket rather than matching "agent".
  if (TITLE_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return "title";
  }

  if (
    REAL_ESTATE_AGENT_KEYWORDS.some((keyword) => normalized.includes(keyword))
  ) {
    return "real_estate_agent";
  }

  return "other";
}

/**
 * Subset of a business card scan inspected for bucket classification.
 * Every field is optional so callers can pass a full scan row or a partial.
 * `raw_ocr_text` / `ai_notes` are checked only when present.
 */
export type ScanContactFields = {
  extracted_contact_type?: string | null;
  extracted_title?: string | null;
  extracted_company?: string | null;
  extracted_full_name?: string | null;
  raw_ocr_text?: string | null;
  ai_notes?: string | null;
};

/** Keywords that, in any inspected field, classify a scan as title. */
const SCAN_TITLE_KEYWORDS = [
  "title company",
  "mh title",
  "title",
  "escrow officer",
  "escrow assistant",
  "escrow manager",
  "escrow",
  "first american",
  "fidelity",
  "stewart",
  "old republic",
];

/** Keywords that, in any inspected field, classify a scan as real estate agent. */
const SCAN_REAL_ESTATE_KEYWORDS = [
  "realtor",
  "real estate agent",
  "real estate",
  "brokerage",
  "broker",
];

/**
 * Classifies a scan into a bucket by inspecting multiple extracted fields,
 * not just `extracted_contact_type`. This handles cases where the AI returns
 * a vague contact type (e.g. "general") but the title / company / OCR text
 * clearly indicates title or real estate.
 *
 * Priority: title wins over real estate agent if both appear; anything
 * unrecognized falls through to "other".
 */
export function normalizeScanContactType(scan: ScanContactFields): ContactBucket {
  const haystack = [
    scan.extracted_contact_type,
    scan.extracted_title,
    scan.extracted_company,
    scan.extracted_full_name,
    scan.raw_ocr_text,
    scan.ai_notes,
  ]
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )
    .join(" \n ")
    .toLowerCase();

  if (haystack.length === 0) return "other";

  if (SCAN_TITLE_KEYWORDS.some((keyword) => haystack.includes(keyword))) {
    return "title";
  }

  if (SCAN_REAL_ESTATE_KEYWORDS.some((keyword) => haystack.includes(keyword))) {
    return "real_estate_agent";
  }

  return "other";
}

/** Human-readable label for a bucket, used as subsection headers. */
export const CONTACT_BUCKET_LABELS: Record<ContactBucket, string> = {
  real_estate_agent: "Real Estate Agents",
  title: "Title People",
  other: "Other",
};

/** Fixed display order for buckets within an AE section. */
export const CONTACT_BUCKET_ORDER: ContactBucket[] = [
  "real_estate_agent",
  "title",
  "other",
];
