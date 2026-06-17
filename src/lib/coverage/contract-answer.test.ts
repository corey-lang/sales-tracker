/**
 * Ask Smitty Utah MVP — contract answer and routing tests.
 *
 * Covers the required test scenarios A–I from the spec:
 *   D. Fridge ambiguity → clarification
 *   E. Pool ambiguity → clarification
 *   F. Seller + add-on → contract answer (not generic add-on catalog)
 *   G. Utah service area counties → contract answer
 *   H. Outside service area / trip fee → contract answer
 *   I. Legal/exclusion question → needs_review
 *
 * Scenarios A, B, C (Epic price, plan comparison, sprinklers on Totally
 * Elevated) require a live Supabase connection and are covered by integration
 * tests outside this suite.
 */

import { describe, expect, it } from "vitest";

import {
  answerFromContract,
  answerSellerAddon,
  checkAmbiguity,
  detectContractCategories,
  isContractQuestion,
  isSellerAddonQuestion,
} from "./contract-answer";
import { isCoverageQuestion, shouldAnswerFromCoverage } from "./answer-logic";

// ---------------------------------------------------------------------------
// isContractQuestion
// ---------------------------------------------------------------------------

describe("isContractQuestion", () => {
  it("detects seller coverage questions", () => {
    expect(isContractQuestion("Does seller coverage include add-ons?")).toBe(true);
    expect(isContractQuestion("What is the seller plan limit?")).toBe(true);
    expect(isContractQuestion("How long does seller coverage last during listing?")).toBe(true);
    expect(isContractQuestion("Are pre-existing conditions covered by seller plan?")).toBe(true);
  });

  it("detects buyer coverage questions", () => {
    expect(isContractQuestion("When does buyer coverage start?")).toBe(true);
    expect(isContractQuestion("How long after closing can I buy buyer coverage?")).toBe(true);
  });

  it("detects new construction questions", () => {
    expect(isContractQuestion("Is there coverage for new construction homes?")).toBe(true);
    expect(isContractQuestion("Tell me about the new construction plan.")).toBe(true);
  });

  it("detects service area questions (scenarios G + H)", () => {
    // Scenario G
    expect(
      isContractQuestion("What counties are in the normal Utah service area?"),
    ).toBe(true);
    // Scenario H
    expect(
      isContractQuestion("What happens outside the normal service area?"),
    ).toBe(true);
    expect(isContractQuestion("What is the trip fee?")).toBe(true);
    expect(isContractQuestion("Is there an extra charge outside the county?")).toBe(true);
  });

  it("detects exclusion / legal questions (scenario I)", () => {
    expect(isContractQuestion("What are the exclusions?")).toBe(true);
    expect(isContractQuestion("What does the contract say about legal interpretation?")).toBe(true);
    expect(isContractQuestion("Tell me about contract exclusions.")).toBe(true);
  });

  it("does NOT flag brochure-only questions", () => {
    expect(isContractQuestion("Is the fridge covered on Epic?")).toBe(false);
    expect(isContractQuestion("What does Epic cost?")).toBe(false);
    expect(isContractQuestion("Compare Essential and Elevated")).toBe(false);
    expect(isContractQuestion("Are sprinklers covered on Totally Elevated?")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isCoverageQuestion — contract terms must be caught by the gate
// ---------------------------------------------------------------------------

describe("isCoverageQuestion catches contract-related terms", () => {
  it("gates service area questions (must not fall through to Cogent)", () => {
    expect(isCoverageQuestion("What counties are in the normal Utah service area?")).toBe(true);
    expect(isCoverageQuestion("What is the trip fee?")).toBe(true);
    expect(isCoverageQuestion("Is there coverage outside my county?")).toBe(true);
  });

  it("gates seller/buyer coverage questions", () => {
    expect(isCoverageQuestion("Does seller coverage include add-ons?")).toBe(true);
    expect(isCoverageQuestion("Tell me about buyer plan options.")).toBe(true);
    expect(isCoverageQuestion("What is the listing coverage period?")).toBe(true);
  });

  it("gates new construction questions", () => {
    expect(isCoverageQuestion("Is there a new construction plan?")).toBe(true);
  });

  it("gates exclusion questions", () => {
    expect(isCoverageQuestion("What are the exclusions in the contract?")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shouldAnswerFromCoverage — contract terms must intercept before Cogent
// ---------------------------------------------------------------------------

describe("shouldAnswerFromCoverage", () => {
  it("intercepts contract-term messages", () => {
    expect(
      shouldAnswerFromCoverage(null, "What counties are in the normal Utah service area?"),
    ).toBe(true);
    expect(
      shouldAnswerFromCoverage(null, "Does seller coverage include add-ons?"),
    ).toBe(true);
    expect(shouldAnswerFromCoverage(null, "What is the trip fee?")).toBe(true);
    expect(
      shouldAnswerFromCoverage(null, "What are the contract exclusions?"),
    ).toBe(true);
  });

  it("always intercepts when localFlow is active", () => {
    expect(shouldAnswerFromCoverage("coverage", "Epic")).toBe(true);
    expect(shouldAnswerFromCoverage("coverage", "homeowner")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isSellerAddonQuestion — scenario F pre-routing check
// ---------------------------------------------------------------------------

describe("isSellerAddonQuestion (scenario F)", () => {
  it("detects seller + add-on combinations", () => {
    expect(isSellerAddonQuestion("Does seller coverage include add-ons?")).toBe(true);
    expect(isSellerAddonQuestion("Can sellers get optional coverage?")).toBe(true);
    expect(isSellerAddonQuestion("Do listings come with add-on coverage?")).toBe(true);
    expect(isSellerAddonQuestion("Are addons available during listing?")).toBe(true);
  });

  it("does NOT flag generic add-on questions", () => {
    expect(isSellerAddonQuestion("What add-ons are available?")).toBe(false);
    expect(isSellerAddonQuestion("How much does pool add-on cost?")).toBe(false);
  });

  it("does NOT flag seller questions without add-on", () => {
    expect(isSellerAddonQuestion("How long is seller coverage?")).toBe(false);
    expect(isSellerAddonQuestion("What's the seller plan limit?")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// answerSellerAddon — scenario F answer
// ---------------------------------------------------------------------------

describe("answerSellerAddon (scenario F)", () => {
  it("returns a grounded answer with contract citation", () => {
    const answer = answerSellerAddon();
    expect(answer.kind).toBe("grounded");
    expect(answer.sourceType).toBe("contract");
    expect(answer.confidence).toBe("high");
  });

  it("says add-ons are NOT covered during seller coverage", () => {
    const answer = answerSellerAddon();
    expect(answer.text.toLowerCase()).toContain("not covered");
    expect(answer.text.toLowerCase()).toMatch(/optional coverage items|add-on/);
  });

  it("includes the $2,000 aggregate limit", () => {
    const answer = answerSellerAddon();
    expect(answer.text).toContain("$2,000");
  });

  it("cites Utah Sample Contract 2025.5, p. 12", () => {
    const answer = answerSellerAddon();
    expect(answer.citations).toHaveLength(1);
    expect(answer.citations[0].brochure).toContain("Utah Sample Contract");
    expect(answer.citations[0].pages).toContain(12);
  });
});

// ---------------------------------------------------------------------------
// answerFromContract — scenarios G, H, I
// ---------------------------------------------------------------------------

describe("answerFromContract", () => {
  it("returns null for non-UT states", () => {
    expect(
      answerFromContract("What counties are in the service area?", "TX"),
    ).toBeNull();
  });

  it("returns null for non-contract questions", () => {
    expect(
      answerFromContract("Is the dishwasher covered on Epic?", "UT"),
    ).toBeNull();
  });

  it("scenario G — service area counties", () => {
    const answer = answerFromContract(
      "What counties are in the normal Utah service area?",
      "UT",
    );
    expect(answer).not.toBeNull();
    expect(answer!.kind).toBe("grounded");
    expect(answer!.confidence).toBe("high");
    expect(answer!.sourceType).toBe("contract");
    expect(answer!.text).toContain("Salt Lake");
    expect(answer!.text).toContain("Davis");
    expect(answer!.text).toContain("Weber");
    expect(answer!.text).toContain("Utah");
    expect(answer!.text).toContain("Washington");
    expect(answer!.citations[0].brochure).toContain("Utah Sample Contract");
  });

  it("scenario H — outside service area / trip fee", () => {
    const answer = answerFromContract(
      "What happens outside the normal service area?",
      "UT",
    );
    expect(answer).not.toBeNull();
    expect(answer!.kind).toBe("grounded");
    expect(answer!.text).toContain("$85");
    expect(answer!.text.toLowerCase()).toContain("trip fee");
  });

  it("scenario H (trip fee query directly)", () => {
    const answer = answerFromContract("What is the trip fee?", "UT");
    expect(answer).not.toBeNull();
    expect(answer!.text).toContain("$85");
  });

  it("scenario I — exclusions / legal interpretation → needs_review", () => {
    const answer = answerFromContract("What are the exclusions?", "UT");
    expect(answer).not.toBeNull();
    expect(answer!.kind).toBe("grounded");
    expect(answer!.confidence).toBe("needs_review");
    expect(answer!.text.toLowerCase()).toContain("admin");
  });

  it("answers seller coverage questions with contract facts", () => {
    const answer = answerFromContract("When does seller coverage start?", "UT");
    expect(answer).not.toBeNull();
    expect(answer!.text.toLowerCase()).toContain("listing");
  });

  it("answers buyer coverage questions", () => {
    const answer = answerFromContract("When does buyer coverage start?", "UT");
    expect(answer).not.toBeNull();
    expect(answer!.text).toContain("closing date");
  });

  it("answers new construction questions", () => {
    const answer = answerFromContract("Tell me about the new construction plan.", "UT");
    expect(answer).not.toBeNull();
    expect(answer!.text.toLowerCase()).toContain("buyer coverage");
  });
});

// ---------------------------------------------------------------------------
// checkAmbiguity — scenarios D and E
// ---------------------------------------------------------------------------

describe("checkAmbiguity (scenarios D and E)", () => {
  // Scenario D — fridge
  it("D: triggers fridge clarification for 'fridge'", () => {
    const answer = checkAmbiguity("Is the fridge covered?", false);
    expect(answer).not.toBeNull();
    expect(answer!.kind).toBe("clarify");
    expect(answer!.answerOptions?.map((o) => o.label)).toContain(
      "Kitchen Refrigerator",
    );
    expect(answer!.answerOptions?.map((o) => o.label)).toContain(
      "Additional Kitchen Refrigerator",
    );
    expect(answer!.answerOptions?.map((o) => o.label)).toContain(
      "Additional Refrigerator / Freezer",
    );
  });

  it("D: triggers fridge clarification for 'refrigerator'", () => {
    const answer = checkAmbiguity("Is the refrigerator covered?", false);
    expect(answer).not.toBeNull();
    expect(answer!.kind).toBe("clarify");
  });

  it("D: does NOT trigger when item context already set", () => {
    const answer = checkAmbiguity("Is the fridge covered?", true);
    expect(answer).toBeNull();
  });

  it("D: does NOT trigger for specific fridge terms", () => {
    expect(
      checkAmbiguity("Is the kitchen refrigerator covered?", false),
    ).toBeNull();
    expect(
      checkAmbiguity("Is the additional kitchen refrigerator included?", false),
    ).toBeNull();
  });

  // Scenario E — pool
  it("E: triggers pool clarification for 'pool'", () => {
    const answer = checkAmbiguity("How much is pool coverage?", false);
    expect(answer).not.toBeNull();
    expect(answer!.kind).toBe("clarify");
    const labels = answer!.answerOptions?.map((o) => o.label) ?? [];
    expect(labels.some((l) => l.includes("Pool/Spa"))).toBe(true);
    expect(labels.some((l) => l.includes("Pool Pump"))).toBe(true);
    expect(labels.some((l) => l.includes("Weekly Pool"))).toBe(true);
  });

  it("E: does NOT trigger for specific pool terms", () => {
    expect(
      checkAmbiguity("Is the built-in pool pump covered?", false),
    ).toBeNull();
    expect(checkAmbiguity("Tell me about pool pump coverage.", false)).toBeNull();
  });

  it("returns null for unrelated messages", () => {
    expect(checkAmbiguity("Is the HVAC covered?", false)).toBeNull();
    expect(checkAmbiguity("Does Epic cover garage doors?", false)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectContractCategories
// ---------------------------------------------------------------------------

describe("detectContractCategories", () => {
  it("returns multiple categories for compound questions", () => {
    const cats = detectContractCategories(
      "Are there trip fees for counties outside the normal service area?",
    );
    expect(cats).toContain("service_area");
    expect(cats).toContain("trip_fee");
  });

  it("returns empty array for brochure questions", () => {
    expect(detectContractCategories("Is the dishwasher covered?")).toHaveLength(0);
    expect(detectContractCategories("What does Epic cost?")).toHaveLength(0);
  });
});
