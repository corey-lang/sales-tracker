/**
 * Coverage Intelligence — review store (Phase 2 review workflow).
 *
 * Server-only. Lists PENDING extracted rows for a brochure and applies a review
 * decision (approve / reject, optionally with edits). Edits + approval happen in
 * a single UPDATE on a still-pending row, which the DB allows; an already-
 * approved row's values are frozen by a trigger, so this layer also refuses to
 * edit approved rows (belt-and-braces with a clear error). Provenance
 * (source_text/source_page) is never editable here — approved rows stay
 * brochure-backed and source-cited.
 */

import { getServerSupabase } from "@/lib/supabase/server";
import { ApiError, notFound } from "@/lib/server/auth";

export type ReviewKind = "coverage" | "pricing" | "addons";
export const REVIEW_KINDS: ReviewKind[] = ["coverage", "pricing", "addons"];

/**
 * Counts a brochure's APPROVED facts across all three fact tables. An approved
 * fact becomes authoritative the moment the brochure is `current`, so this is
 * the "is there anything to serve?" signal used to guard promotion.
 *
 * Lives here (not in brochures.ts / quality.ts) so both can import it without a
 * cycle — review.ts depends on neither.
 */
export async function countApprovedFacts(brochureId: string): Promise<number> {
  const supabase = getServerSupabase();
  const tables = ["plan_coverage_items", "plan_pricing", "plan_addons"];
  let total = 0;
  for (const table of tables) {
    const res = await supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("brochure_id", brochureId)
      .eq("review_status", "approved");
    if (res.error) {
      console.warn(
        `[coverage] approved-fact count failed table=${table} brochure=${brochureId} code=${res.error.code ?? "?"}`,
      );
      throw new ApiError(500, "Could not verify approved facts for this brochure.");
    }
    total += res.count ?? 0;
  }
  return total;
}

/**
 * Guard: a brochure may only become `current` when it has at least one approved
 * fact — otherwise it would publish an empty/unreviewed brochure as the
 * authoritative source (the "empty-current" stale-answer bug). Throws 409 when
 * the count is zero. Used by both the manual promote path and approve-publish.
 */
export function assertHasApprovedFacts(approvedCount: number): void {
  if (approvedCount <= 0) {
    throw new ApiError(
      409,
      "This brochure has no approved facts yet, so it can't be made current. Extract and approve at least one fact first.",
    );
  }
}

export function isReviewKind(v: string): v is ReviewKind {
  return v === "coverage" || v === "pricing" || v === "addons";
}

const TABLE: Record<ReviewKind, string> = {
  coverage: "plan_coverage_items",
  pricing: "plan_pricing",
  addons: "plan_addons",
};

const COVERAGE_COLS =
  "id, state_code, plan_name, coverage_item, included, coverage_limit, coverage_limit_text, source_text, source_page, extraction_confidence, extraction_method, review_status";
const PRICING_COLS =
  "id, state_code, plan_name, price_amount, price_cadence, currency_code, price_text, source_text, source_page, extraction_confidence, extraction_method, review_status";
const ADDON_COLS =
  "id, state_code, addon_name, plan_name, included_in_plan, available_as_addon, addon_price_amount, addon_price_cadence, currency_code, addon_price_text, coverage_limit, coverage_limit_text, source_text, source_page, extraction_confidence, extraction_method, review_status";

export type PendingCoverage = {
  id: string;
  stateCode: string;
  planName: string;
  coverageItem: string;
  included: boolean | null;
  coverageLimit: number | null;
  coverageLimitText: string | null;
  sourceText: string | null;
  sourcePage: number | null;
  confidence: number | null;
  extractionMethod: string | null;
};

export type PendingPricing = {
  id: string;
  stateCode: string;
  planName: string;
  priceAmount: number | null;
  priceCadence: string | null;
  currencyCode: string;
  priceText: string | null;
  sourceText: string | null;
  sourcePage: number | null;
  confidence: number | null;
  extractionMethod: string | null;
};

export type PendingAddon = {
  id: string;
  stateCode: string;
  addonName: string;
  planName: string | null;
  includedInPlan: boolean | null;
  availableAsAddon: boolean | null;
  addonPriceAmount: number | null;
  addonPriceCadence: string | null;
  currencyCode: string;
  addonPriceText: string | null;
  coverageLimit: number | null;
  coverageLimitText: string | null;
  sourceText: string | null;
  sourcePage: number | null;
  confidence: number | null;
  extractionMethod: string | null;
};

export type PendingFacts = {
  coverage: PendingCoverage[];
  pricing: PendingPricing[];
  addons: PendingAddon[];
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const mapCoverage = (r: any): PendingCoverage => ({
  id: r.id,
  stateCode: r.state_code,
  planName: r.plan_name,
  coverageItem: r.coverage_item,
  included: r.included,
  coverageLimit: r.coverage_limit,
  coverageLimitText: r.coverage_limit_text,
  sourceText: r.source_text,
  sourcePage: r.source_page,
  confidence: r.extraction_confidence,
  extractionMethod: r.extraction_method,
});
const mapPricing = (r: any): PendingPricing => ({
  id: r.id,
  stateCode: r.state_code,
  planName: r.plan_name,
  priceAmount: r.price_amount,
  priceCadence: r.price_cadence,
  currencyCode: r.currency_code,
  priceText: r.price_text,
  sourceText: r.source_text,
  sourcePage: r.source_page,
  confidence: r.extraction_confidence,
  extractionMethod: r.extraction_method,
});
const mapAddon = (r: any): PendingAddon => ({
  id: r.id,
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
  sourcePage: r.source_page,
  confidence: r.extraction_confidence,
  extractionMethod: r.extraction_method,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Lists all review_status='pending' rows for a brochure, grouped by kind. */
export async function listPending(brochureId: string): Promise<PendingFacts> {
  const supabase = getServerSupabase();
  const base = (table: string, cols: string) =>
    supabase
      .from(table)
      .select(cols)
      .eq("brochure_id", brochureId)
      .eq("review_status", "pending")
      .order("source_page", { ascending: true, nullsFirst: false });

  const [c, p, a] = await Promise.all([
    base("plan_coverage_items", COVERAGE_COLS),
    base("plan_pricing", PRICING_COLS),
    base("plan_addons", ADDON_COLS),
  ]);
  if (c.error || p.error || a.error) {
    console.warn(
      `[coverage] pending list failed c=${c.error?.code ?? "-"} p=${p.error?.code ?? "-"} a=${a.error?.code ?? "-"}`,
    );
    throw new ApiError(500, "Could not load pending rows.");
  }
  return {
    coverage: (c.data ?? []).map(mapCoverage),
    pricing: (p.data ?? []).map(mapPricing),
    addons: (a.data ?? []).map(mapAddon),
  };
}

export type ReviewAction = "approve" | "reject";

/**
 * Applies a review decision to one row. `dbEdits` is a snake_case column map
 * (already shaped by the route: value edits only on approve, plus optional
 * notes / extraction_method).
 *
 * PENDING-ONLY (atomic): the UPDATE is constrained by `review_status='pending'`
 * in the WHERE clause, so a row that is already approved / rejected /
 * needs_changes is NEVER mutated by this endpoint — even though only its id is
 * supplied. If no pending row matched, a clear 409 (or 404) is returned.
 */
export async function applyReview(
  kind: ReviewKind,
  rowId: string,
  reviewerId: string,
  action: ReviewAction,
  dbEdits: Record<string, unknown>,
): Promise<void> {
  const supabase = getServerSupabase();
  const table = TABLE[kind];

  const update: Record<string, unknown> = {
    ...dbEdits,
    review_status: action === "approve" ? "approved" : "rejected",
    reviewed_by: reviewerId,
    reviewed_at: new Date().toISOString(),
  };

  const res = await supabase
    .from(table)
    .update(update)
    .eq("id", rowId)
    .eq("review_status", "pending") // atomic pending-only guard
    .select("id");

  if (res.error) {
    // 23001 = restrict_violation from the approved-immutability trigger (a
    // backstop; the pending-only predicate above means it shouldn't fire).
    if (res.error.code === "23001") {
      throw new ApiError(
        409,
        "This row is approved and its values can't be overwritten.",
      );
    }
    console.warn(
      `[coverage] review update failed kind=${kind} id=${rowId} code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    throw new ApiError(500, "Could not save the review decision.");
  }

  if (res.data && res.data.length > 0) return; // a pending row was updated

  // Nothing updated → the row either doesn't exist or isn't pending. Probe to
  // return the right status/message.
  const exists = await supabase
    .from(table)
    .select("id")
    .eq("id", rowId)
    .maybeSingle();
  if (exists.error) {
    throw new ApiError(500, "Could not save the review decision.");
  }
  if (!exists.data) {
    throw notFound("Row not found.");
  }
  throw new ApiError(409, "Only pending rows can be reviewed.");
}

export type BulkReviewItem = { kind: ReviewKind; rowId: string };
export type BulkReviewResult = {
  requested: number;
  updated: number;
  skipped: number;
};

/**
 * Bulk approve/reject. Uses the SAME pending-only safety as applyReview: each
 * per-kind UPDATE is constrained by `review_status='pending'`, so already
 * approved/rejected/needs_changes rows are never touched (they count toward
 * `skipped`). Edits are NOT applied in bulk — only the status, reviewer stamps,
 * and an optional shared note. One UPDATE per kind.
 */
export async function bulkReview(
  items: BulkReviewItem[],
  reviewerId: string,
  action: ReviewAction,
  note: string | null,
): Promise<BulkReviewResult> {
  const supabase = getServerSupabase();
  const byKind: Record<ReviewKind, string[]> = {
    coverage: [],
    pricing: [],
    addons: [],
  };
  for (const it of items) byKind[it.kind].push(it.rowId);

  const reviewedAt = new Date().toISOString();
  const status = action === "approve" ? "approved" : "rejected";
  let updated = 0;

  for (const kind of REVIEW_KINDS) {
    const ids = byKind[kind];
    if (ids.length === 0) continue;
    const update: Record<string, unknown> = {
      review_status: status,
      reviewed_by: reviewerId,
      reviewed_at: reviewedAt,
    };
    if (note) update.notes = note;

    const res = await supabase
      .from(TABLE[kind])
      .update(update)
      .in("id", ids)
      .eq("review_status", "pending") // pending-only guard
      .select("id");
    if (res.error) {
      console.warn(
        `[coverage] bulk review failed kind=${kind} code=${res.error.code ?? "?"} msg=${res.error.message}`,
      );
      throw new ApiError(500, "Could not apply the bulk review.");
    }
    updated += res.data?.length ?? 0;
  }

  return { requested: items.length, updated, skipped: items.length - updated };
}
