/**
 * Ask Smitty — pure answer logic for Coverage Intelligence (no I/O).
 *
 * Everything here is deterministic and dependency-free (imports only the pure
 * type contracts from ./types). It holds the parts of grounded answering that
 * must be trustworthy and therefore unit-tested WITHOUT a database:
 *   - state code → display label ("UT" → "Utah"),
 *   - brochure citation formatting,
 *   - term normalization + synonym/vocabulary matching (what the AE typed →
 *     the brochure's canonical plan/item/add-on name),
 *   - coarse intent classification,
 *   - the included(true/false/null) → answer-kind decision,
 *   - the plain-English answer + refusal templates.
 *
 * The I/O (querying the authoritative_* views) lives in ./service.ts, which
 * calls into these functions. Keeping them separate means the answer behavior
 * is covered by fast pure tests and the service stays a thin data layer.
 *
 * RULES BAKED IN HERE (mirror the Phase 1 spec):
 *   - Never invent coverage/pricing. Templates only render values they're given.
 *   - A NULL `included` is "not specified", never "yes" or "no".
 *   - Every grounded answer carries at least one citation; a refusal carries
 *     none and names the state so it's obvious which brochure was searched.
 */

import type {
  CoverageItem,
  PlanAddon,
  PlanComparisonRow,
  PlanPricing,
} from "./types";

// ---------------------------------------------------------------------------
// State labels
// ---------------------------------------------------------------------------

/** USPS code → human state name, for the "Answering using <State> plan
 *  documents" banner and citation/refusal copy. Unknown codes echo back. */
const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina",
  ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};

/** "UT" → "Utah". Unknown/empty codes echo back uppercased so copy still reads. */
export function stateLabel(code: string): string {
  const c = (code ?? "").trim().toUpperCase();
  return STATE_NAMES[c] ?? c;
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

/** A source reference attached to a grounded answer. One per brochure, carrying
 *  every page that backed the answer (multi-fact answers span several pages). */
export type Citation = {
  /** Brochure title verbatim, e.g. "Utah Homeowner Brochure". */
  brochure: string;
  /** Version label as the brochure presents it, e.g. "2025.7"; null if none. */
  version: string | null;
  /** 1-based source pages the answer's facts came from — unique + sorted.
   *  Empty only when NONE of the source rows recorded a page. */
  pages: number[];
  /** Rendered one-line label, e.g. "Utah Homeowner Brochure 2025.7, pp. 3, 5". */
  label: string;
};

/** "<title> <version>" (version omitted when absent). The BrochureRef.citation
 *  form, without page. */
export function formatBrochureCitation(
  title: string,
  version: string | null,
): string {
  const v = version?.trim();
  return v ? `${title} ${v}` : title;
}

/** Unique, sorted, positive page numbers from a (possibly messy) input list. */
export function uniquePages(pages: Array<number | null | undefined>): number[] {
  return [
    ...new Set(
      pages.filter(
        (p): p is number => typeof p === "number" && Number.isFinite(p) && p > 0,
      ),
    ),
  ].sort((a, b) => a - b);
}

/** ", p. 4" for one page, ", pp. 3, 5" for several, "" for none. */
export function pageSuffix(pages: number[]): string {
  if (pages.length === 0) return "";
  if (pages.length === 1) return `, p. ${pages[0]}`;
  return `, pp. ${pages.join(", ")}`;
}

/** Builds a Citation with a rendered label. Accepts one page, several, or none;
 *  pages are de-duped + sorted and rendered as p./pp. Page numbers are never
 *  dropped when source rows carry them. */
export function buildCitation(
  title: string,
  version: string | null,
  pages: Array<number | null | undefined> | number | null | undefined,
): Citation {
  const list = Array.isArray(pages) ? pages : [pages];
  const cleaned = uniquePages(list);
  const base = formatBrochureCitation(title, version);
  return {
    brochure: title,
    version: version ?? null,
    pages: cleaned,
    label: `${base}${pageSuffix(cleaned)}`,
  };
}

// ---------------------------------------------------------------------------
// Term normalization + matching
// ---------------------------------------------------------------------------

/** Lowercase, trim, collapse internal whitespace. Used for both the typed
 *  message and the brochure vocabulary so matches are casing/spacing-stable. */
export function normalizeTerm(value: string): string {
  return value.toLowerCase().trim().replace(/\s+/g, " ");
}

/** A curated synonym row (subset of coverage_synonyms) the matcher can apply. */
export type SynonymEntry = {
  canonicalType: "coverage_item" | "plan" | "addon";
  synonym: string; // already normalized (lower+trim) per the DB CHECK
  canonicalValue: string;
};

/**
 * True when `term` appears in `haystack` on WORD BOUNDARIES (not as a stray
 * substring). Both are expected normalized (lowercase). Boundaries are
 * start/end or any non-alphanumeric char, so "te" matches the standalone token
 * "te" but NOT the "te" inside "water" — critical so a short plan abbreviation
 * can't spuriously match and ground the answer in the wrong plan.
 */
function containsTerm(haystack: string, term: string): boolean {
  const t = term.trim();
  if (t.length < 2) return false; // 1-char terms are too ambiguous to match on
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`).test(haystack);
}

/**
 * Finds which canonical vocabulary terms the message references.
 *
 * Two passes, both deterministic:
 *   1. Curated synonyms — if the normalized message contains a synonym phrase,
 *      its canonicalValue is included (this is how "sprinklers" → "Sprinkler
 *      System & Timers" and "TE" → "Totally Elevated").
 *   2. Direct vocabulary — any known canonical term whose normalized form
 *      appears as a substring of the message.
 *
 * Returns the canonical terms (de-duped, original casing from `vocabulary`).
 * Never guesses beyond the provided vocabulary/synonyms.
 */
export function detectMentions(
  message: string,
  vocabulary: string[],
  synonyms: SynonymEntry[],
  type: SynonymEntry["canonicalType"],
): string[] {
  const haystack = normalizeTerm(message);
  const canonicalByNorm = new Map<string, string>();
  for (const term of vocabulary) {
    canonicalByNorm.set(normalizeTerm(term), term);
  }

  const out = new Set<string>();

  for (const syn of synonyms) {
    if (syn.canonicalType !== type) continue;
    if (syn.synonym && containsTerm(haystack, syn.synonym)) {
      // Prefer the real vocabulary casing when we have it.
      const norm = normalizeTerm(syn.canonicalValue);
      out.add(canonicalByNorm.get(norm) ?? syn.canonicalValue);
    }
  }

  for (const [norm, original] of canonicalByNorm) {
    if (containsTerm(haystack, norm)) out.add(original);
  }

  return [...out];
}

// ---------------------------------------------------------------------------
// Intent classification (coarse)
// ---------------------------------------------------------------------------

export type CoverageIntent =
  | "list_plans"
  | "compare"
  | "pricing"
  | "addons"
  | "coverage";

const COMPARE_KEYWORDS = ["compare", " vs ", " vs.", "versus", "difference between"];
const LIST_PLANS_KEYWORDS = [
  "what plans",
  "which plans do we",
  "plans do we offer",
  "plans do we have",
  "list plans",
  "list the plans",
  "what do we offer",
  "what do we sell",
  "plan options",
  "what coverage do we offer",
  "tell me about coverage",
];
const ADDON_KEYWORDS = [
  "add-on",
  "add on",
  "addon",
  "add-ons",
  "add ons",
  "addons",
  "optional coverage",
  "extra coverage",
];
const PRICING_KEYWORDS = [
  "price",
  "pricing",
  "cost",
  "costs",
  "how much",
  "rate",
  "premium",
  "fee",
  "quote",
];

/**
 * Coarse intent for a coverage/pricing message. Order encodes precedence:
 * compare → list-plans → add-ons → pricing → coverage (the catch-all for any
 * other on-topic question). The caller decides on-topic-ness separately; this
 * only sub-classifies a question already known to be coverage/pricing.
 */
export function classifyCoverageIntent(message: string): CoverageIntent {
  const text = normalizeTerm(message);
  if (COMPARE_KEYWORDS.some((k) => text.includes(k.trim()))) return "compare";
  if (LIST_PLANS_KEYWORDS.some((k) => text.includes(k))) return "list_plans";
  if (ADDON_KEYWORDS.some((k) => text.includes(k))) return "addons";
  if (PRICING_KEYWORDS.some((k) => text.includes(k))) return "pricing";
  return "coverage";
}

// ---------------------------------------------------------------------------
// Coverage-question GATE — decides whether a message should be answered from
// the brochure at all. This is the dedicated detector the chat route uses; it
// does NOT rely on the static sales-knowledge matcher. Word-boundary matched so
// "discover" doesn't trip "cover" and "plan my week" doesn't trip "plan".
// ---------------------------------------------------------------------------

/** Any of these means the message is unambiguously a coverage/pricing/plan
 *  question (covered/cover, brochure, price, service fee, limit, add-on, …). */
const STRONG_COVERAGE_TERMS = [
  "cover",
  "covers",
  "covered",
  "coverage",
  "brochure",
  "add-on",
  "add on",
  "addon",
  "add-ons",
  "add ons",
  "addons",
  "price",
  "pricing",
  "cost",
  "costs",
  "service fee",
  "service fees",
  "service-fee",
  "service-fees",
  "service call fee",
  "trade call fee",
  "deductible",
  "limit",
  "limits",
  "benefit maximum",
  "include",
  "includes",
  "included",
  "premium",
  "warranty",
  "home warranty",
  "homescription",
  "whats covered",
];

/** Naming a plan is itself a coverage signal. */
const PLAN_NAME_TERMS = ["epic", "essential", "elevated", "totally elevated"];

/** "plan(s)"/"tier"/"option" are too generic to gate on alone ("plan my week").
 *  They only count when paired with a buying/offering/audience qualifier below
 *  — so "the seller plan", "our buyer plans", "what plans do we offer" route in,
 *  while "plan my week" / "plan visits" do not. */
const WEAK_PLAN_WORDS = ["plan", "plans", "tier", "tiers", "option", "options"];
const PLAN_CONTEXT_QUALIFIERS = [
  "offer",
  "sell",
  "recommend",
  "compare",
  "difference",
  "what plan",
  "what plans",
  "which plan",
  "which plans",
  "do we have",
  "do we offer",
  // Audience/possessive qualifiers — "seller plan", "buyer plans", "our plans".
  "seller",
  "buyer",
  "our",
];

/**
 * The chat route's gate: is this message a coverage/pricing/plan/brochure
 * question that must be answered from the authoritative brochure (or refused
 * from it)? Catches normal phrasings — "Does Epic cover HVAC?", "Is
 * refrigerator covered?", "What does Totally Elevated cover?", "Does the
 * brochure mention sprinklers?" — while leaving generic "plan" usage
 * ("help me plan my week") alone.
 */
export function isCoverageQuestion(message: string): boolean {
  const text = normalizeTerm(message);
  if (STRONG_COVERAGE_TERMS.some((t) => containsTerm(text, t))) return true;
  if (PLAN_NAME_TERMS.some((t) => containsTerm(text, t))) return true;
  const hasWeakPlanWord = WEAK_PLAN_WORDS.some((t) => containsTerm(text, t));
  if (
    hasWeakPlanWord &&
    PLAN_CONTEXT_QUALIFIERS.some((q) => containsTerm(text, q))
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// included(true/false/null) → answer kind
// ---------------------------------------------------------------------------

export type CoverageKind = "answer" | "not_covered" | "unspecified";

/** TRUE → "answer" (included), FALSE → "not_covered", NULL → "unspecified"
 *  (brochure doesn't say — never guess). */
export function includedToKind(included: boolean | null): CoverageKind {
  if (included === true) return "answer";
  if (included === false) return "not_covered";
  return "unspecified";
}

// ---------------------------------------------------------------------------
// Answer + refusal templates
// ---------------------------------------------------------------------------

/** The outcome the service hands back to the chat route. A grounded answer
 *  always has ≥1 citation; a refusal has none. */
export type CoverageAnswer = {
  kind: "grounded" | "refusal";
  text: string;
  citations: Citation[];
};

/** Standard "couldn't find it" refusal — names the state so it's obvious which
 *  brochure was searched. No citations (nothing was found). */
export function refusal(stateCode: string, detail?: string): CoverageAnswer {
  const label = stateLabel(stateCode);
  const lead = `I couldn't find that in the current ${label} brochure.`;
  return {
    kind: "refusal",
    text: detail ? `${lead} ${detail}` : lead,
    citations: [],
  };
}

/** Refusal used when the AE has no assigned state — we never guess one. */
export function noStateRefusal(): CoverageAnswer {
  return {
    kind: "refusal",
    text:
      "I don't have a state assigned to your account yet, so I can't look up plan documents. Ask an admin to set your state, then try again.",
    citations: [],
  };
}

/** Renders a coverage-item lookup ("does <plan> cover <item>?") for the three
 *  authoritative outcomes. `unspecified` is a found-but-silent brochure, which
 *  we state plainly rather than guessing. */
export function renderCoverageItem(
  item: Pick<CoverageItem, "planName" | "coverageItem" | "included" | "coverageLimitText">,
  citation: Citation,
): CoverageAnswer {
  const kind = includedToKind(item.included);
  let text: string;
  if (kind === "answer") {
    const limit = item.coverageLimitText
      ? ` Limit: ${item.coverageLimitText}.`
      : "";
    text = `Yes — the ${item.planName} plan covers ${item.coverageItem}.${limit}`;
  } else if (kind === "not_covered") {
    text = `No — the ${item.planName} plan does not cover ${item.coverageItem}.`;
  } else {
    text = `The ${item.planName} plan is in the current brochure, but it doesn't specify ${item.coverageItem} either way, so I can't confirm it.`;
  }
  return { kind: "grounded", text, citations: [citation] };
}

/** Renders "which plans include <item>?" from the list of plan names found. */
export function renderPlansIncluding(
  coverageItem: string,
  planNames: string[],
  citation: Citation,
): CoverageAnswer {
  const list = planNames.map((p) => `• ${p}`).join("\n");
  return {
    kind: "grounded",
    text: `These plans include ${coverageItem}:\n${list}`,
    citations: [citation],
  };
}

/** Renders the plan list ("what plans do we offer?"). */
export function renderPlanList(
  planNames: string[],
  citation: Citation,
): CoverageAnswer {
  const list = planNames.map((p) => `• ${p}`).join("\n");
  return {
    kind: "grounded",
    text: `Here are the plans in the current brochure:\n${list}`,
    citations: [citation],
  };
}

/** Renders a single plan's brochure-stated price. Only the brochure's own
 *  wording (`priceText`) is shown — never a derived figure. */
export function renderPlanPricing(
  pricing: Pick<PlanPricing, "planName" | "priceText">,
  citation: Citation,
): CoverageAnswer {
  return {
    kind: "grounded",
    text: pricing.priceText
      ? `${pricing.planName}: ${pricing.priceText}.`
      : `The current brochure lists the ${pricing.planName} plan but doesn't state a price for it.`,
    citations: [citation],
  };
}

/** Renders the add-on catalog. Shows each add-on's name and, when the brochure
 *  stated it, its price text — nothing inferred. */
export function renderAddons(
  addons: Pick<PlanAddon, "addonName" | "addonPriceText">[],
  citation: Citation,
): CoverageAnswer {
  const lines = addons.map((a) =>
    a.addonPriceText ? `• ${a.addonName} — ${a.addonPriceText}` : `• ${a.addonName}`,
  );
  return {
    kind: "grounded",
    text: `Optional add-ons in the current brochure:\n${lines.join("\n")}`,
    citations: [citation],
  };
}

/** Renders a two-plan comparison aligned by coverage item. */
export function renderComparison(
  planA: string,
  planB: string,
  rows: PlanComparisonRow[],
  citation: Citation,
): CoverageAnswer {
  const cell = (
    side: { included: boolean | null; limitText: string | null } | null,
  ): string => {
    if (!side) return "—";
    if (side.included === true) return side.limitText ? `Yes (${side.limitText})` : "Yes";
    if (side.included === false) return "No";
    return "Not specified";
  };
  const lines = rows.map(
    (r) => `• ${r.coverageItem}: ${planA} — ${cell(r.a)}; ${planB} — ${cell(r.b)}`,
  );
  return {
    kind: "grounded",
    text: `${planA} vs ${planB}:\n${lines.join("\n")}`,
    citations: [citation],
  };
}
