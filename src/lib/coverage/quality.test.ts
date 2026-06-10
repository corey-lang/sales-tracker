import { describe, expect, it, vi } from "vitest";

import {
  approveAndPublishBrochure,
  classifyAddon,
  classifyCoverage,
  classifyPricing,
  DEFAULT_CONFIDENCE_THRESHOLD,
  effectiveThreshold,
  TRUSTED_CONFIDENCE_FLOOR,
  type BrochureAnalysis,
  type PublishDeps,
} from "./quality";
import {
  assertHasApprovedFacts,
  type PendingAddon,
  type PendingCoverage,
  type PendingPricing,
} from "./review";

// ---------------------------------------------------------------------------
// Row factories — valid-by-default; override the field a test cares about.
// ---------------------------------------------------------------------------

function coverage(over: Partial<PendingCoverage> = {}): PendingCoverage {
  return {
    id: "c1",
    stateCode: "UT",
    planName: "Epic",
    coverageItem: "HVAC System",
    included: true,
    coverageLimit: null,
    coverageLimitText: null,
    sourceText: "The HVAC system is covered under the Epic plan.",
    sourcePage: 3,
    confidence: 0.5,
    extractionMethod: "ai",
    ...over,
  };
}

function pricing(over: Partial<PendingPricing> = {}): PendingPricing {
  return {
    id: "p1",
    stateCode: "UT",
    planName: "Epic",
    priceAmount: 600,
    priceCadence: "annual",
    currencyCode: "USD",
    priceText: "$600 / year",
    sourceText: "Epic plan is $600 per year.",
    sourcePage: 4,
    confidence: 0.9,
    extractionMethod: "ai",
    ...over,
  };
}

function addon(over: Partial<PendingAddon> = {}): PendingAddon {
  return {
    id: "a1",
    stateCode: "UT",
    addonName: "Pool Coverage",
    planName: null,
    includedInPlan: false,
    availableAsAddon: true,
    addonPriceAmount: 120,
    addonPriceCadence: "annual",
    currencyCode: "USD",
    addonPriceText: "$120 / year",
    coverageLimit: null,
    coverageLimitText: null,
    sourceText: "Pool coverage is available for $120 per year.",
    sourcePage: 5,
    confidence: 0.9,
    extractionMethod: "ai",
    ...over,
  };
}

describe("effectiveThreshold (server owns the minimum)", () => {
  it("uses the trust-appropriate floor when no threshold is requested", () => {
    expect(effectiveThreshold(undefined, true)).toBe(TRUSTED_CONFIDENCE_FLOOR); // 0.50
    expect(effectiveThreshold(undefined, false)).toBe(DEFAULT_CONFIDENCE_THRESHOLD); // 0.85
  });
  it("clamps a caller request UP to the floor — never below it", () => {
    expect(effectiveThreshold(0.4, true)).toBe(0.5); // trusted: can't drop below 0.50
    expect(effectiveThreshold(0.4, false)).toBe(0.85); // non-trusted: can't drop below 0.85
    expect(effectiveThreshold(0.0, true)).toBe(0.5);
    expect(effectiveThreshold(0.7, false)).toBe(0.85);
  });
  it("honors a caller request that RAISES the bar (stricter)", () => {
    expect(effectiveThreshold(0.95, true)).toBe(0.95);
    expect(effectiveThreshold(0.95, false)).toBe(0.95);
  });
});

describe("trusted-mode eligibility (confidence gate only)", () => {
  const trustedT = effectiveThreshold(undefined, true); // 0.50
  const defaultT = effectiveThreshold(undefined, false); // 0.85

  it("trusted: 0.50-confidence row with a valid citation is ELIGIBLE", () => {
    const cls = classifyCoverage(coverage({ confidence: 0.5 }), 1, trustedT);
    expect(cls.isException).toBe(false);
    expect(cls.reasons).toEqual([]);
  });

  it("non-trusted: the same 0.50-confidence row is HELD (low confidence)", () => {
    const cls = classifyCoverage(coverage({ confidence: 0.5 }), 1, defaultT);
    expect(cls.isException).toBe(true);
    expect(cls.reasons).toContain("low confidence");
  });

  it("trusted: very low confidence (OCR garbage) is still HELD below the floor", () => {
    const cls = classifyCoverage(coverage({ confidence: 0.2 }), 1, trustedT);
    expect(cls.isException).toBe(true);
    expect(cls.reasons).toContain("low confidence");
  });

  it("citation mismatch is HELD even for a high-confidence trusted row", () => {
    const cls = classifyCoverage(
      coverage({
        confidence: 0.95,
        coverageItem: "Refrigerator",
        sourceText: "Air conditioning repair service line.",
      }),
      1,
      trustedT,
    );
    expect(cls.isException).toBe(true);
    expect(cls.reasons).toContain("citation mismatch");
  });

  it("missing source is HELD (no citation can ever auto-publish)", () => {
    const cls = classifyCoverage(coverage({ sourceText: "  " }), 1, trustedT);
    expect(cls.isException).toBe(true);
    expect(cls.reasons).toContain("missing source");
  });

  it("missing source_page is HELD (page metadata required, even trusted)", () => {
    const cov = classifyCoverage(coverage({ sourcePage: null }), 1, trustedT);
    expect(cov.isException).toBe(true);
    expect(cov.reasons).toContain("missing page");

    const pri = classifyPricing(pricing({ sourcePage: null }), 1, trustedT);
    expect(pri.reasons).toContain("missing page");

    const add = classifyAddon(addon({ sourcePage: null }), 1, trustedT);
    expect(add.reasons).toContain("missing page");
  });

  it("missing price is HELD for pricing rows", () => {
    const cls = classifyPricing(
      pricing({ priceAmount: null, priceText: null }),
      1,
      trustedT,
    );
    expect(cls.isException).toBe(true);
    expect(cls.reasons).toContain("missing price");
  });

  it("duplicate rows are HELD", () => {
    const cls = classifyCoverage(coverage(), 2, trustedT);
    expect(cls.isException).toBe(true);
    expect(cls.reasons).toContain("duplicate");
  });

  it("an add-on sold as add-on without a price is HELD", () => {
    const cls = classifyAddon(
      addon({ availableAsAddon: true, addonPriceAmount: null, addonPriceText: null }),
      1,
      trustedT,
    );
    expect(cls.isException).toBe(true);
    expect(cls.reasons).toContain("missing price");
  });

  it("a clean trusted add-on with price + citation is ELIGIBLE", () => {
    const cls = classifyAddon(addon({ confidence: 0.6 }), 1, trustedT);
    expect(cls.isException).toBe(false);
  });
});

describe("plan disambiguation (word-boundary, longest-first)", () => {
  const trustedT = effectiveThreshold(undefined, true); // 0.50 — trusted must NOT bypass
  const cov = (planName: string, sourceText: string) =>
    classifyCoverage(
      coverage({ confidence: 0.95, planName, coverageItem: "HVAC", coverageLimitText: null, sourceText, sourcePage: 4 }),
      1,
      trustedT,
    );

  it("HELDS an Elevated row whose source only says 'Totally Elevated'", () => {
    const cls = cov("Elevated", "Totally Elevated: HVAC No Dollar Limit");
    expect(cls.isException).toBe(true);
    expect(cls.reasons).toContain("plan unverified");
  });

  it("HELDS a Totally Elevated row whose source only says 'Elevated'", () => {
    const cls = cov("Totally Elevated", "Elevated: HVAC $300 / Request");
    expect(cls.isException).toBe(true);
    expect(cls.reasons).toContain("plan unverified");
  });

  it("an exact 'Elevated' source validates Elevated", () => {
    expect(cov("Elevated", "Elevated: HVAC covered").reasons).not.toContain(
      "plan unverified",
    );
  });

  it("an exact 'Totally Elevated' source validates Totally Elevated", () => {
    expect(
      cov("Totally Elevated", "Totally Elevated: HVAC covered").reasons,
    ).not.toContain("plan unverified");
  });

  it("an exact 'Epic' source validates Epic", () => {
    expect(cov("Epic", "Epic: HVAC covered").reasons).not.toContain(
      "plan unverified",
    );
  });
});

describe("base-plan pricing is canonical-only (never derived)", () => {
  const trustedT = effectiveThreshold(undefined, true);

  // "knownPlans" no longer exists — eligibility is the canonical set alone, so
  // these hold regardless of any contamination from extracted rows.
  it("HELDS 'Water Softener' as a base-plan price (not canonical)", () => {
    const cls = classifyPricing(
      pricing({ confidence: 0.95, planName: "Water Softener", priceText: "$100", sourceText: "Water Softener $100", sourcePage: 6 }),
      1,
      trustedT,
    );
    expect(cls.isException).toBe(true);
    expect(cls.reasons).toContain("not a base plan");
  });

  it.each([
    "Exterior Main Line Coverage",
    "Reverse Osmosis System",
    "Pool/Spa",
    "Additional Refrigerator",
  ])("HELDS optional coverage '%s' misfiled as pricing", (planName) => {
    const cls = classifyPricing(
      pricing({ confidence: 0.95, planName, priceText: "$100", sourceText: `${planName} $100`, sourcePage: 6 }),
      1,
      trustedT,
    );
    expect(cls.reasons).toContain("not a base plan");
  });

  it("a non-canonical plan named in its source is STILL held (canonical authority)", () => {
    // Even though the source proves the (non-base) plan, it isn't canonical.
    const cls = classifyPricing(
      pricing({ confidence: 1, planName: "Gold", priceText: "$100", sourceText: "Gold: $100 per year", sourcePage: 6 }),
      1,
      trustedT,
    );
    expect(cls.reasons).toContain("not a base plan");
  });

  it("APPROVES a canonical base-plan price proven by its source", () => {
    const cls = classifyPricing(
      pricing({ confidence: 0.6, planName: "Epic", priceText: "$600 / year", sourceText: "Epic plan is $600 per year.", sourcePage: 7 }),
      1,
      trustedT,
    );
    expect(cls.isException).toBe(false);
  });
});

describe("coverage value/limit must be cited", () => {
  const trustedT = effectiveThreshold(undefined, true);

  it("HELDS Epic / HVAC Refrigerant / $300 when the source omits the value", () => {
    const cls = classifyCoverage(
      coverage({ confidence: 0.95, planName: "Epic", coverageItem: "HVAC Refrigerant", coverageLimitText: "$300 / Request", sourceText: "Epic plan: HVAC Refrigerant covered", sourcePage: 5 }),
      1,
      trustedT,
    );
    expect(cls.isException).toBe(true);
    expect(cls.reasons).toContain("value unverified");
  });

  it("HELDS '$300 / Request' when the source proves only the amount (no '/ Request')", () => {
    const cls = classifyCoverage(
      coverage({ confidence: 0.95, planName: "Epic", coverageItem: "HVAC Refrigerant", coverageLimitText: "$300 / Request", sourceText: "Epic: HVAC Refrigerant $300", sourcePage: 5 }),
      1,
      trustedT,
    );
    expect(cls.isException).toBe(true);
    expect(cls.reasons).toContain("value unverified");
  });

  it("PASSES '$300 / Request' when the full limit is cited", () => {
    const cls = classifyCoverage(
      coverage({ confidence: 0.6, planName: "Epic", coverageItem: "HVAC Refrigerant", coverageLimitText: "$300 / Request", sourceText: "Epic: HVAC Refrigerant $300 / Request", sourcePage: 5 }),
      1,
      trustedT,
    );
    expect(cls.isException).toBe(false);
  });

  it("HELDS '$150 / night ($500 max)' when the source is only partial", () => {
    const partials = [
      "Epic: Lodging $150 / night", // missing 500 + max
      "Epic: Lodging $150 night $500", // missing max
      "Epic: Lodging $500 max", // missing 150 + night
    ];
    for (const sourceText of partials) {
      const cls = classifyCoverage(
        coverage({ confidence: 1, planName: "Epic", coverageItem: "Lodging", coverageLimitText: "$150 / night ($500 max)", sourceText, sourcePage: 5 }),
        1,
        trustedT,
      );
      expect(cls.reasons).toContain("value unverified");
    }
  });

  it("PASSES '$150 / night ($500 max)' when night, max, and both numbers are cited", () => {
    const cls = classifyCoverage(
      coverage({ confidence: 0.6, planName: "Epic", coverageItem: "Lodging", coverageLimitText: "$150 / night ($500 max)", sourceText: "Epic: Lodging $150 / night ($500 max)", sourcePage: 5 }),
      1,
      trustedT,
    );
    expect(cls.isException).toBe(false);
  });

  it("PASSES Epic / HVAC Refrigerant / No Dollar Limit cited in the source", () => {
    const cls = classifyCoverage(
      coverage({ confidence: 0.6, planName: "Epic", coverageItem: "HVAC Refrigerant", coverageLimitText: "No Dollar Limit", sourceText: "Epic: HVAC Refrigerant No Dollar Limit", sourcePage: 5 }),
      1,
      trustedT,
    );
    expect(cls.isException).toBe(false);
  });

  it("PASSES Essential / Ranges / $1,000 / Request cited in the source", () => {
    const cls = classifyCoverage(
      coverage({ confidence: 0.6, planName: "Essential", coverageItem: "Ranges, Ovens, & Cooktops", coverageLimitText: "$1,000 / Request", sourceText: "Essential: Ranges, Ovens, & Cooktops $1,000 / Request", sourcePage: 6 }),
      1,
      trustedT,
    );
    expect(cls.isException).toBe(false);
  });

  it("HELDS Epic / Ranges / $1,000 when the source proves a different plan", () => {
    const cls = classifyCoverage(
      coverage({ confidence: 0.95, planName: "Epic", coverageItem: "Ranges, Ovens, & Cooktops", coverageLimitText: "$1,000 / Request", sourceText: "Essential: Ranges, Ovens, & Cooktops $1,000 / Request", sourcePage: 6 }),
      1,
      trustedT,
    );
    expect(cls.isException).toBe(true);
    expect(cls.reasons).toContain("plan unverified");
  });

  it("trusted confidence 1.0 does not bypass plan or value gates", () => {
    const plan = classifyCoverage(
      coverage({ confidence: 1, planName: "Epic", coverageItem: "HVAC Refrigerant", coverageLimitText: "$300 / Request", sourceText: "HVAC Refrigerant $300 / Request", sourcePage: 5 }),
      1,
      trustedT,
    );
    expect(plan.isException).toBe(true); // plan unverified
    const value = classifyCoverage(
      coverage({ confidence: 1, planName: "Epic", coverageItem: "HVAC Refrigerant", coverageLimitText: "$300 / Request", sourceText: "Epic: HVAC Refrigerant covered", sourcePage: 5 }),
      1,
      trustedT,
    );
    expect(value.isException).toBe(true); // value unverified

    // Partial value (amount present, "/ Request" qualifier missing) is NOT
    // bypassed by trusted + max confidence.
    const partial = classifyCoverage(
      coverage({ confidence: 1, planName: "Epic", coverageItem: "HVAC Refrigerant", coverageLimitText: "$300 / Request", sourceText: "Epic: HVAC Refrigerant $300", sourcePage: 5 }),
      1,
      trustedT,
    );
    expect(partial.isException).toBe(true);
    expect(partial.reasons).toContain("value unverified");
  });
});

describe("assertHasApprovedFacts (promote guard)", () => {
  it("throws when zero approved facts (blocks empty-current promote)", () => {
    expect(() => assertHasApprovedFacts(0)).toThrow(/no approved facts/i);
  });
  it("passes when there is at least one approved fact", () => {
    expect(() => assertHasApprovedFacts(1)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// approveAndPublishBrochure — promotion safety via injected deps (no DB).
// ---------------------------------------------------------------------------

function analysis(over: Partial<BrochureAnalysis> = {}): BrochureAnalysis {
  return {
    threshold: 0.5,
    pendingTotal: 2,
    byKind: { coverage: 2, pricing: 0, addons: 0 },
    confidence: { high: 0, medium: 2, low: 0 },
    flags: {
      missingSource: 0,
      missingPage: 0,
      missingPlan: 0,
      missingPrice: 0,
      duplicate: 0,
      lowConfidence: 0,
      citationMismatch: 0,
      planUnverified: 0,
      valueUnverified: 0,
    },
    eligible: 2,
    held: 0,
    pages: { withFacts: 1, min: 3, max: 3 },
    sample: [],
    eligibleIds: { coverage: ["c1", "c2"], pricing: [], addons: [] },
    ...over,
  };
}

function deps(over: Partial<PublishDeps> = {}): PublishDeps & {
  promote: ReturnType<typeof vi.fn>;
  bulkApprove: ReturnType<typeof vi.fn>;
} {
  return {
    analyze: vi.fn().mockResolvedValue(analysis()),
    bulkApprove: vi.fn().mockResolvedValue(2),
    countApproved: vi.fn().mockResolvedValue(2),
    promote: vi.fn().mockResolvedValue({}),
    ...over,
  } as PublishDeps & {
    promote: ReturnType<typeof vi.fn>;
    bulkApprove: ReturnType<typeof vi.fn>;
  };
}

describe("approveAndPublishBrochure", () => {
  it("requires a confirmed sample review", async () => {
    const d = deps();
    await expect(
      approveAndPublishBrochure("b", "r", "imported", 0.5, false, d),
    ).rejects.toThrow(/sample review/i);
    expect(d.promote).not.toHaveBeenCalled();
  });

  it("blocks publish when there are no eligible rows", async () => {
    const d = deps({
      analyze: vi
        .fn()
        .mockResolvedValue(
          analysis({ eligible: 0, eligibleIds: { coverage: [], pricing: [], addons: [] } }),
        ),
    });
    await expect(
      approveAndPublishBrochure("b", "r", "imported", 0.5, true, d),
    ).rejects.toThrow(/no eligible rows/i);
    expect(d.bulkApprove).not.toHaveBeenCalled();
    expect(d.promote).not.toHaveBeenCalled();
  });

  it("does NOT promote when the bulk approval updated 0 rows (race) and none are approved", async () => {
    const d = deps({
      bulkApprove: vi.fn().mockResolvedValue(0),
      countApproved: vi.fn().mockResolvedValue(0),
    });
    await expect(
      approveAndPublishBrochure("b", "r", "imported", 0.5, true, d),
    ).rejects.toThrow(/nothing was approved/i);
    expect(d.promote).not.toHaveBeenCalled();
  });

  it("promotes when approved facts exist after the bulk approval", async () => {
    const d = deps();
    const result = await approveAndPublishBrochure("b", "r", "imported", 0.5, true, d);
    expect(d.promote).toHaveBeenCalledTimes(1);
    expect(result.published).toBe(true);
    expect(result.approved).toBe(2);
  });

  it("promotes on a retry where rows were already approved (updated 0 but count > 0)", async () => {
    const d = deps({
      bulkApprove: vi.fn().mockResolvedValue(0), // nothing new
      countApproved: vi.fn().mockResolvedValue(5), // but facts already approved
    });
    const result = await approveAndPublishBrochure("b", "r", "imported", 0.5, true, d);
    expect(d.promote).toHaveBeenCalledTimes(1);
    expect(result.published).toBe(true);
  });
});
