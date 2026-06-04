import { handleApiError, requireAeToolAccess } from "@/lib/server/auth";
import { readOrdersSnapshot } from "@/lib/server/orders";
import { paceVerdict } from "@/lib/working-days";

// GET /api/me/orders
//
// The current AE's month-to-date production orders (from Cogent) + today's
// count + order pace. Returns ONLY the caller's own numbers — never other AEs'.
// AE-accessible (requireAeToolAccess excludes juice_box_only guests; the card
// only renders on the AE Home branch anyway).
//
// Fails GRACEFULLY: if Cogent is unavailable, responds 200 { available: false }
// so the Home card can show a quiet "unavailable" state without breaking Home.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // Auth errors are real 401/403s; surface them normally.
  let me;
  try {
    me = await requireAeToolAccess(req);
  } catch (err) {
    return handleApiError(err);
  }

  try {
    // Read the CACHED snapshot ONLY (cron/manual-refresh populated) — a page
    // load never calls Cogent. No snapshot yet → unavailable until first sync.
    const snap = await readOrdersSnapshot();
    if (!snap) {
      return Response.json({ available: false });
    }
    const monthly = snap.data;
    const mine = monthly.items.find((i) => i.salespersonId === me.id);

    // An AE with no Cogent territory mapping (e.g. test accounts) has no orders.
    const orders = mine
      ? {
          orderCount: mine.orderCount,
          orderTarget: mine.orderTarget,
          percentToGoal: mine.percentToGoal,
          todayOrders: mine.todayOrders,
          verdict: mine.verdict,
          pacePercent: mine.pacePercent,
        }
      : {
          orderCount: 0,
          orderTarget: 0,
          percentToGoal: null,
          todayOrders: 0,
          // percentToGoal is null here, so the verdict is "none" regardless.
          verdict: paceVerdict(null, monthly.pace?.expectedPercent ?? 0),
          pacePercent: null,
        };

    return Response.json({
      available: true,
      startDate: monthly.startDate,
      endDate: monthly.endDate,
      pace: monthly.pace,
      orders,
      refreshedAt: snap.refreshedAt,
    });
  } catch (err) {
    // Orders endpoint/config failure — degrade, don't break Home.
    console.warn(`[me-orders] orders unavailable err=${String(err)}`);
    return Response.json({ available: false });
  }
}
