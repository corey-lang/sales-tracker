import { format, isValid, parseISO, startOfWeek } from "date-fns";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  badRequest,
  handleApiError,
  requireAdmin,
} from "@/lib/server/auth";
import { weekAvailability } from "@/lib/working-days";
import { fetchWeekAdjustments } from "@/lib/server/working-days";

// GET /api/admin/working-days/availability?weekStart=YYYY-MM-DD
//
// Admin-only. Returns each AE's available working days for the business week
// containing `weekStart`, plus whether a global holiday falls in it:
//   { weekStart, isHolidayWeek, availableDays: { <salespersonId>: number } }
//
// WHY THIS EXISTS
//   The admin Dashboard "Activity totals" card reads activity_entries +
//   weekly_goals with the ANON key, but working_day_adjustments is server-only
//   (RLS, no policy). This route is the boundary the card reads its
//   adjusted-target context through — only the resulting per-AE day COUNTS
//   cross the wire, never the raw PTO rows. Fails closed (502, safe message)
//   when the adjustment read fails.

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

    // Normalize to the week's Monday — the canonical weekStart everywhere.
    const monday = format(startOfWeek(parsed, { weekStartsOn: 1 }), "yyyy-MM-dd");

    const supabase = getServerSupabase();
    const { adjustments, error } = await fetchWeekAdjustments(supabase, monday);
    if (error) {
      // Already a user-safe string (raw provider text logged in the helper).
      throw new ApiError(502, error);
    }

    const peopleRes = await supabase
      .from("salespeople")
      .select("id")
      .eq("role", "ae")
      .eq("is_test", false);
    if (peopleRes.error) {
      console.error(
        `[working-days] availability roster read failed code=${peopleRes.error.code ?? "?"} msg=${peopleRes.error.message}`,
      );
      throw new ApiError(500, "Could not load working day availability.");
    }

    const availableDays: Record<string, number> = {};
    let isHolidayWeek = false;
    for (const p of (peopleRes.data ?? []) as Array<{ id: string }>) {
      const a = weekAvailability({
        weekStart: monday,
        salespersonId: p.id,
        adjustments,
      });
      availableDays[p.id] = a.availableDays;
      if (a.isHolidayWeek) isHolidayWeek = true;
    }

    return Response.json(
      { weekStart: monday, isHolidayWeek, availableDays },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
