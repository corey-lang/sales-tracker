import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  handleApiError,
  parseBody,
  requireAdmin,
} from "@/lib/server/auth";
import { ID_CHUNK, selectAllPages } from "@/lib/server/paginate";
import { visibleSalespersonIds } from "@/lib/server/roster";

// POST /api/admin/maintenance/activity
//
// Admin-only. Destructive activity_entries maintenance behind the admin
// Maintenance card. It used to run in the browser with the anon key; now that
// test accounts' rows are hidden from the public key, it runs here so
// ownership is enforced by the server:
//
//   { action: "clear_test" }  → delete activity rows of the SIGNED-IN admin's
//                               OWN private test accounts (test_owner_id = me).
//   { action: "clear_all" }   → delete activity rows of every salesperson the
//                               admin can see (all real people + their own
//                               test accounts). Another admin's private test
//                               account is never touched.
//
// Returns { deleted, accounts? }.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("clear_test") }),
  z.object({ action: z.literal("clear_all") }),
]);

export async function POST(req: Request) {
  try {
    const me = await requireAdmin(req);
    const body = await parseBody(req, RequestSchema);
    const supabase = getServerSupabase();

    let ids: string[];
    if (body.action === "clear_test") {
      const res = await selectAllPages<{ id: string }>(() =>
        supabase
          .from("salespeople")
          .select("id")
          .eq("is_test", true)
          .eq("test_owner_id", me.id)
          .order("id", { ascending: true }),
      );
      if (res.error) throw new ApiError(500, "Could not load your test accounts.");
      ids = res.data.map((r) => r.id);
    } else {
      ids = await visibleSalespersonIds(supabase, me);
    }

    let deleted = 0;
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const res = await supabase
        .from("activity_entries")
        .delete({ count: "exact" })
        .in("salesperson_id", ids.slice(i, i + ID_CHUNK));
      if (res.error) {
        throw new ApiError(500, `Could not clear activity: ${res.error.message}`);
      }
      deleted += res.count ?? 0;
    }
    return Response.json({
      deleted,
      accounts: body.action === "clear_test" ? ids.length : undefined,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
