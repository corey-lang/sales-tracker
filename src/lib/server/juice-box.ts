import {
  forbidden,
  requireSalesperson,
  type AuthedSalesperson,
} from "@/lib/server/auth";

/**
 * Server-side gate for the Juice Box feature during the test rollout.
 *
 * Juice Box is intentionally limited to admin + test accounts until the rest
 * of the team is onboarded. Regular AEs are blocked at the UI layer (the
 * bottom-nav tab is hidden, and /juice-box redirects to /dashboard), but the
 * API routes must enforce the same rule independently — a route that trusts
 * the UI is a route that can be hit with `curl`.
 *
 * Mirrors the requireSalesperson / requireAdmin contract: returns the caller
 * on success, throws an ApiError otherwise (handleApiError converts it).
 */
export async function requireJuiceBoxAccess(
  req: Request,
): Promise<AuthedSalesperson> {
  const me = await requireSalesperson(req);
  if (!me.is_admin && !me.is_test) {
    throw forbidden("Juice Box is not available for your account yet.");
  }
  return me;
}
