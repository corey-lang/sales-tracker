import { getServerSupabase } from "@/lib/supabase/server";
import { forbidden, handleApiError, parseBody } from "@/lib/server/auth";
import {
  SwagStaleError,
  conflictResponse,
  leadPermissions,
  listSwagAeOptions,
  loadLeadEvents,
  requireSwagLeadsAccess,
  requireVisibleLead,
  updateLead,
  viewOne,
} from "@/lib/server/swag-leads";
import type { SwagLeadDetailResponse } from "@/lib/swag-leads";
import { updateLeadSchema } from "@/lib/swag-leads-validation";

// One swag lead.
//   GET   /api/swag-leads/[id]  -> SwagLeadDetailResponse (lead + full history)
//   PATCH /api/swag-leads/[id]  body { expected_revision, patch } -> { lead }
//
// VISIBILITY  An AE sees only a lead they currently own; anything else is a 404
//             (indistinguishable from a lead that doesn't exist). Management
//             sees every real lead.
// EDITING     Owner AE: the prospecting fields. Management: also name + date
//             received. Reassignment is NOT editable here — only via /transfer,
//             so it always leaves a history record. A save based on a stale
//             `expected_revision` is a 409 carrying the lead as it is now;
//             nothing is overwritten.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireSwagLeadsAccess(req);
    const { id } = await params;
    const supabase = getServerSupabase();
    const lead = await requireVisibleLead(supabase, me, id);
    const [view, events, aeOptions] = await Promise.all([
      viewOne(supabase, lead),
      loadLeadEvents(supabase, lead.id),
      listSwagAeOptions(supabase, me),
    ]);
    const body: SwagLeadDetailResponse = {
      lead: view,
      events,
      permissions: leadPermissions(me, lead),
      ae_options: aeOptions,
    };
    return Response.json(body, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireSwagLeadsAccess(req);
    const { id } = await params;
    const body = await parseBody(req, updateLeadSchema);
    const supabase = getServerSupabase();
    const lead = await requireVisibleLead(supabase, me, id);
    if (!leadPermissions(me, lead).can_edit) throw forbidden("You can't edit that lead.");
    try {
      const saved = await updateLead(supabase, me, lead.id, body.expected_revision, body.patch);
      return Response.json({ lead: await viewOne(supabase, saved) });
    } catch (err) {
      if (err instanceof SwagStaleError) return await conflictResponse(supabase, me, lead.id);
      throw err;
    }
  } catch (err) {
    return handleApiError(err);
  }
}
