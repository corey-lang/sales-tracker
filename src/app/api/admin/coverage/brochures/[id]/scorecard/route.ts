import { ApiError, handleApiError, requireAdmin } from "@/lib/server/auth";
import { getBrochure } from "@/lib/coverage/brochures";
import {
  analyzeBrochure,
  coerceThreshold,
  DEFAULT_CONFIDENCE_THRESHOLD,
} from "@/lib/coverage/quality";

// GET /api/admin/coverage/brochures/:id/scorecard?threshold=0.85
// Admin-only. Extraction-quality summary over this brochure's PENDING rows:
// confidence distribution, flag counts, pages, and eligible-vs-held at the
// confidence threshold. Answers "can I trust this extraction?".

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin(req);
    const { id } = await params;

    const brochure = await getBrochure(id);
    if (!brochure) throw new ApiError(404, "Brochure not found.");

    const url = new URL(req.url);
    const tParam = url.searchParams.get("threshold");
    const threshold =
      tParam !== null
        ? coerceThreshold(Number(tParam))
        : DEFAULT_CONFIDENCE_THRESHOLD;

    const analysis = await analyzeBrochure(id, threshold);
    // eligibleIds is an internal detail for the publish action — don't ship it.
    const { eligibleIds: _eligibleIds, ...scorecard } = analysis;
    void _eligibleIds;
    return Response.json({ brochure, scorecard });
  } catch (err) {
    return handleApiError(err);
  }
}
