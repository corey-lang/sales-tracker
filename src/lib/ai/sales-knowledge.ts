/**
 * Approved, server-side Elevate sales knowledge for the AI Assistant.
 *
 * This is the ONLY source of plan/coverage talking points the assistant is
 * allowed to lean on. It is deliberately PLACEHOLDER-SAFE: where exact pricing
 * or coverage specifics aren't wired in yet, the content coaches the AE on how
 * to *frame* the conversation rather than stating numbers or guarantees we
 * can't back. Nothing here is customer/contact data — it is generic product
 * coaching, safe to send upstream.
 *
 * When the real plan/pricing table is connected, replace the PLACEHOLDER lines
 * in the relevant section bodies with the confirmed specifics; the matching and
 * assembly logic below does not need to change.
 *
 * Used by /api/ai/chat (server-only path). Importing it elsewhere is harmless —
 * it holds no secrets — but it exists to feed the proxy's buildAgentMessage().
 */

/** Reused stem so every "we don't have the exact data yet" line reads the same. */
const PLACEHOLDER =
  "I don't have the exact live pricing/coverage table connected yet, but here is how to frame the conversation:";

export type KnowledgeSection = {
  /** Stable id used by the broad-topic bundle. */
  id: string;
  /** Human title, rendered as the section heading in the assembled context. */
  title: string;
  /** Specific phrases that pull in THIS section. Generic words like "plan" /
   *  "coverage" are handled separately by BROAD_TRIGGERS so a precise question
   *  ("buyer coverage") stays focused instead of dragging in every section. */
  keywords: string[];
  /** Placeholder-safe coaching body. */
  body: string;
};

export const KNOWLEDGE_SECTIONS: KnowledgeSection[] = [
  {
    id: "seller-coverage",
    title: "Seller Coverage",
    keywords: ["seller coverage", "seller's coverage", "listing coverage", "seller plan", "seller warranty"],
    body: [
      "Seller coverage protects a home while it's listed and reassures buyers that major systems and appliances are looked after through the sale.",
      PLACEHOLDER,
      "- Lead with peace of mind during the listing period and fewer deal-killing surprises at inspection.",
      "- Ask the agent which systems or appliances the seller is most worried about, then map those concerns to coverage areas.",
      "- Offer to confirm the exact covered items once the live coverage table is connected.",
    ].join("\n"),
  },
  {
    id: "buyer-coverage",
    title: "Buyer Coverage",
    keywords: ["buyer coverage", "buyer's coverage", "buyer plan"],
    body: [
      "Buyer coverage gives a new homeowner protection on covered systems and appliances after closing, so an early breakdown isn't an out-of-pocket shock.",
      PLACEHOLDER,
      "- Frame it as budget protection in the first year of ownership, when surprises are most stressful.",
      "- Tie it to the home's age and standout features (HVAC, water heater, pool/spa) to make the value concrete.",
      "- Be honest about what you can't yet confirm and offer to get the exact covered list.",
    ].join("\n"),
  },
  {
    id: "new-construction",
    title: "New Construction",
    keywords: ["new construction", "new build", "newly built", "new home", "builder warranty"],
    body: [
      "For newly built homes, position coverage as protection that picks up the everyday systems and appliances the builder's initial warranty may not cover, and that stays in place after that first-year warranty lapses.",
      PLACEHOLDER,
      "- Emphasize long-term peace of mind once the builder warranty expires.",
      "- Clarify what the builder warranty already handles before layering on coverage so the value is obvious.",
    ].join("\n"),
  },
  {
    id: "optional-add-ons",
    title: "Optional Add-ons",
    keywords: ["add-on", "add on", "addon", "add-ons", "add ons", "optional coverage", "extra coverage"],
    body: [
      "Add-ons tailor a plan to the specific home — typically extra systems, specialty appliances, and exterior or structural items beyond the base plan.",
      PLACEHOLDER,
      "- Coach the agent to start with the base plan, then layer add-ons based on the home's age and standout features (pool/spa, well, septic, additional units).",
      "- Recommend only the one or two add-ons that match the home's biggest risks rather than everything at once.",
    ].join("\n"),
  },
  {
    id: "pricing-upgrades",
    title: "Pricing / Upgrades",
    keywords: ["pricing", "price", "cost", "how much", "upgrade", "upgrades", "tier", "tiers"],
    body: [
      "Pricing generally scales with the plan tier plus any add-ons; an upgrade moves a customer from a base plan to broader coverage.",
      PLACEHOLDER,
      "- Until the live pricing table is connected, do NOT quote dollar figures. Explain the value drivers instead: breadth of coverage, the service-call experience, and add-ons.",
      "- Offer to confirm exact pricing rather than guessing, and frame any upgrade around the added protection it buys.",
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
      "Customers most often ask what's covered vs. excluded, how service calls work, whether there's a waiting period, and what happens at claim time.",
      PLACEHOLDER,
      "- Answer the shape of the question honestly, be clear about what you can't yet confirm, and offer to get the exact details.",
      "- Never imply something is covered if it isn't in this approved knowledge.",
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
      "Common objections: \"it's too expensive,\" \"the seller already maintains everything,\" and \"the buyer can just self-insure.\"",
      PLACEHOLDER,
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
      "The right recommendation depends on the home and the deal.",
      PLACEHOLDER,
      "- Start by asking: home age, standout features (pool/spa, well, septic), who's paying (seller vs. buyer), and the agent's goal (protect the deal, win the listing, reassure the buyer).",
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
 * Returns the approved knowledge text relevant to `userMessage`, or null when
 * nothing matches (so unrelated questions don't get a wall of product context).
 *
 * Matching is two-tier: a specific section keyword wins and keeps the answer
 * focused; only when no specific section matches do the broad "plan"/"coverage"
 * triggers pull in the overview bundle.
 */
export function getRelevantKnowledge(userMessage: string): string | null {
  const text = userMessage.toLowerCase();

  const specific = KNOWLEDGE_SECTIONS.filter((section) =>
    section.keywords.some((keyword) => text.includes(keyword)),
  );

  let chosen = specific;
  if (specific.length === 0 && BROAD_TRIGGERS.some((t) => text.includes(t))) {
    chosen = KNOWLEDGE_SECTIONS.filter((s) => BROAD_BUNDLE_IDS.includes(s.id));
  }

  if (chosen.length === 0) return null;

  const header =
    "Approved Elevate knowledge for this answer. Use ONLY what's here for plan/coverage specifics; do not invent details beyond it. When exact pricing or coverage isn't stated, use the placeholder framing and offer to confirm.";

  return [
    header,
    ...chosen.map((section) => `## ${section.title}\n${section.body}`),
  ].join("\n\n");
}
