import { describe, expect, it } from "vitest";

import {
  ANY_PLAN_VALUE,
  AUDIENCE_OPTIONS,
  buildCitation,
  clarifyAnswer,
  classifyCoverageIntent,
  detectMentions,
  formatBrochureCitation,
  includedToKind,
  isCoverageQuestion,
  noStateRefusal,
  normalizeTerm,
  pageSuffix,
  planCoverageTurn,
  refusal,
  renderAddons,
  renderCoverageItem,
  renderComparison,
  renderPlanList,
  renderPlanPricing,
  renderPlansIncluding,
  shouldAnswerFromCoverage,
  stateLabel,
  toOptions,
  uniquePages,
  type SynonymEntry,
} from "./answer-logic";

describe("stateLabel", () => {
  it("maps known USPS codes to names", () => {
    expect(stateLabel("UT")).toBe("Utah");
    expect(stateLabel("tx")).toBe("Texas");
    expect(stateLabel(" az ")).toBe("Arizona");
  });
  it("echoes unknown codes uppercased", () => {
    expect(stateLabel("zz")).toBe("ZZ");
  });
});

describe("citations", () => {
  it("formats brochure citation with and without version", () => {
    expect(formatBrochureCitation("Utah Brochure", "2025.7")).toBe(
      "Utah Brochure 2025.7",
    );
    expect(formatBrochureCitation("Utah Brochure", null)).toBe("Utah Brochure");
  });
  it("appends a single page as 'p. N'", () => {
    expect(buildCitation("Utah Brochure", "2025.7", 4).label).toBe(
      "Utah Brochure 2025.7, p. 4",
    );
  });
  it("appends multiple pages as 'pp. N, M' (deduped + sorted)", () => {
    const c = buildCitation("Utah Brochure", "2025.7", [5, 3, 5, null, 3]);
    expect(c.label).toBe("Utah Brochure 2025.7, pp. 3, 5");
    expect(c.pages).toEqual([3, 5]);
  });
  it("omits pages when none are recorded", () => {
    expect(buildCitation("Utah Brochure", "2025.7", null).label).toBe(
      "Utah Brochure 2025.7",
    );
    expect(buildCitation("Utah Brochure", null, 0).label).toBe("Utah Brochure");
    expect(buildCitation("Utah Brochure", null, []).pages).toEqual([]);
  });
  it("carries structured fields through", () => {
    const c = buildCitation("Utah Brochure", "2025.7", 4);
    expect(c).toMatchObject({ brochure: "Utah Brochure", version: "2025.7", pages: [4] });
  });
});

describe("page helpers", () => {
  it("uniquePages drops null/zero/negatives, dedupes, sorts", () => {
    expect(uniquePages([3, null, 1, 3, 0, -2, 2])).toEqual([1, 2, 3]);
  });
  it("pageSuffix renders p./pp./empty", () => {
    expect(pageSuffix([])).toBe("");
    expect(pageSuffix([4])).toBe(", p. 4");
    expect(pageSuffix([3, 5])).toBe(", pp. 3, 5");
  });
});

describe("isCoverageQuestion (route gate)", () => {
  it("catches normal coverage phrasings that the old matcher missed", () => {
    expect(isCoverageQuestion("Does Epic cover HVAC?")).toBe(true);
    expect(isCoverageQuestion("Is refrigerator covered?")).toBe(true);
    expect(isCoverageQuestion("What does Totally Elevated cover?")).toBe(true);
    expect(isCoverageQuestion("Does the brochure mention sprinklers?")).toBe(true);
  });
  it("catches pricing / add-on / limit / service-fee questions", () => {
    expect(isCoverageQuestion("How much does the Epic plan cost?")).toBe(true);
    expect(isCoverageQuestion("What add-ons are available?")).toBe(true);
    expect(isCoverageQuestion("What's the coverage limit on the water heater?")).toBe(true);
    expect(isCoverageQuestion("What is the service fee?")).toBe(true);
    expect(isCoverageQuestion("What plans do we offer?")).toBe(true);
  });
  it("matches hyphenated and plural service-fee phrasings", () => {
    expect(isCoverageQuestion("What is the service-fee?")).toBe(true);
    expect(isCoverageQuestion("Are there service fees?")).toBe(true);
    expect(isCoverageQuestion("What about service-fees?")).toBe(true);
  });
  it("catches seller/buyer/our plan phrasings", () => {
    expect(isCoverageQuestion("Tell me about the seller plan")).toBe(true);
    expect(isCoverageQuestion("Tell me about our buyer plans")).toBe(true);
    expect(isCoverageQuestion("What's in the buyer plan?")).toBe(true);
    expect(isCoverageQuestion("Walk me through our plans")).toBe(true);
    expect(isCoverageQuestion("Tell me about our seller plans")).toBe(true);
  });
  it("does NOT trigger on generic 'plan' usage", () => {
    expect(isCoverageQuestion("help me plan my week")).toBe(false);
    expect(isCoverageQuestion("help me plan visits")).toBe(false);
    expect(isCoverageQuestion("can you plan my day for me?")).toBe(false);
    expect(isCoverageQuestion("what should I do today?")).toBe(false);
  });
  it("does NOT trip 'cover' inside another word", () => {
    expect(isCoverageQuestion("help me discover new offices")).toBe(false);
  });
});

describe("normalizeTerm", () => {
  it("lowercases, trims, collapses whitespace", () => {
    expect(normalizeTerm("  Sprinkler   System ")).toBe("sprinkler system");
  });
});

describe("classifyCoverageIntent", () => {
  it("detects compare", () => {
    expect(classifyCoverageIntent("compare Epic and Elevated")).toBe("compare");
    expect(classifyCoverageIntent("Epic vs Totally Elevated")).toBe("compare");
  });
  it("detects list_plans", () => {
    expect(classifyCoverageIntent("what plans do we offer?")).toBe("list_plans");
    expect(classifyCoverageIntent("what do we offer")).toBe("list_plans");
  });
  it("detects add-ons", () => {
    expect(classifyCoverageIntent("what add-ons are available?")).toBe("addons");
  });
  it("detects pricing", () => {
    expect(classifyCoverageIntent("how much is the Epic plan?")).toBe("pricing");
    expect(classifyCoverageIntent("what's the price of Elevated")).toBe("pricing");
  });
  it("falls back to coverage for a plain covered/limit question", () => {
    expect(classifyCoverageIntent("is the water heater covered?")).toBe("coverage");
    expect(classifyCoverageIntent("does Epic cover HVAC")).toBe("coverage");
  });
});

describe("detectMentions", () => {
  const synonyms: SynonymEntry[] = [
    { canonicalType: "coverage_item", synonym: "sprinklers", canonicalValue: "Sprinkler System & Timers" },
    { canonicalType: "plan", synonym: "te", canonicalValue: "Totally Elevated" },
  ];
  const plans = ["Epic", "Elevated", "Totally Elevated"];
  const items = ["HVAC", "Sprinkler System & Timers", "Water Heater"];

  it("matches a direct vocabulary term (case-insensitive)", () => {
    expect(detectMentions("does epic cover hvac", plans, synonyms, "plan")).toContain("Epic");
    expect(detectMentions("is the water heater covered", items, synonyms, "coverage_item")).toContain("Water Heater");
  });
  it("resolves a synonym to the canonical term", () => {
    expect(detectMentions("are sprinklers covered?", items, synonyms, "coverage_item")).toContain(
      "Sprinkler System & Timers",
    );
  });
  it("does not match on ultra-short tokens by substring alone", () => {
    // "te" only resolves via the synonym pass, not stray substring of "water".
    const hits = detectMentions("how is the water heater", plans, synonyms, "plan");
    expect(hits).not.toContain("Totally Elevated");
  });
  it("returns empty when nothing matches", () => {
    expect(detectMentions("hello there", plans, synonyms, "plan")).toEqual([]);
  });
});

describe("includedToKind", () => {
  it("maps true/false/null", () => {
    expect(includedToKind(true)).toBe("answer");
    expect(includedToKind(false)).toBe("not_covered");
    expect(includedToKind(null)).toBe("unspecified");
  });
});

describe("answer + refusal templates", () => {
  const cite = buildCitation("Utah Brochure", "2025.7", 4);

  it("refusal names the state and carries no citations", () => {
    const r = refusal("UT");
    expect(r.kind).toBe("refusal");
    expect(r.text).toContain("Utah");
    expect(r.citations).toHaveLength(0);
  });
  it("noStateRefusal explains the missing state", () => {
    expect(noStateRefusal().text).toMatch(/state assigned/i);
  });

  it("renders an included coverage item with its limit + citation", () => {
    const a = renderCoverageItem(
      { planName: "Epic", coverageItem: "HVAC", included: true, coverageLimitText: "Up to $2,000" },
      cite,
    );
    expect(a.kind).toBe("grounded");
    expect(a.text).toContain("Yes");
    expect(a.text).toContain("HVAC");
    expect(a.text).toContain("Up to $2,000");
    expect(a.citations[0].label).toBe("Utah Brochure 2025.7, p. 4");
  });
  it("renders a not-covered item as a clear No", () => {
    const a = renderCoverageItem(
      { planName: "Epic", coverageItem: "Pool", included: false, coverageLimitText: null },
      cite,
    );
    expect(a.text).toContain("No");
    expect(a.text).toContain("does not cover");
  });
  it("renders an unspecified item without guessing", () => {
    const a = renderCoverageItem(
      { planName: "Epic", coverageItem: "Septic", included: null, coverageLimitText: null },
      cite,
    );
    expect(a.text).toMatch(/doesn't specify|can't confirm/i);
  });

  it("renders the plan list and plans-including", () => {
    expect(renderPlanList(["Epic", "Elevated"], cite).text).toContain("Epic");
    expect(renderPlansIncluding("HVAC", ["Epic"], cite).text).toContain("HVAC");
  });

  it("renders pricing using only the brochure's wording", () => {
    expect(renderPlanPricing({ planName: "Epic", priceText: "$600 / year" }, cite).text).toContain(
      "$600 / year",
    );
    expect(renderPlanPricing({ planName: "Epic", priceText: null }, cite).text).toMatch(
      /doesn't state a price/i,
    );
  });

  it("renders add-ons with optional price text", () => {
    const a = renderAddons(
      [
        { addonName: "Pool Coverage", addonPriceText: "$120 / year" },
        { addonName: "Septic", addonPriceText: null },
      ],
      cite,
    );
    expect(a.text).toContain("Pool Coverage — $120 / year");
    expect(a.text).toContain("Septic");
  });

  it("renders a comparison and preserves multi-page citations", () => {
    const multi = buildCitation("Utah Brochure", "2025.7", [3, 5]);
    const a = renderComparison(
      "Epic",
      "Elevated",
      [
        {
          coverageItem: "HVAC",
          a: { included: true, limitText: "Up to $2,000" },
          b: { included: false, limitText: null },
        },
      ],
      multi,
    );
    expect(a.kind).toBe("grounded");
    expect(a.text).toContain("Epic vs Elevated");
    expect(a.citations[0].label).toBe("Utah Brochure 2025.7, pp. 3, 5");
    expect(a.citations[0].pages).toEqual([3, 5]);
  });
});

// ---------------------------------------------------------------------------
// Local coverage narrowing (Phase 1)
// ---------------------------------------------------------------------------

const VOCAB = {
  plans: ["Essential", "Elevated", "Totally Elevated", "Epic"],
  items: ["HVAC", "Pool", "Refrigerator"],
  addons: ["Pool Coverage", "Guest House"],
};
const NO_SYN: SynonymEntry[] = [];

describe("shouldAnswerFromCoverage (routing guarantee)", () => {
  it("routes a fresh coverage question to coverage", () => {
    expect(shouldAnswerFromCoverage(undefined, "Does Epic cover HVAC?")).toBe(
      true,
    );
  });
  it("routes ANY message to coverage while a local flow is active", () => {
    // Bare chip values that do NOT read as coverage questions must still be
    // intercepted by the marker — never fall through to Cogent.
    for (const v of ["Epic", "homeowner", "real_estate", "sellers", "HVAC"]) {
      expect(shouldAnswerFromCoverage("coverage", v)).toBe(true);
    }
  });
  it("does NOT route a bare chip value without the marker (proves marker is required)", () => {
    expect(shouldAnswerFromCoverage(undefined, "homeowner")).toBe(false);
    expect(shouldAnswerFromCoverage(undefined, "real_estate")).toBe(false);
  });
  it("leaves a generic non-coverage message alone", () => {
    expect(shouldAnswerFromCoverage(undefined, "help me plan my week")).toBe(
      false,
    );
    expect(shouldAnswerFromCoverage(null, "hello there")).toBe(false);
  });
});

describe("planCoverageTurn — clarify on under-specified questions", () => {
  it('"Does it cover HVAC?" asks for a plan and preserves the item', () => {
    const plan = planCoverageTurn({
      message: "Does it cover HVAC?",
      vocab: VOCAB,
      synonyms: NO_SYN,
    });
    expect(plan.action).toBe("clarify");
    if (plan.action !== "clarify") return;
    expect(plan.step).toBe("coverage:plan");
    expect(plan.context.coverageItem).toBe("HVAC");
    const values = plan.options.map((o) => o.value);
    expect(values).toContain("Epic");
    expect(values).toContain(ANY_PLAN_VALUE);
  });

  it("pricing with no plan asks for plan options", () => {
    const plan = planCoverageTurn({
      message: "What does this cost?",
      vocab: VOCAB,
      synonyms: NO_SYN,
    });
    expect(plan.action).toBe("clarify");
    if (plan.action !== "clarify") return;
    expect(plan.step).toBe("pricing:plan");
    expect(plan.options.map((o) => o.value)).toEqual(VOCAB.plans);
  });

  it("comparison with no plans asks for plan options", () => {
    const plan = planCoverageTurn({
      message: "Compare our plans",
      vocab: VOCAB,
      synonyms: NO_SYN,
    });
    expect(plan.action).toBe("clarify");
    if (plan.action !== "clarify") return;
    expect(plan.step).toBe("compare:plans");
    expect(plan.options.length).toBeGreaterThan(0);
  });

  it("missing item asks for an item (capped chip set)", () => {
    const plan = planCoverageTurn({
      message: "Epic",
      vocab: VOCAB,
      synonyms: NO_SYN,
    });
    expect(plan.action).toBe("clarify");
    if (plan.action !== "clarify") return;
    expect(plan.step).toBe("coverage:item");
  });
});

describe("planCoverageTurn — slot preservation across turns", () => {
  it("selecting Epic after HVAC runs a coverage_item lookup with both slots", () => {
    const plan = planCoverageTurn({
      message: "Epic",
      vocab: VOCAB,
      synonyms: NO_SYN,
      context: { intent: "coverage", coverageItem: "HVAC" },
      step: "coverage:plan",
    });
    expect(plan).toEqual({
      action: "coverage_item",
      plan: "Epic",
      item: "HVAC",
    });
  });

  it("selecting a plan after a pricing question runs a pricing lookup", () => {
    const plan = planCoverageTurn({
      message: "Elevated",
      vocab: VOCAB,
      synonyms: NO_SYN,
      context: { intent: "pricing" },
      step: "pricing:plan",
    });
    expect(plan).toEqual({ action: "pricing", plan: "Elevated" });
  });

  it("supplying the second plan completes a comparison", () => {
    const plan = planCoverageTurn({
      message: "Epic",
      vocab: VOCAB,
      synonyms: NO_SYN,
      context: { intent: "compare", comparePlans: ["Elevated"] },
      step: "compare:plans",
    });
    expect(plan.action).toBe("compare");
    if (plan.action !== "compare") return;
    expect(new Set([plan.planA, plan.planB])).toEqual(
      new Set(["Elevated", "Epic"]),
    );
  });

  it('"Any plan" routes to a which-plans-include lookup', () => {
    const plan = planCoverageTurn({
      message: ANY_PLAN_VALUE,
      vocab: VOCAB,
      synonyms: NO_SYN,
      context: { intent: "coverage", coverageItem: "HVAC" },
      step: "coverage:plan",
    });
    expect(plan).toEqual({ action: "plans_including", item: "HVAC" });
  });
});

describe("planCoverageTurn — fully specified answers immediately", () => {
  it('"Does Epic cover HVAC?" runs the lookup without clarifying', () => {
    const plan = planCoverageTurn({
      message: "Does Epic cover HVAC?",
      vocab: VOCAB,
      synonyms: NO_SYN,
    });
    expect(plan).toEqual({
      action: "coverage_item",
      plan: "Epic",
      item: "HVAC",
    });
  });

  it('"Which plans include HVAC?" answers directly', () => {
    const plan = planCoverageTurn({
      message: "Which plans include HVAC?",
      vocab: VOCAB,
      synonyms: NO_SYN,
    });
    expect(plan).toEqual({ action: "plans_including", item: "HVAC" });
  });

  it("compare with two named plans runs the comparison", () => {
    const plan = planCoverageTurn({
      message: "Compare Epic and Essential",
      vocab: VOCAB,
      synonyms: NO_SYN,
    });
    expect(plan.action).toBe("compare");
    if (plan.action !== "compare") return;
    expect(new Set([plan.planA, plan.planB])).toEqual(
      new Set(["Epic", "Essential"]),
    );
  });

  it("list-plans and add-ons need no narrowing", () => {
    expect(
      planCoverageTurn({
        message: "What plans do we offer?",
        vocab: VOCAB,
        synonyms: NO_SYN,
      }).action,
    ).toBe("list_plans");
    expect(
      planCoverageTurn({
        message: "What add-ons are available?",
        vocab: VOCAB,
        synonyms: NO_SYN,
      }).action,
    ).toBe("addons");
  });
});

describe("planCoverageTurn — free-text only when it matches slot vocabulary", () => {
  it("typed plan name resolves like a chip tap", () => {
    const plan = planCoverageTurn({
      message: "epic please",
      vocab: VOCAB,
      synonyms: NO_SYN,
      context: { intent: "coverage", coverageItem: "HVAC" },
      step: "coverage:plan",
    });
    expect(plan).toEqual({
      action: "coverage_item",
      plan: "Epic",
      item: "HVAC",
    });
  });

  it("unrecognized free-text re-asks the same step (no guess)", () => {
    const plan = planCoverageTurn({
      message: "purple monkey",
      vocab: VOCAB,
      synonyms: NO_SYN,
      context: { intent: "coverage", coverageItem: "HVAC" },
      step: "coverage:plan",
    });
    expect(plan.action).toBe("clarify");
    if (plan.action !== "clarify") return;
    expect(plan.step).toBe("coverage:plan");
    expect(plan.context.planName).toBeUndefined();
  });
});

describe("planCoverageTurn — audience is context only", () => {
  it("stores a coverage audience without changing the lookup path", () => {
    const plan = planCoverageTurn({
      message: "homeowner",
      vocab: VOCAB,
      synonyms: NO_SYN,
      context: { intent: "coverage", coverageItem: "HVAC" },
      step: "audience",
    });
    expect(plan.action).toBe("clarify");
    if (plan.action !== "clarify") return;
    expect(plan.context.coverageAudience).toBe("homeowner");
    // Still narrowing to a plan — audience did not resolve or filter anything.
    expect(plan.step).toBe("coverage:plan");
  });

  it("exposes the three coverage-type options", () => {
    expect(AUDIENCE_OPTIONS.map((o) => o.value)).toEqual([
      "real_estate",
      "homeowner",
      "sellers",
    ]);
  });
});

describe("clarifyAnswer + grounded citation invariants", () => {
  it("a clarify carries chips/step/context and NO citations", () => {
    const a = clarifyAnswer(
      "coverage:plan",
      "Which plan are you asking about for HVAC?",
      toOptions(["Epic", "Elevated"]),
      { intent: "coverage", coverageItem: "HVAC" },
    );
    expect(a.kind).toBe("clarify");
    expect(a.citations).toEqual([]);
    expect(a.coverageStep).toBe("coverage:plan");
    expect(a.answerOptions).toHaveLength(2);
    expect(a.context?.coverageItem).toBe("HVAC");
  });

  it("a grounded answer preserves its citation", () => {
    const c = buildCitation("Utah Brochure", "2025.7", 4);
    const g = renderCoverageItem(
      { planName: "Epic", coverageItem: "HVAC", included: true, coverageLimitText: null },
      c,
    );
    expect(g.kind).toBe("grounded");
    expect(g.citations).toEqual([c]);
  });
});
