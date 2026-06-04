/**
 * Coverage Intelligence — extraction quality + brochure analysis (Phase 2.5).
 *
 * Server-only. The brochure is the source of truth; this layer answers
 * "can I trust this EXTRACTION?" rather than re-validating the brochure. It
 * computes confidence/flag/exception stats over a brochure's PENDING rows so an
 * operator can publish the trustworthy rows in bulk and hold only the genuine
 * exceptions (low confidence / quality-flagged) for a quick spot-check.
 *
 * EXCEPTION (held back from auto-publish) = a pending row that is either below
 * the confidence threshold OR carries a blocking quality flag:
 *   - missing source_text  (no citation — never auto-publish)
 *   - missing plan         (coverage/pricing only)
 *   - missing price        (pricing always; add-ons only when sold as add-on)
 *   - duplicate-looking    (same key as another pending row of that kind)
 * A missing numeric limit is NOT blocking (many items legitimately have none).
 */

import { ApiError } from "@/lib/server/auth";
import { promoteCurrentBrochure } from "./brochures";
import {
  bulkReview,
  listPending,
  type PendingAddon,
  type PendingCoverage,
  type PendingPricing,
} from "./review";

/** Rows at/above this confidence (and flag-free) are auto-publishable. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.85;

function lc(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Deterministic citation-consistency checks. The brochure is trusted; this only
// guards against EXTRACTION rows whose critical values aren't actually supported
// by the cited source_text (e.g. a price hallucinated from a different line).
// Deliberately CONSERVATIVE — normalizes hard and only flags obvious mismatches,
// so valid rows (formatting differences, table-implied values) aren't blocked.
// A failing row is HELD as a pending exception, never rejected/deleted.
// ---------------------------------------------------------------------------

const CITATION_STOPWORDS = new Set([
  "with", "your", "this", "that", "plan", "plans", "from", "into", "they",
  "will", "when", "each", "also", "such", "have", "there", "their", "which",
  "other", "only", "than", "then", "per",
]);

function normalizeForMatch(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Significant (length>=4, non-stopword) tokens of a phrase. */
function significantTokens(s: string): string[] {
  return normalizeForMatch(s)
    .split(" ")
    .filter((t) => t.length >= 4 && !CITATION_STOPWORDS.has(t));
}

/** Digit groups from a string, commas stripped ("$1,000" → "1000"). */
function digitGroups(s: string | null | undefined): string[] {
  return (s ?? "").match(/\d[\d,]*/g)?.map((d) => d.replace(/,/g, "")) ?? [];
}

/** Conservative: empty needle → supported (uncheckable). One token → must be
 *  present. Multiple → at least half present as substrings in the haystack. */
function tokensSupported(needle: string, hay: string): boolean {
  const toks = significantTokens(needle);
  if (toks.length === 0) return true;
  const present = toks.filter((t) => hay.includes(t)).length;
  if (toks.length === 1) return present === 1;
  return present >= Math.ceil(toks.length / 2);
}

/** True when the coverage item is supported by its source_text. */
function coverageCitationOk(r: PendingCoverage): boolean {
  const hay = normalizeForMatch(r.sourceText);
  // Item name is the key signal; plan name is intentionally NOT required (it's
  // often a table header, not on the cited line).
  return tokensSupported(r.coverageItem, hay);
}

/** True when the pricing row's price is supported by its source_text. */
function pricingCitationOk(r: PendingPricing): boolean {
  const hayDigits = digitGroups(r.sourceText);
  const priceDigits = [...digitGroups(r.priceText)];
  if (r.priceAmount != null) priceDigits.push(String(Math.trunc(r.priceAmount)));
  if (priceDigits.length > 0) {
    // At least one of the price's digit groups must appear in the source.
    return priceDigits.some((d) => hayDigits.includes(d));
  }
  // No digits to check (e.g. price_text is words) → fall back to token support.
  if (r.priceText) return tokensSupported(r.priceText, normalizeForMatch(r.sourceText));
  return true;
}

/** True when the add-on name is supported by its source_text. */
function addonCitationOk(r: PendingAddon): boolean {
  return tokensSupported(r.addonName, normalizeForMatch(r.sourceText));
}

export type Exceptionable = { isException: boolean; reasons: string[] };

function classifyCoverage(
  r: PendingCoverage,
  dup: number,
  threshold: number,
): Exceptionable {
  const reasons: string[] = [];
  if ((r.confidence ?? 0) < threshold) reasons.push("low confidence");
  if (!r.sourceText?.trim()) reasons.push("missing source");
  if (!r.planName.trim()) reasons.push("missing plan");
  if (dup > 1) reasons.push("duplicate");
  if (r.sourceText?.trim() && !coverageCitationOk(r))
    reasons.push("citation mismatch");
  return { isException: reasons.length > 0, reasons };
}

function classifyPricing(
  r: PendingPricing,
  dup: number,
  threshold: number,
): Exceptionable {
  const reasons: string[] = [];
  if ((r.confidence ?? 0) < threshold) reasons.push("low confidence");
  if (!r.sourceText?.trim()) reasons.push("missing source");
  if (!r.planName.trim()) reasons.push("missing plan");
  if (r.priceAmount == null && !r.priceText?.trim()) reasons.push("missing price");
  if (dup > 1) reasons.push("duplicate");
  if (r.sourceText?.trim() && !pricingCitationOk(r))
    reasons.push("citation mismatch");
  return { isException: reasons.length > 0, reasons };
}

function classifyAddon(
  r: PendingAddon,
  dup: number,
  threshold: number,
): Exceptionable {
  const reasons: string[] = [];
  if ((r.confidence ?? 0) < threshold) reasons.push("low confidence");
  if (!r.sourceText?.trim()) reasons.push("missing source");
  if (
    r.availableAsAddon === true &&
    r.addonPriceAmount == null &&
    !r.addonPriceText?.trim()
  )
    reasons.push("missing price");
  if (dup > 1) reasons.push("duplicate");
  if (r.sourceText?.trim() && !addonCitationOk(r))
    reasons.push("citation mismatch");
  return { isException: reasons.length > 0, reasons };
}

/** A spot-check sample row surfaced before bulk publish. */
export type SampleRow = {
  kind: "coverage" | "pricing" | "addons";
  id: string;
  sourcePage: number | null;
  sourceText: string | null;
  summary: string;
};

export type BrochureAnalysis = {
  threshold: number;
  pendingTotal: number;
  byKind: { coverage: number; pricing: number; addons: number };
  confidence: { high: number; medium: number; low: number };
  flags: {
    missingSource: number;
    missingPlan: number;
    missingPrice: number;
    duplicate: number;
    lowConfidence: number;
    citationMismatch: number;
  };
  eligible: number;
  held: number;
  pages: { withFacts: number; min: number | null; max: number | null };
  /** Up to 5 random eligible rows for the pre-publish spot-check. */
  sample: SampleRow[];
  /** Non-exception pending row ids, per kind — what "Approve & Publish" acts on. */
  eligibleIds: { coverage: string[]; pricing: string[]; addons: string[] };
};

/**
 * Analyzes a brochure's pending rows: confidence distribution, flag counts, and
 * which rows are auto-publishable (eligible) vs held as exceptions.
 */
export async function analyzeBrochure(
  brochureId: string,
  threshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
): Promise<BrochureAnalysis> {
  const p = await listPending(brochureId);

  const flags = {
    missingSource: 0,
    missingPlan: 0,
    missingPrice: 0,
    duplicate: 0,
    lowConfidence: 0,
    citationMismatch: 0,
  };
  const confidence = { high: 0, medium: 0, low: 0 };
  const eligibleIds = {
    coverage: [] as string[],
    pricing: [] as string[],
    addons: [] as string[],
  };
  const eligibleSamples: SampleRow[] = [];
  let eligible = 0;
  let held = 0;
  const pages = new Set<number>();
  let minPage: number | null = null;
  let maxPage: number | null = null;

  const tallyConfidence = (c: number | null) => {
    const v = c ?? 0;
    if (v >= 0.85) confidence.high += 1;
    else if (v >= 0.65) confidence.medium += 1;
    else confidence.low += 1;
  };
  const tallyReasons = (reasons: string[]) => {
    if (reasons.includes("missing source")) flags.missingSource += 1;
    if (reasons.includes("missing plan")) flags.missingPlan += 1;
    if (reasons.includes("missing price")) flags.missingPrice += 1;
    if (reasons.includes("duplicate")) flags.duplicate += 1;
    if (reasons.includes("low confidence")) flags.lowConfidence += 1;
    if (reasons.includes("citation mismatch")) flags.citationMismatch += 1;
  };
  const tallyPage = (page: number | null) => {
    if (page == null) return;
    pages.add(page);
    minPage = minPage == null ? page : Math.min(minPage, page);
    maxPage = maxPage == null ? page : Math.max(maxPage, page);
  };

  // coverage
  const covDup = new Map<string, number>();
  for (const r of p.coverage) {
    const k = `${lc(r.planName)} ${lc(r.coverageItem)}`;
    covDup.set(k, (covDup.get(k) ?? 0) + 1);
  }
  for (const r of p.coverage) {
    tallyConfidence(r.confidence);
    tallyPage(r.sourcePage);
    const cls = classifyCoverage(
      r,
      covDup.get(`${lc(r.planName)} ${lc(r.coverageItem)}`) ?? 0,
      threshold,
    );
    tallyReasons(cls.reasons);
    if (cls.isException) held += 1;
    else {
      eligible += 1;
      eligibleIds.coverage.push(r.id);
      eligibleSamples.push({
        kind: "coverage",
        id: r.id,
        sourcePage: r.sourcePage,
        sourceText: r.sourceText,
        summary: `${r.planName} — ${r.coverageItem}${r.coverageLimitText ? ` · ${r.coverageLimitText}` : ""}`,
      });
    }
  }

  // pricing
  const priDup = new Map<string, number>();
  for (const r of p.pricing) {
    const k = lc(r.planName);
    priDup.set(k, (priDup.get(k) ?? 0) + 1);
  }
  for (const r of p.pricing) {
    tallyConfidence(r.confidence);
    tallyPage(r.sourcePage);
    const cls = classifyPricing(r, priDup.get(lc(r.planName)) ?? 0, threshold);
    tallyReasons(cls.reasons);
    if (cls.isException) held += 1;
    else {
      eligible += 1;
      eligibleIds.pricing.push(r.id);
      eligibleSamples.push({
        kind: "pricing",
        id: r.id,
        sourcePage: r.sourcePage,
        sourceText: r.sourceText,
        summary: `${r.planName} — ${r.priceText ?? (r.priceAmount != null ? String(r.priceAmount) : "?")}`,
      });
    }
  }

  // addons
  const addDup = new Map<string, number>();
  for (const r of p.addons) {
    const k = `${lc(r.addonName)} ${lc(r.planName)}`;
    addDup.set(k, (addDup.get(k) ?? 0) + 1);
  }
  for (const r of p.addons) {
    tallyConfidence(r.confidence);
    tallyPage(r.sourcePage);
    const cls = classifyAddon(
      r,
      addDup.get(`${lc(r.addonName)} ${lc(r.planName)}`) ?? 0,
      threshold,
    );
    tallyReasons(cls.reasons);
    if (cls.isException) held += 1;
    else {
      eligible += 1;
      eligibleIds.addons.push(r.id);
      eligibleSamples.push({
        kind: "addons",
        id: r.id,
        sourcePage: r.sourcePage,
        sourceText: r.sourceText,
        summary: `${r.addonName}${r.planName ? ` (${r.planName})` : ""}${r.addonPriceText ? ` — ${r.addonPriceText}` : ""}`,
      });
    }
  }

  // Random spot-check sample (up to 5) from the eligible rows.
  const shuffled = [...eligibleSamples];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const sample = shuffled.slice(0, 5);

  return {
    threshold,
    pendingTotal: p.coverage.length + p.pricing.length + p.addons.length,
    byKind: {
      coverage: p.coverage.length,
      pricing: p.pricing.length,
      addons: p.addons.length,
    },
    confidence,
    flags,
    eligible,
    held,
    pages: { withFacts: pages.size, min: minPage, max: maxPage },
    sample,
    eligibleIds,
  };
}

export type ApprovePublishResult = {
  approved: number;
  held: number;
  eligible: number;
  threshold: number;
  published: boolean;
  publishNote: string | null;
};

/**
 * Approves every AUTO-PUBLISHABLE (non-exception) pending row for a brochure and
 * promotes the brochure to current — "publish the trustworthy rows, hold the
 * exceptions". Exceptions stay pending for spot-check. Uses the pending-only
 * bulk mutation (audit-stamped) and the atomic promote RPC.
 */
export async function approveAndPublishBrochure(
  brochureId: string,
  reviewerId: string,
  brochureStatus: string,
  threshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
  confirmedSampleReview: boolean = false,
): Promise<ApprovePublishResult> {
  // Server-side gate — never trust a UI-only confirmation.
  if (confirmedSampleReview !== true) {
    throw new ApiError(
      400,
      "Sample review must be confirmed before publishing.",
    );
  }

  // Re-analyze server-side (never trust a client-supplied eligible set).
  const analysis = await analyzeBrochure(brochureId, threshold);

  // Block empty publish: nothing trustworthy to approve.
  if (analysis.eligible === 0) {
    throw new ApiError(
      409,
      "No eligible rows to publish. Review the held exceptions first.",
    );
  }

  const items = [
    ...analysis.eligibleIds.coverage.map((rowId) => ({
      kind: "coverage" as const,
      rowId,
    })),
    ...analysis.eligibleIds.pricing.map((rowId) => ({
      kind: "pricing" as const,
      rowId,
    })),
    ...analysis.eligibleIds.addons.map((rowId) => ({
      kind: "addons" as const,
      rowId,
    })),
  ];

  let approved = 0;
  if (items.length > 0) {
    const res = await bulkReview(
      items,
      reviewerId,
      "approve",
      "Bulk-approved via brochure publish",
    );
    approved = res.updated;
  }

  // Publish: promote to current when the brochure is in a promotable state.
  let published = false;
  let publishNote: string | null = null;
  if (brochureStatus === "imported" || brochureStatus === "current") {
    await promoteCurrentBrochure(brochureId);
    published = true;
  } else {
    publishNote = `Brochure status is '${brochureStatus}', so it was not promoted to current. Approved rows are saved but won't serve until a current version is published.`;
  }

  if (analysis.held > 0 && !publishNote) {
    publishNote = `${analysis.held} exception row(s) were held as pending for review and are not published yet.`;
  }

  return {
    approved,
    held: analysis.held,
    eligible: analysis.eligible,
    threshold,
    published,
    publishNote,
  };
}

/** Validates a client-supplied threshold (0..1). */
export function coerceThreshold(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_CONFIDENCE_THRESHOLD;
  }
  if (value < 0 || value > 1) {
    throw new ApiError(400, "confidenceThreshold must be between 0 and 1.");
  }
  return value;
}
