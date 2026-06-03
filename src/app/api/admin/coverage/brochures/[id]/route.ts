import {
  handleApiError,
  notFound,
  requireAdmin,
} from "@/lib/server/auth";
import { getBrochure } from "@/lib/coverage/brochures";

// GET /api/admin/coverage/brochures/:id — read one brochure's metadata.
// Admin-only. Read path for the admin "AI Coverage Intelligence" view.

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
    if (!brochure) throw notFound("Brochure not found.");
    return Response.json({ brochure });
  } catch (err) {
    return handleApiError(err);
  }
}
