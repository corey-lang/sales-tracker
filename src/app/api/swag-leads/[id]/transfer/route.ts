import { getServerSupabase } from "@/lib/supabase/server";
import { forbidden, handleApiError, parseBody } from "@/lib/server/auth";
import { requireVisibleSalesperson } from "@/lib/server/roster";
import {
  SwagStaleError,
  conflictResponse,
  leadPermissions,
  requireSwagLeadsAccess,
  requireVisibleLead,
  transferLead,
  transferResponseLead,
  viewOne,
} from "@/lib/server/swag-leads";
import { transferSchema } from "@/lib/swag-leads-validation";

// POST /api/swag-leads/[id]/transfer
//   body { to_assigned_to?: <AE uuid>, to_ooa?: true, reason?, expected_revision? }
//   -> { lead }
//
// The ONLY way a lead changes owner. One database transaction moves the lead
// (same row — never a copy) and writes the immutable history record:
// previous → new, who, when, why.
//
// WHO   Management may transfer ANY lead (including OOA → AE). An AE may
//       transfer a lead only while they are its CURRENT owner, to another AE or
//       to OOA. Everyone else gets a 404 (they can't see the lead at all).
// RACES The function locks the lead row first, so two simultaneous transfers —
//       or a transfer and an edit — serialize; the loser is refused (it is no
//       longer the owner, or its `expected_revision` is stale → 409) instead of
//       overwriting.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireSwagLeadsAccess(req);
    const { id } = await params;
    const body = await parseBody(req, transferSchema);
    const supabase = getServerSupabase();
    const lead = await requireVisibleLead(supabase, me, id);
    if (!leadPermissions(me, lead).can_transfer) {
      throw forbidden("You can only transfer your own leads.");
    }
    const toOoa = body.to_ooa === true;
    // A private test account someone else owns reads as "not found".
    if (!toOoa) await requireVisibleSalesperson(supabase, me, body.to_assigned_to as string, "AE not found.");
    try {
      const moved = await transferLead(supabase, me, lead.id, {
        toAssignedTo: toOoa ? null : (body.to_assigned_to as string),
        toOoa,
        reason: body.reason?.trim() || null,
        expectedRevision: body.expected_revision ?? null,
      });
      // An AE who just handed the lead off no longer owns it: a receipt, not the lead.
      return Response.json({ lead: transferResponseLead(me, await viewOne(supabase, moved)) });
    } catch (err) {
      if (err instanceof SwagStaleError) {
        // After a concurrent transfer the caller may no longer be allowed to see
        // the lead; conflictResponse then (correctly) answers 404.
        return await conflictResponse(supabase, me, lead.id);
      }
      throw err;
    }
  } catch (err) {
    return handleApiError(err);
  }
}
