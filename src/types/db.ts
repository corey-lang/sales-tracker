import type { UserRole } from "@/lib/permissions";

export type Salesperson = {
  id: string;
  first_name: string;
  location: string | null;
  is_admin: boolean;
  // True for accounts used to test the app. Excluded from leaderboards so
  // their activity doesn't pollute team standings. Still appears in admin
  // views so the admin can see / debug what was logged.
  is_test: boolean;
  // Plaintext PIN required to log in as this user when is_admin=true.
  // Not exposed via the bulk salespeople fetch in the login screen —
  // only fetched at submit time to compare against the entered value.
  admin_pin: string | null;
  // Source of truth for permission checks. is_admin remains for legacy
  // queries that filter on the boolean.
  role: UserRole;
  created_at: string;
};
