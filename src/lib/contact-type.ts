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
