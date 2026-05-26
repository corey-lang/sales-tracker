import {
  ApiError,
  badRequest,
  handleApiError,
  requireSalesperson,
} from "@/lib/server/auth";
import { fetchLinkPreview } from "@/lib/server/link-preview";

// GET /api/link-preview?url=<encoded>
//
// AUTH
//   requireSalesperson(req) — any signed-in salesperson (including
//   juice_box_only guests, since the Juice Box surface is open to the
//   whole team). Identity comes from the signed session; the URL is the
//   only thing read from the client.
//
// SHAPE
//   200  { preview: LinkPreview }
//   400  { error } — missing/invalid url query parameter
//   404  { error } — fetch failed, blocked host, non-HTML, etc.
//   429  { error } — per-user rate-limit exceeded
//   The client renders nothing on any 4xx/5xx (calm degradation).
//
// SSRF / ABUSE
//   The heavy lifting is in `fetchLinkPreview()`:
//     * http/https only, embedded credentials stripped
//     * DNS-resolve to a PUBLIC IP, then PIN the socket to that IP via
//       node:http(s) `lookup` override — closes the rebind window
//       between DNS check and actual connect
//     * 3-hop redirect cap with per-hop re-resolve + re-pin
//     * 5s total timeout, 512 KB body cap, text/html required
//   This route adds two more layers:
//     * Auth gate (requireSalesperson) — no anon fetches
//     * Per-user in-memory rate limit so a signed-in user can't drive
//       arbitrary outbound fetches in a loop. Lightweight, no DB.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Per-user rate limit (lightweight, in-process)
// ---------------------------------------------------------------------------
//
// Vercel runs multiple isolated invocations of this function, so this is
// per-instance, not strictly global. That's fine for the goal here —
// the limit prevents a single client from looping outbound fetches
// against ONE instance at full speed. A determined attacker spreading
// across instances would hit the rate limit on most calls anyway since
// Vercel sticks subsequent requests from a warm client to the same
// instance for performance.
//
// Sliding-window counter, 60s window, RATE_LIMIT_MAX requests per
// salesperson per window. Set generously above any realistic UI burst
// (a long feed with many distinct preview URLs) so genuine usage never
// hits it — the goal is to bound abuse loops, not legitimate browsing.

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;

/** Timestamps of recent requests per salesperson id. Pruned lazily. */
const recentHits = new Map<string, number[]>();

/**
 * Returns true if the caller is allowed (and records the hit). Returns
 * false when the per-window count would exceed RATE_LIMIT_MAX — the
 * route then responds 429.
 */
function admit(salespersonId: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const prior = recentHits.get(salespersonId);
  const fresh = prior ? prior.filter((t) => t > cutoff) : [];

  if (fresh.length >= RATE_LIMIT_MAX) {
    // Persist the pruned list so a stalled offender doesn't see a
    // "fresh" window after timestamps roll off below their cap.
    recentHits.set(salespersonId, fresh);
    return false;
  }
  fresh.push(now);
  recentHits.set(salespersonId, fresh);

  // Bound memory by occasionally sweeping fully-expired users.
  // Triggered probabilistically so a steady stream of requests can't
  // pay the full O(N) sweep cost on every call.
  if (recentHits.size > 200 && Math.random() < 0.05) {
    for (const [uid, hits] of recentHits) {
      const pruned = hits.filter((t) => t > cutoff);
      if (pruned.length === 0) recentHits.delete(uid);
      else if (pruned.length !== hits.length) recentHits.set(uid, pruned);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export async function GET(req: Request) {
  try {
    const me = await requireSalesperson(req);

    if (!admit(me.id)) {
      return Response.json(
        { error: "Rate limit exceeded — try again shortly." },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)),
          },
        },
      );
    }

    const raw = new URL(req.url).searchParams.get("url");
    if (!raw || raw.length === 0) {
      throw badRequest("Missing `url` query parameter.");
    }
    if (raw.length > 2048) {
      throw badRequest("URL is too long.");
    }

    const preview = await fetchLinkPreview(raw);
    if (!preview) {
      // 404 — the client treats this as "no preview available" and
      // renders nothing. All failure reasons collapse to the same
      // status so a probe can't distinguish "blocked private IP" from
      // "non-HTML" from "timeout."
      throw new ApiError(404, "No preview available.");
    }

    return Response.json(
      { preview },
      {
        headers: {
          "Cache-Control":
            "private, max-age=3600, s-maxage=3600, stale-while-revalidate=86400",
        },
      },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
