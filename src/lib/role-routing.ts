import type { UserRole } from "@/lib/permissions";

/**
 * Whether the given person should be treated as an admin for routing /
 * client-side guards.
 *
 * `role === "admin"` is the single source of truth — same gate as
 * server-side `requireAdmin` and the login PIN check. The legacy
 * `is_admin` boolean still exists on the salespeople row for DB-level
 * compatibility but is no longer consulted anywhere in app code.
 */
export function isAdminUser(person: { role: UserRole }): boolean {
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
export function landingPathFor(person: { role: UserRole }): string {
  if (isAdminUser(person)) return "/admin";
  if (person.role === "juice_box_only") return "/juice-box";
  return "/dashboard";
}
