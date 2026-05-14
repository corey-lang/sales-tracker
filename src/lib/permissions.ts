export type UserRole = "admin" | "assistant" | "ae";

export function isUserRole(value: unknown): value is UserRole {
  return value === "admin" || value === "assistant" || value === "ae";
}

// TODO: replace this name-based check with a real `is_test_account` column on
// the salespeople table. Today the only test row is the seeded "Test"
// salesperson (see supabase/seed.sql), and CITEXT makes first_name
// case-insensitive in the DB — normalize here since the value also flows
// through localStorage. Every call site that uses this gate must also remain
// strictly read-only / non-persisting; the test account must never produce
// real records, exports, or metric impact.
export function isTestAccount(salesperson: { first_name: string }): boolean {
  return salesperson.first_name.trim().toLowerCase() === "test";
}
