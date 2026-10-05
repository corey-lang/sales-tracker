import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import { badRequest, handleApiError } from "@/lib/server/auth";
import {
  fetchSeenSummaries,
  requireJuiceBoxSeenAccess,
} from "@/lib/server/juice-box-seen";
import {
  SEEN_SUMMARY_MAX_IDS,
  type SeenSummariesResponse,
} from "@/lib/juice-box-seen";

// Juice Box — "Seen by X of Y" counts for a batch of posts.
//
//   GET /api/team-messages/seen?ids=<uuid>,<uuid>,…   (1–200 ids)
//     -> { posts: { [id]: { seen, total } } }
//
// ACCESS: admin, or a user granted can_view_juice_box_seen. Everyone else — every
// AE included — gets a 403 with no read-state data at all (checked BEFORE the ids
// are even parsed, so a malformed request can't be used to probe either).
//
// NO N+1: three queries (posts, audience, receipts) however many posts are asked
// about — see lib/server/juice-box-seen.ts. "Seen" is receipt-based, not read-marker
// based (lib/juice-box-seen.ts explains why). Deleted / unknown ids are simply absent from the
// answer. Counts only — names come from /api/team-messages/:id/seen.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IdsSchema = z
  .array(z.string().uuid())
  .min(1)
  .max(SEEN_SUMMARY_MAX_IDS);

export async function GET(req: Request) {
  try {
    await requireJuiceBoxSeenAccess(req);

    const raw = new URL(req.url).searchParams.get("ids") ?? "";
    const parsed = IdsSchema.safeParse(
      raw.split(",").map((s) => s.trim()).filter(Boolean),
    );
    if (!parsed.success) {
      throw badRequest(`Send 1–${SEEN_SUMMARY_MAX_IDS} post ids.`);
    }
    const ids = [...new Set(parsed.data)];

    const posts = await fetchSeenSummaries(getServerSupabase(), ids);
    const body: SeenSummariesResponse = { posts };
    return Response.json(body, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return handleApiError(err);
  }
}
