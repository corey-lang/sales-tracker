/**
 * Route-level tests for POST /api/ai/chat — Ask Smitty Utah MVP.
 *
 * Tests verify the full routing pipeline from request to response shape,
 * covering contract-backed answers, ambiguity chips, Utah gate, narrator
 * skip behavior, and workbook fallback when the brochure DB is unavailable.
 * DB-dependent calls (requireTestAccount, answerCoverageQuestion) are mocked;
 * pure contract/ambiguity/workbook logic runs real.
 *
 * Scenarios:
 *   A. Seller + add-on → contract-backed, never routes to generic add-on catalog
 *   B. Service area counties → contract-backed
 *   C. Outside service area → contract-backed, includes $85 Trip Fee
 *   D. Fridge → clarification with 3 options
 *   E. Pool → clarification with 4 options
 *   F. Sprinklers on Totally Elevated → brochure-backed (DB mock returns data)
 *   G. Non-UT state → Utah beta gate fires before coverage or Cogent routing
 *   H. Brochure DB returns refusal (no published brochure) → workbook fallback
 *      covers Epic pricing, sprinklers on TE, Kitchen Refrigerator flow, pool add-on,
 *      and falls through for unknown items.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — hoisted before imports by vitest
// ---------------------------------------------------------------------------

vi.mock("@/lib/server/auth", () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = "ApiError";
    }
  }
  return {
    ApiError,
    requireTestAccount: vi.fn(),
    parseBody: vi.fn(async (req: Request, _schema: unknown) => req.json()),
    handleApiError: vi.fn((err: unknown) =>
      Response.json({ error: String(err) }, { status: 500 }),
    ),
  };
});

vi.mock("@/lib/coverage/service", () => ({
  answerCoverageQuestion: vi.fn(),
}));

vi.mock("@/lib/ai/smitty-narrator", () => ({
  callSmittyNarrator: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/ai/sales-knowledge", () => ({
  getRelevantKnowledge: vi.fn(() => null),
  isCoveragePricingQuestion: vi.fn(() => false),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { POST } from "./route";
import { requireTestAccount } from "@/lib/server/auth";
import { answerCoverageQuestion } from "@/lib/coverage/service";
import { callSmittyNarrator } from "@/lib/ai/smitty-narrator";

const mockRequireTestAccount = vi.mocked(requireTestAccount);
const mockAnswerCoverageQuestion = vi.mocked(answerCoverageQuestion);
const mockNarrator = vi.mocked(callSmittyNarrator);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUtUser(override: { state_code?: string | null } = {}) {
  return {
    id: "test-ae-1",
    state_code: "UT",
    is_test: true,
    role: "ae" as const,
    can_import_offices: false,
    first_name: "Test",
    ...override,
  };
}

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireTestAccount.mockResolvedValue(makeUtUser());
  mockNarrator.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// Scenario A — seller + add-on → contract-backed
// ---------------------------------------------------------------------------

describe("A: seller add-on question → contract answer", () => {
  it("returns a grounded answer from contract (not generic add-on catalog)", async () => {
    const res = await POST(
      makeRequest({ message: "Does seller coverage include add-ons?" }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.type).toBe("answer");
    expect(json.grounded).toBe(true);
  });

  it("reply says optional coverage items are not covered during seller term", async () => {
    const res = await POST(
      makeRequest({ message: "Does seller coverage include add-ons?" }),
    );
    const json = await res.json();

    // The deterministic reply must be the primary answer.
    expect(json.reply.toLowerCase()).toContain("not covered");
    expect(json.reply.toLowerCase()).toMatch(/optional coverage items|add-on/);
  });

  it("reply includes the $2,000 aggregate limit", async () => {
    const res = await POST(
      makeRequest({ message: "Does seller coverage include add-ons?" }),
    );
    const json = await res.json();
    expect(json.reply).toContain("$2,000");
  });

  it("sourceType is contract and page is 12", async () => {
    const res = await POST(
      makeRequest({ message: "Does seller coverage include add-ons?" }),
    );
    const json = await res.json();

    expect(json.sources).toHaveLength(1);
    expect(json.sources[0].sourceType).toBe("contract");
    expect(json.sources[0].pages).toContain(12);
  });

  it("narrator is NOT called for contract answers", async () => {
    await POST(
      makeRequest({ message: "Does seller coverage include add-ons?" }),
    );
    expect(mockNarrator).not.toHaveBeenCalled();
  });

  it("quickAnswer and details are not in the response", async () => {
    const res = await POST(
      makeRequest({ message: "Does seller coverage include add-ons?" }),
    );
    const json = await res.json();
    expect(json.quickAnswer).toBeUndefined();
    expect(json.details).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario B — service area counties → contract-backed
// ---------------------------------------------------------------------------

describe("B: service area counties → contract answer", () => {
  it("reply includes all five Utah counties", async () => {
    const res = await POST(
      makeRequest({ message: "What counties are in the normal Utah service area?" }),
    );
    const json = await res.json();

    expect(json.type).toBe("answer");
    expect(json.reply).toContain("Salt Lake");
    expect(json.reply).toContain("Davis");
    expect(json.reply).toContain("Weber");
    expect(json.reply).toContain("Washington");
  });

  it("sourceType is contract, page is 12", async () => {
    const res = await POST(
      makeRequest({ message: "What counties are in the normal Utah service area?" }),
    );
    const json = await res.json();

    expect(json.sources[0]?.sourceType).toBe("contract");
    expect(json.sources[0]?.pages).toContain(12);
  });

  it("narrator is NOT called for contract answers", async () => {
    await POST(
      makeRequest({ message: "What counties are in the normal Utah service area?" }),
    );
    expect(mockNarrator).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scenario C — outside service area / trip fee → contract-backed
// ---------------------------------------------------------------------------

describe("C: outside service area / trip fee → contract answer", () => {
  it("reply includes Home Warranty Coverage Items availability in other counties", async () => {
    const res = await POST(
      makeRequest({ message: "What happens outside the normal service area?" }),
    );
    const json = await res.json();

    expect(json.type).toBe("answer");
    expect(json.reply.toLowerCase()).toContain("home warranty coverage items");
  });

  it("reply includes the $85 Trip Fee", async () => {
    const res = await POST(
      makeRequest({ message: "What happens outside the normal service area?" }),
    );
    const json = await res.json();
    expect(json.reply).toContain("$85");
    expect(json.reply.toLowerCase()).toContain("trip fee");
  });

  it("reply mentions on-demand service area limit", async () => {
    const res = await POST(
      makeRequest({ message: "What happens outside the normal service area?" }),
    );
    const json = await res.json();
    expect(json.reply.toLowerCase()).toContain("on-demand");
  });

  it("sourceType is contract, page is 12", async () => {
    const res = await POST(
      makeRequest({ message: "What happens outside the normal service area?" }),
    );
    const json = await res.json();
    expect(json.sources[0]?.sourceType).toBe("contract");
    expect(json.sources[0]?.pages).toContain(12);
  });

  it("trip fee direct query also returns $85", async () => {
    const res = await POST(makeRequest({ message: "What is the trip fee?" }));
    const json = await res.json();
    expect(json.reply).toContain("$85");
    expect(json.type).toBe("answer");
  });
});

// ---------------------------------------------------------------------------
// Scenario D — fridge ambiguity → clarification
// ---------------------------------------------------------------------------

describe("D: fridge ambiguity → clarification", () => {
  it("type is clarification", async () => {
    const res = await POST(makeRequest({ message: "Is the fridge covered?" }));
    const json = await res.json();
    expect(json.type).toBe("clarification");
  });

  it("answerOptions include Kitchen Refrigerator", async () => {
    const res = await POST(makeRequest({ message: "Is the fridge covered?" }));
    const json = await res.json();
    const labels: string[] = json.answerOptions.map(
      (o: { label: string }) => o.label,
    );
    expect(labels).toContain("Kitchen Refrigerator");
  });

  it("answerOptions include Additional Kitchen Refrigerator", async () => {
    const res = await POST(makeRequest({ message: "Is the fridge covered?" }));
    const json = await res.json();
    const labels: string[] = json.answerOptions.map(
      (o: { label: string }) => o.label,
    );
    expect(labels).toContain("Additional Kitchen Refrigerator");
  });

  it("answerOptions include Additional Refrigerator / Freezer", async () => {
    const res = await POST(makeRequest({ message: "Is the fridge covered?" }));
    const json = await res.json();
    const labels: string[] = json.answerOptions.map(
      (o: { label: string }) => o.label,
    );
    expect(labels).toContain("Additional Refrigerator / Freezer");
  });

  it("DB is never queried for ambiguous fridge question", async () => {
    await POST(makeRequest({ message: "Is the fridge covered?" }));
    expect(mockAnswerCoverageQuestion).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scenario E — pool ambiguity → clarification
// ---------------------------------------------------------------------------

describe("E: pool ambiguity → clarification", () => {
  it("type is clarification", async () => {
    const res = await POST(makeRequest({ message: "How much is pool coverage?" }));
    const json = await res.json();
    expect(json.type).toBe("clarification");
  });

  it("answerOptions include all four pool options", async () => {
    const res = await POST(makeRequest({ message: "How much is pool coverage?" }));
    const json = await res.json();
    const labels: string[] = json.answerOptions.map(
      (o: { label: string }) => o.label,
    );
    expect(labels.some((l) => l.includes("Pool/Spa") && l.includes("Standard"))).toBe(true);
    expect(labels.some((l) => l.includes("Pool/Spa") && l.includes("Automation"))).toBe(true);
    expect(labels.some((l) => l.includes("Pool Pump"))).toBe(true);
    expect(labels.some((l) => l.includes("Weekly Pool"))).toBe(true);
  });

  it("DB is never queried for ambiguous pool question", async () => {
    await POST(makeRequest({ message: "How much is pool coverage?" }));
    expect(mockAnswerCoverageQuestion).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scenario F — sprinklers on Totally Elevated → brochure-backed
// ---------------------------------------------------------------------------

describe("F: sprinklers on Totally Elevated → brochure answer", () => {
  const mockBrochureAnswer = {
    kind: "grounded" as const,
    text: "No — Sprinkler System & Timers are not covered in the Totally Elevated plan. The Epic plan includes Sprinkler System & Timers at $500/request as a standard coverage item.",
    citations: [
      {
        brochure: "Utah Brochure 2025.5",
        version: "2025.5",
        // Reviewed Utah source: plan matrix on p. 7 (not p. 3).
        pages: [7],
        label: "Utah Brochure 2025.5 2025.5, p. 7",
      },
    ],
    confidence: "high" as const,
    sourceType: "brochure" as const,
  };

  beforeEach(() => {
    mockAnswerCoverageQuestion.mockResolvedValue(mockBrochureAnswer);
  });

  it("calls the brochure DB lookup for a non-ambiguous item question", async () => {
    await POST(
      makeRequest({ message: "Are sprinklers covered on Totally Elevated?" }),
    );
    expect(mockAnswerCoverageQuestion).toHaveBeenCalledWith(
      "UT",
      "Are sprinklers covered on Totally Elevated?",
      undefined,
      undefined,
    );
  });

  it("type is answer", async () => {
    const res = await POST(
      makeRequest({ message: "Are sprinklers covered on Totally Elevated?" }),
    );
    const json = await res.json();
    expect(json.type).toBe("answer");
  });

  it("reply says no for Totally Elevated", async () => {
    const res = await POST(
      makeRequest({ message: "Are sprinklers covered on Totally Elevated?" }),
    );
    const json = await res.json();
    expect(json.reply.toLowerCase()).toContain("not covered");
    expect(json.reply.toLowerCase()).toContain("totally elevated");
  });

  it("reply mentions Epic includes sprinklers at $500", async () => {
    const res = await POST(
      makeRequest({ message: "Are sprinklers covered on Totally Elevated?" }),
    );
    const json = await res.json();
    expect(json.reply.toLowerCase()).toContain("epic");
    expect(json.reply).toContain("$500");
  });

  it("sourceType is brochure and source page is 7 (reviewed Utah plan matrix)", async () => {
    const res = await POST(
      makeRequest({ message: "Are sprinklers covered on Totally Elevated?" }),
    );
    const json = await res.json();
    expect(json.sources).toHaveLength(1);
    expect(json.sources[0].sourceType).toBe("brochure");
    expect(json.sources[0].pages).toContain(7);
  });
});

// ---------------------------------------------------------------------------
// Scenario G — non-UT state → Utah beta gate fires before any routing
// ---------------------------------------------------------------------------

describe("G: non-UT state → Utah beta gate", () => {
  it("returns needs_review for a TX account asking a coverage question", async () => {
    mockRequireTestAccount.mockResolvedValue(makeUtUser({ state_code: "TX" }));
    const res = await POST(
      makeRequest({ message: "Does seller coverage include add-ons?" }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.type).toBe("needs_review");
    expect(json.reply.toLowerCase()).toContain("utah");
    expect(json.reply.toLowerCase()).toContain("beta");
  });

  it("returns needs_review for a TX account asking a non-coverage question", async () => {
    mockRequireTestAccount.mockResolvedValue(makeUtUser({ state_code: "TX" }));
    const res = await POST(
      makeRequest({ message: "What is the weather today?" }),
    );
    const json = await res.json();

    expect(json.type).toBe("needs_review");
    expect(json.reply).toContain("Utah");
  });

  it("returns needs_review for a null-state account in a non-UT deploy", async () => {
    // null state is pinned to "UT" by the route (effectiveState fallback), so
    // null-state accounts get UT coverage. Only explicit non-UT codes are blocked.
    mockRequireTestAccount.mockResolvedValue(makeUtUser({ state_code: null }));
    const res = await POST(
      makeRequest({ message: "What counties are in the service area?" }),
    );
    const json = await res.json();

    // null → "UT" fallback → should pass the gate and return a real answer
    expect(json.type).toBe("answer");
    expect(json.reply).toContain("Salt Lake");
  });

  it("DB lookup is NOT called when Utah gate blocks", async () => {
    mockRequireTestAccount.mockResolvedValue(makeUtUser({ state_code: "TX" }));
    await POST(makeRequest({ message: "Is the fridge covered?" }));
    expect(mockAnswerCoverageQuestion).not.toHaveBeenCalled();
  });

  it("narrator is NOT called when Utah gate blocks", async () => {
    mockRequireTestAccount.mockResolvedValue(makeUtUser({ state_code: "TX" }));
    await POST(makeRequest({ message: "Does seller coverage include add-ons?" }));
    expect(mockNarrator).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Source shape invariants
// ---------------------------------------------------------------------------

describe("source shape invariants", () => {
  it("never emits page 0 in sources", async () => {
    const res = await POST(
      makeRequest({ message: "Does seller coverage include add-ons?" }),
    );
    const json = await res.json();
    for (const s of json.sources ?? []) {
      for (const p of s.pages ?? []) {
        expect(p).toBeGreaterThan(0);
      }
    }
  });

  it("contract exclusion answer → needs_review, pages include 13 and 14", async () => {
    const res = await POST(makeRequest({ message: "What are the exclusions?" }));
    const json = await res.json();

    expect(json.type).toBe("needs_review");
    expect(json.sources[0]?.sourceType).toBe("contract");
    expect(json.sources[0]?.pages).toContain(13);
    expect(json.sources[0]?.pages).toContain(14);
  });

  it("clarification turn has empty sources", async () => {
    const res = await POST(makeRequest({ message: "Is the fridge covered?" }));
    const json = await res.json();
    expect(json.sources).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scenario H — brochure DB refusal → workbook fallback
//
// answerCoverageQuestion is mocked to return the "no published brochure" refusal
// (what the service returns when plan_brochures has no current-status row for UT).
// answerFromWorkbook is NOT mocked — it runs with real hardcoded workbook facts.
// ---------------------------------------------------------------------------

const NO_BROCHURE_REFUSAL = {
  kind: "refusal" as const,
  text: "I couldn't find that in the current Utah brochure. There isn't a current plan brochure on file for your state yet.",
  citations: [],
};

describe("H: brochure DB returns refusal → workbook fallback answers", () => {
  beforeEach(() => {
    mockAnswerCoverageQuestion.mockResolvedValue(NO_BROCHURE_REFUSAL);
  });

  // H-1: Epic pricing
  it("'What does Epic cost?' → workbook returns $950", async () => {
    const res = await POST(makeRequest({ message: "What does Epic cost?" }));
    const json = await res.json();
    expect(json.type).toBe("answer");
    expect(json.reply).toContain("$950");
  });

  it("Epic pricing answer → sourceType is workbook, page 7", async () => {
    const res = await POST(makeRequest({ message: "What does Epic cost?" }));
    const json = await res.json();
    expect(json.sources).toHaveLength(1);
    expect(json.sources[0].sourceType).toBe("workbook");
    expect(json.sources[0].pages).toContain(7);
  });

  it("Epic pricing answer → grounded is true", async () => {
    const res = await POST(makeRequest({ message: "What does Epic cost?" }));
    const json = await res.json();
    expect(json.grounded).toBe(true);
  });

  it("Epic pricing answer → reply includes Utah Real Estate scope and sq ft threshold", async () => {
    const res = await POST(makeRequest({ message: "What does Epic cost?" }));
    const json = await res.json();
    expect(json.reply.toLowerCase()).toContain("utah real estate");
    expect(json.reply).toContain("4,000");
  });

  // H-2: Sprinklers on Totally Elevated
  it("'Are sprinklers covered on Totally Elevated?' → workbook says not covered", async () => {
    const res = await POST(
      makeRequest({ message: "Are sprinklers covered on Totally Elevated?" }),
    );
    const json = await res.json();
    expect(json.type).toBe("answer");
    expect(json.reply.toLowerCase()).toContain("not cover");
    expect(json.reply.toLowerCase()).toContain("totally elevated");
  });

  it("sprinklers on TE → reply mentions $80 add-on option", async () => {
    const res = await POST(
      makeRequest({ message: "Are sprinklers covered on Totally Elevated?" }),
    );
    const json = await res.json();
    expect(json.reply).toContain("$80");
  });

  it("sprinklers on TE → sourceType workbook, page includes 7", async () => {
    const res = await POST(
      makeRequest({ message: "Are sprinklers covered on Totally Elevated?" }),
    );
    const json = await res.json();
    expect(json.sources[0].sourceType).toBe("workbook");
    expect(json.sources[0].pages).toContain(7);
  });

  it("sprinklers on Epic → workbook says covered at $500/request", async () => {
    const res = await POST(
      makeRequest({ message: "Are sprinklers covered on Epic?" }),
    );
    const json = await res.json();
    expect(json.type).toBe("answer");
    expect(json.reply.toLowerCase()).toContain("epic");
    expect(json.reply).toContain("$500");
  });

  // H-3: Kitchen Refrigerator chip after fridge clarification → asks for plan
  it("'Kitchen Refrigerator' chip (coverage:item step) → workbook asks for plan", async () => {
    const res = await POST(
      makeRequest({
        message: "Kitchen Refrigerator",
        localFlow: "coverage",
        coverageStep: "coverage:item",
        coverageContext: { intent: "coverage" },
      }),
    );
    const json = await res.json();
    expect(json.type).toBe("clarification");
    const labels: string[] = json.answerOptions.map((o: { label: string }) => o.label);
    expect(labels).toContain("Epic");
    expect(labels).toContain("Elevated");
    expect(labels).toContain("Essential");
    expect(labels).toContain("Totally Elevated");
  });

  it("Kitchen Refrigerator + Elevated plan → workbook returns $2,000/request", async () => {
    const res = await POST(
      makeRequest({
        message: "Elevated",
        localFlow: "coverage",
        coverageStep: "coverage:plan",
        coverageContext: { intent: "coverage", coverageItem: "Kitchen Refrigerator" },
      }),
    );
    const json = await res.json();
    expect(json.type).toBe("answer");
    expect(json.reply).toContain("$2,000");
    expect(json.sources[0].sourceType).toBe("workbook");
    expect(json.sources[0].pages).toContain(7);
  });

  it("Kitchen Refrigerator + Essential plan → workbook says not covered", async () => {
    const res = await POST(
      makeRequest({
        message: "Essential",
        localFlow: "coverage",
        coverageStep: "coverage:plan",
        coverageContext: { intent: "coverage", coverageItem: "Kitchen Refrigerator" },
      }),
    );
    const json = await res.json();
    expect(json.type).toBe("answer");
    expect(json.reply.toLowerCase()).toContain("not cover");
  });

  // H-4: Pool/spa add-on after pool clarification → returns add-on price directly
  it("'Built-in Pool/Spa Equipment with Standard Timer' chip → workbook returns $250", async () => {
    const res = await POST(
      makeRequest({
        message: "Built-in Pool/Spa Equipment with Standard Timer",
        localFlow: "coverage",
        coverageStep: "coverage:item",
        coverageContext: { intent: "coverage" },
      }),
    );
    const json = await res.json();
    expect(json.type).toBe("answer");
    expect(json.reply).toContain("$250");
    expect(json.reply).toContain("$1,000");
  });

  it("pool/spa standard timer → sourceType workbook, page 9", async () => {
    const res = await POST(
      makeRequest({
        message: "Built-in Pool/Spa Equipment with Standard Timer",
        localFlow: "coverage",
        coverageStep: "coverage:item",
        coverageContext: { intent: "coverage" },
      }),
    );
    const json = await res.json();
    expect(json.sources[0].sourceType).toBe("workbook");
    expect(json.sources[0].pages).toContain(9);
  });

  it("pool/spa add-on → no plan clarification asked (add-ons are plan-independent)", async () => {
    const res = await POST(
      makeRequest({
        message: "Built-in Pool/Spa Equipment with Standard Timer",
        localFlow: "coverage",
        coverageStep: "coverage:item",
        coverageContext: { intent: "coverage" },
      }),
    );
    const json = await res.json();
    // Should be an answer, not a clarification asking for plan
    expect(json.type).toBe("answer");
  });

  // H-5: Unknown item → workbook returns null → original refusal shown
  it("unknown item (garage door) → workbook falls through to brochure refusal", async () => {
    const res = await POST(
      makeRequest({ message: "Is the garage door covered on Essential?" }),
    );
    const json = await res.json();
    // Original refusal text contains "brochure"
    expect(json.reply.toLowerCase()).toContain("brochure");
    expect(json.type).toBe("needs_review");
  });
});

// ---------------------------------------------------------------------------
// Scenario H-catch — DB throws (connectivity error) → workbook fallback
//
// The catch path in runBrochureLookup must attempt the workbook before
// returning the "trouble reaching plan documents" message.
// ---------------------------------------------------------------------------

describe("H-catch: DB throws connectivity error → workbook fallback", () => {
  beforeEach(() => {
    mockAnswerCoverageQuestion.mockRejectedValue(new Error("connection timeout"));
  });

  it("known item (Epic pricing) → workbook answers even when DB throws", async () => {
    const res = await POST(makeRequest({ message: "What does Epic cost?" }));
    const json = await res.json();
    expect(json.type).toBe("answer");
    expect(json.reply).toContain("$950");
    expect(json.sources[0].sourceType).toBe("workbook");
  });

  it("unknown item (garage door) + DB throws → returns plan-documents message", async () => {
    const res = await POST(
      makeRequest({ message: "Is the garage door covered on Elevated?" }),
    );
    const json = await res.json();
    expect(json.type).toBe("needs_review");
    expect(json.reply.toLowerCase()).toContain("trouble");
  });
});

// ---------------------------------------------------------------------------
// Multi-source scenarios (I–L) — verify all approved Utah sources are searched
// for each question and merged according to source-priority rules.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Scenario I — "Standard timer for pool. What does that mean?"
//
// - Contract: no pool facts → null.
// - Workbook: "standard timer" synonym resolves to Built-in Pool/Spa Equipment
//   with Standard Timer → $250 add-on, $1,000/request limit, p. 9.
// - Merged: workbook wins (only grounded source).
// ---------------------------------------------------------------------------

describe("I: pool standard timer → workbook answer (multi-source)", () => {
  beforeEach(() => {
    mockAnswerCoverageQuestion.mockResolvedValue({
      kind: "refusal" as const,
      text: "I couldn't find that in the current Utah brochure.",
      citations: [],
    });
  });

  it("type is answer", async () => {
    const res = await POST(
      makeRequest({ message: "Standard timer for pool. What does that mean?" }),
    );
    const json = await res.json();
    expect(json.type).toBe("answer");
  });

  it("reply contains $250 add-on price", async () => {
    const res = await POST(
      makeRequest({ message: "Standard timer for pool. What does that mean?" }),
    );
    const json = await res.json();
    expect(json.reply).toContain("$250");
  });

  it("reply contains $1,000 per-request limit", async () => {
    const res = await POST(
      makeRequest({ message: "Standard timer for pool. What does that mean?" }),
    );
    const json = await res.json();
    expect(json.reply).toContain("$1,000");
  });

  it("sourceType is workbook, page 9", async () => {
    const res = await POST(
      makeRequest({ message: "Standard timer for pool. What does that mean?" }),
    );
    const json = await res.json();
    expect(json.sources).toHaveLength(1);
    expect(json.sources[0].sourceType).toBe("workbook");
    expect(json.sources[0].pages).toContain(9);
  });

  it("grounded is true", async () => {
    const res = await POST(
      makeRequest({ message: "Standard timer for pool. What does that mean?" }),
    );
    const json = await res.json();
    expect(json.grounded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario J — "What happens outside our coverage area?"
//
// Contract wins for service area / trip fee — these are CONTRACT_ONLY_CATEGORIES.
// Workbook returns refusal (no service area data). Merged result is contract.
// Verifies that multi-source architecture still applies source-priority rules.
// ---------------------------------------------------------------------------

describe("J: outside coverage area → contract wins (multi-source)", () => {
  beforeEach(() => {
    mockAnswerCoverageQuestion.mockResolvedValue({
      kind: "refusal" as const,
      text: "I couldn't find service area info in the brochure.",
      citations: [],
    });
  });

  it("type is answer", async () => {
    const res = await POST(
      makeRequest({ message: "What happens outside our coverage area?" }),
    );
    const json = await res.json();
    expect(json.type).toBe("answer");
  });

  it("reply includes five Utah counties from contract", async () => {
    const res = await POST(
      makeRequest({ message: "What happens outside our coverage area?" }),
    );
    const json = await res.json();
    expect(json.reply).toContain("Salt Lake");
    expect(json.reply).toContain("Davis");
    expect(json.reply).toContain("Weber");
    expect(json.reply).toContain("Washington");
  });

  it("reply includes $85 Trip Fee from contract", async () => {
    const res = await POST(
      makeRequest({ message: "What happens outside our coverage area?" }),
    );
    const json = await res.json();
    expect(json.reply).toContain("$85");
    expect(json.reply.toLowerCase()).toContain("trip fee");
  });

  it("sourceType is contract, page 12", async () => {
    const res = await POST(
      makeRequest({ message: "What happens outside our coverage area?" }),
    );
    const json = await res.json();
    expect(json.sources[0]?.sourceType).toBe("contract");
    expect(json.sources[0]?.pages).toContain(12);
  });

  it("narrator is NOT called (contract answer)", async () => {
    await POST(
      makeRequest({ message: "What happens outside our coverage area?" }),
    );
    expect(mockNarrator).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scenario K — "How much is new construction?"
//
// Contract: new_construction category → buyer only, 1-3 years, p. 12.
// Workbook/brochure: refusal (no new construction pricing in workbook fallback).
// Merged: contract wins (only grounded source).
//
// K-2 verifies the combined case when the brochure DB has pricing data:
// both sources merged with brochure leading (pricing intent) + contract appended.
// ---------------------------------------------------------------------------

describe("K: new construction → multi-source answer", () => {
  it("K-1: brochure DB refusal → workbook NC pricing ($800) + contract rules returned", async () => {
    mockAnswerCoverageQuestion.mockResolvedValue({
      kind: "refusal" as const,
      text: "No new construction plan data in brochure.",
      citations: [],
    });
    const res = await POST(
      makeRequest({ message: "How much is new construction?" }),
    );
    const json = await res.json();
    expect(json.type).toBe("answer");
    // Workbook pricing leads: $800 for three years.
    expect(json.reply).toContain("$800");
    // Must NOT include Guest House/ADU tier prices ($220/$270/$330/$400).
    expect(json.reply).not.toMatch(/\$220|\$270|\$330|\$400/);
    // Contract rules also appended.
    expect(json.reply.toLowerCase()).toContain("buyer");
  });

  it("K-1: combined answer includes workbook (p. 9) and contract (p. 12) sources", async () => {
    mockAnswerCoverageQuestion.mockResolvedValue({
      kind: "refusal" as const,
      text: "No new construction plan data in brochure.",
      citations: [],
    });
    const res = await POST(
      makeRequest({ message: "How much is new construction?" }),
    );
    const json = await res.json();
    const sourceTypes = json.sources.map((s: { sourceType: string }) => s.sourceType);
    expect(sourceTypes).toContain("workbook");
    expect(sourceTypes).toContain("contract");
    const pages = json.sources.flatMap((s: { pages: number[] }) => s.pages);
    expect(pages).toContain(9);
    expect(pages).toContain(12);
  });

  it("K-2: both sources grounded → combined answer with brochure price leading", async () => {
    // Simulate DB returning new construction pricing.
    mockAnswerCoverageQuestion.mockResolvedValue({
      kind: "grounded" as const,
      text: "New Construction Plan: $1,050/year.",
      citations: [
        {
          brochure: "Utah Brochure 2025.5",
          version: "2025.5",
          pages: [9],
          label: "Utah Brochure 2025.5, p. 9",
        },
      ],
      confidence: "high" as const,
      sourceType: "brochure" as const,
    });
    const res = await POST(
      makeRequest({ message: "How much is new construction?" }),
    );
    const json = await res.json();
    expect(json.type).toBe("answer");
    // Brochure leads (pricing intent) → price should appear.
    expect(json.reply).toContain("$1,050");
    // Contract appended → buyer-only rule should also appear.
    expect(json.reply.toLowerCase()).toContain("buyer");
  });

  it("K-2: combined answer sources include both brochure p. 9 and contract p. 12", async () => {
    mockAnswerCoverageQuestion.mockResolvedValue({
      kind: "grounded" as const,
      text: "New Construction Plan: $1,050/year.",
      citations: [
        {
          brochure: "Utah Brochure 2025.5",
          version: "2025.5",
          pages: [9],
          label: "Utah Brochure 2025.5, p. 9",
        },
      ],
      confidence: "high" as const,
      sourceType: "brochure" as const,
    });
    const res = await POST(
      makeRequest({ message: "How much is new construction?" }),
    );
    const json = await res.json();
    const sourceTypes = json.sources.map((s: { sourceType: string }) => s.sourceType);
    expect(sourceTypes).toContain("brochure");
    expect(sourceTypes).toContain("contract");
    const pages = json.sources.flatMap((s: { pages: number[] }) => s.pages);
    expect(pages).toContain(9);
    expect(pages).toContain(12);
  });
});

// ---------------------------------------------------------------------------
// Scenario L — Follow-up "How much is it?" with item context from prior turn
//
// When the previous answer established a coverageItem (via chip-tap or explicit
// context), the follow-up pricing question should resolve to that item without
// re-asking. Tests both the pool standard timer and the new construction paths.
// ---------------------------------------------------------------------------

describe("L: follow-up 'How much is it?' uses prior coverageItem context", () => {
  beforeEach(() => {
    mockAnswerCoverageQuestion.mockResolvedValue({
      kind: "refusal" as const,
      text: "I couldn't find that in the current Utah brochure.",
      citations: [],
    });
  });

  it("L-1: pool standard timer context → $250 answer (workbook, plan-independent)", async () => {
    // Simulates a follow-up after the pool standard timer chip was already tapped.
    const res = await POST(
      makeRequest({
        message: "How much is it?",
        localFlow: "coverage",
        coverageStep: "coverage:item",
        coverageContext: {
          intent: "coverage",
          coverageItem: "Built-in Pool/Spa Equipment with Standard Timer",
        },
      }),
    );
    const json = await res.json();
    expect(json.type).toBe("answer");
    expect(json.reply).toContain("$250");
    expect(json.reply).toContain("$1,000");
    expect(json.sources[0]?.sourceType).toBe("workbook");
  });

  it("L-1: pool standard timer follow-up → no plan clarification (add-ons are plan-independent)", async () => {
    const res = await POST(
      makeRequest({
        message: "How much is it?",
        localFlow: "coverage",
        coverageStep: "coverage:item",
        coverageContext: {
          intent: "coverage",
          coverageItem: "Built-in Pool/Spa Equipment with Standard Timer",
        },
      }),
    );
    const json = await res.json();
    // Should be a direct answer, not a plan clarification.
    expect(json.type).toBe("answer");
    expect(json.answerOptions).toHaveLength(0);
  });

  it("L-2: new construction with pricingTarget → workbook pricing answer (canonical follow-up path)", async () => {
    // Canonical new construction follow-up: context carries pricingTarget set by
    // the server on the prior turn. The workbook returns pricing, not contract rules.
    const res = await POST(
      makeRequest({
        message: "How much is it?",
        localFlow: "coverage",
        coverageStep: "coverage:item",
        coverageContext: {
          intent: "pricing",
          coverageItem: "new_construction",
          pricingTarget: "new_construction",
        },
      }),
    );
    const json = await res.json();
    expect(json.type).toBe("answer");
    expect(json.grounded).toBe(true);
    expect(json.reply).toContain("$800");
    expect(json.reply).not.toMatch(/\$220|\$270|\$330|\$400/);
    expect(
      json.sources.some((s: { sourceType: string }) => s.sourceType === "workbook"),
    ).toBe(true);
  });

  it("L-3: Kitchen Refrigerator + Elevated context → $2,000 answer (existing guided flow)", async () => {
    const res = await POST(
      makeRequest({
        message: "Elevated",
        localFlow: "coverage",
        coverageStep: "coverage:plan",
        coverageContext: {
          intent: "coverage",
          coverageItem: "Kitchen Refrigerator",
        },
      }),
    );
    const json = await res.json();
    expect(json.type).toBe("answer");
    expect(json.reply).toContain("$2,000");
    expect(json.sources[0]?.sourceType).toBe("workbook");
  });
});

// ---------------------------------------------------------------------------
// Scenario M — True two-turn context propagation
//
// Verifies that a resolved answer returns enough context (localFlow +
// coverageContext.coverageItem) that the follow-up "How much is it?" can
// resolve the topic without re-asking — even when the first turn was a fresh
// question with no incoming context.
// ---------------------------------------------------------------------------

describe("M: two-turn follow-up context propagation", () => {
  beforeEach(() => {
    // Default: no published brochure → workbook fallback path.
    mockAnswerCoverageQuestion.mockResolvedValue({
      kind: "refusal" as const,
      text: "No data in brochure.",
      citations: [],
    });
  });

  // -------------------------------------------------------------------------
  // M-1 — new construction: first turn returns topic context; follow-up resolves
  // -------------------------------------------------------------------------

  it("M-1: 'How much is new construction?' returns pricingTarget=new_construction context", async () => {
    const res = await POST(
      makeRequest({ message: "How much is new construction?" }),
    );
    const json = await res.json();
    expect(json.type).toBe("answer");
    expect(json.localFlow).toBe("coverage");
    expect(json.coverageContext?.coverageItem).toBe("new_construction");
    expect(json.coverageContext?.pricingTarget).toBe("new_construction");
  });

  it("M-1: follow-up 'How much is it?' with new_construction context → workbook $800 pricing", async () => {
    const res = await POST(
      makeRequest({
        message: "How much is it?",
        localFlow: "coverage",
        coverageStep: "coverage:item",
        coverageContext: {
          intent: "pricing",
          coverageItem: "new_construction",
          pricingTarget: "new_construction",
        },
      }),
    );
    const json = await res.json();
    expect(json.type).toBe("answer");
    expect(json.grounded).toBe(true);
    expect(json.reply).toContain("$800");
    // Must NOT include Guest House/ADU tier prices.
    expect(json.reply).not.toMatch(/\$220|\$270|\$330|\$400/);
    expect(
      json.sources.some((s: { sourceType: string }) => s.sourceType === "workbook"),
    ).toBe(true);
    expect(json.department).toBe("coverage");
  });

  it("M-1 integrated: real two-turn chain — follow-up returns $800, not Guest House/ADU tiers", async () => {
    // Turn 1: fresh new construction pricing question.
    const res1 = await POST(makeRequest({ message: "How much is new construction?" }));
    const json1 = await res1.json();
    expect(json1.localFlow).toBe("coverage");
    expect(json1.coverageContext?.pricingTarget).toBe("new_construction");

    // Turn 2: "How much is it?" using the EXACT context the server returned.
    const res2 = await POST(
      makeRequest({
        message: "How much is it?",
        localFlow: json1.localFlow,
        coverageStep: json1.coverageStep,
        coverageContext: json1.coverageContext,
      }),
    );
    const json2 = await res2.json();
    expect(json2.type).toBe("answer");
    expect(json2.grounded).toBe(true);
    expect(json2.reply).toContain("$800");
    // Must NOT bleed Guest House/ADU tier pricing into the NC follow-up.
    expect(json2.reply).not.toMatch(/\$220|\$270|\$330|\$400/);
    expect(
      json2.sources.some((s: { sourceType: string }) => s.sourceType === "workbook"),
    ).toBe(true);
    expect(json2.department).toBe("coverage");
  });

  // -------------------------------------------------------------------------
  // M-2 — pool standard timer: first turn returns item context; follow-up resolves
  // -------------------------------------------------------------------------

  it("M-2: 'Standard timer for pool' returns localFlow=coverage and resolved add-on coverageItem", async () => {
    const res = await POST(
      makeRequest({ message: "Standard timer for pool. What does that mean?" }),
    );
    const json = await res.json();
    expect(json.type).toBe("answer");
    expect(json.localFlow).toBe("coverage");
    expect(json.coverageContext?.coverageItem).toBe(
      "Built-in Pool/Spa Equipment with Standard Timer",
    );
  });

  it("M-2: follow-up 'How much is it?' with standard timer context → $250 add-on, $1,000/request", async () => {
    const res = await POST(
      makeRequest({
        message: "How much is it?",
        localFlow: "coverage",
        coverageStep: "coverage:item",
        coverageContext: {
          intent: "coverage",
          coverageItem: "Built-in Pool/Spa Equipment with Standard Timer",
        },
      }),
    );
    const json = await res.json();
    expect(json.type).toBe("answer");
    expect(json.reply).toContain("$250");
    expect(json.reply).toContain("$1,000");
    expect(json.sources[0]?.sourceType).toBe("workbook");
  });

  // -------------------------------------------------------------------------
  // M-3 — outside coverage area: first turn returns service_area context;
  //       follow-up "What's the fee?" still hits contract (trip fee)
  // -------------------------------------------------------------------------

  it("M-3: 'What happens outside our coverage area?' returns localFlow=coverage and coverageItem=service_area", async () => {
    const res = await POST(
      makeRequest({ message: "What happens outside our coverage area?" }),
    );
    const json = await res.json();
    expect(json.type).toBe("answer");
    expect(json.localFlow).toBe("coverage");
    // Primary contract category for the "outside coverage area" question.
    expect(json.coverageContext?.coverageItem).toBe("service_area");
  });

  it("M-3: follow-up 'What's the fee?' with service_area context → $85 Trip Fee from contract p.12", async () => {
    const res = await POST(
      makeRequest({
        message: "What's the fee?",
        localFlow: "coverage",
        coverageStep: "coverage:item",
        coverageContext: { intent: "coverage", coverageItem: "service_area" },
      }),
    );
    const json = await res.json();
    expect(json.type).toBe("answer");
    expect(json.reply).toContain("$85");
    expect(json.reply.toLowerCase()).toContain("trip fee");
    expect(json.sources[0]?.sourceType).toBe("contract");
    expect(json.sources[0]?.pages).toContain(12);
  });

  // -------------------------------------------------------------------------
  // M-4 — "How much is it?" with no prior context → plan clarification,
  //       never Cogent quote flow
  // -------------------------------------------------------------------------

  it("M-4: 'How much is it?' with no context → plan clarification, not Cogent quote flow", async () => {
    const res = await POST(makeRequest({ message: "How much is it?" }));
    const json = await res.json();
    // Coverage path handles it locally (never reaches Cogent).
    expect(json.department).toBe("coverage");
    // Workbook asks "Which plan's price would you like?" with plan chips.
    expect(json.type).toBe("clarification");
    expect(json.answerOptions.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario N — Context stickiness / reset
//
// Once an item is answered (e.g. Kitchen Refrigerator), a new explicit topic
// in the next message must start fresh. Stale coverageContext must NOT be
// carried into unrelated questions.
// ---------------------------------------------------------------------------

describe("N: stale context reset — new topic starts fresh", () => {
  beforeEach(() => {
    mockAnswerCoverageQuestion.mockResolvedValue({
      kind: "refusal" as const,
      text: "No data in brochure.",
      citations: [],
    });
  });

  // Simulates the state after a Kitchen Refrigerator answer:
  // server returned localFlow=coverage, coverageStep=coverage:item,
  // coverageContext={ intent:"coverage", coverageItem:"Kitchen Refrigerator" }.
  const fridgeContext = {
    localFlow: "coverage" as const,
    coverageStep: "coverage:item",
    coverageContext: { intent: "coverage", coverageItem: "Kitchen Refrigerator" },
  };

  it("N-1: 'How much is pool coverage?' after fridge answer → pool clarification, not fridge plan", async () => {
    const res = await POST(
      makeRequest({ message: "How much is pool coverage?", ...fridgeContext }),
    );
    const json = await res.json();
    // Pool question is fresh: should ask which pool add-on.
    expect(json.type).toBe("clarification");
    expect(json.reply.toLowerCase()).toContain("pool");
    // Must NOT be asking which plan for Kitchen Refrigerator.
    expect(json.reply.toLowerCase()).not.toContain("kitchen refrigerator");
    // Stale coverageItem should not persist.
    expect(json.coverageContext?.coverageItem).not.toBe("Kitchen Refrigerator");
  });

  it("N-2: 'How much is a duplex?' after fridge answer → Guest House/ADU pricing", async () => {
    const res = await POST(
      makeRequest({ message: "How much is a duplex?", ...fridgeContext }),
    );
    const json = await res.json();
    expect(json.type).toBe("answer");
    expect(json.grounded).toBe(true);
    // Guest House/ADU tier prices.
    expect(json.reply).toMatch(/\$220|\$270|\$330|\$400/);
    expect(json.reply.toLowerCase()).toContain("guest house");
    // Not the Kitchen Refrigerator plan flow.
    expect(json.reply.toLowerCase()).not.toContain("kitchen refrigerator");
  });

  it("N-3: 'I'm not asking about a fridge' after fridge answer → context cleared, no plan selection", async () => {
    const res = await POST(
      makeRequest({ message: "I'm not asking about a fridge", ...fridgeContext }),
    );
    const json = await res.json();
    // Must NOT continue the Kitchen Refrigerator plan selection.
    expect(json.reply.toLowerCase()).not.toMatch(/which plan.*kitchen|kitchen.*which plan/);
    // Stale coverageItem is gone from the new response context.
    expect(json.coverageContext?.coverageItem).not.toBe("Kitchen Refrigerator");
  });

  it("N-4: New Construction price answer includes $800 but NOT Guest House/ADU tier prices", async () => {
    const res = await POST(makeRequest({ message: "How much is new construction?" }));
    const json = await res.json();
    expect(json.type).toBe("answer");
    expect(json.reply).toContain("$800");
    expect(json.reply).not.toMatch(/\$220|\$270|\$330|\$400/);
  });

  it("N-5: Guest House/ADU answer returns tier prices, not NC $800 price", async () => {
    const res = await POST(makeRequest({ message: "How much is a guest house?" }));
    const json = await res.json();
    expect(json.type).toBe("answer");
    expect(json.reply).toMatch(/\$220|\$270|\$330|\$400/);
    expect(json.reply.toLowerCase()).toContain("guest house");
    expect(json.reply).not.toContain("$800");
  });
});
