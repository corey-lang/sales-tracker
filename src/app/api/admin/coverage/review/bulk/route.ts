import { z } from "zod";

import { handleApiError, parseBody, requireAdmin } from "@/lib/server/auth";
import { bulkReview } from "@/lib/coverage/review";

// POST /api/admin/coverage/review/bulk
//   body: { action: "approve"|"reject", note?: string, items: [{kind, rowId}] }
//
// Admin-only bulk review. Reuses the pending-only mutation safety: rows that
// aren't review_status='pending' are silently skipped (counted in `skipped`),
// never flipped. No value edits in bulk — status + reviewer stamps + optional
// shared note only.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ItemSchema = z.object({
  kind: z.enum(["coverage", "pricing", "addons"]),
  rowId: z.string().uuid(),
});

const BodySchema = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().trim().max(2000).optional(),
  items: z.array(ItemSchema).min(1).max(500),
});

export async function POST(req: Request) {
  try {
    const me = await requireAdmin(req);
    const body = await parseBody(req, BodySchema);
    const result = await bulkReview(
      body.items,
      me.id,
      body.action,
      body.note ?? null,
    );
    return Response.json({ result });
  } catch (err) {
    return handleApiError(err);
  }
}
