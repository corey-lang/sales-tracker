import { z } from "zod";

import {
  ApiError,
  handleApiError,
  parseBody,
  requireAdmin,
} from "@/lib/server/auth";
import { getBrochure } from "@/lib/coverage/brochures";
import {
  approveAndPublishBrochure,
  coerceThreshold,
} from "@/lib/coverage/quality";

// POST /api/admin/coverage/brochures/:id/approve-publish
//   body: { confidenceThreshold?: number }   // 0..1, default 0.85
//
// Admin-only. Approves every AUTO-PUBLISHABLE (non-exception) pending row and
// promotes the brochure to current. Exceptions (low-confidence / flagged) stay
// pending for spot-check. Pending-only + audit-stamped; honors current/approved
// publication rules. No AI Assistant integration.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  confidenceThreshold: z.number().optional(),
  // Required: the admin confirmed they spot-checked the eligible sample.
  confirmedSampleReview: z.boolean().optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireAdmin(req);
    const { id } = await params;

    const brochure = await getBrochure(id);
    if (!brochure) throw new ApiError(404, "Brochure not found.");

    const body = await parseBody(req, BodySchema);
    const threshold = coerceThreshold(body.confidenceThreshold);

    const result = await approveAndPublishBrochure(
      id,
      me.id,
      brochure.status,
      threshold,
      body.confirmedSampleReview === true,
    );
    return Response.json({ result });
  } catch (err) {
    return handleApiError(err);
  }
}
