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

/** An error from apiFetchJson carrying the HTTP status so callers can branch
 *  (e.g. 401 → "sign in again"). `.message` is always human-readable. */
export class ApiResponseError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "ApiResponseError";
  }
}

/**
 * apiFetch + safe JSON parsing. Use this instead of `apiFetch(...).then(r =>
 * r.json())` so a NON-JSON response never throws the cryptic
 * "Unexpected token '<', '<!DOCTYPE'... is not valid JSON".
 *
 * That symptom means the fetch resolved to an HTML page — almost always a
 * Next 404/redirect page because the request hit the wrong origin or a route
 * that isn't deployed, NOT a real API JSON error. We detect the non-JSON body
 * and throw an ApiResponseError describing the HTTP status, content-type, and
 * the first 200 chars of the body so the actual cause is visible.
 *
 * On a JSON error response (res not ok) it throws the server's `error` string.
 */
export async function apiFetchJson<T>(
  input: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await apiFetch(input, init);
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";

  let parsed: unknown;
  let parseFailed = false;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parseFailed = true;
    }
  }

  if (parseFailed) {
    const snippet = text.slice(0, 200).replace(/\s+/g, " ").trim();
    throw new ApiResponseError(
      `Expected JSON but received ${contentType || "an unknown content type"} ` +
        `(HTTP ${res.status}) from ${input}. First 200 chars: ${snippet}`,
      res.status,
    );
  }

  if (!res.ok) {
    const message =
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof (parsed as { error?: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : `Request to ${input} failed with HTTP ${res.status}.`;
    throw new ApiResponseError(message, res.status);
  }

  return parsed as T;
}
