import type { UserRole } from "@/lib/permissions";

/**
 * Whether the given person should be treated as an admin for routing /
 * client-side guards.
 *
 * `role === "admin"` is the single source of truth — both for client
 * routing and for server-side admin APIs (`requireAdmin` in
 * src/lib/server/auth.ts). The legacy `is_admin` boolean still lives
 * on the row and on the stored session for display purposes (the "Admin"
 * label on /more, the admin Home tab in bottom-nav), but it never grants
 * routing or access by itself.
 *
 * Keeping both signals aligned means a drifted row (`is_admin=true,
 * role='ae'` or `role='admin', is_admin=false`) consistently behaves as
 * its `role` says, both on landing and on server gates — no "lands on
 * /admin but every API 403s" partial-admin state. See the README /
 * deploy notes for the SQL query that finds and reconciles drift.
 */
export function isAdminUser(person: {
  is_admin?: boolean | null;
  role: UserRole;
}): boolean {
  return person.role === "admin";
}

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
  if (isAdminUser(person)) return "/admin";
  if (person.role === "juice_box_only") return "/juice-box";
  return "/dashboard";
}
