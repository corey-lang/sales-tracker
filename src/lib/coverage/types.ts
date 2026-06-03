/**
 * Coverage Intelligence — data contracts for the brochure-backed knowledge base.
 *
 * These types mirror the four tables in supabase/coverage_intelligence.sql and
 * define the SERVICE CONTRACT the AI Assistant reads through. They are the
 * source of truth for "Coverage & Pricing Expert" answers: every result is
 * tied to the exact brochure VERSION it came from, so answers are reproducible
 * and citable ("Source: Utah Brochure 2025.7").
 *
 * DESIGN NOTES
 *   - Server-only. The underlying tables are RLS-locked (no anon access); this
 *     module is consumed by service-role code (the AI proxy + admin routes).
 *   - AUTHORITATIVE-ONLY: every fact carries the raw brochure wording
 *     (`*_text` / `sourceText`) alongside any structured value. Pricing is only
 *     ever present when the brochure stated it — the service never infers it.
 *   - PRIMARY SOURCE: Coverage Intelligence is the primary answer source for
 *     coverage lookups, plan comparisons, limits, add-ons, and brochure-backed
 *     pricing. The external agent is the FALLBACK (used only on `no_data`).
 *   - REVIEW GATE: only `reviewStatus === "approved"` rows on a `status:
 *     "current"` brochure are served as authoritative. Confidence + provenance
 *     (sourcePage) ride along for the admin review workflow.
 *   - Implementations of `CoverageService` land in Phase 5 (src/lib/coverage/
 *     service.ts). This file is the agreed interface to build against.
 */

/** Two-letter USPS state code, stored/queried UPPER (e.g. "UT", "AZ"). */
export type StateCode = string;

export type BrochureStatus =
  | "imported"
  | "current"
  | "superseded"
  | "archived"
  | "failed";

/** How a fact row was produced. */
export type ExtractionMethod = "manual" | "ai" | "ai_assisted";

/** Review lifecycle for an extracted fact. Only "approved" is served. */
export type ReviewStatus = "pending" | "approved" | "rejected" | "needs_changes";

/** Billing cadence a structured price applies to. */
export type PriceCadence =
  | "one_time"
  | "monthly"
  | "quarterly"
  | "semi_annual"
  | "annual"
  | "per_term"
  | "per_service_request"
  | "other";

/** Provenance + review fields shared by every extracted fact row. */
export type ExtractionMeta = {
  sourcePage: number | null;
  extractionMethod: ExtractionMethod | null;
  extractionConfidence: number | null; // 0..1
  reviewStatus: ReviewStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
};

/** Maps a typed term to a canonical brochure term (row of `coverage_synonyms`). */
export type CoverageSynonym = {
  id: string;
  stateCode: StateCode | null; // null = global
  canonicalType: "coverage_item" | "plan" | "addon";
  synonym: string;
  canonicalValue: string;
  notes: string | null;
};

/** A registered brochure version (row of `plan_brochures`). */
export type Brochure = {
  id: string;
  stateCode: StateCode;
  brochureTitle: string;
  brochureVersion: string | null;
  effectiveDate: string | null; // YYYY-MM-DD
  sourceUrl: string | null;
  fileHash: string | null;
  importedAt: string;
  status: BrochureStatus;
  notes: string | null;
};

/**
 * Lightweight provenance stamped onto every service result so the assistant can
 * cite its source. Derived from the brochure the facts came from.
 */
export type BrochureRef = {
  brochureId: string;
  stateCode: StateCode;
  brochureTitle: string;
  brochureVersion: string | null;
  effectiveDate: string | null;
  status: BrochureStatus;
  /** Human citation line, e.g. "Utah Brochure 2025.7". */
  citation: string;
};

/** A coverage fact for one plan + item (row of `plan_coverage_items`). */
export type CoverageItem = ExtractionMeta & {
  id: string;
  brochureId: string;
  stateCode: StateCode;
  planName: string;
  coverageItem: string;
  /** true = included, false = explicitly not, null = brochure unclear. */
  included: boolean | null;
  coverageLimit: number | null;
  coverageLimitText: string | null;
  sourceText: string | null;
  notes: string | null;
};

/** A plan price (row of `plan_pricing`); only present when the brochure states it. */
export type PlanPricing = ExtractionMeta & {
  id: string;
  brochureId: string;
  stateCode: StateCode;
  planName: string;
  priceAmount: number | null;
  priceCadence: PriceCadence | null;
  currencyCode: string; // ISO 4217, defaults "USD"
  priceText: string | null;
  sourceText: string | null;
  notes: string | null;
};

/** An add-on catalog entry (row of `plan_addons`). */
export type PlanAddon = ExtractionMeta & {
  id: string;
  brochureId: string;
  stateCode: StateCode;
  addonName: string;
  planName: string | null;
  includedInPlan: boolean | null;
  availableAsAddon: boolean | null;
  addonPriceAmount: number | null;
  addonPriceCadence: PriceCadence | null;
  currencyCode: string; // ISO 4217, defaults "USD"
  addonPriceText: string | null;
  coverageLimit: number | null;
  coverageLimitText: string | null;
  sourceText: string | null;
  notes: string | null;
};

/**
 * Outcome of a coverage lookup. `kind` lets the AI layer branch:
 *   - "answer"      → authoritative; answer directly + cite.
 *   - "not_covered" → authoritative negative; answer directly + cite.
 *   - "unspecified" → the plan exists in the brochure but the item isn't
 *                     addressed; state that plainly (don't guess), then the AI
 *                     layer may augment.
 *   - "no_data"     → no current brochure / plan not found → fall back to the
 *                     external agent.
 */
export type CoverageLookupResult =
  | { kind: "answer"; item: CoverageItem; source: BrochureRef }
  | { kind: "not_covered"; item: CoverageItem; source: BrochureRef }
  | { kind: "unspecified"; planName: string; coverageItem: string; source: BrochureRef }
  | { kind: "no_data" };

/** One row of a plan comparison, aligned by coverage item. */
export type PlanComparisonRow = {
  coverageItem: string;
  a: { included: boolean | null; limitText: string | null } | null;
  b: { included: boolean | null; limitText: string | null } | null;
};

export type PlanComparisonResult =
  | {
      kind: "comparison";
      stateCode: StateCode;
      planA: string;
      planB: string;
      rows: PlanComparisonRow[];
      source: BrochureRef;
    }
  | { kind: "no_data" };

export type PlanLimitsResult =
  | { kind: "limits"; planName: string; items: CoverageItem[]; source: BrochureRef }
  | { kind: "no_data" };

export type AddonsResult =
  | { kind: "addons"; addons: PlanAddon[]; source: BrochureRef }
  | { kind: "no_data" };

export type PlanPricingResult =
  | { kind: "pricing"; pricing: PlanPricing; source: BrochureRef }
  | { kind: "no_data" };

/**
 * The Coverage Intelligence read API the AI Assistant calls BEFORE the external
 * agent. Every method resolves against the state's `status='current'` brochure
 * unless a specific brochure is requested, and every successful result carries
 * a `BrochureRef` so the answer can be cited. Implemented in Phase 5.
 *
 * REVIEW-GATE CONTRACT (enforced — do not bypass):
 *   Implementations MUST read ONLY from the authoritative_* views
 *   (`authoritative_plan_coverage_items`, `authoritative_plan_pricing`,
 *   `authoritative_plan_addons`), which the DB defines as
 *   (brochure.status = 'current' AND row.review_status = 'approved'). They must
 *   NEVER read the base fact tables (plan_coverage_items / plan_pricing /
 *   plan_addons) for answering — those include pending/rejected and historical
 *   rows. This keeps AI answers limited to human-approved facts from the
 *   current brochure. The base tables are for the admin review workflow only.
 */
export interface CoverageService {
  /** The current (authoritative) brochure for a state, or null if none. */
  getCurrentBrochure(state: StateCode): Promise<Brochure | null>;

  /** "Does <plan> cover <item> in <state>?" */
  getCoverageItem(
    state: StateCode,
    plan: string,
    coverageItem: string,
  ): Promise<CoverageLookupResult>;

  /** "Which plans include <item> in <state>?" */
  getPlansIncluding(
    state: StateCode,
    coverageItem: string,
  ): Promise<{ kind: "plans"; planNames: string[]; source: BrochureRef } | { kind: "no_data" }>;

  /** Structured comparison of two plans, aligned by coverage item. */
  comparePlans(
    state: StateCode,
    planA: string,
    planB: string,
  ): Promise<PlanComparisonResult>;

  /** All coverage items + limits for a plan. */
  getPlanLimits(state: StateCode, plan: string): Promise<PlanLimitsResult>;

  /** The add-on catalog for a state. */
  getAddons(state: StateCode): Promise<AddonsResult>;

  /** Brochure-backed price for a plan, only when the brochure stated one. */
  getPlanPricing(state: StateCode, plan: string): Promise<PlanPricingResult>;

  /**
   * Resolves a typed term to a canonical brochure term via `coverage_synonyms`
   * (then falls back to normalized matching). Used to turn "sprinklers" into
   * "Sprinkler System & Timers" and "TE" into "Totally Elevated" before lookup.
   * Returns the input unchanged when no synonym matches.
   */
  resolveSynonym(
    state: StateCode,
    type: CoverageSynonym["canonicalType"],
    term: string,
  ): Promise<string>;
}
