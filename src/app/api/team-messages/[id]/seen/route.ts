import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import { badRequest, handleApiError, notFound } from "@/lib/server/auth";
import {
  fetchSeenDetail,
  requireJuiceBoxSeenAccess,
} from "@/lib/server/juice-box-seen";

// Juice Box — who has / has not seen ONE post.
//
//   GET /api/team-messages/:id/seen
//     -> { id, seen, total, seen_people: [{id,name}], not_seen_people: [{id,name}] }
//
// ACCESS: admin, or a user granted can_view_juice_box_seen. Everyone else gets a
// 403 and nothing about anyone's read state. The access check runs FIRST, so an
// unauthorized caller gets the same 403 for a real post, a deleted one and a
// made-up id — the response can't be used to learn anything.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireJuiceBoxSeenAccess(req);
    const { id } = await params;
    if (!z.string().uuid().safeParse(id).success) throw badRequest("Invalid post id.");

    const detail = await fetchSeenDetail(getServerSupabase(), id);
    if (!detail) throw notFound("Post not found.");
    return Response.json(detail, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return handleApiError(err);
  }
}
