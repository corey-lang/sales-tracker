import { ApiError, handleApiError, requireAdmin } from "@/lib/server/auth";
import { getBrochure } from "@/lib/coverage/brochures";
import {
  fetchBrochureBytes,
  reconcileFileHash,
  type HashAction,
} from "@/lib/coverage/ingest";
import { extractPdfPages, looksLikePdf } from "@/lib/coverage/pdf";
import {
  extractPageCandidates,
  pageLikelyHasFacts,
  type AddonCandidate,
  type CoverageItemCandidate,
  type PricingCandidate,
} from "@/lib/coverage/extract";
import {
  insertPendingAddons,
  insertPendingCoverageItems,
  insertPendingPricing,
  type WithPage,
} from "@/lib/coverage/facts";

// POST /api/admin/coverage/brochures/:id/extract
//
// Admin-only. Phase 2 ingestion + extraction-to-pending-review:
//   1. Fetch the brochure's source_url (server-side).
//   2. SHA-256 the bytes; backfill file_hash if null, verify if present,
//      REJECT on mismatch (409).
//   3. Extract per-page text (PDF), pre-filter, AI-extract candidate facts.
//   4. Insert candidates as review_status='pending' (append-only; existing rows
//      are never touched — approved facts are safe).
//
// Does NOT approve, promote, or touch the AI Assistant. Re-running is idempotent
// (duplicate candidates are skipped).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// PDF parse + several model calls can run long. 60s is valid across Vercel
// plans (Hobby caps here); bounded concurrency keeps a typical brochure inside
// it, and re-running is idempotent if a very long one is capped.
export const maxDuration = 60;

/** Cap pages processed per run so a huge brochure can't blow the time budget. */
const MAX_PAGES = 40;
/** Concurrent model calls — fits more pages in the time budget without tripping
 *  rate limits. */
const EXTRACT_CONCURRENCY = 4;

/** Runs `fn` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin(req);
    const { id } = await params;

    const brochure = await getBrochure(id);
    if (!brochure) throw new ApiError(404, "Brochure not found.");
    if (!brochure.sourceUrl) {
      throw new ApiError(
        400,
        "This brochure has no source_url to fetch. Register it with a source URL first.",
      );
    }

    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new ApiError(
        500,
        "Extraction is not configured on the server (missing API key).",
      );
    }

    // 1 + 2: fetch + hash + reconcile (integrity gate).
    const fetched = await fetchBrochureBytes(brochure.sourceUrl);
    const hashAction: HashAction = await reconcileFileHash(
      brochure,
      fetched.sha256,
    );

    if (!looksLikePdf(fetched.bytes)) {
      throw new ApiError(
        415,
        "Only PDF brochures are supported for extraction right now.",
      );
    }

    // 3: per-page text.
    const pages = await extractPdfPages(fetched.bytes);
    const pagesTotal = pages.length;
    const pagesWithText = pages.filter((p) => p.trim().length > 0).length;

    // 3 (cont): AI-extract candidates from the relevant pages (bounded
    // concurrency), tagging each with its source page.
    const coverageItems: WithPage<CoverageItemCandidate>[] = [];
    const pricing: WithPage<PricingCandidate>[] = [];
    const addons: WithPage<AddonCandidate>[] = [];

    // Pages (1-based) within the cap that plausibly carry facts.
    const targetPages = pages
      .slice(0, MAX_PAGES)
      .map((text, i) => ({ text, pageNumber: i + 1 }))
      .filter((p) => pageLikelyHasFacts(p.text));
    const pagesExtracted = targetPages.length;

    const perPage = await mapWithConcurrency(
      targetPages,
      EXTRACT_CONCURRENCY,
      (p) =>
        extractPageCandidates(
          brochure.stateCode,
          p.text,
          p.pageNumber,
          apiKey,
        ).then((result) => ({ pageNumber: p.pageNumber, result })),
    );

    for (const { pageNumber, result } of perPage) {
      for (const c of result.coverageItems)
        coverageItems.push({ ...c, sourcePage: pageNumber });
      for (const c of result.pricing)
        pricing.push({ ...c, sourcePage: pageNumber });
      for (const c of result.addons)
        addons.push({ ...c, sourcePage: pageNumber });
    }

    // 4: insert as pending (append-only; dedup-skips existing).
    const coverageResult = await insertPendingCoverageItems(
      brochure.id,
      brochure.stateCode,
      coverageItems,
    );
    const pricingResult = await insertPendingPricing(
      brochure.id,
      brochure.stateCode,
      pricing,
    );
    const addonResult = await insertPendingAddons(
      brochure.id,
      brochure.stateCode,
      addons,
    );

    return Response.json({
      brochureId: brochure.id,
      stateCode: brochure.stateCode,
      fileHash: fetched.sha256,
      hashAction,
      pagesTotal,
      pagesWithText,
      pagesExtracted,
      pagesCapped: pages.length > MAX_PAGES,
      candidates: {
        coverageItems: coverageItems.length,
        pricing: pricing.length,
        addons: addons.length,
      },
      pending: {
        coverageItems: coverageResult,
        pricing: pricingResult,
        addons: addonResult,
      },
      note: "All rows are review_status='pending'. Nothing is approved, promoted, or served to the AI Assistant.",
    });
  } catch (err) {
    return handleApiError(err);
  }
}
