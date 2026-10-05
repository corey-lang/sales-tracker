import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import { badRequest, handleApiError, requireSalesperson } from "@/lib/server/auth";
import { recordSeen } from "@/lib/server/juice-box-seen";
import { SEEN_REPORT_MAX_IDS } from "@/lib/juice-box-seen";

// Juice Box — "I reached these posts."
//
//   POST /api/team-messages/seen/report   body { ids: [uuid, …] }  (1–100)
//     -> { ok: true }
//
// Called by the feed as posts have been on screen long enough to count (see
// components/juice-box/seen-report.ts). This is what "Seen by X of Y" is built
// from; the channel read marker (/reads/me) is NOT involved and is not touched.
//
// ACCESS: any signed-in salesperson — everyone's screen contributes, not only the
// people who may view the result. Identity is the verified session; the body can
// only name posts (strict schema), never a person, so nobody can mark a post as
// seen on someone else's behalf. The response carries no read state.
//
// Idempotent and cheap: ONE statement however many ids; posts already recorded,
// deleted / unknown posts and the caller's own posts are skipped in the database.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ReportSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(SEEN_REPORT_MAX_IDS),
  })
  .strict();

export async function POST(req: Request) {
  try {
    const me = await requireSalesperson(req);

    let json: unknown;
    try {
      json = await req.json();
    } catch {
      throw badRequest("Request body is not valid JSON.");
    }
    const parsed = ReportSchema.safeParse(json);
    if (!parsed.success) throw badRequest(`Send 1–${SEEN_REPORT_MAX_IDS} post ids.`);

    await recordSeen(getServerSupabase(), me.id, [...new Set(parsed.data.ids)]);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return handleApiError(err);
  }
}
