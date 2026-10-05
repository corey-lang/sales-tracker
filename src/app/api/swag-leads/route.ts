import { getServerSupabase } from "@/lib/supabase/server";
import { ApiError, forbidden, handleApiError, parseBody } from "@/lib/server/auth";
import { requireVisibleSalesperson } from "@/lib/server/roster";
import {
  buildLeadsResponse,
  createLead,
  requireSwagLeadsAccess,
  requireVisibleLead,
  resolveScope,
  viewOne,
} from "@/lib/server/swag-leads";
import { createLeadSchema, listQuerySchema } from "@/lib/swag-leads-validation";

// Swag Leads — list (dashboard data) + create.
//   GET  /api/swag-leads?scope=<mine|all|ooa|<ae uuid>>&metric=<key>&q=…&…
//        -> SwagLeadsResponse
//   POST /api/swag-leads  -> { lead }
//
// Swag leads are social-media PROSPECTING leads (not swag orders).
//
// ACCESS  AE or management (see lib/server/swag-leads.ts).
// SCOPE   An AE gets their own leads, always; asking for anyone else's is a
//         403. Management defaults to every lead ("all"), and may pick "ooa" or
//         one AE. The metrics are computed from the SCOPE's leads — choosing an
//         AE recomputes them for that AE; `metric` / filters only narrow the list.
// CREATE  An AE's lead is always assigned to themselves. Management chooses an
//         AE or OOA. The owner is never trusted blindly: the database function
//         re-checks the actor and the target. A REPLAYED create (same
//         request_id) returns the original lead only to someone who can still
//         see it — a former owner gets a 404 with no lead data — enforced in
//         the database function and re-checked here.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const me = await requireSwagLeadsAccess(req);
    const supabase = getServerSupabase();
    const parsed = listQuerySchema.safeParse(
      Object.fromEntries(new URL(req.url).searchParams.entries()),
    );
    if (!parsed.success) {
      throw new ApiError(
        400,
        `Invalid filter — ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }
    const { scope: rawScope, metric, ...filters } = parsed.data;
    const scope = await resolveScope(supabase, me, rawScope);
    const body = await buildLeadsResponse(supabase, me, scope, { metric, ...filters });
    return Response.json(body, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const me = await requireSwagLeadsAccess(req);
    const body = await parseBody(req, createLeadSchema);
    const supabase = getServerSupabase();
    const { assigned_to, ooa, request_id, ...fields } = body;

    let assignedTo: string | null;
    let isOoa: boolean;
    if (me.is_manager) {
      if (Boolean(ooa) === Boolean(assigned_to)) {
        throw new ApiError(400, "Choose exactly one of an AE or OOA.");
      }
      isOoa = Boolean(ooa);
      assignedTo = isOoa ? null : (assigned_to as string);
      // A private test account someone else owns reads as "not found".
      if (assignedTo) await requireVisibleSalesperson(supabase, me, assignedTo, "AE not found.");
    } else {
      // An AE adds to their own list only.
      if (ooa || (assigned_to && assigned_to !== me.id)) {
        throw forbidden("You can only add leads to your own list.");
      }
      assignedTo = me.id;
      isOoa = false;
    }

    // Only the fields the client actually sent (undefined = use the default).
    const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    const lead = await createLead(supabase, me, {
      fields: defined,
      assignedTo,
      ooa: isOoa,
      requestId: request_id ?? null,
    });
    // Whatever the database returned — a new lead OR the original of a replayed
    // request — is re-checked against the caller's CURRENT visibility before any
    // of it is sent. A creator who no longer owns the lead (it was transferred
    // away) gets a 404 and no lead data.
    const visible = await requireVisibleLead(supabase, me, lead.id);
    return Response.json({ lead: await viewOne(supabase, visible) }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
