import { getServerSupabase } from "@/lib/supabase/server";
import { pairedBusinessMonday } from "@/lib/goals";
import { weekAvailability } from "@/lib/working-days";
import {
  ApiError,
  handleApiError,
  requireAeToolAccess,
} from "@/lib/server/auth";
import { fetchWeekAdjustments } from "@/lib/server/working-days";

// GET /api/me/working-days
//
// Returns the SIGNED-IN AE's available-day context for the Mon-Fri business
// week PAIRED with the current Sun-Sat activity week (rolls Sunday) —
// { weekStart, availableDays, isHolidayWeek } — so the dashboard's adjusted
// targets line up with the activity week MyWeekCard shows. On a Sunday this is
// the UPCOMING Mon-Fri week, NOT the prior one, so new-week Sunday activity is
// never compared against last week's availability/targets. Available-day math
// itself stays Mon-Fri.
//
// The working_day_adjustments table is server-only (RLS, no policy), so this
// is the boundary an AE reads their OWN context through. Only the caller's
// resulting numbers cross the wire — never another AE's PTO rows. Fails closed
// (502, safe message) if the adjustment read fails, so the client never
// silently shows a full 5-day week's targets when the data is unavailable.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const me = await requireAeToolAccess(req);

    // Paired Mon-Fri Monday of the current Sun-Sat activity week (rolls Sunday).
    const weekStart = pairedBusinessMonday();
    const { adjustments, error } = await fetchWeekAdjustments(
      getServerSupabase(),
      weekStart,
    );
    if (error) {
      // `error` is already a user-safe string (raw provider text logged inside
      // fetchWeekAdjustments).
      throw new ApiError(502, error);
    }

    const avail = weekAvailability({
      weekStart,
      salespersonId: me.id,
      adjustments,
    });

    return Response.json(
      {
        weekStart,
        availableDays: avail.availableDays,
        isHolidayWeek: avail.isHolidayWeek,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
