/**
 * Approved, server-side Elevate knowledge for the AI Assistant.
 *
 * This is the ONLY source of plan/coverage talking points the assistant is
 * allowed to lean on. It is deliberately PLACEHOLDER-SAFE: where exact pricing
 * or coverage specifics aren't wired in yet, the content states what IS and
 * ISN'T available and what to clarify — it does not invent numbers or
 * guarantees. The coverage/pricing sections are written as factual coverage &
 * pricing expertise (NOT sales coaching). Two sections (Objection Handling,
 * What to Recommend) remain coaching-oriented and only surface when the user
 * explicitly asks for that help. Nothing here is customer/contact data.
 *
 * When the real plan/pricing table is connected, replace the PLACEHOLDER lines
 * in the relevant section bodies with the confirmed specifics; the matching and
 * assembly logic below does not need to change.
 *
 * Used by /api/ai/chat (server-only path). Importing it elsewhere is harmless —
 * it holds no secrets — but it exists to feed the proxy's buildAgentMessage().
 */

/** Reused stem for "the exact data isn't connected" — expert framing, not
 *  coaching. Followed by what the assistant CAN still help with. */
const PLACEHOLDER =
  "I don't currently have access to the live pricing/coverage table, so I can't confirm exact figures or guarantee specifics. Here's what I can still help with:";

export type KnowledgeSection = {
  /** Stable id used by the broad-topic bundle and topic classification. */
  id: string;
  /** Human title, rendered as the section heading in the assembled context. */
  title: string;
  /** Specific phrases that pull in THIS section. Generic words like "plan" /
   *  "coverage" are handled separately by BROAD_TRIGGERS so a precise question
   *  ("buyer coverage") stays focused instead of dragging in every section. */
  keywords: string[];
  /** Placeholder-safe body. Coverage/pricing sections are factual/expert; the
   *  two coaching sections are clearly coaching and only trigger on request. */
  body: string;
};

/** Section ids that are coverage/pricing expertise (vs. the coaching sections
 *  objection-handling / what-to-recommend). Drives `isCoveragePricingQuestion`. */
export const COVERAGE_PRICING_SECTION_IDS = [
  "seller-coverage",
  "buyer-coverage",
  "new-construction",
  "optional-add-ons",
  "pricing-upgrades",
  "common-coverage-questions",
];

export const KNOWLEDGE_SECTIONS: KnowledgeSection[] = [
  {
    id: "seller-coverage",
    title: "Seller Coverage",
    keywords: ["seller coverage", "seller's coverage", "listing coverage", "seller plan", "seller warranty"],
    body: [
      "Seller coverage protects covered systems and appliances on a home while it's listed and through the sale.",
      PLACEHOLDER,
      "- I can explain what typically falls under seller coverage vs. what's excluded, and which plans include it.",
      "- Name the specific system or appliance and I'll say whether it's generally included, an add-on, or not covered.",
    ].join("\n"),
  },
  {
    id: "buyer-coverage",
    title: "Buyer Coverage",
    keywords: ["buyer coverage", "buyer's coverage", "buyer plan"],
    body: [
      "Buyer coverage protects covered systems and appliances for a homeowner after closing.",
      PLACEHOLDER,
      "- I can outline what's typically included vs. optional, and which plans carry it.",
      "- Name the item or plan you're checking and I'll give a direct included / add-on / not-covered answer where I can.",
    ].join("\n"),
  },
  {
    id: "new-construction",
    title: "New Construction",
    keywords: ["new construction", "new build", "newly built", "new home", "builder warranty"],
    body: [
      "New-construction coverage addresses everyday systems and appliances beyond the builder's initial warranty, and continues after that first-year warranty lapses.",
      PLACEHOLDER,
      "- I can clarify what the builder warranty typically covers vs. what our plans add.",
      "- Ask about a specific system and I'll say where it falls (included, add-on, or not covered).",
    ].join("\n"),
  },
  {
    id: "optional-add-ons",
    title: "Optional Add-ons",
    keywords: ["add-on", "add on", "addon", "add-ons", "add ons", "optional coverage", "extra coverage"],
    body: [
      "Add-ons extend a base plan to specific items — common categories include extra systems, specialty appliances, and exterior/structural items (e.g. pool/spa, well, septic, additional units).",
      PLACEHOLDER,
      "- I can tell you which add-ons exist and, for a given item, whether a plan includes it or it requires an add-on.",
      "- Name the item (e.g. pool, sprinkler) and I'll tell you included vs. add-on vs. not covered.",
    ].join("\n"),
  },
  {
    id: "pricing-upgrades",
    title: "Pricing / Upgrades",
    keywords: ["pricing", "price", "cost", "how much", "upgrade", "upgrades", "tier", "tiers"],
    body: [
      "Pricing scales with the plan tier plus any add-ons; an upgrade moves to broader coverage.",
      PLACEHOLDER,
      "- I will NOT quote dollar figures while pricing isn't connected. If you need an exact price, I'll say it isn't connected yet and, where applicable, ask for the quote details needed.",
      "- I CAN tell you which plans and add-ons exist, what each includes, included vs. add-on for a given item, and how the plans compare.",
    ].join("\n"),
  },
  {
    id: "common-coverage-questions",
    title: "Common Coverage Questions",
    keywords: [
      "coverage question",
      "coverage questions",
      "common question",
      "common questions",
      "what's covered",
      "whats covered",
      "what is covered",
      "is it covered",
      "does it cover",
      "covered",
      "exclusion",
      "exclusions",
      "waiting period",
      "claim",
      "service call",
    ],
    body: [
      "Typical questions: what's covered vs. excluded, included vs. add-on, which plan carries an item, how service calls work, and whether there's a waiting period.",
      PLACEHOLDER,
      "- Ask about a specific item or plan and I'll give a direct covered / not-covered / add-on answer where I can.",
      "- I'll clearly separate what I can confirm from what isn't connected yet, and never imply something is covered if it isn't in this approved knowledge.",
    ].join("\n"),
  },
  {
    id: "objection-handling",
    title: "Objection Handling",
    keywords: [
      "objection",
      "too expensive",
      "pushback",
      "not interested",
      "why so expensive",
      "don't need",
      "dont need",
      "already maintains",
    ],
    body: [
      "(Sales coaching — only because the user explicitly asked for objection help.)",
      "Common objections: \"it's too expensive,\" \"the seller already maintains everything,\" and \"the buyer can just self-insure.\"",
      "- Acknowledge the concern, reframe price as risk transfer and deal protection, share one brief value point, then ask a question that moves the conversation forward.",
      "- Keep it consultative — you're coaching the agent, not arguing with them.",
    ].join("\n"),
  },
  {
    id: "what-to-recommend",
    title: "What to Recommend to an Agent",
    keywords: [
      "what should i recommend",
      "what do you recommend",
      "recommend",
      "which plan should",
      "best plan for",
      "what to recommend",
    ],
    body: [
      "(Sales coaching — only because the user explicitly asked for a recommendation.)",
      "The right recommendation depends on the home and the deal.",
      "- Start by asking: home age, standout features (pool/spa, well, septic), who's paying (seller vs. buyer), and the agent's goal.",
      "- Then suggest a base plan plus the one or two add-ons that cover the biggest risks, and offer to confirm exact coverage and pricing.",
    ].join("\n"),
  },
];

/** Generic phrases that signal a broad "what do we offer?" question. When no
 *  specific section matches, these pull in the plan/coverage overview bundle so
 *  the assistant can present an option menu. */
const BROAD_TRIGGERS = [
  "plan",
  "plans",
  "coverage",
  "what do we offer",
  "what do we sell",
  "what plans",
  "tell me about coverage",
  "plan options",
];

/** Sections shown for a broad question — the plan/coverage "menu" areas. */
const BROAD_BUNDLE_IDS = [
  "seller-coverage",
  "buyer-coverage",
  "new-construction",
  "optional-add-ons",
  "pricing-upgrades",
];

/**
 * Selects the knowledge sections relevant to `userMessage`. Two-tier: a
 * specific section keyword wins and keeps the answer focused; only when no
 * specific section matches do the broad "plan"/"coverage" triggers pull in the
 * overview bundle. Returns [] when nothing matches.
 */
function selectSections(userMessage: string): KnowledgeSection[] {
  const text = userMessage.toLowerCase();

  const specific = KNOWLEDGE_SECTIONS.filter((section) =>
    section.keywords.some((keyword) => text.includes(keyword)),
  );
  if (specific.length > 0) return specific;

  if (BROAD_TRIGGERS.some((t) => text.includes(t))) {
    return KNOWLEDGE_SECTIONS.filter((s) => BROAD_BUNDLE_IDS.includes(s.id));
  }
  return [];
}

/**
 * Returns the approved knowledge text relevant to `userMessage`, or null when
 * nothing matches (so unrelated questions don't get a wall of product context).
 */
export function getRelevantKnowledge(userMessage: string): string | null {
  const chosen = selectSections(userMessage);
  if (chosen.length === 0) return null;

  const header =
    "Approved Elevate knowledge for this answer. Use ONLY what's here for plan/coverage specifics; do not invent details beyond it. When exact pricing or coverage isn't stated, say so plainly and offer the alternatives listed, rather than guessing.";

  return [
    header,
    ...chosen.map((section) => `## ${section.title}\n${section.body}`),
  ].join("\n\n");
}

/**
 * True when the message is a COVERAGE/PRICING question (vs. an explicit request
 * for objection-handling or recommendation coaching). Used by the proxy to
 * apply coverage/pricing-expert answer behavior. Objection/recommend questions
 * return false so requested coaching is left alone.
 */
export function isCoveragePricingQuestion(userMessage: string): boolean {
  return selectSections(userMessage).some((s) =>
    COVERAGE_PRICING_SECTION_IDS.includes(s.id),
  );
}
