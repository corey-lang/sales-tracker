/**
 * Utah MVP contract-backed facts — Ask Smitty Phase 1.
 *
 * These facts are sourced from the Utah Sample Contract 2025.5 and cover the
 * questions the existing brochure views cannot answer: seller coverage rules,
 * buyer coverage rules, new construction, service area, trip fees, and
 * exclusions/legal guardrails. Hard-coded for the MVP; a future migration
 * should move these into a reviewed contract_facts DB table alongside brochure
 * facts so they go through the same extract → review → publish lifecycle.
 * TODO(contract-facts-db): migrate to structured storage before State 2 rollout.
 *
 * SOURCE PRIORITY: Contract beats brochure for coverage/legal rules. Pricing
 * and plan comparisons come from the brochure/workbook.
 */

export type ContractCategory =
  | "seller_coverage"
  | "buyer_coverage"
  | "new_construction"
  | "service_area"
  | "trip_fee"
  | "expedited_service"
  | "exclusions";

export type ContractFact = {
  id: string;
  category: ContractCategory;
  text: string;
  /** Source pages within Utah Sample Contract 2025.5. */
  pages: number[];
};

/** Utah Sample Contract source metadata for building citations. */
export const UTAH_CONTRACT_TITLE = "Utah Sample Contract 2025.5";
export const UTAH_CONTRACT_SOURCE_TYPE = "contract" as const;

export const UTAH_CONTRACT_FACTS: ContractFact[] = [
  // -------------------------------------------------------------------------
  // Seller coverage (Utah Sample Contract 2025.5, p. 12)
  // -------------------------------------------------------------------------
  {
    id: "ut-seller-1",
    category: "seller_coverage",
    text: "Seller's Coverage is available for the listing/escrow period.",
    pages: [12],
  },
  {
    id: "ut-seller-2",
    category: "seller_coverage",
    text: "Effective Date begins the day the listing is received by Company.",
    pages: [12],
  },
  {
    id: "ut-seller-3",
    category: "seller_coverage",
    text: "Seller Coverage continues until close of sale, listing termination, or expiration of the initial listing period up to 6 months, whichever occurs first.",
    pages: [12],
  },
  {
    id: "ut-seller-4",
    category: "seller_coverage",
    text: "Pre-existing conditions are not covered on Seller's Coverage Plans.",
    pages: [12],
  },
  {
    id: "ut-seller-5",
    category: "seller_coverage",
    text: "Seller's Coverage is limited to $2,000 aggregate.",
    pages: [12],
  },
  {
    id: "ut-seller-6",
    category: "seller_coverage",
    text: "Optional Coverage Items (add-ons) are not covered during Seller's Coverage term.",
    pages: [12],
  },

  // -------------------------------------------------------------------------
  // Buyer coverage (Utah Sample Contract 2025.5, p. 12)
  // -------------------------------------------------------------------------
  {
    id: "ut-buyer-1",
    category: "buyer_coverage",
    text: "Buyer's Coverage is purchased in conjunction with a real estate transaction by or on behalf of a home buyer up to 30 days after closing.",
    pages: [12],
  },
  {
    id: "ut-buyer-2",
    category: "buyer_coverage",
    text: "Buyer's Coverage is effective as of the closing date and continues for the time stated on the Declaration of Coverage.",
    pages: [12],
  },
  {
    id: "ut-buyer-3",
    category: "buyer_coverage",
    text: "Plan fee must be received within 30 days after closing.",
    pages: [12],
  },

  // -------------------------------------------------------------------------
  // New construction (Utah Sample Contract 2025.5, p. 12)
  // -------------------------------------------------------------------------
  {
    id: "ut-newco-1",
    category: "new_construction",
    text: "New Construction Plan is buyer coverage only.",
    pages: [12],
  },
  {
    id: "ut-newco-2",
    category: "new_construction",
    text: "Purchased in conjunction with a brand-new home transaction by or on behalf of buyer up to 30 days after closing.",
    pages: [12],
  },
  {
    id: "ut-newco-3",
    category: "new_construction",
    text: "Begins one year from original closing date and continues for three years from that date.",
    pages: [12],
  },
  {
    id: "ut-newco-4",
    category: "new_construction",
    text: "Plan fee must be received within 30 days after closing.",
    pages: [12],
  },

  // -------------------------------------------------------------------------
  // Service area (Utah Sample Contract 2025.5, p. 12)
  // -------------------------------------------------------------------------
  {
    id: "ut-area-1",
    category: "service_area",
    text: "Normal Service Area in Utah includes Salt Lake, Davis, Weber, Utah, and Washington counties.",
    pages: [12],
  },
  {
    id: "ut-area-2",
    category: "service_area",
    text: "Coverage for Home Warranty Coverage Items may be provided in other Utah counties, but an additional trip charge is required for each new service request.",
    pages: [12],
  },
  {
    id: "ut-area-3",
    category: "service_area",
    text: "On-demand Service Items are limited to counties in the normal Service Area.",
    pages: [12],
  },

  // -------------------------------------------------------------------------
  // Trip fee (Utah Sample Contract 2025.5, p. 12)
  // -------------------------------------------------------------------------
  {
    id: "ut-trip-1",
    category: "trip_fee",
    text: "Covered properties outside the normal Service Area are charged an $85 Trip Fee in addition to the Service Fee for each new service request.",
    pages: [12],
  },

  // -------------------------------------------------------------------------
  // Expedited / after-hours service (Utah Sample Contract 2025.5, p. 12)
  // -------------------------------------------------------------------------
  {
    id: "ut-exp-1",
    category: "expedited_service",
    text: "Non-emergency service outside normal business hours, holidays, or weekends requires a $200 Service Fee if an authorized Service Pro is available.",
    pages: [12],
  },

  // -------------------------------------------------------------------------
  // Exclusions / legal guardrail (Utah Sample Contract 2025.5, pp. 13–14)
  // -------------------------------------------------------------------------
  {
    id: "ut-excl-1",
    category: "exclusions",
    text: "For specific exclusions and legal interpretation of coverage, refer to the Utah Sample Contract. Ask Smitty can point to the relevant contract section, but admin should verify coverage interpretation before an AE gives a final answer.",
    pages: [13, 14],
  },
];
