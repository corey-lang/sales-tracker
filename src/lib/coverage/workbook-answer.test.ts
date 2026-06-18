/**
 * Unit tests for answerFromWorkbook — the Utah MVP brochure fallback.
 *
 * These tests exercise the pure function directly (no mocking needed) and
 * verify every answer type: pricing, coverage items, add-ons, plan list,
 * addon catalog, plans-including, clarification flows, and null fallthrough.
 */

import { describe, expect, it } from "vitest";
import { answerFromWorkbook } from "./workbook-answer";

// ---------------------------------------------------------------------------
// Non-UT state → always null
// ---------------------------------------------------------------------------

describe("non-UT state", () => {
  it("returns null for TX state", () => {
    expect(answerFromWorkbook("What does Epic cost?", "TX")).toBeNull();
  });

  it("returns null for AZ state", () => {
    expect(answerFromWorkbook("Are sprinklers covered on Totally Elevated?", "AZ")).toBeNull();
  });

  it("accepts UT case-insensitively", () => {
    const result = answerFromWorkbook("What does Epic cost?", "ut");
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

describe("pricing — Epic", () => {
  it("returns a grounded answer", () => {
    const r = answerFromWorkbook("What does Epic cost?", "UT");
    expect(r?.kind).toBe("grounded");
  });

  it("reply contains $950", () => {
    const r = answerFromWorkbook("What does Epic cost?", "UT");
    expect(r?.text).toContain("$950");
  });

  it("sourceType is workbook", () => {
    const r = answerFromWorkbook("What does Epic cost?", "UT");
    expect(r?.sourceType).toBe("workbook");
  });

  it("confidence is high", () => {
    const r = answerFromWorkbook("What does Epic cost?", "UT");
    expect(r?.confidence).toBe("high");
  });

  it("citation page is 7", () => {
    const r = answerFromWorkbook("What does Epic cost?", "UT");
    expect(r?.citations[0]?.pages).toContain(7);
  });

  it("reply includes Utah Real Estate scope note", () => {
    const r = answerFromWorkbook("What does Epic cost?", "UT");
    expect(r?.text.toLowerCase()).toContain("utah real estate");
  });

  it("reply includes 4,000 sq ft threshold", () => {
    const r = answerFromWorkbook("What does Epic cost?", "UT");
    expect(r?.text).toContain("4,000");
  });

  it("reply mentions $50 deduction for homes under 1,499 sq ft", () => {
    const r = answerFromWorkbook("What does Epic cost?", "UT");
    expect(r?.text).toContain("1,499");
  });
});

describe("pricing — Essential", () => {
  it("reply contains $500", () => {
    const r = answerFromWorkbook("How much is Essential?", "UT");
    expect(r?.text).toContain("$500");
  });
});

describe("pricing — plan not specified → asks for plan", () => {
  it("returns clarification asking for plan", () => {
    const r = answerFromWorkbook("What does it cost?", "UT");
    expect(r?.kind).toBe("clarify");
    expect(r?.coverageStep).toBe("pricing:plan");
  });

  it("answer options include all 4 plans", () => {
    const r = answerFromWorkbook("What does it cost?", "UT");
    const labels = r?.answerOptions?.map((o) => o.label) ?? [];
    expect(labels).toContain("Epic");
    expect(labels).toContain("Essential");
    expect(labels).toContain("Elevated");
    expect(labels).toContain("Totally Elevated");
  });
});

// ---------------------------------------------------------------------------
// Coverage items — Kitchen Refrigerator
// ---------------------------------------------------------------------------

describe("Kitchen Refrigerator — by plan", () => {
  it("Epic → covered, $7,500/request", () => {
    const r = answerFromWorkbook(
      "Is Kitchen Refrigerator covered on Epic?",
      "UT",
    );
    expect(r?.kind).toBe("grounded");
    expect(r?.text).toContain("$7,500");
    expect(r?.text.toLowerCase()).toContain("epic");
  });

  it("Elevated → covered, $2,000/request", () => {
    const r = answerFromWorkbook(
      "Is Kitchen Refrigerator covered on Elevated?",
      "UT",
    );
    expect(r?.text).toContain("$2,000");
  });

  it("Totally Elevated → covered, $4,000/request", () => {
    const r = answerFromWorkbook(
      "Is Kitchen Refrigerator covered on Totally Elevated?",
      "UT",
    );
    expect(r?.text).toContain("$4,000");
  });

  it("Essential → not covered", () => {
    const r = answerFromWorkbook(
      "Is Kitchen Refrigerator covered on Essential?",
      "UT",
    );
    expect(r?.kind).toBe("grounded");
    expect(r?.text.toLowerCase()).toContain("not cover");
  });
});

describe("Kitchen Refrigerator — guided flow via chip", () => {
  it("coverage:item step sets item and asks for plan", () => {
    const r = answerFromWorkbook(
      "Kitchen Refrigerator",
      "UT",
      { intent: "coverage" },
      "coverage:item",
    );
    expect(r?.kind).toBe("clarify");
    expect(r?.coverageStep).toBe("coverage:plan");
    const labels = r?.answerOptions?.map((o) => o.label) ?? [];
    expect(labels).toContain("Epic");
    expect(labels).toContain("Elevated");
  });

  it("coverage:plan step with Elevated context → $2,000 answer", () => {
    const r = answerFromWorkbook(
      "Elevated",
      "UT",
      { intent: "coverage", coverageItem: "Kitchen Refrigerator" },
      "coverage:plan",
    );
    expect(r?.kind).toBe("grounded");
    expect(r?.text).toContain("$2,000");
    expect(r?.text.toLowerCase()).toContain("elevated");
  });

  it("coverage:plan with Epic context → $7,500 answer", () => {
    const r = answerFromWorkbook(
      "Epic",
      "UT",
      { intent: "coverage", coverageItem: "Kitchen Refrigerator" },
      "coverage:plan",
    );
    expect(r?.kind).toBe("grounded");
    expect(r?.text).toContain("$7,500");
  });

  it("citation page 7 on plan answer", () => {
    const r = answerFromWorkbook(
      "Epic",
      "UT",
      { intent: "coverage", coverageItem: "Kitchen Refrigerator" },
      "coverage:plan",
    );
    expect(r?.citations[0]?.pages).toContain(7);
    expect(r?.sourceType).toBe("workbook");
  });
});

// ---------------------------------------------------------------------------
// Coverage items — Sprinkler System & Timers
// ---------------------------------------------------------------------------

describe("Sprinkler System & Timers", () => {
  it("Totally Elevated → not covered, mentions $80 add-on", () => {
    const r = answerFromWorkbook(
      "Are sprinklers covered on Totally Elevated?",
      "UT",
    );
    expect(r?.kind).toBe("grounded");
    expect(r?.text.toLowerCase()).toContain("not cover");
    expect(r?.text).toContain("$80");
  });

  it("Totally Elevated → pages include 7 and 9 (coverage page + add-on page)", () => {
    const r = answerFromWorkbook(
      "Are sprinklers covered on Totally Elevated?",
      "UT",
    );
    expect(r?.citations[0]?.pages).toContain(7);
    expect(r?.citations[0]?.pages).toContain(9);
  });

  it("Essential → not covered, mentions $80 add-on", () => {
    const r = answerFromWorkbook(
      "Are sprinklers covered on Essential?",
      "UT",
    );
    expect(r?.text.toLowerCase()).toContain("not cover");
    expect(r?.text).toContain("$80");
  });

  it("Epic → covered, $500/request", () => {
    const r = answerFromWorkbook("Are sprinklers covered on Epic?", "UT");
    expect(r?.kind).toBe("grounded");
    expect(r?.text).toContain("$500");
    expect(r?.text.toLowerCase()).toContain("epic");
  });

  it("'sprinkler' synonym also works", () => {
    const r = answerFromWorkbook("Is sprinkler covered on Epic?", "UT");
    expect(r?.kind).toBe("grounded");
    expect(r?.text).toContain("$500");
  });
});

// ---------------------------------------------------------------------------
// Add-on items — Built-in Pool/Spa Standard Timer
// ---------------------------------------------------------------------------

describe("Built-in Pool/Spa Equipment with Standard Timer", () => {
  it("coverage:item chip → add-on answer, no plan asked", () => {
    const r = answerFromWorkbook(
      "Built-in Pool/Spa Equipment with Standard Timer",
      "UT",
      { intent: "coverage" },
      "coverage:item",
    );
    expect(r?.kind).toBe("grounded");
    expect(r?.text).toContain("$250");
    expect(r?.text).toContain("$1,000");
  });

  it("add-on answer → sourceType workbook, page 9", () => {
    const r = answerFromWorkbook(
      "Built-in Pool/Spa Equipment with Standard Timer",
      "UT",
      { intent: "coverage" },
      "coverage:item",
    );
    expect(r?.sourceType).toBe("workbook");
    expect(r?.citations[0]?.pages).toContain(9);
  });

  it("automation controller chip → $400, $2,000/request", () => {
    const r = answerFromWorkbook(
      "Built-in Pool/Spa Equipment with Automation Controller",
      "UT",
      { intent: "coverage" },
      "coverage:item",
    );
    expect(r?.kind).toBe("grounded");
    expect(r?.text).toContain("$400");
    expect(r?.text).toContain("$2,000");
  });
});

// ---------------------------------------------------------------------------
// Plans-including
// ---------------------------------------------------------------------------

describe("plans_including", () => {
  it("which plans include Kitchen Refrigerator → Elevated, Totally Elevated, Epic", () => {
    const r = answerFromWorkbook(
      "Which plans include Kitchen Refrigerator?",
      "UT",
    );
    expect(r?.kind).toBe("grounded");
    expect(r?.text).toContain("Elevated");
    expect(r?.text).toContain("Epic");
    expect(r?.text.toLowerCase()).not.toContain("essential");
  });

  it("which plans include Sprinkler System & Timers → Epic only", () => {
    const r = answerFromWorkbook(
      "Which plans include Sprinkler System & Timers?",
      "UT",
    );
    expect(r?.kind).toBe("grounded");
    expect(r?.text).toContain("Epic");
    // Essential, Elevated, TE should NOT appear as included plans
    expect(r?.text).not.toMatch(/•\s*Essential/);
    expect(r?.text).not.toMatch(/•\s*Elevated/);
  });
});

// ---------------------------------------------------------------------------
// Plan list
// ---------------------------------------------------------------------------

describe("plan list", () => {
  it("'what plans do we offer?' → lists all 4 plans", () => {
    const r = answerFromWorkbook("What plans do we offer?", "UT");
    expect(r?.kind).toBe("grounded");
    expect(r?.text).toContain("Essential");
    expect(r?.text).toContain("Elevated");
    expect(r?.text).toContain("Totally Elevated");
    expect(r?.text).toContain("Epic");
  });
});

// ---------------------------------------------------------------------------
// Add-on catalog
// ---------------------------------------------------------------------------

describe("add-on catalog", () => {
  it("'what add-ons are available?' → returns add-on list", () => {
    const r = answerFromWorkbook("What add-ons are available?", "UT");
    expect(r?.kind).toBe("grounded");
    expect(r?.text.toLowerCase()).toContain("add-on");
    expect(r?.text).toContain("$250");
    expect(r?.text).toContain("$80");
  });
});

// ---------------------------------------------------------------------------
// Null fallthrough — unknown items
// ---------------------------------------------------------------------------

describe("unknown items → null", () => {
  it("garage door → null (not in workbook vocab)", () => {
    expect(
      answerFromWorkbook("Is the garage door covered on Essential?", "UT"),
    ).toBeNull();
  });

  it("HVAC → null (not in workbook vocab)", () => {
    expect(
      answerFromWorkbook("Is HVAC covered on Epic?", "UT"),
    ).toBeNull();
  });
});
