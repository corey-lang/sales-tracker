import { buildSingleAeActivityWeek } from "@/lib/server/activity-report";
import { format } from "date-fns";

import { getServerSupabase } from "@/lib/supabase/server";
import { todayInAppTimezone } from "@/lib/dates";
import { pairedBusinessMonday } from "@/lib/goals";
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
    const me = await requireAeToolAccess(req);

    // "This week" is the CURRENT Sun-Sat ACTIVITY week (rolls Sunday). We pass
    // its paired business Monday as `since`: computeStandings sums the activity
    // numerator over the Sun-Sat window derived from it, while availability /
    // adjusted targets / pace use that Mon-Fri week. On Sunday this is the NEW
    // week, so a Sunday log counts immediately. Denver-anchored so the boundary
    // matches the rest of the app (see src/lib/dates.ts).
    const now = todayInAppTimezone();
    const todayStr = format(now, "yyyy-MM-dd");
    const since = pairedBusinessMonday(now);

    const { standings, error } = await computeStandings(
      getServerSupabase(),
      since,
      todayStr,
      // Resolve goals as of the paired business Monday (not today), so on a
      // Sunday a Monday-effective goal applies to the new activity week rather
      // than scoring it against the prior week's goal.
      since,
      todayStr,
    );
    if (error) {
      // `error` is already sanitized by computeStandings (raw provider text is
      // logged there, not here). Return a fixed safe message regardless.
      return Response.json(
        { error: "Could not load leaderboard right now." },
        { status: 500 },
      );
    }

    // AEs only see their OWN available-days / pace context. Strip those fields
    // from every other rep's standing so one AE can't infer a teammate's PTO
    // from a reduced available-day count. The full leaderboard still shows
    // everyone's % (unchanged); the pace fields ride along only for `me`.
    const sanitized = standings.map((s) => {
      if (s.id === me.id) return s;
      const {
        availableDays: _ad,
        expectedPercent: _ep,
        isHolidayWeek: _hw,
        ...rest
      } = s;
      void _ad;
      void _ep;
      void _hw;
      return rest;
    });

    // A private test account is never in the team standings (so it can't
    // appear in — or shift — anyone's leaderboard or rank). Its own "This week"
    // tile gets its personal score instead, from the single-AE scoring path:
    // same week windows, goal resolution, availability and scoring, computed
    // over only this account and returned only to it.
    let personal: Record<string, unknown> | undefined;
    if (me.is_test) {
      const single = await buildSingleAeActivityWeek(
        getServerSupabase(),
        { id: me.id, first_name: me.first_name },
        since,
        todayStr,
        since,
        todayStr,
      );
      if (single.error || !single.row) {
        return Response.json(
          { error: "Could not load leaderboard right now." },
          { status: 500 },
        );
      }
      personal = {
        id: me.id,
        first_name: me.first_name,
        percent: single.row.score,
        availableDays: single.row.available_days,
        expectedPercent: single.row.expected_percent,
        isHolidayWeek: single.row.is_holiday_week,
      };
    }

    // Only `standings` (and, for a test account, its own `personal` row)
    // leaves the server. Sorting is intentionally left to
    // each consumer so the full page and the mini card keep their own ranking.
    return Response.json(
      personal ? { standings: sanitized, personal } : { standings: sanitized },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
