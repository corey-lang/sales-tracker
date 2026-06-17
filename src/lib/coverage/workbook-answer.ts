/**
 * Workbook-backed answers for Ask Smitty — Utah MVP fallback.
 *
 * Called when the production plan_brochures table has no current-status row
 * for Utah. Provides grounded answers for the core MVP questions using
 * hardcoded brochure facts verified during the admin review workbook process.
 *
 * Architecture:
 *   - Pure (no I/O). All facts hardcoded from utah-workbook-facts.ts.
 *   - Returns null for any question the workbook data can't answer; the
 *     caller must then fall back to the original DB refusal.
 *   - Never fabricates coverage or pricing. Every answer cites a real page.
 *
 * SECURITY: no DB access, no Anthropic calls, no general home warranty
 * knowledge. Only facts confirmed by the admin review workbook.
 */

import {
  buildCitation,
  clarifyAnswer,
  planCoverageTurn,
  type CoverageAnswer,
  type CoverageNarrowingContext,
} from "./answer-logic";
import {
  UTAH_WORKBOOK_TITLE,
  UTAH_WORKBOOK_VERSION,
  UTAH_WORKBOOK_SOURCE_TYPE,
  WORKBOOK_ADDON_ITEMS,
  WORKBOOK_ADDONS,
  WORKBOOK_COVERAGE,
  WORKBOOK_COVERAGE_ITEM_ADDON,
  WORKBOOK_COVERAGE_ITEMS,
  WORKBOOK_PLANS,
  WORKBOOK_PRICING,
  WORKBOOK_SYNONYMS,
  WORKBOOK_VOCAB_ITEMS,
  type WorkbookAddonItem,
  type WorkbookCoverageItem,
  type WorkbookPlan,
} from "./utah-workbook-facts";

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isWorkbookPlan(s: string): s is WorkbookPlan {
  return (WORKBOOK_PLANS as readonly string[]).includes(s);
}

function isWorkbookCoverageItem(s: string): s is WorkbookCoverageItem {
  return (WORKBOOK_COVERAGE_ITEMS as readonly string[]).includes(s);
}

function isWorkbookAddonItem(s: string): s is WorkbookAddonItem {
  return (WORKBOOK_ADDON_ITEMS as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------------
// Answer builders — one per action type
// ---------------------------------------------------------------------------

function addonAnswer(item: WorkbookAddonItem): CoverageAnswer {
  const data = WORKBOOK_ADDONS[item];
  const citation = buildCitation(UTAH_WORKBOOK_TITLE, UTAH_WORKBOOK_VERSION, [data.page]);
  let text = `${item} is available as an optional add-on for ${data.addonPriceText}`;
  if (data.limitText) text += ` with coverage up to ${data.limitText}`;
  text += ".";
  return {
    kind: "grounded",
    text,
    citations: [citation],
    confidence: "high",
    sourceType: UTAH_WORKBOOK_SOURCE_TYPE,
  };
}

function coverageItemAnswer(item: WorkbookCoverageItem, plan: WorkbookPlan): CoverageAnswer {
  const data = WORKBOOK_COVERAGE[item][plan];
  const addonInfo = WORKBOOK_COVERAGE_ITEM_ADDON[item];

  if (data.included) {
    const limit = data.limitText ? ` Limit: ${data.limitText}.` : "";
    const citation = buildCitation(UTAH_WORKBOOK_TITLE, UTAH_WORKBOOK_VERSION, [data.page]);
    return {
      kind: "grounded",
      text: `Yes — the ${plan} plan covers ${item}.${limit}`,
      citations: [citation],
      confidence: "high",
      sourceType: UTAH_WORKBOOK_SOURCE_TYPE,
    };
  }

  // Not covered — mention add-on if available.
  let text = `No — the ${plan} plan does not cover ${item}.`;
  const pages: number[] = [data.page];
  if (addonInfo) {
    text += ` It is available as an optional add-on for ${addonInfo.addonPriceText}.`;
    if (!pages.includes(addonInfo.page)) pages.push(addonInfo.page);
  }
  return {
    kind: "grounded",
    text,
    citations: [buildCitation(UTAH_WORKBOOK_TITLE, UTAH_WORKBOOK_VERSION, pages)],
    confidence: "high",
    sourceType: UTAH_WORKBOOK_SOURCE_TYPE,
  };
}

function pricingAnswer(plan: WorkbookPlan): CoverageAnswer {
  const data = WORKBOOK_PRICING[plan];
  const citation = buildCitation(UTAH_WORKBOOK_TITLE, UTAH_WORKBOOK_VERSION, [data.page]);
  // Scope note is required: prices are Utah Real Estate base plan rates for
  // homes under 4,000 sq ft. Homes under 1,499 sq ft deduct $50. These
  // constraints come from the Utah Brochure 2025.5, p. 7.
  const scope =
    "Utah Real Estate base plan, homes under 4,000 sq ft. Deduct $50 for homes under 1,499 sq ft.";
  return {
    kind: "grounded",
    text: `${plan}: ${data.priceText} — ${scope}`,
    citations: [citation],
    confidence: "high",
    sourceType: UTAH_WORKBOOK_SOURCE_TYPE,
  };
}

function planListAnswer(): CoverageAnswer {
  const pages = [...new Set(Object.values(WORKBOOK_PRICING).map((p) => p.page))].sort(
    (a, b) => a - b,
  );
  const citation = buildCitation(UTAH_WORKBOOK_TITLE, UTAH_WORKBOOK_VERSION, pages);
  const lines = (WORKBOOK_PLANS as readonly string[]).map((p) => `• ${p}`);
  return {
    kind: "grounded",
    text: `Here are the plans in the current brochure:\n${lines.join("\n")}`,
    citations: [citation],
    confidence: "high",
    sourceType: UTAH_WORKBOOK_SOURCE_TYPE,
  };
}

function addonsAnswer(): CoverageAnswer {
  const pages = [...new Set(Object.values(WORKBOOK_ADDONS).map((a) => a.page))].sort(
    (a, b) => a - b,
  );
  const citation = buildCitation(UTAH_WORKBOOK_TITLE, UTAH_WORKBOOK_VERSION, pages);
  const lines: string[] = (WORKBOOK_ADDON_ITEMS as readonly string[]).map((name) => {
    const data = WORKBOOK_ADDONS[name as WorkbookAddonItem];
    const limit = data.limitText ? ` (up to ${data.limitText})` : "";
    return `• ${name} — ${data.addonPriceText}${limit}`;
  });
  // Sprinkler System & Timers is also available as add-on on non-Epic plans.
  const sprinklerAddon = WORKBOOK_COVERAGE_ITEM_ADDON["Sprinkler System & Timers"];
  if (sprinklerAddon) {
    lines.push(
      `• Sprinkler System & Timers (Essential/Elevated/Totally Elevated) — ${sprinklerAddon.addonPriceText}`,
    );
  }
  return {
    kind: "grounded",
    text: `Optional add-ons in the current brochure:\n${lines.join("\n")}`,
    citations: [citation],
    confidence: "high",
    sourceType: UTAH_WORKBOOK_SOURCE_TYPE,
  };
}

function plansIncludingAnswer(item: string): CoverageAnswer | null {
  if (!isWorkbookCoverageItem(item)) return null;
  const coverageData = WORKBOOK_COVERAGE[item];
  const planNames = (WORKBOOK_PLANS as readonly string[]).filter(
    (p) => coverageData[p as WorkbookPlan]?.included,
  );
  const pages = [
    ...new Set(Object.values(coverageData).map((d) => d.page)),
  ].sort((a, b) => a - b);
  const citation = buildCitation(UTAH_WORKBOOK_TITLE, UTAH_WORKBOOK_VERSION, pages);
  if (planNames.length === 0) {
    return {
      kind: "grounded",
      text: `${item} is not included in any standard plan. Check add-on options.`,
      citations: [citation],
      confidence: "high",
      sourceType: UTAH_WORKBOOK_SOURCE_TYPE,
    };
  }
  const list = planNames.map((p) => `• ${p}`).join("\n");
  return {
    kind: "grounded",
    text: `These plans include ${item}:\n${list}`,
    citations: [citation],
    confidence: "high",
    sourceType: UTAH_WORKBOOK_SOURCE_TYPE,
  };
}

// ---------------------------------------------------------------------------
// Vocabulary used by planCoverageTurn for workbook entity detection.
// ---------------------------------------------------------------------------

const WORKBOOK_VOCAB = {
  plans: [...WORKBOOK_PLANS] as string[],
  items: WORKBOOK_VOCAB_ITEMS,
  addons: [...WORKBOOK_ADDON_ITEMS] as string[],
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Tries to answer a coverage/pricing question from hardcoded Utah workbook
 * facts. Returns null when the workbook doesn't cover the question — the
 * caller must then surface the original DB refusal.
 *
 * Pure: no I/O. No DB access, no API calls. All facts from utah-workbook-facts.ts.
 *
 * Only handles UT state (returns null for any other state code).
 */
export function answerFromWorkbook(
  message: string,
  stateCode: string,
  context?: CoverageNarrowingContext,
  step?: string,
): CoverageAnswer | null {
  if (stateCode.trim().toUpperCase() !== "UT") return null;

  const turn = planCoverageTurn({
    message,
    vocab: WORKBOOK_VOCAB,
    synonyms: WORKBOOK_SYNONYMS,
    context,
    step,
  });

  switch (turn.action) {
    case "list_plans":
      return planListAnswer();

    case "addons":
      return addonsAnswer();

    case "pricing": {
      if (!isWorkbookPlan(turn.plan)) return null;
      return pricingAnswer(turn.plan);
    }

    case "coverage_item": {
      if (isWorkbookCoverageItem(turn.item) && isWorkbookPlan(turn.plan)) {
        return coverageItemAnswer(turn.item, turn.plan);
      }
      // Add-on items are plan-independent; return add-on info regardless of plan.
      if (isWorkbookAddonItem(turn.item)) {
        return addonAnswer(turn.item);
      }
      return null;
    }

    case "plans_including":
      return plansIncludingAnswer(turn.item);

    case "clarify": {
      switch (turn.step) {
        case "coverage:item":
          // No known item detected — workbook only handles specific items.
          return null;

        case "coverage:plan": {
          if (!turn.context.coverageItem) return null;
          const item = turn.context.coverageItem;
          // Add-on items are plan-independent: skip plan selection and answer directly.
          if (isWorkbookAddonItem(item)) {
            return addonAnswer(item);
          }
          // Known coverage item awaiting plan selection — ask for the plan.
          if (isWorkbookCoverageItem(item)) {
            return clarifyAnswer(turn.step, turn.prompt, turn.options, turn.context);
          }
          return null;
        }

        case "pricing:plan":
          // Workbook has pricing for all plans — offer plan chips.
          return clarifyAnswer(turn.step, turn.prompt, turn.options, turn.context);

        default:
          return null;
      }
    }

    case "compare":
      // Comparison not supported in workbook fallback.
      return null;

    default:
      return null;
  }
}
