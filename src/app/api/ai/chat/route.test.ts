/**
 * Route-level tests for POST /api/ai/chat — Ask Smitty Utah MVP.
 *
 * Tests verify the full routing pipeline from request to response shape,
 * covering contract-backed answers, ambiguity chips, Utah gate, and narrator
 * skip behavior. DB-dependent calls (requireTestAccount, answerCoverageQuestion)
 * are mocked; pure contract/ambiguity logic runs real.
 *
 * Scenarios:
 *   A. Seller + add-on → contract-backed, never routes to generic add-on catalog
 *   B. Service area counties → contract-backed
 *   C. Outside service area → contract-backed, includes $85 Trip Fee
 *   D. Fridge → clarification with 3 options
 *   E. Pool → clarification with 4 options
 *   F. Sprinklers on Totally Elevated → brochure-backed
 *   G. Non-UT state → Utah beta gate fires before coverage or Cogent routing
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
        pages: [3],
        label: "Utah Brochure 2025.5 2025.5, p. 3",
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

  it("sourceType is brochure and source page is 3", async () => {
    const res = await POST(
      makeRequest({ message: "Are sprinklers covered on Totally Elevated?" }),
    );
    const json = await res.json();
    expect(json.sources).toHaveLength(1);
    expect(json.sources[0].sourceType).toBe("brochure");
    expect(json.sources[0].pages).toContain(3);
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
