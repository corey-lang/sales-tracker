import { getServerSupabase } from "@/lib/supabase/server";
import { visibleRosterOr } from "@/lib/roster";
import {
  ApiError,
  handleApiError,
  requireAeToolAccess,
} from "@/lib/server/auth";
import { selectAllPages } from "@/lib/server/paginate";

// GET /api/roster/visible
//
// The salespeople roster as the SIGNED-IN viewer may see it in selectors and
// name lookups (lib/roster.ts workflow-visibility rule): every real person,
// plus private test accounts the viewer owns. Another user's test account is
// simply absent.
//
// WHY A ROUTE (not an anon read): ownership (`test_owner_id`) is deliberately
// NOT readable with the public key, so the browser can't work out who may see
// what. The server applies the rule in the query and returns only the
// columns a selector needs — never `test_owner_id` or `admin_pin`.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const me = await requireAeToolAccess(req);
    const res = await selectAllPages<{
      id: string;
      first_name: string;
      role: string;
      is_test: boolean | null;
      deactivated_at: string | null;
    }>(() =>
      getServerSupabase()
        .from("salespeople")
        .select("id, first_name, role, is_test, deactivated_at")
        .or(visibleRosterOr(me.id))
        .order("first_name", { ascending: true })
        .order("id", { ascending: true }),
    );
    if (res.error) throw new ApiError(500, "Could not load the roster.");
    return Response.json(
      {
        people: res.data.map((p) => ({
          id: p.id,
          first_name: p.first_name,
          role: p.role,
          is_test: p.is_test === true,
          deactivated_at: p.deactivated_at,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
