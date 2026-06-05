import { APP_TIMEZONE } from "@/lib/dates";
import { syncOrders } from "@/lib/server/orders";

// GET /api/cron/orders-sync
//
// Vercel Cron target. Pulls the latest orders from the Cogent integration
// endpoint and refreshes the singleton `order_snapshot` cache that the AE Home
// and Admin orders screens read.
//
// SCHEDULE (see vercel.json): every 15 minutes across a broad UTC range. Vercel
// Cron runs only in UTC and has no per-cron timezone, and the UTC↔Mountain
// offset shifts with DST — so the cron range is intentionally wide and THIS
// ROUTE enforces the exact Mountain-Time windows (DST-correct via Intl),
// skipping ticks that fall outside them. Two windows:
//
//   • DAYTIME FRESHNESS — 5:00 AM … 11:00 PM MT, every 15 min. Keeps Today
//     Orders current via the MTD baseline delta during business hours.
//
//   • MIDNIGHT ROLLOVER — ~12:00–12:15 AM MT. The first sync of the new MT day
//     creates that day's baseline row from current MTD totals, so Today Orders
//     reset to 0 right after midnight — before any AE opens the app — instead
//     of waiting for the first daytime sync. This is purely a TIMING change:
//     the baseline-delta math in syncOrders is unchanged.
//
// Between 12:15 AM and 5:00 AM MT no sync runs. Logging (start/success/failure/
// duration) lives in syncOrders so cron + manual refresh log identically.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Daytime freshness window 5:00 AM … 11:00 PM Mountain Time, INCLUSIVE of both
// ends (minutes-of-day: 300 … 1380). Inclusive end means the 11:00 PM tick runs
// but 11:15 PM does not.
const DAY_START_MIN = 5 * 60; // 5:00 AM MT
const DAY_END_MIN = 23 * 60; // 11:00 PM MT

// Midnight rollover window 12:00 … 12:15 AM Mountain Time (minutes-of-day:
// 0 … 15). The first sync of the new MT day lands here and creates the new
// daily baseline (Today → 0). The 12:15 tick is a redundant guard in case the
// 12:00 tick is missed or fires with a little clock skew.
const ROLLOVER_START_MIN = 0; // 12:00 AM MT
const ROLLOVER_END_MIN = 15; // 12:15 AM MT

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
  const inDaytime = mins >= DAY_START_MIN && mins <= DAY_END_MIN;
  const inRollover = mins >= ROLLOVER_START_MIN && mins <= ROLLOVER_END_MIN;
  if (!inDaytime && !inRollover) {
    console.log(
      `[orders-sync] skipped — outside daytime/rollover windows (MT min-of-day=${mins})`,
    );
    return Response.json({ skipped: true, mtMinutes: mins });
  }
  if (inRollover) {
    // Fires at most ~twice/day; not noisy. Marks the baseline rollover/reset.
    console.log(
      `[orders-sync] midnight rollover tick (MT min-of-day=${mins}) — first sync of the new MT day; new baseline → Today=0`,
    );
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
