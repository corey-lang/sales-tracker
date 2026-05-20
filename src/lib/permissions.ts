export type UserRole = "admin" | "assistant" | "ae";

export function isUserRole(value: unknown): value is UserRole {
  return value === "admin" || value === "assistant" || value === "ae";
}

/**
 * Whether a salesperson is the test account.
 *
 * Source of truth: the `salespeople.is_test` boolean column. Every code path
 * that produces a salesperson object — /api/auth/login (route.ts) and
 * requireSalesperson (server/auth.ts) — populates this flag from the row.
 * Client sessions are gated on a token issued by /api/auth/login, and any
 * pre-Phase-0 session without a token is invalidated by `hydrate` in
 * use-salesperson.ts. So `is_test` is reliably present on every salesperson
 * that ever reaches this function; a name-based fallback is no longer needed.
 *
 * Every call site that uses this gate must also remain strictly read-only /
 * non-persisting; the test account must never produce real records, exports,
 * or metric impact.
 */
export function isTestAccount(salesperson: {
  is_test?: boolean | null;
}): boolean {
  return salesperson.is_test === true;
}
