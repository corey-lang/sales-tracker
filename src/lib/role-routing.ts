import type { UserRole } from "@/lib/permissions";

/**
 * The page a signed-in user should land on after auth (or after being
 * bounced from a page they don't have access to).
 *
 *   * admin  → /admin
 *   * juice_box_only → /juice-box (their only allowed surface)
 *   * everyone else → /dashboard
 *
 * Single source of truth so the login page, sign-in restoration in
 * `app/page.tsx`, and the per-page guards on /dashboard, /leaderboard,
 * /todos, /scan-biz-card all bounce the new role consistently.
 */
export function landingPathFor(person: {
  is_admin: boolean;
  role: UserRole;
}): string {
  if (person.is_admin) return "/admin";
  if (person.role === "juice_box_only") return "/juice-box";
  return "/dashboard";
}
