import { z } from "zod";

import {
  badRequest,
  handleApiError,
  parseBody,
  requireAdmin,
} from "@/lib/server/auth";
import { applyReview, isReviewKind, type ReviewKind } from "@/lib/coverage/review";

// PATCH /api/admin/coverage/review/:kind/:rowId
//   kind ∈ coverage | pricing | addons
//   body: { action: "approve" | "reject", edits?: { ... } }
//
// Admin-only. Approves or rejects one pending row. On approve with `edits`, the
// provided structured fields are corrected in the SAME update that approves it
// (allowed while the row is still pending). Provenance (source_text/source_page)
// is NOT editable. Editing an already-approved row is refused by the store + DB.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTION = z.enum(["approve", "reject"]);

const CADENCE = z.enum([
  "one_time",
  "monthly",
  "quarterly",
  "semi_annual",
  "annual",
  "per_term",
  "per_service_request",
  "other",
]);

const currency = z
  .string()
  .trim()
  .length(3)
  .transform((s) => s.toUpperCase());

const CoverageEdits = z
  .object({
    planName: z.string().trim().min(1).max(200).optional(),
    coverageItem: z.string().trim().min(1).max(300).optional(),
    included: z.boolean().nullable().optional(),
    coverageLimit: z.number().finite().nullable().optional(),
    coverageLimitText: z.string().trim().max(500).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

const PricingEdits = z
  .object({
    planName: z.string().trim().min(1).max(200).optional(),
    priceAmount: z.number().finite().nullable().optional(),
    priceCadence: CADENCE.nullable().optional(),
    currencyCode: currency.optional(),
    priceText: z.string().trim().max(500).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

const AddonEdits = z
  .object({
    addonName: z.string().trim().min(1).max(200).optional(),
    planName: z.string().trim().min(1).max(200).nullable().optional(),
    includedInPlan: z.boolean().nullable().optional(),
    availableAsAddon: z.boolean().nullable().optional(),
    addonPriceAmount: z.number().finite().nullable().optional(),
    addonPriceCadence: CADENCE.nullable().optional(),
    currencyCode: currency.optional(),
    addonPriceText: z.string().trim().max(500).nullable().optional(),
    coverageLimit: z.number().finite().nullable().optional(),
    coverageLimitText: z.string().trim().max(500).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

function bodySchema(kind: ReviewKind) {
  const edits =
    kind === "coverage"
      ? CoverageEdits
      : kind === "pricing"
        ? PricingEdits
        : AddonEdits;
  return z.object({ action: ACTION, edits: edits.optional() });
}

/** camelCase edit key → snake_case column. Only keys present here are writable. */
const COLUMN: Record<string, string> = {
  planName: "plan_name",
  coverageItem: "coverage_item",
  included: "included",
  coverageLimit: "coverage_limit",
  coverageLimitText: "coverage_limit_text",
  priceAmount: "price_amount",
  priceCadence: "price_cadence",
  currencyCode: "currency_code",
  priceText: "price_text",
  addonName: "addon_name",
  includedInPlan: "included_in_plan",
  availableAsAddon: "available_as_addon",
  addonPriceAmount: "addon_price_amount",
  addonPriceCadence: "addon_price_cadence",
  addonPriceText: "addon_price_text",
  notes: "notes",
};

function toDbEdits(edits: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!edits) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(edits)) {
    if (value === undefined) continue;
    const col = COLUMN[key];
    if (col) out[col] = value;
  }
  return out;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ kind: string; rowId: string }> },
) {
  try {
    const me = await requireAdmin(req);
    const { kind, rowId } = await params;
    if (!isReviewKind(kind)) throw badRequest("Invalid review kind.");

    const body = await parseBody(req, bodySchema(kind));

    // Split notes (review metadata) from value edits.
    const all = toDbEdits(body.edits as Record<string, unknown> | undefined);
    const notesValue = all.notes;
    const valueEdits = { ...all };
    delete valueEdits.notes;

    // Approve: apply value edits (edit-then-approve) + flip method to
    // 'ai_assisted' when values were corrected. Reject: persist only a reviewer
    // note, never value edits.
    const dbEdits: Record<string, unknown> = {};
    if (body.action === "approve") {
      Object.assign(dbEdits, valueEdits);
      if (Object.keys(valueEdits).length > 0) {
        dbEdits.extraction_method = "ai_assisted";
      }
    }
    if (notesValue !== undefined) dbEdits.notes = notesValue;

    await applyReview(kind, rowId, me.id, body.action, dbEdits);
    return Response.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
