import { addDays, format, isValid, parseISO, startOfWeek } from "date-fns";

import { getServerSupabase } from "@/lib/supabase/server";
import { todayInAppTimezone } from "@/lib/dates";
import { badRequest, handleApiError, requireAdmin } from "@/lib/server/auth";
import { buildScorecard } from "@/lib/server/scorecard";

// GET /api/admin/scorecard?weekStart=YYYY-MM-DD
//
// Admin-only operating scorecard for a chosen business week. Returns one
// row per AE with score % plus raw KPI counts (visits, cards, to-dos,
// offices, last-active) — manager-facing only. The AE leaderboard remains
// percentage-only; raw counts never leak there.
//
// AUTHORIZATION
//   requireAdmin() rejects any non-admin caller (401/403) before any data
//   is read. There is no AE-facing variant of this route.
//
// Mirrors the week-normalization rules in /api/admin/leaderboard: clamps
// the through-date to today (Denver business day) and resolves goals as
// of the week's end so prior weeks score against the goal in effect then.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await requireAdmin(req);

    const weekStart = new URL(req.url).searchParams.get("weekStart");
    if (!weekStart) {
      throw badRequest("weekStart is required (YYYY-MM-DD).");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      throw badRequest("weekStart must be in YYYY-MM-DD format.");
    }
    const parsed = parseISO(weekStart);
    if (!isValid(parsed)) {
      throw badRequest("weekStart is not a valid calendar date.");
    }

    const now = todayInAppTimezone();
    const todayStr = format(now, "yyyy-MM-dd");
    const monday = startOfWeek(parsed, { weekStartsOn: 1 });
    const since = format(monday, "yyyy-MM-dd");
    let through = format(addDays(monday, 4), "yyyy-MM-dd");
    if (through > todayStr) through = todayStr;
    const goalAsOf = through;

    const { rows, error } = await buildScorecard(
      getServerSupabase(),
      since,
      through,
      goalAsOf,
    );
    if (error) {
      return Response.json({ error }, { status: 500 });
    }

    return Response.json(
      { rows, since, through },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
