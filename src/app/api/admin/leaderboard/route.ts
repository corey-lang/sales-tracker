import { addDays, format, isValid, parseISO, startOfWeek } from "date-fns";

import { getServerSupabase } from "@/lib/supabase/server";
import { todayInAppTimezone } from "@/lib/dates";
import { badRequest, handleApiError, requireAdmin } from "@/lib/server/auth";
import { computeStandings } from "@/lib/server/leaderboard-standings";

// GET /api/admin/leaderboard?weekStart=YYYY-MM-DD
//
// Admin-only leaderboard standings for a chosen PRIOR business week — powers
// the admin leaderboard's week picker.
//
// AUTHORIZATION
//   requireAdmin() rejects any non-admin caller (401/403) before any data is
//   read. /api/leaderboard intentionally has NO week parameter, so historical
//   leaderboard data is reachable only through this admin-guarded route.
//
// Scoring is identical to /api/leaderboard (shared computeStandings helper),
// and like that route this returns ONLY standings — goal targets never leave
// the server.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await requireAdmin(req);

    const weekStart = new URL(req.url).searchParams.get("weekStart");
    if (!weekStart) {
      throw badRequest("weekStart is required (YYYY-MM-DD).");
    }
    // Format check, then a real-date check — "2026-13-40" passes the regex but
    // is not a valid date, and must yield a clean 400 rather than a 500.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      throw badRequest("weekStart must be in YYYY-MM-DD format.");
    }
    const parsed = parseISO(weekStart);
    if (!isValid(parsed)) {
      throw badRequest("weekStart is not a valid calendar date.");
    }

    // Normalize to the Monday of that week, then Mon-Fri. Never report past
    // today, so picking the current week shows progress so far. "Today" is
    // the Denver business-day so this admin view never drifts ahead of the
    // AE-facing leaderboard.
    const now = todayInAppTimezone();
    const todayStr = format(now, "yyyy-MM-dd");
    const monday = startOfWeek(parsed, { weekStartsOn: 1 });
    const since = format(monday, "yyyy-MM-dd");
    let through = format(addDays(monday, 4), "yyyy-MM-dd");
    if (through > todayStr) through = todayStr;
    // Resolve each AE's goal as of the week's end, so prior weeks score
    // against the goal that was in effect then.
    const goalAsOf = through;

    const { standings, error } = await computeStandings(
      getServerSupabase(),
      since,
      through,
      goalAsOf,
    );
    if (error) {
      return Response.json({ error }, { status: 500 });
    }

    return Response.json(
      { standings },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
