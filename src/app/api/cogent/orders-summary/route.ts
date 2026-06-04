import { handleApiError, requireAdmin } from "@/lib/server/auth";
import { readOrdersSnapshot } from "@/lib/server/orders";

// GET /api/cogent/orders-summary
//
// Admin-only. CACHE-ONLY read of the month-to-date orders rollup from the
// singleton `order_snapshot` (populated by the cron + admin manual refresh).
// This route NEVER calls Cogent live — page loads must not trigger an upstream
// fetch. For a raw upstream/diagnostic probe use the separate, admin-gated
// /api/cogent/test route.
//
// Until the first successful sync, returns a clean `synced:false` empty state
// (200) so the admin page renders and the Refresh button can populate it.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await requireAdmin(req);

    const snap = await readOrdersSnapshot();
    if (!snap) {
      return Response.json({
        startDate: "",
        endDate: "",
        pace: null,
        company: null,
        items: [],
        unmappedTerritories: [],
        refreshedAt: null,
        synced: false,
      });
    }

    const monthly = snap.data;
    return Response.json({
      startDate: monthly.startDate,
      endDate: monthly.endDate,
      pace: monthly.pace,
      company: monthly.company,
      items: monthly.items,
      unmappedTerritories: monthly.unmappedTerritories,
      refreshedAt: snap.refreshedAt,
      synced: true,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
