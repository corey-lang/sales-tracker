/**
 * Utah MVP workbook/brochure facts — Ask Smitty Phase 1.
 *
 * Hardcoded from Utah Brochure 2025.5. Used as a fallback when the production
 * plan_brochures table has no current-status row for UT (i.e., the brochure
 * hasn't been fully published yet). Answers the core MVP questions the Test AE
 * needs during the Utah beta.
 *
 * SOURCE: Utah Brochure 2025.5
 *   p. 7  — plan pricing and coverage items by plan
 *   p. 9  — add-on catalog
 *
 * TODO(workbook-facts-db): remove this fallback file once the Utah brochure is
 * published and the authoritative_plan_* DB views return data for UT. Until
 * then this file IS the source of truth for Utah MVP coverage answers.
 */

/** Brochure title for citations. */
export const UTAH_WORKBOOK_TITLE = "Utah Brochure 2025.5";
/** Version string for citations. */
export const UTAH_WORKBOOK_VERSION = "2025.5";
/** Source type tag used in SmittySource. */
export const UTAH_WORKBOOK_SOURCE_TYPE = "workbook" as const;

/** All 4 Utah plans in brochure order. */
export const WORKBOOK_PLANS = [
  "Essential",
  "Elevated",
  "Totally Elevated",
  "Epic",
] as const;
export type WorkbookPlan = (typeof WORKBOOK_PLANS)[number];

/** Coverage items for which we have per-plan data (p. 7). */
export const WORKBOOK_COVERAGE_ITEMS = [
  "Kitchen Refrigerator",
  "Sprinkler System & Timers",
] as const;
export type WorkbookCoverageItem = (typeof WORKBOOK_COVERAGE_ITEMS)[number];

/** Add-on items from the add-on catalog (p. 9).
 *  "Sprinkler System & Timers" is listed separately in WORKBOOK_COVERAGE_ITEM_ADDON
 *  because it is also a per-plan coverage item on Epic. */
export const WORKBOOK_ADDON_ITEMS = [
  "Built-in Pool/Spa Equipment with Standard Timer",
  "Built-in Pool/Spa Equipment with Automation Controller",
  "Additional Pool Pump",
  "Additional Kitchen Refrigerator",
  "Additional Refrigerator / Freezer",
] as const;
export type WorkbookAddonItem = (typeof WORKBOOK_ADDON_ITEMS)[number];

/** All items the workbook vocab can detect in a message. */
export const WORKBOOK_VOCAB_ITEMS: string[] = [
  ...WORKBOOK_COVERAGE_ITEMS,
  ...WORKBOOK_ADDON_ITEMS,
];

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export type WorkbookCoverageData = {
  included: boolean;
  limitText: string | null;
  page: number;
};

export type WorkbookAddonData = {
  addonPriceText: string;
  limitText: string | null;
  page: number;
};

export type WorkbookPricingData = {
  priceText: string;
  page: number;
};

// ---------------------------------------------------------------------------
// Per-plan per-item coverage. Source: Utah Brochure 2025.5, p. 7.
// ---------------------------------------------------------------------------

export const WORKBOOK_COVERAGE: Record<
  WorkbookCoverageItem,
  Record<WorkbookPlan, WorkbookCoverageData>
> = {
  "Kitchen Refrigerator": {
    Essential: { included: false, limitText: null, page: 7 },
    Elevated: { included: true, limitText: "$2,000/request", page: 7 },
    "Totally Elevated": { included: true, limitText: "$4,000/request", page: 7 },
    Epic: { included: true, limitText: "$7,500/request", page: 7 },
  },
  "Sprinkler System & Timers": {
    Essential: { included: false, limitText: null, page: 7 },
    Elevated: { included: false, limitText: null, page: 7 },
    "Totally Elevated": { included: false, limitText: null, page: 7 },
    Epic: { included: true, limitText: "$500/request", page: 7 },
  },
};

// ---------------------------------------------------------------------------
// Plan pricing. Source: Utah Brochure 2025.5, p. 7.
// Prices are for Utah Real Estate homes under 4,000 sq ft.
// ---------------------------------------------------------------------------

export const WORKBOOK_PRICING: Record<WorkbookPlan, WorkbookPricingData> = {
  Essential: { priceText: "$500/year", page: 7 },
  Elevated: { priceText: "$600/year", page: 7 },
  "Totally Elevated": { priceText: "$750/year", page: 7 },
  Epic: { priceText: "$950/year", page: 7 },
};

// ---------------------------------------------------------------------------
// Add-on catalog. Source: Utah Brochure 2025.5, p. 9.
// ---------------------------------------------------------------------------

export const WORKBOOK_ADDONS: Record<WorkbookAddonItem, WorkbookAddonData> = {
  "Built-in Pool/Spa Equipment with Standard Timer": {
    addonPriceText: "$250",
    limitText: "$1,000/request",
    page: 9,
  },
  "Built-in Pool/Spa Equipment with Automation Controller": {
    addonPriceText: "$400",
    limitText: "$2,000/request",
    page: 9,
  },
  "Additional Pool Pump": {
    addonPriceText: "$100",
    limitText: null,
    page: 9,
  },
  "Additional Kitchen Refrigerator": {
    addonPriceText: "$70",
    limitText: "$2,000/request",
    page: 9,
  },
  "Additional Refrigerator / Freezer": {
    addonPriceText: "$50",
    limitText: "$1,000/request",
    page: 9,
  },
};

/**
 * Coverage items that are also available as optional add-ons on plans where
 * they are not included as standard. Source: Utah Brochure 2025.5, p. 9.
 */
export const WORKBOOK_COVERAGE_ITEM_ADDON: Partial<
  Record<WorkbookCoverageItem, { addonPriceText: string; page: number }>
> = {
  "Sprinkler System & Timers": { addonPriceText: "$80", page: 9 },
};

// ---------------------------------------------------------------------------
// Synonyms for workbook entity detection.
// Enables "sprinklers" → "Sprinkler System & Timers", "te" → "Totally Elevated".
// ---------------------------------------------------------------------------

export const WORKBOOK_SYNONYMS: Array<{
  canonicalType: "coverage_item" | "plan" | "addon";
  synonym: string;
  canonicalValue: string;
}> = [
  {
    canonicalType: "coverage_item",
    synonym: "sprinklers",
    canonicalValue: "Sprinkler System & Timers",
  },
  {
    canonicalType: "coverage_item",
    synonym: "sprinkler",
    canonicalValue: "Sprinkler System & Timers",
  },
  {
    canonicalType: "coverage_item",
    synonym: "sprinkler system",
    canonicalValue: "Sprinkler System & Timers",
  },
  {
    canonicalType: "plan",
    synonym: "te",
    canonicalValue: "Totally Elevated",
  },
  // "Totally Elevated" as an explicit synonym ensures it is added to the
  // detectMentions Set BEFORE "Elevated" from the direct-vocabulary pass.
  // Without this, "elevated" word-boundary-matches inside "totally elevated",
  // causing "Elevated" to be returned as detectedPlans[0] instead of the longer
  // and correct "Totally Elevated".
  {
    canonicalType: "plan",
    synonym: "totally elevated",
    canonicalValue: "Totally Elevated",
  },
];
