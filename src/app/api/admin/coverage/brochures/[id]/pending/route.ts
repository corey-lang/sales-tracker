import { ApiError, handleApiError, requireAdmin } from "@/lib/server/auth";
import { getBrochure } from "@/lib/coverage/brochures";
import { listPending } from "@/lib/coverage/review";

// GET /api/admin/coverage/brochures/:id/pending
// Admin-only. Returns this brochure's review_status='pending' rows grouped by
// kind (coverage / pricing / addons) for the review UI.

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
    const pending = await listPending(id);
    return Response.json({ brochure, pending });
  } catch (err) {
    return handleApiError(err);
  }
}
