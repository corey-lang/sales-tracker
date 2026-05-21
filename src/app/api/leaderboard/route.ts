import { format } from "date-fns";

import { getServerSupabase } from "@/lib/supabase/server";
import { todayInAppTimezone } from "@/lib/dates";
import { businessWeekToDateRange } from "@/lib/goals";
import { handleApiError, requireAeToolAccess } from "@/lib/server/auth";
import { computeStandings } from "@/lib/server/leaderboard-standings";

// GET /api/leaderboard
//
// Server-side leaderboard standings for AE-facing views (the full /leaderboard
// page and the dashboard mini card). Always the CURRENT business week — there
// is no week parameter here, so a non-admin caller cannot pull historical
// leaderboard data. Prior weeks are admin-only: see /api/admin/leaderboard.
//
// ACCESS
//   requireAeToolAccess() — any signed-in salesperson EXCEPT
//   juice_box_only. Travis/Rizz are guests in the team chat with no
//   leaderboard surface; the UI redirects them away from /leaderboard
//   and this route enforces the same gate so a direct fetch can't
//   bypass the client.
//
// WHY THIS EXISTS
//   The browser used to run `weekly_goals.select("*")` directly to compute
//   leaderboard percentages. That shipped EVERY rep's raw goal targets —
//   including per-person overrides — to every AE's browser, even though the UI
//   only ever renders percentages. An AE could read other AEs' raw goals
//   straight out of the network response. This route reads weekly_goals with
//   the service-role key, does the percentage math here, and returns ONLY
//   leaderboard-safe data: id, first_name, raw activity totals (already shown
//   on the full leaderboard), and the percent score. Goal targets never cross
//   the wire.
//
// SCORING / RANKING ARE UNCHANGED
//   Standings come from the shared computeStandings() helper — the same
//   diminishing-returns / per-activity-average logic and goal resolution as
//   before. `percent` is returned as `number | null` so each consumer keeps
//   applying its own existing sort.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await requireAeToolAccess(req);

    // Anchor to the app business zone (America/Denver) so the
    // leaderboard's "this week" rolls over at the same instant as the
    // Weekly Focus surfaces. See src/lib/dates.ts for rationale.
    const now = todayInAppTimezone();
    const { since, through } = businessWeekToDateRange(now);
    const todayStr = format(now, "yyyy-MM-dd");

    const { standings, error } = await computeStandings(
      getServerSupabase(),
      since,
      through,
      todayStr,
    );
    if (error) {
      return Response.json({ error }, { status: 500 });
    }

    // Only `standings` leaves the server. Sorting is intentionally left to
    // each consumer so the full page and the mini card keep their own ranking.
    return Response.json(
      { standings },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
