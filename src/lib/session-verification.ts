// Decides what the SIGN-IN screen should do about a session already sitting in
// localStorage.
//
// THE LOOP THIS EXISTS TO PREVENT
//   The sign-in page used to redirect to the landing page whenever a stored
//   session OBJECT was present — without checking whether it still works. With
//   a stale token that produced a hard loop:
//
//     /  sees stored session      → replace("/dashboard")
//     /dashboard gets 401         → replace("/")
//     /  still sees that session  → replace("/dashboard")   … forever
//
//   Two rules break it, and both live here so they can be tested without a
//   browser:
//     1. Presence is not proof. A stored session earns a redirect only after the
//        SERVER confirms it (GET /api/me/permissions → 200).
//     2. A 401 means the token is dead: clear it ONCE and STAY on sign-in. The
//        next render then sees no session at all, so there is nothing left to
//        redirect on.
//
//   A non-401 failure (5xx, offline) is explicitly NOT treated as proof of
//   expiry: clearing a possibly-valid session because the server hiccuped would
//   log people out for no reason, and redirecting on it would re-open the loop.
//   We keep the session, stay put, and let the user sign in again if they want.
//
// Pure module — no React, no DOM, no fetch. The page supplies the inputs.

import type { UserRole } from "@/lib/permissions";

export type SessionVerdict =
  /** Nothing stored (or it was just cleared) — show the name picker. */
  | { kind: "no-session" }
  /** Stored session, verification still in flight — show a stable loading
   *  state. Never redirect from here. */
  | { kind: "verifying" }
  /** Server confirmed the session. Redirect ONCE to this role's landing page. */
  | { kind: "valid"; role: UserRole }
  /** Server rejected the session (401). Clear it once; stay on sign-in. */
  | { kind: "invalid" }
  /** The check itself failed. Keep the session, stay on sign-in, no loop. */
  | { kind: "unknown" };

export function sessionVerdict(input: {
  /** True once localStorage hydration has run (useSalesperson().loaded). */
  loaded: boolean;
  /** Whether a stored session is currently held. */
  hasStoredSession: boolean;
  /** True once the verification request has completed (success OR failure). */
  settled: boolean;
  /** HTTP status of that request; null when it never completed (offline). */
  status: number | null;
  /** Role the SERVER reported, when it answered 200. */
  role: UserRole | null;
}): SessionVerdict {
  // Before hydration we don't know whether a session exists. Treat it as
  // "verifying" so the screen shows one stable loading state instead of
  // flashing the picker and then replacing it.
  if (!input.loaded) return { kind: "verifying" };
  if (!input.hasStoredSession) return { kind: "no-session" };
  if (!input.settled) return { kind: "verifying" };

  if (input.status === 401) return { kind: "invalid" };
  // 200 without a usable role is not a confirmation — fall through to
  // "unknown" rather than redirecting somewhere arbitrary.
  if (input.status === 200 && input.role) {
    return { kind: "valid", role: input.role };
  }
  return { kind: "unknown" };
}

/** True for the one verdict that may navigate. Keeps the "redirect at most
 *  once, and only on a server-confirmed session" rule in one place. */
export function verdictShouldRedirect(verdict: SessionVerdict): boolean {
  return verdict.kind === "valid";
}

/** True for the one verdict that may delete the stored session. */
export function verdictShouldClearSession(verdict: SessionVerdict): boolean {
  return verdict.kind === "invalid";
}
