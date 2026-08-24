import type { UserRole } from "@/lib/permissions";

export type Salesperson = {
  id: string;
  first_name: string;
  location: string | null;
  // Legacy boolean kept on the DB row for compatibility but no longer
  // consulted by app logic — `role === "admin"` is the single source of
  // truth (see src/lib/role-routing.ts, src/lib/server/auth.ts).
  is_admin: boolean;
  // True for accounts used to test the app. Excluded from leaderboards so
  // their activity doesn't pollute team standings. Still appears in admin
  // views so the admin can see / debug what was logged.
  is_test: boolean;
  // Plaintext PIN required to log in as this user when role='admin'.
  // Not exposed via the bulk salespeople fetch in the login screen —
  // only fetched at submit time to compare against the entered value.
  admin_pin: string | null;
  // Source of truth for permission checks.
  role: UserRole;
  // Soft-disable for someone who has left the company. `null` = on the
  // active roster; a timestamp = deactivated then. The row itself is never
  // deleted (every historical record FKs to it), so the active-roster
  // predicate everywhere is `deactivated_at IS NULL`. Login refuses a
  // deactivated row and `requireSalesperson` 401s every API request from
  // one. See supabase/salespeople_deactivated_at.sql.
  deactivated_at: string | null;
  created_at: string;
};
