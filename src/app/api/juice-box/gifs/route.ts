import { handleApiError } from "@/lib/server/auth";
import { requireJuiceBoxAccess } from "@/lib/server/juice-box";
import { searchGiphy } from "@/lib/server/giphy";

// Juice Box — proxy to the GIPHY API.
//
//   GET /api/juice-box/gifs[?q=<query>&limit=N]
//   ->  { configured: boolean, results: GifResult[] }
//
// PURPOSE
//   Keeps the GIPHY API key server-side. The browser-side GIF picker
//   never sees the key, never talks to GIPHY directly, and can only
//   reach this route under the same admin/test gate as the rest of the
//   Juice Box surface.
//
// GRACEFUL DEGRADATION
//   When GIPHY_API_KEY is unset, the route still answers 200 with
//   `{ configured: false, results: [] }`. The picker uses that flag to
//   render a "GIF search not configured yet" empty state without
//   throwing a network error.
//
// SECURITY
//   * Auth: admin OR test only (requireJuiceBoxAccess). Regular AEs 403.
//   * Limit is clamped to [1, MAX_LIMIT] server-side.
//   * No tracking parameters or salesperson ids leak to GIPHY.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LIMIT = 30;
const DEFAULT_LIMIT = 20;

export async function GET(req: Request) {
  try {
    await requireJuiceBoxAccess(req);

    const url = new URL(req.url);
    const limitParam = url.searchParams.get("limit");
    const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : NaN;
    const limit = Number.isFinite(parsedLimit)
      ? Math.max(1, Math.min(MAX_LIMIT, parsedLimit))
      : DEFAULT_LIMIT;
    const q = url.searchParams.get("q") ?? "";

    const results = await searchGiphy({ q, limit });
    if (results === null) {
      // GIPHY_API_KEY unset — degrade gracefully.
      return Response.json({ configured: false, results: [] });
    }
    return Response.json({ configured: true, results });
  } catch (err) {
    return handleApiError(err);
  }
}
