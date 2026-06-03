import { handleApiError, requireAdmin } from "@/lib/server/auth";
import { promoteCurrentBrochure } from "@/lib/coverage/brochures";

// POST /api/admin/coverage/brochures/:id/promote
//
// Admin-only. Marks this brochure as the CURRENT (authoritative) brochure for
// its state and demotes the prior current brochure to 'superseded' — atomically
// via the coverage_promote_current_brochure RPC. History is preserved (the old
// brochure and its facts remain; only its status changes).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin(req);
    const { id } = await params;
    const brochure = await promoteCurrentBrochure(id);
    return Response.json({ brochure });
  } catch (err) {
    return handleApiError(err);
  }
}
