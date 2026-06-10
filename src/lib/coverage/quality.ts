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
  countApprovedFacts,
  listPending,
  type BulkReviewItem,
  type PendingAddon,
  type PendingCoverage,
  type PendingPricing,
} from "./review";

/** Non-trusted hard floor: rows below this confidence are NEVER auto-approved. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.85;

/**
 * The canonical base plan names. Base-plan PRICING may only auto-approve for one
 * of these — independent of (never derived from) extracted coverage rows, so a
 * misfiled add-on can't become a "known plan". Add a state's plan names here as
 * states are onboarded. Matched case-insensitively, whole-phrase.
 */
export const CANONICAL_BASE_PLANS = [
  "Essential",
  "Elevated",
  "Totally Elevated",
  "Epic",
];

/** Trusted Brochure Mode hard floor. For an official (trusted) brochure the
 *  confidence gate is relaxed to this floor — obvious high/medium-confidence
 *  rows auto-approve — while EVERY structural gate (citation present, citation
 *  consistency, source_page present, dedupe, required plan/price) still applies.
 *  Confidence below this floor (e.g. OCR garbage) is always held. */
export const TRUSTED_CONFIDENCE_FLOOR = 0.5;

/**
 * The SERVER-OWNED minimum auto-approve confidence for a brochure: 0.85 for a
 * normal brochure, 0.50 for a trusted one. This is a hard floor — no API request
 * can auto-approve below it.
 */
export function minConfidenceFloor(trusted: boolean): number {
  return trusted ? TRUSTED_CONFIDENCE_FLOOR : DEFAULT_CONFIDENCE_THRESHOLD;
}

/**
 * The confidence threshold actually applied to a brochure's rows. The server
 * OWNS the minimum (`minConfidenceFloor`): a caller-supplied value may only make
 * the gate STRICTER (raise it), never lower it below the floor. An absent
 * request uses the floor. Trusted vs. non-trusted changes ONLY which floor is
 * used — never the structural exception rules.
 *
 *   effectiveThreshold(undefined, true)  → 0.50   (trusted floor)
 *   effectiveThreshold(undefined, false) → 0.85   (non-trusted floor)
 *   effectiveThreshold(0.40, true)       → 0.50   (can't go below trusted floor)
 *   effectiveThreshold(0.40, false)      → 0.85   (can't go below non-trusted floor)
 *   effectiveThreshold(0.95, *)          → 0.95   (raising the bar is honored)
 */
export function effectiveThreshold(
  requested: number | undefined,
  trusted: boolean,
): number {
  const floor = minConfidenceFloor(trusted);
  return requested === undefined ? floor : Math.max(requested, floor);
}

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

const CANONICAL_BASE_PLAN_SET = new Set(
  CANONICAL_BASE_PLANS.map(normalizeForMatch),
);

/** True when `planName` is one of the canonical base plans (case-insensitive,
 *  whole-phrase). Independent of any extracted rows. */
function isCanonicalBasePlan(planName: string | null): boolean {
  return CANONICAL_BASE_PLAN_SET.has(normalizeForMatch(planName ?? ""));
}

/**
 * Which of `candidateLabels` appear in the source as WHOLE PHRASES (space-
 * delimited word boundaries on the normalized text), matched LONGEST-FIRST with
 * the matched span removed. Longest-first + removal is what disambiguates nested
 * plan names: a source that says "Totally Elevated" yields ONLY {totally
 * elevated} — the contained "elevated" is consumed and can't also match an
 * "Elevated" row. Returns the normalized labels found.
 */
function plansPresentInSource(
  sourceText: string | null,
  candidateLabels: string[],
): Set<string> {
  let hay = ` ${normalizeForMatch(sourceText)} `;
  const present = new Set<string>();
  const labels = [
    ...new Set(candidateLabels.map(normalizeForMatch).filter((s) => s.length > 0)),
  ].sort((a, b) => b.length - a.length);
  for (const label of labels) {
    const padded = ` ${label} `;
    if (hay.includes(padded)) {
      present.add(label);
      hay = hay.split(padded).join("  "); // consume so a nested label can't re-match
    }
  }
  return present;
}

/**
 * True when the source_text proves the row's specific PLAN assignment.
 *
 * Multi-column-table guard. A brochure grid has several plan columns, so a
 * single-cell snippet proves the value exists but NOT which column owns it. The
 * source must name the row's plan as a whole phrase — and, via longest-first
 * matching, "Elevated" can't be validated by a source that only says "Totally
 * Elevated" (and vice-versa). Candidate labels are the canonical base plans plus
 * the row's own plan (so a non-canonical plan can still match itself). A blank
 * plan name is uncheckable → true (other gates decide).
 */
function sourceProvesPlan(planName: string | null, sourceText: string | null): boolean {
  const norm = normalizeForMatch(planName ?? "");
  if (!norm) return true;
  const present = plansPresentInSource(sourceText, [
    ...CANONICAL_BASE_PLANS,
    planName ?? "",
  ]);
  return present.has(norm);
}

/** True when the coverage item is supported by its source_text. */
function coverageCitationOk(r: PendingCoverage): boolean {
  const hay = normalizeForMatch(r.sourceText);
  // Item name is the key signal; plan and value are proven separately so a
  // multi-column row needs plan + item + value all supported by the cited text.
  return tokensSupported(r.coverageItem, hay);
}

/**
 * The significant NON-NUMERIC qualifier tokens of a limit string — the words
 * that change the meaning of the value (e.g. "Request", "night", "max",
 * "Dollar", "Limit"). Currency/punctuation/slashes/commas are normalized away
 * by normalizeForMatch; numeric groups are validated separately, so purely
 * numeric tokens are excluded here. Length ≥ 3 (so "max"/"day" count) and
 * stopwords ("per", "than", …) are dropped.
 */
function limitQualifierTokens(s: string | null | undefined): string[] {
  return normalizeForMatch(s)
    .split(" ")
    .filter(
      (t) => t.length >= 3 && !/^\d+$/.test(t) && !CITATION_STOPWORDS.has(t),
    );
}

/**
 * True when the coverage row's full VALUE/limit is proven by its source_text.
 * A row that carries a limit must cite the WHOLE limit, not just the number:
 *   - EVERY numeric group (from coverage_limit and the digits in
 *     coverage_limit_text) must appear in the source's digits, AND
 *   - EVERY significant qualifier token of coverage_limit_text (e.g. "Request",
 *     "night", "max", "Dollar", "Limit") must appear in the source.
 * So "Epic: HVAC Refrigerant $300" does NOT prove "$300 / Request" (the
 * "/ Request" qualifier is missing). A row with no limit/value → true.
 */
function coverageValueOk(r: PendingCoverage): boolean {
  const hay = normalizeForMatch(r.sourceText);
  const sourceDigits = digitGroups(r.sourceText);

  // 1) Numeric groups: structured numeric limit + any digit groups in the text.
  const wantDigits = new Set<string>();
  if (r.coverageLimit != null) wantDigits.add(String(Math.trunc(r.coverageLimit)));
  for (const d of digitGroups(r.coverageLimitText)) wantDigits.add(d);
  for (const d of wantDigits) {
    if (!sourceDigits.includes(d)) return false;
  }

  // 2) Qualifier tokens of the limit text must all be present.
  const limitText = r.coverageLimitText?.trim();
  if (limitText) {
    const tokens = limitQualifierTokens(limitText);
    for (const t of tokens) {
      if (!hay.includes(t)) return false;
    }
    // A limit string with neither digits nor qualifier tokens (rare) still must
    // be supported rather than silently passing on nothing.
    if (wantDigits.size === 0 && tokens.length === 0) {
      return tokensSupported(limitText, hay);
    }
  }
  return true;
}

/** True when a coverage row carries a value/limit that must be cited. */
function coverageHasValue(r: PendingCoverage): boolean {
  return r.coverageLimit != null || !!r.coverageLimitText?.trim();
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

export function classifyCoverage(
  r: PendingCoverage,
  dup: number,
  threshold: number,
): Exceptionable {
  const reasons: string[] = [];
  if ((r.confidence ?? 0) < threshold) reasons.push("low confidence");
  if (!r.sourceText?.trim()) reasons.push("missing source");
  if (r.sourcePage == null) reasons.push("missing page");
  if (!r.planName.trim()) reasons.push("missing plan");
  if (dup > 1) reasons.push("duplicate");
  if (r.sourceText?.trim() && !coverageCitationOk(r))
    reasons.push("citation mismatch");
  // The cited text must prove the PLAN this value belongs to (multi-column guard).
  if (r.sourceText?.trim() && !sourceProvesPlan(r.planName, r.sourceText))
    reasons.push("plan unverified");
  // ...and the VALUE/limit itself, when the row carries one — a row whose limit
  // ("$300 / Request") isn't in the cited text can't auto-approve.
  if (r.sourceText?.trim() && coverageHasValue(r) && !coverageValueOk(r))
    reasons.push("value unverified");
  return { isException: reasons.length > 0, reasons };
}

/**
 * Base-plan pricing eligibility is structurally limited to the CANONICAL base
 * plans (CANONICAL_BASE_PLANS) — NEVER derived from extracted coverage rows, so
 * a misfiled add-on can't contaminate the set of "known plans". A `plan_pricing`
 * row whose plan_name isn't canonical (e.g. "Water Softener", "Exterior Main
 * Line Coverage", "Reverse Osmosis System", pool/spa, extra fridge) is held as
 * "not a base plan". A canonical plan still must have the plan AND price proven
 * by the cited text.
 */
export function classifyPricing(
  r: PendingPricing,
  dup: number,
  threshold: number,
): Exceptionable {
  const reasons: string[] = [];
  if ((r.confidence ?? 0) < threshold) reasons.push("low confidence");
  if (!r.sourceText?.trim()) reasons.push("missing source");
  if (r.sourcePage == null) reasons.push("missing page");
  if (!r.planName.trim()) reasons.push("missing plan");
  if (r.priceAmount == null && !r.priceText?.trim()) reasons.push("missing price");
  if (dup > 1) reasons.push("duplicate");
  if (r.sourceText?.trim() && !pricingCitationOk(r))
    reasons.push("citation mismatch");
  // The cited text must prove the PLAN the price belongs to (multi-column guard).
  if (r.sourceText?.trim() && !sourceProvesPlan(r.planName, r.sourceText))
    reasons.push("plan unverified");
  // Base-plan pricing only — canonical plan names, independent of extracted rows.
  if (r.planName.trim() && !isCanonicalBasePlan(r.planName))
    reasons.push("not a base plan");
  return { isException: reasons.length > 0, reasons };
}

export function classifyAddon(
  r: PendingAddon,
  dup: number,
  threshold: number,
): Exceptionable {
  const reasons: string[] = [];
  if ((r.confidence ?? 0) < threshold) reasons.push("low confidence");
  if (!r.sourceText?.trim()) reasons.push("missing source");
  if (r.sourcePage == null) reasons.push("missing page");
  if (
    r.availableAsAddon === true &&
    r.addonPriceAmount == null &&
    !r.addonPriceText?.trim()
  )
    reasons.push("missing price");
  if (dup > 1) reasons.push("duplicate");
  if (r.sourceText?.trim() && !addonCitationOk(r))
    reasons.push("citation mismatch");
  // When an add-on is scoped to a specific plan, the cited text must prove that
  // plan assignment. Catalog-level add-ons (plan_name null) are plan-agnostic.
  if (
    r.planName?.trim() &&
    r.sourceText?.trim() &&
    !sourceProvesPlan(r.planName, r.sourceText)
  )
    reasons.push("plan unverified");
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
    missingPage: number;
    missingPlan: number;
    missingPrice: number;
    duplicate: number;
    lowConfidence: number;
    citationMismatch: number;
    /** Rows where the source_text can't prove the plan-specific value, or a
     *  pricing row whose plan_name isn't a canonical base plan. */
    planUnverified: number;
    /** Coverage rows whose limit/value isn't cited in the source_text. */
    valueUnverified: number;
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
    missingPage: 0,
    missingPlan: 0,
    missingPrice: 0,
    duplicate: 0,
    lowConfidence: 0,
    citationMismatch: 0,
    planUnverified: 0,
    valueUnverified: 0,
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
    if (reasons.includes("missing page")) flags.missingPage += 1;
    if (reasons.includes("missing plan")) flags.missingPlan += 1;
    if (reasons.includes("missing price")) flags.missingPrice += 1;
    if (reasons.includes("duplicate")) flags.duplicate += 1;
    if (reasons.includes("low confidence")) flags.lowConfidence += 1;
    if (reasons.includes("citation mismatch")) flags.citationMismatch += 1;
    // Both causes (unprovable plan, or non-plan pricing row) count once.
    if (reasons.includes("plan unverified") || reasons.includes("not a base plan"))
      flags.planUnverified += 1;
    if (reasons.includes("value unverified")) flags.valueUnverified += 1;
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
 * Injectable I/O for approveAndPublishBrochure. Defaults to the real
 * implementations; tests pass stubs to exercise the promotion-guard logic (e.g.
 * the race where bulk approval updates 0 rows) without a database.
 */
export type PublishDeps = {
  analyze: (id: string, threshold: number) => Promise<BrochureAnalysis>;
  bulkApprove: (items: BulkReviewItem[], reviewerId: string) => Promise<number>;
  countApproved: (id: string) => Promise<number>;
  promote: (id: string) => Promise<unknown>;
};

export const defaultPublishDeps: PublishDeps = {
  analyze: (id, threshold) => analyzeBrochure(id, threshold),
  bulkApprove: async (items, reviewerId) =>
    (await bulkReview(items, reviewerId, "approve", "Bulk-approved via brochure publish"))
      .updated,
  countApproved: (id) => countApprovedFacts(id),
  promote: (id) => promoteCurrentBrochure(id),
};

/**
 * Approves every AUTO-PUBLISHABLE (non-exception) pending row for a brochure and
 * promotes the brochure to current — "publish the trustworthy rows, hold the
 * exceptions". Exceptions stay pending for spot-check. Uses the pending-only
 * bulk mutation (audit-stamped) and the atomic promote RPC.
 *
 * PROMOTION SAFETY: after the bulk approval, it re-reads the brochure's APPROVED
 * fact count and only promotes when that count is > 0. This closes the race
 * where the eligible rows changed between analysis and the bulk update (so the
 * update touched 0 rows) — without this, the brochure could be promoted with
 * nothing to serve (the empty-current bug). `promoteCurrentBrochure` enforces
 * the same guard at the DB-call layer as defense in depth.
 */
export async function approveAndPublishBrochure(
  brochureId: string,
  reviewerId: string,
  brochureStatus: string,
  threshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
  confirmedSampleReview: boolean = false,
  deps: PublishDeps = defaultPublishDeps,
): Promise<ApprovePublishResult> {
  // Server-side gate — never trust a UI-only confirmation.
  if (confirmedSampleReview !== true) {
    throw new ApiError(
      400,
      "Sample review must be confirmed before publishing.",
    );
  }

  // Re-analyze server-side (never trust a client-supplied eligible set).
  const analysis = await deps.analyze(brochureId, threshold);

  // Block empty publish: nothing trustworthy to approve.
  if (analysis.eligible === 0) {
    throw new ApiError(
      409,
      "No eligible rows to publish. Review the held exceptions first.",
    );
  }

  const items: BulkReviewItem[] = [
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

  const approved = items.length > 0 ? await deps.bulkApprove(items, reviewerId) : 0;

  // Promotion guard: verify the brochure actually has approved facts now. If the
  // eligible rows changed before the bulk update (nothing approved, and none
  // were already approved), do NOT promote an empty brochure.
  const finalApproved = await deps.countApproved(brochureId);
  if (finalApproved === 0) {
    throw new ApiError(
      409,
      "Nothing was approved (the eligible rows changed before publish), so the brochure was not promoted. Re-run extraction or review the exceptions.",
    );
  }

  // Publish: promote to current when the brochure is in a promotable state.
  let published = false;
  let publishNote: string | null = null;
  if (brochureStatus === "imported" || brochureStatus === "current") {
    await deps.promote(brochureId);
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

/**
 * Validates an OPTIONAL client-supplied threshold (0..1). Returns `undefined`
 * when absent/NaN so the server-owned floor (effectiveThreshold) is the
 * baseline — the caller never sets the minimum. Throws on out-of-range. A
 * provided value can only RAISE the gate; effectiveThreshold clamps it up to the
 * floor.
 */
export function coerceThreshold(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (value < 0 || value > 1) {
    throw new ApiError(400, "confidenceThreshold must be between 0 and 1.");
  }
  return value;
}
