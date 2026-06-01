import { addDays, format, isValid, parseISO, startOfWeek } from "date-fns";

import { getServerSupabase } from "@/lib/supabase/server";
import { todayInAppTimezone } from "@/lib/dates";
import { badRequest, handleApiError, requireAdmin } from "@/lib/server/auth";
import { buildActivityReport } from "@/lib/server/activity-report";

// GET /api/admin/reports/activity?weekStart=YYYY-MM-DD
//
// Admin-only. Returns the per-AE activity report (actual/goal per activity,
// overall score, available-days + pace) for a chosen business week.
//
// WHY THIS EXISTS
//   The report used to be computed in the browser, reading every AE's
//   weekly_goals, activity_entries, and working_day_adjustments (incl. PTO)
//   with the anon key — readable by anyone. This route does the read +
//   aggregation server-side behind requireAdmin, so the raw rows (and private
//   PTO context) never cross the wire. Client-side layout gating is NOT the
//   security boundary; this server check is.
//
// Mirrors the week-normalization rules in /api/admin/scorecard.

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

    const { rows, error } = await buildActivityReport(
      getServerSupabase(),
      since,
      through,
      goalAsOf,
      todayStr,
    );
    if (error) {
      // `error` is already a user-safe string (no raw provider message).
      return Response.json({ error }, { status: 502 });
    }

    return Response.json(
      { rows, since, through },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
