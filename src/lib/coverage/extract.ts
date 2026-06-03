/**
 * Coverage Intelligence — AI extraction of candidate facts from page text
 * (Phase 2).
 *
 * Server-only. Given the plain text of ONE brochure page, asks an LLM to pull
 * out ONLY facts explicitly present, as candidate rows. Everything produced here
 * is a CANDIDATE for human review (review_status='pending'); nothing is trusted,
 * approved, or served to the AI Assistant. The model is instructed to never
 * infer (especially pricing) and to copy `sourceText` verbatim from the page.
 *
 * extraction_method for these rows is 'ai'. Confidence is per-row.
 */

import { z } from "zod";

import type { PriceCadence } from "./types";

const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";

const CADENCE_VALUES: PriceCadence[] = [
  "one_time",
  "monthly",
  "quarterly",
  "semi_annual",
  "annual",
  "per_term",
  "per_service_request",
  "other",
];

export type CoverageItemCandidate = {
  planName: string;
  coverageItem: string;
  included: boolean | null;
  coverageLimit: number | null;
  coverageLimitText: string | null;
  sourceText: string;
  confidence: number;
};

export type PricingCandidate = {
  planName: string;
  priceAmount: number | null;
  priceCadence: PriceCadence | null;
  currencyCode: string | null;
  priceText: string | null;
  sourceText: string;
  confidence: number;
};

export type AddonCandidate = {
  addonName: string;
  planName: string | null;
  includedInPlan: boolean | null;
  availableAsAddon: boolean | null;
  addonPriceAmount: number | null;
  addonPriceCadence: PriceCadence | null;
  currencyCode: string | null;
  addonPriceText: string | null;
  coverageLimit: number | null;
  coverageLimitText: string | null;
  sourceText: string;
  confidence: number;
};

export type PageCandidates = {
  coverageItems: CoverageItemCandidate[];
  pricing: PricingCandidate[];
  addons: AddonCandidate[];
};

/** Cheap pre-filter: only call the model on pages that plausibly hold plan,
 *  coverage, or pricing content. Saves tokens on cover pages, legal text, etc. */
export function pageLikelyHasFacts(pageText: string): boolean {
  return /\b(cover|covered|coverage|plan|warranty|limit|optional|add[- ]?on|included|exclusion|\$|price|premium|fee)\b/i.test(
    pageText,
  );
}

const nullableNumber = z
  .union([z.number(), z.null()])
  .optional()
  .transform((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));

const nullableBool = z
  .union([z.boolean(), z.null()])
  .optional()
  .transform((v) => (typeof v === "boolean" ? v : null));

const nullableText = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (typeof v === "string" && v.trim().length > 0 ? v : null));

const requiredText = z.string().min(1);

const confidence = z
  .union([z.number(), z.null()])
  .optional()
  .transform((v) =>
    typeof v === "number" && Number.isFinite(v)
      ? Math.min(1, Math.max(0, v))
      : 0.5,
  );

const cadence = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) =>
    typeof v === "string" && (CADENCE_VALUES as string[]).includes(v)
      ? (v as PriceCadence)
      : null,
  );

const PageSchema = z.object({
  coverageItems: z
    .array(
      z.object({
        planName: requiredText,
        coverageItem: requiredText,
        included: nullableBool,
        coverageLimit: nullableNumber,
        coverageLimitText: nullableText,
        sourceText: requiredText,
        confidence,
      }),
    )
    .optional()
    .transform((v) => v ?? []),
  pricing: z
    .array(
      z.object({
        planName: requiredText,
        priceAmount: nullableNumber,
        priceCadence: cadence,
        currencyCode: nullableText,
        priceText: nullableText,
        sourceText: requiredText,
        confidence,
      }),
    )
    .optional()
    .transform((v) => v ?? []),
  addons: z
    .array(
      z.object({
        addonName: requiredText,
        planName: nullableText,
        includedInPlan: nullableBool,
        availableAsAddon: nullableBool,
        addonPriceAmount: nullableNumber,
        addonPriceCadence: cadence,
        currencyCode: nullableText,
        addonPriceText: nullableText,
        coverageLimit: nullableNumber,
        coverageLimitText: nullableText,
        sourceText: requiredText,
        confidence,
      }),
    )
    .optional()
    .transform((v) => v ?? []),
});

const SYSTEM_PROMPT = [
  "You extract structured facts from ONE page of a US home-warranty plan brochure.",
  "Hard rules:",
  "1. Extract ONLY facts explicitly stated in the provided page text. Never infer, guess, summarize, or calculate.",
  "2. Copy `sourceText` VERBATIM from the page — the exact line/phrase the fact came from. If you cannot quote it, do not emit the row.",
  "3. PRICING: include a price ONLY if an explicit price/amount appears in the text. Never derive or estimate a price. If no price is stated, omit pricing.",
  "4. `included` = true only if the text says the item is covered/included; false only if explicitly excluded/not covered; otherwise null.",
  "5. Use the brochure's exact plan and item names. If the page has no plan/coverage/pricing facts, return empty arrays.",
  "6. `confidence` (0..1) reflects how explicit the text is for that row.",
  "Output a SINGLE JSON object with keys: coverageItems[], pricing[], addons[]. Use exactly these field names:",
  "  coverageItems: { planName, coverageItem, included, coverageLimit, coverageLimitText, sourceText, confidence }",
  "  pricing:       { planName, priceAmount, priceCadence, currencyCode, priceText, sourceText, confidence }",
  "  addons:        { addonName, planName, includedInPlan, availableAsAddon, addonPriceAmount, addonPriceCadence, currencyCode, addonPriceText, coverageLimit, coverageLimitText, sourceText, confidence }",
  "priceCadence/addonPriceCadence must be one of: one_time, monthly, quarterly, semi_annual, annual, per_term, per_service_request, other (or null).",
].join("\n");

/**
 * Runs extraction for one page. Returns candidate rows (possibly empty). Never
 * throws on a bad model response — a parse failure yields empty candidates and
 * is logged, so one bad page can't abort a whole brochure.
 */
export async function extractPageCandidates(
  stateCode: string,
  pageText: string,
  pageNumber: number,
  apiKey: string,
): Promise<PageCandidates> {
  const empty: PageCandidates = { coverageItems: [], pricing: [], addons: [] };
  const trimmed = pageText.trim();
  if (!trimmed) return empty;

  const model = process.env.OPENAI_EXTRACTION_MODEL ?? "gpt-4o-mini";
  let res: Response;
  try {
    res = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `State: ${stateCode}\nPage: ${pageNumber}\n\nPage text:\n"""\n${trimmed.slice(0, 12000)}\n"""`,
          },
        ],
      }),
    });
  } catch (err) {
    console.warn(`[coverage] extraction call failed page=${pageNumber} err=${String(err)}`);
    return empty;
  }

  if (!res.ok) {
    console.warn(`[coverage] extraction non-2xx page=${pageNumber} status=${res.status}`);
    return empty;
  }

  let content: string | undefined;
  try {
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    content = json.choices?.[0]?.message?.content;
  } catch {
    return empty;
  }
  if (!content) return empty;

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    console.warn(`[coverage] extraction returned non-JSON page=${pageNumber}`);
    return empty;
  }

  const parsed = PageSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(`[coverage] extraction schema mismatch page=${pageNumber}`);
    return empty;
  }
  return parsed.data;
}
