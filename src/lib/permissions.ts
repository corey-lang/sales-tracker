export type UserRole = "admin" | "assistant" | "ae";

export function isUserRole(value: unknown): value is UserRole {
  return value === "admin" || value === "assistant" || value === "ae";
}

/**
 * Whether a salesperson is the test account.
 *
 * Source of truth: the `salespeople.is_test` boolean column. Every code path
 * that loads a salesperson from the DB (the /api/auth/login response,
 * requireSalesperson) now ships this flag, so call sites read the
 * authoritative value regardless of what the row's first_name happens to be
 * — "Test", "QA Test", "Demo", a real person flagged for test, etc. all work.
 *
 * Fallback: if `is_test` isn't present (e.g. a localStorage session written
 * before this fix), we still match a case-insensitive first_name of "test"
 * so the seeded Test account keeps working without forcing a re-login.
 *
 * Every call site that uses this gate must also remain strictly read-only /
 * non-persisting; the test account must never produce real records, exports,
 * or metric impact.
 */
export function isTestAccount(salesperson: {
  first_name?: string | null;
  is_test?: boolean | null;
}): boolean {
  if (salesperson.is_test === true) return true;
  const name = salesperson.first_name;
  return (
    typeof name === "string" && name.trim().toLowerCase() === "test"
  );
}
