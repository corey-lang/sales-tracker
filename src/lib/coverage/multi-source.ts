/**
 * Multi-source answer merge for Ask Smitty — Utah MVP.
 *
 * Every Utah coverage question searches ALL approved sources and merges relevant
 * matches into a single grounded answer. Previously the route picked one source
 * lane early; this layer always searches both and ranks by intent.
 *
 * Search order:
 *   1. Contract facts   — seller/buyer/new-construction/service-area/trip-fee/exclusions
 *   2. Workbook/brochure — pricing, plan comparison, add-ons, coverage item limits
 *
 * Source priority (contract beats brochure for legal/rule questions):
 *   CONTRACT_ONLY categories → contract is the sole authoritative source.
 *   Combined categories (new_construction) → both sources contribute:
 *     - pricing intent → workbook/brochure leads, contract appends
 *     - rules intent   → contract leads, workbook/brochure appends
 *   Workbook-only topics (pool, sprinklers, plan pricing) → workbook/brochure wins.
 *
 * Pure: no I/O, no DB access, no API calls. All merge decisions are deterministic
 * from the message text and the two pre-fetched answers.
 */

import { type CoverageAnswer } from "./answer-logic";
import { detectContractCategories } from "./contract-answer";

// ---------------------------------------------------------------------------
// Category sets
// ---------------------------------------------------------------------------

/**
 * Contract categories that are the sole authoritative source. When a question
 * matches ONLY these categories the brochure/workbook answer is discarded even
 * if it returned a grounded result — the contract is the only truth here.
 */
const CONTRACT_ONLY_CATEGORIES = new Set([
  "seller_coverage",
  "buyer_coverage",
  "service_area",
  "trip_fee",
  "expedited_service",
  "exclusions",
]);

/**
 * Contract categories where both contract AND brochure/workbook contribute.
 * Contract provides the legal rules; brochure provides pricing/plan data.
 * (new_construction: contract says "buyer only, 1-3 yr"; brochure has the price.)
 */
const CONTRACT_COMBINED_CATEGORIES = new Set(["new_construction"]);

// ---------------------------------------------------------------------------
// Intent detection
// ---------------------------------------------------------------------------

/**
 * True when the message is primarily asking for a price or cost.
 * Used to decide whether brochure (pricing) or contract (rules) leads in
 * a combined-category merge.
 */
function hasPricingIntent(message: string): boolean {
  const t = message.toLowerCase();
  return (
    t.includes("how much") ||
    t.includes("price") ||
    t.includes("pricing") ||
    t.includes("cost") ||
    t.includes("costs") ||
    t.includes("rate")
  );
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Merges a contract answer and a brochure/workbook answer into the single best
 * response for the AE. Returns null only when BOTH inputs are null.
 *
 * Merge rules (in order):
 *   1. Either null → return the non-null side immediately.
 *   2. Clarify turn from either side → takes full precedence (never interleave
 *      clarification with grounded facts).
 *   3. needs_review (exclusions guardrail) → contract always wins.
 *   4. CONTRACT_ONLY categories → contract wins, brochure/workbook discarded.
 *   5. Both grounded + combined/workbook topic → merge texts with priority order:
 *        - pricing intent → brochure/workbook leads (price first), contract appends
 *        - rules intent   → contract leads, brochure/workbook appends
 *   6. One grounded, one refusal → prefer the grounded answer.
 *   7. Both refusals → return contract's refusal (has more specific messaging).
 */
export function mergeUtahSources(
  message: string,
  contractAnswer: CoverageAnswer | null,
  workbookAnswer: CoverageAnswer | null,
): CoverageAnswer | null {
  // Short-circuit when one side has nothing.
  if (!contractAnswer && !workbookAnswer) return null;
  if (!contractAnswer) return workbookAnswer;
  if (!workbookAnswer) return contractAnswer;

  // Exclusions / legal guardrail always wins.
  if (
    contractAnswer.kind === "grounded" &&
    contractAnswer.confidence === "needs_review"
  ) {
    return contractAnswer;
  }

  // Category priority check — must run BEFORE clarify so that a workbook
  // "which plan?" clarification cannot override a grounded contract answer on a
  // contract-only topic (e.g. "What is the trip fee?" → trip_fee category →
  // contract wins; workbook's pricing clarify is discarded).
  const cats = detectContractCategories(message);
  const onlyContractCats =
    cats.length > 0 && cats.every((c) => CONTRACT_ONLY_CATEGORIES.has(c));
  const hasCombinedCat = cats.some((c) => CONTRACT_COMBINED_CATEGORIES.has(c));

  // Contract-only categories: brochure/workbook answer discarded.
  if (onlyContractCats && !hasCombinedCat) {
    return contractAnswer.kind === "grounded" ? contractAnswer : workbookAnswer;
  }

  // Clarification turns.
  // Contract clarifications are returned directly (safety net — item pre-clarifications
  // from checkAmbiguity already run before mergeUtahSources, so this rarely fires).
  if (contractAnswer.kind === "clarify") return contractAnswer;
  // Workbook clarifications are only returned when the contract has NO grounded
  // answer. If the contract already answered (e.g. new construction rules), the
  // workbook's "which plan?" prompt is misleading and should be discarded.
  if (workbookAnswer.kind === "clarify") {
    if (contractAnswer.kind === "grounded") return contractAnswer;
    return workbookAnswer;
  }

  // Both grounded → merge texts + citations, ranked by intent.
  if (contractAnswer.kind === "grounded" && workbookAnswer.kind === "grounded") {
    const pricingFirst = hasPricingIntent(message);
    const primary = pricingFirst ? workbookAnswer : contractAnswer;
    const secondary = pricingFirst ? contractAnswer : workbookAnswer;
    return {
      kind: "grounded",
      text: `${primary.text}\n\n${secondary.text}`,
      citations: [...primary.citations, ...secondary.citations],
      confidence: "high",
      sourceType: primary.sourceType,
    };
  }

  // One grounded, one refusal → prefer grounded.
  if (contractAnswer.kind === "grounded") return contractAnswer;
  if (workbookAnswer.kind === "grounded") return workbookAnswer;

  // Both refusals.
  return contractAnswer;
}
