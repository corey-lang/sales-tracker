import { getServerSupabase } from "@/lib/supabase/server";
import { mondayOfWeek } from "@/lib/goals";
import { weekAvailability } from "@/lib/working-days";
import {
  ApiError,
  handleApiError,
  requireAeToolAccess,
} from "@/lib/server/auth";
import { fetchWeekAdjustments } from "@/lib/server/working-days";

// GET /api/me/working-days
//
// Returns the SIGNED-IN AE's available-day context for the CURRENT business
// week — { weekStart, availableDays, isHolidayWeek } — so the dashboard can
// show adjusted weekly targets and the "X Available Days" banner.
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

    const weekStart = mondayOfWeek();
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
