import { APP_TIMEZONE } from "@/lib/dates";
import { syncOrders } from "@/lib/server/orders";

// GET /api/cron/orders-sync
//
// Vercel Cron target. Pulls the latest orders from the Cogent integration
// endpoint and refreshes the singleton `order_snapshot` cache that the AE Home
// and Admin orders screens read. Scheduled every 15 minutes (see vercel.json);
// the schedule is in UTC and broadly covers the active window, and this route
// then ENFORCES the exact window 7:00–23:00 Mountain Time (DST-correct) and
// skips outside it. Logging (start/success/failure/duration) lives in
// syncOrders so cron + manual refresh log identically.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Active window 7:00 AM … 11:00 PM Mountain Time, INCLUSIVE of both ends
// (minutes-of-day: 420 … 1380). Inclusive end means the 11:00 PM tick runs but
// 11:15 PM does not.
const WINDOW_START_MIN = 7 * 60; // 7:00 AM MT
const WINDOW_END_MIN = 23 * 60; // 11:00 PM MT

/** Current minutes-of-day (0–1439) in the app (Mountain) timezone, DST-correct. */
function currentAppMinutes(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIMEZONE,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "12");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const hh = Number.isFinite(h) ? h % 24 : 12; // some impls render midnight as "24"
  const mm = Number.isFinite(m) ? m : 0;
  return hh * 60 + mm;
}

export async function GET(req: Request) {
  // CRON_SECRET is REQUIRED — the endpoint must never be publicly triggerable.
  // Vercel Cron sends it as `Authorization: Bearer <CRON_SECRET>`.
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    // Misconfiguration, not an auth failure: refuse to run rather than expose
    // an unauthenticated sync trigger.
    console.error(
      "[orders-sync] CRON_SECRET is not configured; refusing to run the cron route",
    );
    return new Response("CRON_SECRET is not configured on the server.", {
      status: 503,
    });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const mins = currentAppMinutes();
  if (mins < WINDOW_START_MIN || mins > WINDOW_END_MIN) {
    console.log(`[orders-sync] skipped — outside window (MT min-of-day=${mins})`);
    return Response.json({ skipped: true, mtMinutes: mins });
  }

  try {
    const result = await syncOrders();
    return Response.json({
      ok: true,
      refreshedAt: result.refreshedAt,
      durationMs: result.durationMs,
      aes: result.data.items.length,
    });
  } catch {
    // syncOrders already logged the failure with duration. Return 500 so Vercel
    // marks the cron invocation failed (and retries on the next tick).
    return new Response("Orders sync failed", { status: 500 });
  }
}
