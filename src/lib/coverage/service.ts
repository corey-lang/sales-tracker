/**
 * Coverage Intelligence — read service (Phase 5 / Ask Smitty Phase 1).
 *
 * Server-only implementation of the CoverageService contract from ./types. It
 * is the PRIMARY answer source for Ask Smitty's coverage/pricing/plan questions.
 *
 * AUTHORITATIVE-ONLY (enforced):
 *   Every read goes through the authoritative_* views, which the DB defines as
 *   (brochure.status = 'current' AND row.review_status = 'approved'). The base
 *   fact tables are NEVER read here — so pending/rejected/historical rows can't
 *   leak into an answer. Combined with state_code filtering, an answer can only
 *   ever come from the current, approved brochure for the requested state, and
 *   never from another state's documents.
 *
 * NO INFERENCE:
 *   Methods return exactly what the brochure stated. A missing fact is `no_data`
 *   / `unspecified`, never a guess. The pure rendering + decision logic lives in
 *   ./answer-logic (and is unit-tested without a DB).
 *
 * Never import this from a "use client" component (it uses the service role).
 */

import { getServerSupabase } from "@/lib/supabase/server";
import {
  type AddonsResult,
  type Brochure,
  type BrochureRef,
  type CoverageItem,
  type CoverageLookupResult,
  type CoverageService,
  type CoverageSynonym,
  type PlanAddon,
  type PlanComparisonResult,
  type PlanComparisonRow,
  type PlanLimitsResult,
  type PlanPricing,
  type PlanPricingResult,
  type StateCode,
} from "./types";
import {
  type CoverageAnswer,
  type CoverageNarrowingContext,
  buildCitation,
  clarifyAnswer,
  formatBrochureCitation,
  noStateRefusal,
  planCoverageTurn,
  refusal,
  renderAddons,
  renderCoverageItem,
  renderComparison,
  renderPlanList,
  renderPlanPricing,
  renderPlansIncluding,
  type SynonymEntry,
  uniquePages,
} from "./answer-logic";

// ---------------------------------------------------------------------------
// Row shapes (the authoritative_* views select the base columns + brochure
// title/version/effective_date). Only the fields we read are typed.
// ---------------------------------------------------------------------------

type BrochureCols = {
  brochure_id: string;
  state_code: string;
  brochure_title: string;
  brochure_version: string | null;
  effective_date: string | null;
};

type CoverageRow = BrochureCols & {
  id: string;
  plan_name: string;
  coverage_item: string;
  included: boolean | null;
  coverage_limit: number | null;
  coverage_limit_text: string | null;
  source_text: string | null;
  source_page: number | null;
  extraction_method: CoverageItem["extractionMethod"];
  extraction_confidence: number | null;
  review_status: CoverageItem["reviewStatus"];
  reviewed_by: string | null;
  reviewed_at: string | null;
};

type PricingRow = BrochureCols & {
  id: string;
  plan_name: string;
  price_amount: number | null;
  price_cadence: PlanPricing["priceCadence"];
  currency_code: string;
  price_text: string | null;
  source_text: string | null;
  source_page: number | null;
  extraction_method: PlanPricing["extractionMethod"];
  extraction_confidence: number | null;
  review_status: PlanPricing["reviewStatus"];
  reviewed_by: string | null;
  reviewed_at: string | null;
};

type AddonRow = BrochureCols & {
  id: string;
  addon_name: string;
  plan_name: string | null;
  included_in_plan: boolean | null;
  available_as_addon: boolean | null;
  addon_price_amount: number | null;
  addon_price_cadence: PlanAddon["addonPriceCadence"];
  currency_code: string;
  addon_price_text: string | null;
  coverage_limit: number | null;
  coverage_limit_text: string | null;
  source_text: string | null;
  source_page: number | null;
  extraction_method: PlanAddon["extractionMethod"];
  extraction_confidence: number | null;
  review_status: PlanAddon["reviewStatus"];
  reviewed_by: string | null;
  reviewed_at: string | null;
};

/** Normalizes a caller-supplied state code to the stored UPPER 2-letter form. */
function normState(state: StateCode): string {
  return (state ?? "").trim().toUpperCase();
}

/** Builds the citable BrochureRef from any authoritative row. status is always
 *  'current' (the view guarantees it). */
function brochureRefFromRow(row: BrochureCols): BrochureRef {
  return {
    brochureId: row.brochure_id,
    stateCode: row.state_code,
    brochureTitle: row.brochure_title,
    brochureVersion: row.brochure_version,
    effectiveDate: row.effective_date,
    status: "current",
    citation: formatBrochureCitation(row.brochure_title, row.brochure_version),
  };
}

function mapCoverageRow(row: CoverageRow): CoverageItem {
  return {
    id: row.id,
    brochureId: row.brochure_id,
    stateCode: row.state_code,
    planName: row.plan_name,
    coverageItem: row.coverage_item,
    included: row.included,
    coverageLimit: row.coverage_limit,
    coverageLimitText: row.coverage_limit_text,
    sourceText: row.source_text,
    notes: null,
    sourcePage: row.source_page,
    extractionMethod: row.extraction_method,
    extractionConfidence: row.extraction_confidence,
    reviewStatus: row.review_status,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
  };
}

const COVERAGE_COLS =
  "id, brochure_id, state_code, plan_name, coverage_item, included, coverage_limit, coverage_limit_text, source_text, source_page, extraction_method, extraction_confidence, review_status, reviewed_by, reviewed_at, brochure_title, brochure_version, effective_date";
const PRICING_COLS =
  "id, brochure_id, state_code, plan_name, price_amount, price_cadence, currency_code, price_text, source_text, source_page, extraction_method, extraction_confidence, review_status, reviewed_by, reviewed_at, brochure_title, brochure_version, effective_date";
const ADDON_COLS =
  "id, brochure_id, state_code, addon_name, plan_name, included_in_plan, available_as_addon, addon_price_amount, addon_price_cadence, currency_code, addon_price_text, coverage_limit, coverage_limit_text, source_text, source_page, extraction_method, extraction_confidence, review_status, reviewed_by, reviewed_at, brochure_title, brochure_version, effective_date";

// ---------------------------------------------------------------------------
// CoverageService implementation
// ---------------------------------------------------------------------------

class SupabaseCoverageService implements CoverageService {
  async getCurrentBrochure(state: StateCode): Promise<Brochure | null> {
    const supabase = getServerSupabase();
    const res = await supabase
      .from("plan_brochures")
      .select(
        "id, state_code, brochure_title, brochure_version, effective_date, source_url, file_hash, imported_at, status, trusted, notes",
      )
      .eq("state_code", normState(state))
      .eq("status", "current")
      .maybeSingle();
    if (res.error || !res.data) return null;
    const r = res.data as Record<string, unknown>;
    return {
      id: r.id as string,
      stateCode: r.state_code as string,
      brochureTitle: r.brochure_title as string,
      brochureVersion: (r.brochure_version as string | null) ?? null,
      effectiveDate: (r.effective_date as string | null) ?? null,
      sourceUrl: (r.source_url as string | null) ?? null,
      fileHash: (r.file_hash as string | null) ?? null,
      importedAt: r.imported_at as string,
      status: "current",
      trusted: r.trusted === true,
      notes: (r.notes as string | null) ?? null,
    };
  }

  async getCoverageItem(
    state: StateCode,
    plan: string,
    coverageItem: string,
  ): Promise<CoverageLookupResult> {
    const supabase = getServerSupabase();
    const res = await supabase
      .from("authoritative_plan_coverage_items")
      .select(COVERAGE_COLS)
      .eq("state_code", normState(state))
      .eq("plan_name", plan)
      .eq("coverage_item", coverageItem)
      .maybeSingle();
    if (res.error || !res.data) return { kind: "no_data" };
    const row = res.data as CoverageRow;
    const item = mapCoverageRow(row);
    const source = brochureRefFromRow(row);
    if (item.included === true) return { kind: "answer", item, source };
    if (item.included === false) return { kind: "not_covered", item, source };
    return {
      kind: "unspecified",
      planName: plan,
      coverageItem,
      sourcePage: item.sourcePage,
      source,
    };
  }

  async getPlansIncluding(
    state: StateCode,
    coverageItem: string,
  ): Promise<
    | { kind: "plans"; planNames: string[]; pages: number[]; source: BrochureRef }
    | { kind: "no_data" }
  > {
    const supabase = getServerSupabase();
    const res = await supabase
      .from("authoritative_plan_coverage_items")
      .select(COVERAGE_COLS)
      .eq("state_code", normState(state))
      .eq("coverage_item", coverageItem)
      .eq("included", true);
    if (res.error || !res.data || res.data.length === 0) {
      return { kind: "no_data" };
    }
    const rows = res.data as CoverageRow[];
    const planNames = [...new Set(rows.map((r) => r.plan_name))];
    const pages = uniquePages(rows.map((r) => r.source_page));
    return { kind: "plans", planNames, pages, source: brochureRefFromRow(rows[0]) };
  }

  async comparePlans(
    state: StateCode,
    planA: string,
    planB: string,
  ): Promise<PlanComparisonResult> {
    const supabase = getServerSupabase();
    const res = await supabase
      .from("authoritative_plan_coverage_items")
      .select(COVERAGE_COLS)
      .eq("state_code", normState(state))
      .in("plan_name", [planA, planB]);
    if (res.error || !res.data || res.data.length === 0) {
      return { kind: "no_data" };
    }
    const rows = res.data as CoverageRow[];
    // Align by coverage item; preserve first-seen order.
    const order: string[] = [];
    const byItem = new Map<
      string,
      { a: PlanComparisonRow["a"]; b: PlanComparisonRow["b"] }
    >();
    for (const r of rows) {
      if (!byItem.has(r.coverage_item)) {
        byItem.set(r.coverage_item, { a: null, b: null });
        order.push(r.coverage_item);
      }
      const slot = byItem.get(r.coverage_item)!;
      const cell = { included: r.included, limitText: r.coverage_limit_text };
      if (r.plan_name === planA) slot.a = cell;
      else if (r.plan_name === planB) slot.b = cell;
    }
    const comparisonRows: PlanComparisonRow[] = order.map((coverageItem) => ({
      coverageItem,
      a: byItem.get(coverageItem)!.a,
      b: byItem.get(coverageItem)!.b,
    }));
    return {
      kind: "comparison",
      stateCode: normState(state),
      planA,
      planB,
      rows: comparisonRows,
      pages: uniquePages(rows.map((r) => r.source_page)),
      source: brochureRefFromRow(rows[0]),
    };
  }

  async getPlanLimits(
    state: StateCode,
    plan: string,
  ): Promise<PlanLimitsResult> {
    const supabase = getServerSupabase();
    const res = await supabase
      .from("authoritative_plan_coverage_items")
      .select(COVERAGE_COLS)
      .eq("state_code", normState(state))
      .eq("plan_name", plan);
    if (res.error || !res.data || res.data.length === 0) {
      return { kind: "no_data" };
    }
    const rows = res.data as CoverageRow[];
    return {
      kind: "limits",
      planName: plan,
      items: rows.map(mapCoverageRow),
      source: brochureRefFromRow(rows[0]),
    };
  }

  async getAddons(state: StateCode): Promise<AddonsResult> {
    const supabase = getServerSupabase();
    const res = await supabase
      .from("authoritative_plan_addons")
      .select(ADDON_COLS)
      .eq("state_code", normState(state));
    if (res.error || !res.data || res.data.length === 0) {
      return { kind: "no_data" };
    }
    const rows = res.data as AddonRow[];
    const addons: PlanAddon[] = rows.map((r) => ({
      id: r.id,
      brochureId: r.brochure_id,
      stateCode: r.state_code,
      addonName: r.addon_name,
      planName: r.plan_name,
      includedInPlan: r.included_in_plan,
      availableAsAddon: r.available_as_addon,
      addonPriceAmount: r.addon_price_amount,
      addonPriceCadence: r.addon_price_cadence,
      currencyCode: r.currency_code,
      addonPriceText: r.addon_price_text,
      coverageLimit: r.coverage_limit,
      coverageLimitText: r.coverage_limit_text,
      sourceText: r.source_text,
      notes: null,
      sourcePage: r.source_page,
      extractionMethod: r.extraction_method,
      extractionConfidence: r.extraction_confidence,
      reviewStatus: r.review_status,
      reviewedBy: r.reviewed_by,
      reviewedAt: r.reviewed_at,
    }));
    return { kind: "addons", addons, source: brochureRefFromRow(rows[0]) };
  }

  async getPlanPricing(
    state: StateCode,
    plan: string,
  ): Promise<PlanPricingResult> {
    const supabase = getServerSupabase();
    const res = await supabase
      .from("authoritative_plan_pricing")
      .select(PRICING_COLS)
      .eq("state_code", normState(state))
      .eq("plan_name", plan)
      .maybeSingle();
    if (res.error || !res.data) return { kind: "no_data" };
    const r = res.data as PricingRow;
    const pricing: PlanPricing = {
      id: r.id,
      brochureId: r.brochure_id,
      stateCode: r.state_code,
      planName: r.plan_name,
      priceAmount: r.price_amount,
      priceCadence: r.price_cadence,
      currencyCode: r.currency_code,
      priceText: r.price_text,
      sourceText: r.source_text,
      notes: null,
      sourcePage: r.source_page,
      extractionMethod: r.extraction_method,
      extractionConfidence: r.extraction_confidence,
      reviewStatus: r.review_status,
      reviewedBy: r.reviewed_by,
      reviewedAt: r.reviewed_at,
    };
    return { kind: "pricing", pricing, source: brochureRefFromRow(r) };
  }

  async resolveSynonym(
    state: StateCode,
    type: CoverageSynonym["canonicalType"],
    term: string,
  ): Promise<string> {
    const supabase = getServerSupabase();
    const normalized = term.toLowerCase().trim();
    if (!normalized) return term;
    // Prefer a state-specific synonym over a global (NULL state) one.
    const res = await supabase
      .from("coverage_synonyms")
      .select("synonym, canonical_value, state_code")
      .eq("canonical_type", type)
      .eq("synonym", normalized)
      .or(`state_code.eq.${normState(state)},state_code.is.null`);
    if (res.error || !res.data || res.data.length === 0) return term;
    const rows = res.data as { canonical_value: string; state_code: string | null }[];
    const stateRow = rows.find((r) => r.state_code !== null);
    return (stateRow ?? rows[0]).canonical_value;
  }
}

export const coverageService: CoverageService = new SupabaseCoverageService();

// ---------------------------------------------------------------------------
// Orchestrator — the single entry point the chat route calls.
// ---------------------------------------------------------------------------

/** Distinct vocabulary for a state, read from the authoritative views. Drives
 *  entity detection (which plan/item/add-on the AE's message refers to) and
 *  carries the source pages that establish the plans exist (for the plan-list
 *  citation). */
async function loadVocabulary(state: string): Promise<{
  plans: string[];
  items: string[];
  addons: string[];
  planPages: number[];
}> {
  const supabase = getServerSupabase();
  const [cov, pricing, addons] = await Promise.all([
    supabase
      .from("authoritative_plan_coverage_items")
      .select("plan_name, coverage_item, source_page")
      .eq("state_code", state),
    supabase
      .from("authoritative_plan_pricing")
      .select("plan_name, source_page")
      .eq("state_code", state),
    supabase
      .from("authoritative_plan_addons")
      .select("addon_name")
      .eq("state_code", state),
  ]);
  const planSet = new Set<string>();
  const itemSet = new Set<string>();
  const addonSet = new Set<string>();
  const planPageList: (number | null)[] = [];
  for (const r of (cov.data as { plan_name: string; coverage_item: string; source_page: number | null }[] | null) ?? []) {
    planSet.add(r.plan_name);
    itemSet.add(r.coverage_item);
    planPageList.push(r.source_page);
  }
  for (const r of (pricing.data as { plan_name: string; source_page: number | null }[] | null) ?? []) {
    planSet.add(r.plan_name);
    planPageList.push(r.source_page);
  }
  for (const r of (addons.data as { addon_name: string }[] | null) ?? []) {
    addonSet.add(r.addon_name);
  }
  return {
    plans: [...planSet],
    items: [...itemSet],
    addons: [...addonSet],
    planPages: uniquePages(planPageList),
  };
}

/** Synonyms in scope for a state (global rows + state-specific rows). */
async function loadSynonyms(state: string): Promise<SynonymEntry[]> {
  const supabase = getServerSupabase();
  const res = await supabase
    .from("coverage_synonyms")
    .select("canonical_type, synonym, canonical_value, state_code")
    .or(`state_code.eq.${state},state_code.is.null`);
  if (res.error || !res.data) return [];
  return (res.data as {
    canonical_type: SynonymEntry["canonicalType"];
    synonym: string;
    canonical_value: string;
  }[]).map((r) => ({
    canonicalType: r.canonical_type,
    synonym: r.synonym,
    canonicalValue: r.canonical_value,
  }));
}

/**
 * Answers a coverage/pricing/plan question for one AE, grounded ONLY in their
 * state's current, approved brochure. Returns a grounded answer (with
 * citations), a clarify (a narrowing question + chips, no citations), or a
 * refusal. NEVER falls back to generic reasoning and NEVER reads another
 * state's documents.
 *
 * `stateCode` is the AE's assigned state (null when unset → refusal). The chat
 * route decides a turn belongs here (fresh coverage question OR an in-progress
 * LOCAL coverage flow) before calling this.
 *
 * `context`/`step` carry the LOCAL narrowing state the client echoes back each
 * turn (entirely separate from any Cogent thread). When present, a bare chip
 * value like "Epic" is interpreted as the answer to `step`, with prior slots
 * (e.g. coverageItem "HVAC") preserved from `context`.
 */
export async function answerCoverageQuestion(
  stateCode: string | null,
  message: string,
  context?: CoverageNarrowingContext,
  step?: string,
): Promise<CoverageAnswer> {
  if (!stateCode) return noStateRefusal();
  const state = stateCode.trim().toUpperCase();

  // No current brochure for the state → say so plainly (don't guess).
  const brochure = await coverageService.getCurrentBrochure(state);
  if (!brochure) {
    return refusal(
      state,
      "There isn't a current plan brochure on file for your state yet.",
    );
  }
  const [vocab, synonyms] = await Promise.all([
    loadVocabulary(state),
    loadSynonyms(state),
  ]);

  const plan = planCoverageTurn({ message, vocab, synonyms, context, step });

  switch (plan.action) {
    case "clarify": {
      // Loop guard: a narrowing question with no options can't be answered —
      // refuse cleanly rather than emit empty chips that strand the AE.
      if (plan.options.length === 0) return refusal(state);
      return clarifyAnswer(plan.step, plan.prompt, plan.options, plan.context);
    }

    case "list_plans": {
      if (vocab.plans.length === 0) return refusal(state);
      return renderPlanList(
        vocab.plans,
        buildCitation(
          brochure.brochureTitle,
          brochure.brochureVersion,
          vocab.planPages,
        ),
      );
    }

    case "compare": {
      const result = await coverageService.comparePlans(
        state,
        plan.planA,
        plan.planB,
      );
      if (result.kind === "no_data") return refusal(state);
      return renderComparison(
        result.planA,
        result.planB,
        result.rows,
        buildCitation(
          result.source.brochureTitle,
          result.source.brochureVersion,
          result.pages,
        ),
      );
    }

    case "addons": {
      const result = await coverageService.getAddons(state);
      if (result.kind === "no_data") return refusal(state);
      return renderAddons(
        result.addons,
        buildCitation(
          result.source.brochureTitle,
          result.source.brochureVersion,
          result.addons.map((a) => a.sourcePage),
        ),
      );
    }

    case "pricing": {
      const result = await coverageService.getPlanPricing(state, plan.plan);
      if (result.kind === "no_data") return refusal(state);
      return renderPlanPricing(
        result.pricing,
        buildCitation(
          result.source.brochureTitle,
          result.source.brochureVersion,
          result.pricing.sourcePage,
        ),
      );
    }

    case "plans_including": {
      const result = await coverageService.getPlansIncluding(state, plan.item);
      if (result.kind === "no_data") {
        return refusal(
          state,
          `The current brochure doesn't list ${plan.item} as included in any plan.`,
        );
      }
      return renderPlansIncluding(
        plan.item,
        result.planNames,
        buildCitation(
          result.source.brochureTitle,
          result.source.brochureVersion,
          result.pages,
        ),
      );
    }

    case "coverage_item":
    default: {
      const result = await coverageService.getCoverageItem(
        state,
        plan.plan,
        plan.item,
      );
      if (result.kind === "no_data") {
        return refusal(
          state,
          `The current brochure doesn't address ${plan.item} for the ${plan.plan} plan.`,
        );
      }
      if (result.kind === "unspecified") {
        return renderCoverageItem(
          {
            planName: result.planName,
            coverageItem: result.coverageItem,
            included: null,
            coverageLimitText: null,
          },
          buildCitation(
            result.source.brochureTitle,
            result.source.brochureVersion,
            result.sourcePage,
          ),
        );
      }
      return renderCoverageItem(
        result.item,
        buildCitation(
          result.source.brochureTitle,
          result.source.brochureVersion,
          result.item.sourcePage,
        ),
      );
    }
  }
}
