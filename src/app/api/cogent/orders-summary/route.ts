import { format, startOfMonth } from "date-fns";
import { z } from "zod";

import { ApiError, badRequest, handleApiError, requireAdmin } from "@/lib/server/auth";
import { getOrdersSummary } from "@/lib/server/cogent";
import { todayInAppTimezone } from "@/lib/dates";

// GET /api/cogent/orders-summary
//
// Admin-only. Returns AE production-order totals aggregated from Cogent's
// Orders API for a date window, plus any territories that map to no AE.
//
// Query params (both optional):
//   startDate  yyyy-MM-dd  default: first day of the current month
//   endDate    yyyy-MM-dd  default: today
//
// This route performs NO database writes — it only reads the
// cogent_territory_mappings table (via the library) to attribute Cogent
// territories to AEs. The Cogent API key never appears in the response or
// logs; only safe metadata (status, count, duration, unmapped count) is
// logged. See src/lib/server/cogent.ts for the aggregation rules.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** yyyy-MM-dd. Calendar-day strings, matching Cogent's date params and the
 *  DATE-typed columns elsewhere in the app (no timezone math). */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const QuerySchema = z.object({
  startDate: z.string().regex(DATE_RE).optional(),
  endDate: z.string().regex(DATE_RE).optional(),
});

export async function GET(req: Request) {
  try {
    await requireAdmin(req);

    const url = new URL(req.url);
    const parsed = QuerySchema.safeParse({
      startDate: url.searchParams.get("startDate") ?? undefined,
      endDate: url.searchParams.get("endDate") ?? undefined,
    });
    if (!parsed.success) {
      throw badRequest("startDate and endDate must be yyyy-MM-dd.");
    }

    // Anchor "today" and the month start to the app's business timezone
    // (Denver), NOT server-local time. On Vercel the function runs in UTC, so
    // `new Date()` after ~6pm Denver is already "tomorrow" in UTC — which
    // would shift the today/MTD window a day forward and miss the day's
    // orders. todayInAppTimezone() gives a Date whose calendar fields are the
    // current Denver day. (endDate is inclusive here; the Cogent library adds
    // the day needed for Cogent's exclusive end internally.)
    const todayAnchor = todayInAppTimezone();
    const today = format(todayAnchor, "yyyy-MM-dd");
    const startDate =
      parsed.data.startDate ?? format(startOfMonth(todayAnchor), "yyyy-MM-dd");
    const endDate = parsed.data.endDate ?? today;

    if (startDate > endDate) {
      throw badRequest("startDate must not be after endDate.");
    }

    let summary;
    try {
      summary = await getOrdersSummary({ startDate, endDate, today });
    } catch (err) {
      // Upstream/config failures from the library are operational, not 4xx.
      console.warn(`[cogent-orders-summary] failed err=${String(err)}`);
      throw new ApiError(502, "Could not retrieve the Cogent orders summary.");
    }

    // Log safe metadata ONLY — never the payload, never the key.
    console.log(
      `[cogent-orders-summary] OK status=${summary.meta.upstreamStatus} ` +
        `rows=${summary.meta.rowCount} aes=${summary.items.length} ` +
        `unmapped=${summary.meta.unmappedCount} durationMs=${summary.meta.durationMs}`,
    );

    return Response.json({
      startDate: summary.startDate,
      endDate: summary.endDate,
      items: summary.items,
      unmappedTerritories: summary.unmappedTerritories,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
