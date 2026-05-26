import { handleApiError, requireSalesperson } from "@/lib/server/auth";

// GET /api/me/permissions
//
// Returns the caller's live permission state straight from the
// salespeople row. Used by the UI to refresh permission-gated surfaces
// (currently /office-imports + /more's office-import link) without
// requiring a logout/login cycle when an admin grants or revokes
// access.
//
// AUTHORITY MODEL
//   This endpoint is NOT the source of truth for any write — every
//   mutating route still re-reads its own permissions via
//   `requireOfficeImporter` / `requireAdmin` / etc. This route just
//   surfaces the same live values to the UI so visibility can match.
//
// AUTH
//   requireSalesperson(req) — any signed-in salesperson (including
//   juice_box_only). The response shape never includes anything that
//   isn't already visible to the caller's own UI; no other users'
//   permissions are exposed.
//
// CACHE
//   `private, no-store` — permissions can change at any time and the
//   point of this endpoint is to defeat stale caches.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type LivePermissionsResponse = {
  is_admin: boolean;
  role: "admin" | "assistant" | "ae" | "juice_box_only";
  can_import_offices: boolean;
};

export async function GET(req: Request) {
  try {
    const me = await requireSalesperson(req);
    const body: LivePermissionsResponse = {
      is_admin: me.is_admin,
      role: me.role,
      can_import_offices: me.can_import_offices,
    };
    return Response.json(body, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
