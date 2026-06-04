import { handleApiError, requireAdmin } from "@/lib/server/auth";
import { syncOrders } from "@/lib/server/orders";

// POST /api/admin/cogent/refresh
//
// Admin manual "Refresh" — runs the SAME sync logic as the cron
// (/api/cron/orders-sync → syncOrders): pulls fresh orders from Cogent,
// updates the singleton cache + last_successful_refresh, and returns the fresh
// rollup so the admin screen updates immediately. Admin-only.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    await requireAdmin(req);
    const { data, refreshedAt } = await syncOrders();
    return Response.json({
      startDate: data.startDate,
      endDate: data.endDate,
      pace: data.pace,
      company: data.company,
      items: data.items,
      unmappedTerritories: data.unmappedTerritories,
      refreshedAt,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
