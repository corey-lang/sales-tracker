/**
 * Contract-backed answers for Ask Smitty — Utah MVP.
 *
 * Answers questions whose truth comes from the contract (not the brochure):
 * seller coverage, buyer coverage, new construction, service area, trip fees,
 * exclusions, and legal guardrails. Also handles two ambiguous item questions
 * (refrigerator, pool) that need specific option chips before hitting the DB.
 *
 * Source priority enforced here:
 *   seller/buyer/new-construction/service-area/trip-fee/exclusions → contract
 *   seller + add-on → contract (blocks generic add-on catalog route)
 *   pricing/plan comparison/add-on catalog → brochure (not handled here)
 */

import {
  buildCitation,
  clarifyAnswer,
  normalizeTerm,
  type AnswerOption,
  type CoverageAnswer,
  type CoverageNarrowingContext,
} from "./answer-logic";
import {
  UTAH_CONTRACT_FACTS,
  UTAH_CONTRACT_TITLE,
  UTAH_CONTRACT_SOURCE_TYPE,
  type ContractCategory,
} from "./utah-contract-facts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Word-boundary substring check (same as answer-logic, duplicated here to
 *  keep contract-answer free of private imports). */
function hasWord(haystack: string, term: string): boolean {
  const t = term.trim();
  if (t.length < 2) return false;
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${esc}(?:[^a-z0-9]|$)`).test(haystack);
}

function hasAny(haystack: string, terms: string[]): boolean {
  return terms.some((t) => (t.includes(" ") ? haystack.includes(t) : hasWord(haystack, t)));
}

// ---------------------------------------------------------------------------
// Contract-intent detection
// ---------------------------------------------------------------------------

/** Keyword sets that map unambiguously to a contract category. */
const CATEGORY_KEYWORDS: Record<ContractCategory, string[]> = {
  seller_coverage: [
    "seller coverage",
    "sellers coverage",
    "seller's coverage",
    "seller plan",
    "sellers plan",
    "listing coverage",
    "escrow coverage",
    "listing period",
    "during escrow",
    "during listing",
    "pre-existing",
    "pre existing",
  ],
  buyer_coverage: [
    "buyer coverage",
    "buyer's coverage",
    "buyers coverage",
    "buyer plan",
    "buyers plan",
    "closing date",
    "30 days after closing",
    "after closing",
  ],
  new_construction: [
    "new construction",
    "new home",
    "brand new home",
    "brand-new home",
    "new build",
    "newly built",
    "newly constructed",
    "new construction plan",
  ],
  service_area: [
    "service area",
    "normal service area",
    "counties",
    "county",
    "outside service area",
    "outside normal service area",
    "service county",
    "on-demand service",
    "on demand service",
    // "coverage area" is a natural synonym for "service area" in AE speech —
    // "outside our coverage area" means the same as "outside the service area".
    "coverage area",
    "our coverage area",
    "outside our coverage area",
  ],
  trip_fee: [
    "trip fee",
    "trip charge",
    "outside normal",
    "outside the normal",
    "outside area",
    "additional trip",
    "other county",
    "other counties",
    "$85",
    "85 dollar",
    "additional charge for",
    // Catches "outside our coverage area" so the $85 trip fee fact is bundled
    // whenever an AE asks what happens outside the service area by that name.
    "outside our coverage area",
  ],
  expedited_service: [
    "expedited service",
    "after hours",
    "after-hours",
    "weekend service",
    "holiday service",
    "non-emergency",
    "$200 service fee",
    "200 dollar",
  ],
  exclusions: [
    "exclusion",
    "exclusions",
    "contract exclusion",
    "legal interpretation",
    "contract terms",
    "what does the contract say",
    "what does contract say",
    "legally covered",
    "legally excluded",
    "contract says",
  ],
};

/** Returns the matching contract categories (may be >1 for compound questions). */
export function detectContractCategories(message: string): ContractCategory[] {
  const text = normalizeTerm(message);
  const found: ContractCategory[] = [];
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (hasAny(text, keywords)) found.push(cat as ContractCategory);
  }
  return found;
}

/** True when the message is best answered from the Utah contract. */
export function isContractQuestion(message: string): boolean {
  return detectContractCategories(message).length > 0;
}

/** True when the message asks about add-ons IN A SELLER coverage context.
 *  These must route to the contract (add-ons are excluded from seller coverage)
 *  and NEVER to the generic add-on catalog. */
export function isSellerAddonQuestion(message: string): boolean {
  const text = normalizeTerm(message);
  const hasSeller =
    text.includes("seller") || text.includes("sellers") || text.includes("listing");
  const hasAddon =
    text.includes("add-on") ||
    text.includes("addon") ||
    text.includes("add on") ||
    text.includes("add-ons") ||
    text.includes("addons") ||
    text.includes("optional coverage") ||
    text.includes("extra coverage") ||
    text.includes("optional items");
  return hasSeller && hasAddon;
}

// ---------------------------------------------------------------------------
// Contract answer builder
// ---------------------------------------------------------------------------

/** Collects all facts for the matching categories and builds a grounded answer. */
export function answerFromContract(
  message: string,
  stateCode: string,
): CoverageAnswer | null {
  if (stateCode.toUpperCase() !== "UT") return null;

  const cats = detectContractCategories(message);
  if (cats.length === 0) return null;

  const facts = UTAH_CONTRACT_FACTS.filter((f) => cats.includes(f.category));
  if (facts.length === 0) return null;

  // Exclusions / legal guardrail → needs_review
  if (cats.length === 1 && cats[0] === "exclusions") {
    const fact = facts[0];
    const citation = buildCitation(
      UTAH_CONTRACT_TITLE,
      null,
      fact.pages,
    );
    return {
      kind: "grounded",
      text: fact.text,
      citations: [citation],
      confidence: "needs_review",
      sourceType: UTAH_CONTRACT_SOURCE_TYPE,
    };
  }

  // Gather all unique pages across the matched facts.
  const allPages = [...new Set(facts.flatMap((f) => f.pages))].sort(
    (a, b) => a - b,
  );
  const citation = buildCitation(UTAH_CONTRACT_TITLE, null, allPages);

  // Concatenate the fact texts into a grounded answer.
  const body = facts.map((f) => f.text).join(" ");
  return {
    kind: "grounded",
    text: body,
    citations: [citation],
    confidence: "high",
    sourceType: UTAH_CONTRACT_SOURCE_TYPE,
  };
}

/** Specific answer for seller + add-on questions (contract-backed, high confidence). */
export function answerSellerAddon(): CoverageAnswer {
  const facts = UTAH_CONTRACT_FACTS.filter(
    (f) => f.category === "seller_coverage",
  );
  const addonFact = facts.find((f) => f.id === "ut-seller-6")!;
  const aggFact = facts.find((f) => f.id === "ut-seller-5")!;
  const preFact = facts.find((f) => f.id === "ut-seller-4")!;

  const text = [
    addonFact?.text ??
      "Optional Coverage Items (add-ons) are not covered during Seller's Coverage term.",
    aggFact?.text ?? "Seller's Coverage is limited to $2,000 aggregate.",
    preFact?.text ?? "Pre-existing conditions are not covered on Seller's Coverage Plans.",
  ].join(" ");

  const allPages = [...new Set(facts.flatMap((f) => f.pages))].sort(
    (a, b) => a - b,
  );
  const citation = buildCitation(UTAH_CONTRACT_TITLE, null, allPages);
  return {
    kind: "grounded",
    text,
    citations: [citation],
    confidence: "high",
    sourceType: UTAH_CONTRACT_SOURCE_TYPE,
  };
}

// ---------------------------------------------------------------------------
// Ambiguity clarification — item-level pre-clarification
// ---------------------------------------------------------------------------

/** Terms that signal "refrigerator" without specifying which type. */
const FRIDGE_AMBIGUOUS_TERMS = ["fridge", "refrigerator", "refrig"];

/** Specific fridge vocabulary chips. Values must match the DB's canonical names. */
const FRIDGE_OPTIONS: AnswerOption[] = [
  { label: "Kitchen Refrigerator", value: "Kitchen Refrigerator" },
  { label: "Additional Kitchen Refrigerator", value: "Additional Kitchen Refrigerator" },
  { label: "Additional Refrigerator / Freezer", value: "Additional Refrigerator / Freezer" },
];

/** Already-specific fridge terms that don't need clarification. */
const FRIDGE_SPECIFIC_TERMS = [
  "kitchen refrigerator",
  "additional kitchen",
  "additional refrigerator",
  "additional fridge",
];

/** Terms that signal "pool" without specifying which option. */
const POOL_AMBIGUOUS_TERMS = ["pool", "spa", "swimming pool"];

/** Specific pool vocabulary chips. Values must match the DB's canonical names. */
const POOL_OPTIONS: AnswerOption[] = [
  {
    label: "Built-in Pool/Spa (Standard Timer)",
    value: "Built-in Pool/Spa Equipment with Standard Timer",
  },
  {
    label: "Built-in Pool/Spa (Automation Controller)",
    value: "Built-in Pool/Spa Equipment with Automation Controller",
  },
  { label: "Additional Pool Pump", value: "Additional Pool Pump" },
  {
    label: "Weekly Pool + Total Pool Warranty",
    value: "Weekly Pool Maintenance + Total Pool Warranty",
  },
];

/** Already-specific pool terms that don't need clarification. */
const POOL_SPECIFIC_TERMS = [
  "built-in pool",
  "built in pool",
  "pool pump",
  "weekly pool",
  "standard timer",
  "automation controller",
];

/** Generic "which plan?" options — used when a coverage question names an item
 *  but no plan is specified. */
export const PLAN_OPTIONS: AnswerOption[] = [
  { label: "Essential", value: "Essential" },
  { label: "Elevated", value: "Elevated" },
  { label: "Totally Elevated", value: "Totally Elevated" },
  { label: "Epic", value: "Epic" },
];

/**
 * Returns a clarification answer when the message mentions an ambiguous item
 * that needs a more specific selection before a DB lookup can succeed.
 *
 * Only fires when:
 *   - No coverageItem is already in the narrowing context (so we don't re-ask).
 *   - The message is a fresh coverage question, not a guided-flow chip echo.
 */
export function checkAmbiguity(
  message: string,
  hasItemContext: boolean,
): CoverageAnswer | null {
  if (hasItemContext) return null;

  const text = normalizeTerm(message);

  // Refrigerator
  const hasFridgeTerm = FRIDGE_AMBIGUOUS_TERMS.some((t) => hasWord(text, t));
  if (hasFridgeTerm) {
    const alreadySpecific = FRIDGE_SPECIFIC_TERMS.some((t) =>
      text.includes(t),
    );
    if (!alreadySpecific) {
      const ctx: CoverageNarrowingContext = { intent: "coverage" };
      return clarifyAnswer(
        "coverage:item",
        "Which refrigerator are you asking about?",
        FRIDGE_OPTIONS,
        ctx,
      );
    }
  }

  // Pool / spa
  const hasPoolTerm = POOL_AMBIGUOUS_TERMS.some((t) => hasWord(text, t));
  if (hasPoolTerm) {
    const alreadySpecific = POOL_SPECIFIC_TERMS.some((t) => text.includes(t));
    if (!alreadySpecific) {
      const ctx: CoverageNarrowingContext = { intent: "coverage" };
      return clarifyAnswer(
        "coverage:item",
        "Which pool option are you asking about?",
        POOL_OPTIONS,
        ctx,
      );
    }
  }

  return null;
}
