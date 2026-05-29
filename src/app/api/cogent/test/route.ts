import { format, startOfMonth } from "date-fns";

import { handleApiError, ApiError, requireAdmin } from "@/lib/server/auth";
import {
  COGENT_ORDERS_REPORT_URL,
  COGENT_PRODUCTION_FILTER,
} from "@/lib/server/cogent";

// POST /api/cogent/test
//
// TEMPORARY DIAGNOSTIC ROUTE — not part of the product surface.
//
// ADMIN-ONLY. The raw upstream payload may contain customer data and the
// route is a thin proxy to Cogent, so it is gated with requireAdmin() — same
// gate as /api/cogent/orders-summary. It is NOT publicly callable; a missing
// or non-admin session gets 401/403 before any Cogent call is made.
//
// Purpose: verify connectivity to Cogent's Orders API and let us
// eyeball the *real* response shape before we design any storage
// or UI around it. It does no DB writes, touches no schema, and
// renders no UI. Delete it once the integration shape is settled.
//
// It POSTs to Cogent's `/orders-report` for the current month
// (1st of the month → today) and streams the raw upstream JSON
// straight back to the caller so we can inspect it verbatim.
//
// The request flags encode the AE production-order business rule so
// the test payload matches what the AE Orders tile will eventually
// use. Included toward AE order counts/targets: Buyers Coverage,
// Real Estate Runoff, Property Management Coverage. Excluded:
// Homeowner Coverage, Renewal Coverage, Sellers Coverage.
//
// Auth to Cogent is via the `x-api-key` header, sourced from the
// `COGENT_API_KEY` env var (server-side only — never NEXT_PUBLIC_).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Best-effort count of records in an unknown upstream payload, for
 *  logging only. Cogent's exact shape is what we're here to learn,
 *  so we probe the common cases (top-level array, or an object with
 *  an array under a likely key) and fall back to "unknown". */
function countRecords(payload: unknown): number | "unknown" {
  if (Array.isArray(payload)) return payload.length;
  if (payload && typeof payload === "object") {
    for (const key of ["orders", "data", "results", "items", "records"]) {
      const value = (payload as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value.length;
    }
  }
  return "unknown";
}

export async function POST(req: Request) {
  try {
    // Admin gate first — reject unauthenticated/non-admin callers before
    // touching the Cogent API or the key.
    await requireAdmin(req);

    const apiKey = process.env.COGENT_API_KEY?.trim();
    if (!apiKey) {
      console.warn(
        "[cogent-test] COGENT_API_KEY is not set; cannot reach the Orders API",
      );
      throw new ApiError(
        500,
        "COGENT_API_KEY is not configured on the server.",
      );
    }

    // Current month: first day of the month → today. `date-fns`
    // formats in the server's local time; for a diagnostic that's
    // fine — we just need a sane current-month window to inspect.
    const now = new Date();
    // AE production order logic lives in COGENT_PRODUCTION_FILTER (shared with
    // src/lib/server/cogent.ts so the diagnostic and the real aggregation can
    // never drift): count only Buyers Coverage, Real Estate Runoff, and
    // Property Management Coverage. Homeowner, Renewal, and Sellers coverage
    // are excluded — they must not count toward AE production or targets.
    const requestBody = {
      startDate: format(startOfMonth(now), "yyyy-MM-dd"),
      endDate: format(now, "yyyy-MM-dd"),
      useEffectiveDate: false,
      ...COGENT_PRODUCTION_FILTER,
    };

    let res: Response;
    try {
      res = await fetch(COGENT_ORDERS_REPORT_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(requestBody),
        cache: "no-store",
      });
    } catch (err) {
      console.warn(`[cogent-test] upstream fetch failed err=${String(err)}`);
      throw new ApiError(502, "Failed to reach the Cogent Orders API.");
    }

    // Read the body as text first so we can surface a useful error
    // even when the upstream returns non-JSON (HTML error page, etc).
    const text = await res.text();
    let payload: unknown;
    try {
      payload = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      console.warn(
        `[cogent-test] upstream returned non-JSON status=${res.status} len=${text.length}`,
      );
      throw new ApiError(
        502,
        "Cogent Orders API returned a non-JSON response.",
      );
    }

    if (!res.ok) {
      console.warn(
        `[cogent-test] upstream non-200 status=${res.status} count=${countRecords(
          payload,
        )}`,
      );
      // Pass the upstream status + parsed body through so we can see
      // exactly how Cogent reports errors during diagnosis.
      return Response.json(
        { upstreamStatus: res.status, body: payload },
        { status: 502 },
      );
    }

    // Log the record count ONLY — never the full payload (it may be
    // large and may contain customer data).
    console.log(
      `[cogent-test] OK status=${res.status} count=${countRecords(payload)}`,
    );

    return Response.json(payload, { status: 200 });
  } catch (err) {
    return handleApiError(err);
  }
}
