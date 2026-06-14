import { addDays, format, isValid, parseISO } from "date-fns";

import { getServerSupabase } from "@/lib/supabase/server";
import { todayInAppTimezone } from "@/lib/dates";
import { pairedBusinessMonday } from "@/lib/goals";
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

    // `weekStart` identifies a Sun-Sat ACTIVITY week (its Sunday). Resolve its
    // paired business Monday for availability/goal/pace; computeStandings sums
    // the activity NUMERATOR over the Sun-Sat window derived from it. Robust to
    // a legacy Monday param. Never report past today, so the current week shows
    // progress so far. "Today" is the Denver business day.
    const now = todayInAppTimezone();
    const todayStr = format(now, "yyyy-MM-dd");
    const since = pairedBusinessMonday(parsed); // business Monday of that activity week
    let through = format(addDays(parseISO(since), 4), "yyyy-MM-dd");
    if (through > todayStr) through = todayStr;
    // Resolve each AE's goal as of the week's end so prior weeks score against
    // the goal in effect then — but never BEFORE the week's Monday. On a Sunday
    // the current week's `through` (today) is before `since`; clamp so a
    // Monday-effective goal still applies to the new activity week.
    const goalAsOf = through < since ? since : through;

    const { standings, error } = await computeStandings(
      getServerSupabase(),
      since,
      through,
      goalAsOf,
      // Real today (not the clamped `through`) so a fully-past week reads
      // 100% expected pace, while the current week reads its true to-date pace.
      todayStr,
    );
    if (error) {
      // computeStandings already logged any raw provider text; return a safe
      // generic message.
      return Response.json(
        { error: "Could not load leaderboard right now." },
        { status: 500 },
      );
    }

    return Response.json(
      { standings },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
