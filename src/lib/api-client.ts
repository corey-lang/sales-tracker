/**
 * Client-side fetch wrapper that attaches the signed session token.
 *
 * Every call to an authenticated API route (the business-card workflow, and
 * future CRM routes) must go through apiFetch so the server can identify the
 * caller. The token is read from the same localStorage entry useSalesperson
 * manages — see src/lib/use-salesperson.ts and src/lib/server/auth.ts.
 *
 * Browser-only: importable from "use client" components.
 */

import { STORAGE_KEY } from "@/lib/use-salesperson";

function readToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw) as { token?: unknown };
    return typeof obj.token === "string" && obj.token.length > 0
      ? obj.token
      : null;
  } catch {
    return null;
  }
}

/**
 * Like fetch(), but adds `Authorization: Bearer <token>` from the stored
 * session. If there is no token the request still goes out (and the server
 * answers 401) so callers surface a clear "sign in again" error.
 */
export function apiFetch(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = readToken();
  const headers = new Headers(init.headers);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(input, { ...init, headers });
}
