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
