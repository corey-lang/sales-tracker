import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError } from "@/lib/server/auth";
import { requireJuiceBoxAccess } from "@/lib/server/juice-box";
import { isPushConfigured } from "@/lib/server/push";

// Juice Box push diagnostics — current user's subscription state.
//
//   GET /api/juice-box/push/debug
//   ->  {
//         salesperson_id,
//         push_configured,
//         subscription_count,
//         subscriptions: [{
//           endpoint_host,         // hostname only, e.g. "web.push.apple.com"
//           user_agent,            // optional client hint string
//           created_at,
//           updated_at,
//         }],
//       }
//
// PURPOSE
//   Lets a signed-in admin / test user verify their device's push
//   subscription is in the DB (and matches the host they expect for
//   their browser / OS). Useful when debugging "I tapped Enable
//   notifications but I'm not getting pushes" — if this route returns
//   subscription_count=0 the issue is on the OPT-IN path; if it
//   returns ≥1 the issue is on the DELIVERY path (check the
//   [juice-box-push] log lines in Vercel function logs).
//
// SAFETY
//   * Auth-gated by requireJuiceBoxAccess (admin / test only).
//   * Self-scoped — returns only rows owned by the caller's
//     salesperson_id. A user can never see another user's
//     subscription data through this route.
//   * Returns only the endpoint HOSTNAME. The full endpoint URL
//     contains the push service's auth token (the path segment), so
//     it's intentionally elided here even for the owner.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PUSH_SUBSCRIPTIONS_TABLE = "push_subscriptions";

function safeEndpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "<invalid-url>";
  }
}

export async function GET(req: Request) {
  try {
    const me = await requireJuiceBoxAccess(req);
    const supabase = getServerSupabase();

    const res = await supabase
      .from(PUSH_SUBSCRIPTIONS_TABLE)
      .select("endpoint, user_agent, created_at, updated_at")
      .eq("salesperson_id", me.id)
      .order("created_at", { ascending: false });

    if (res.error) {
      throw new Error(`Failed to read subscriptions: ${res.error.message}`);
    }

    type Row = {
      endpoint: string;
      user_agent: string | null;
      created_at: string;
      updated_at: string;
    };
    const subscriptions = ((res.data ?? []) as Row[]).map((row) => ({
      endpoint_host: safeEndpointHost(row.endpoint),
      user_agent: row.user_agent,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));

    return Response.json({
      salesperson_id: me.id,
      push_configured: isPushConfigured(),
      subscription_count: subscriptions.length,
      subscriptions,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
