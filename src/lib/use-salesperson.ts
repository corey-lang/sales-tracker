"use client";

import { useCallback, useEffect, useState } from "react";

import { isUserRole, type UserRole } from "@/lib/permissions";

export const STORAGE_KEY = "sales-tracker:salesperson";

// ---------------------------------------------------------------------------
// SECURITY MODEL — read before using anything from this module in a gate
// ---------------------------------------------------------------------------
//
// Everything here comes out of localStorage, which the user owns and can edit
// freely from devtools. NOTHING returned by this hook is an authorization
// decision. Use it for navigation and chrome only (which tabs to render, which
// greeting, where to bounce a wrong-role visitor for UX).
//
// The real boundary is server-side, on every request: `requireSalesperson`
// verifies the token's HMAC, RE-READS the `salespeople` row, and the
// role/ownership guards (`requireAeToolAccess`, `requireAdmin`,
// `requireReviewer`, `requireOfficeImporter`, …) decide from that row — so a
// tampered role in localStorage grants exactly nothing. A surface that needs a
// trustworthy role for RENDERING (rather than just chrome) should read it from
// `useLivePermissions()` / GET /api/me/permissions, which is the DB's answer.
//
// Defence in depth for the UX layer: `role` is taken from the SIGNED token's
// payload claim rather than from the sibling `role` field in the stored JSON.
// Editing `role` in localStorage therefore doesn't even change the client
// chrome, and editing the token body invalidates its signature, so every API
// call 401s. This is not a substitute for the server checks above — it just
// removes the trivially-editable knob.

export type StoredSalesperson = {
  id: string;
  first_name: string;
  /** Role for NAVIGATION AND CHROME ONLY — never an authorization decision
   *  (see the security note above). Populated from the signed session token's
   *  `role` claim, not from the mutable stored field. The server re-reads the
   *  authoritative role from the `salespeople` row on every request. */
  role: UserRole;
  /** Test-account flag from `salespeople.is_test`. Still surfaced so server
   *  code (e.g. the scan route's `is_test_data` tagging) can read it via the
   *  session, even though the UI no longer gates anything on it. Optional for
   *  back-compat with sessions written before this field was shipped. */
  is_test?: boolean;
  /** Scoped permission for the office-import surface (see migration #26).
   *  Optional for back-compat with sessions issued before the column shipped;
   *  the UI treats missing as `false`. Server routes re-read the canonical
   *  value from `salespeople.can_import_offices` on every request, so this
   *  client copy is only a UX hint — never the source of truth. */
  can_import_offices?: boolean;
  /** Signed session token issued by /api/auth/login; sent on every API call. */
  token: string;
};

/**
 * Reads the `role` claim out of a signed session token's payload.
 *
 * The token is `base64url(payload) + "." + base64url(HMAC(payload))` (see
 * `signSessionToken` in src/lib/server/auth.ts). The payload is not secret —
 * only its signature is — so the client can read the claim without the key.
 * We CANNOT verify the signature here (no secret in the browser, by design),
 * which is exactly why this value is still UX-only: its worth is that it can't
 * be edited independently of the token, and any edit to the token itself makes
 * the server reject every request made with it.
 *
 * Returns null for a malformed token or an unknown role.
 */
export function sessionRoleFromToken(token: string): UserRole | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  try {
    // base64url → base64, then pad. atob exists in browsers and in Node 18+.
    const b64 = token.slice(0, dot).replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded)) as { role?: unknown };
    return isUserRole(payload.role) ? payload.role : null;
  } catch {
    return null;
  }
}

/**
 * Turns a raw localStorage blob into a session, or null when it can't be
 * trusted as one.
 *
 * A stored session is only honored when it carries a session token. Sessions
 * written before Phase 0 (name-pick login, no token) cannot authorize API
 * requests, so they are treated as not-signed-in — the user signs in once more
 * against /api/auth/login and gets a token. This is a one-time re-login.
 *
 * The role comes from the token's signed claim, NOT from the stored `role`
 * field, so hand-editing that field in devtools changes nothing. A token whose
 * payload carries no readable role is treated as not-signed-in: every token
 * `signSessionToken` has ever minted includes the claim, so the only way to
 * land here is a corrupt or hand-edited token — which the server would reject
 * anyway. Exported for tests.
 */
export function hydrateStoredSalesperson(
  raw: unknown,
): StoredSalesperson | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || typeof obj.first_name !== "string") {
    return null;
  }
  if (typeof obj.token !== "string" || obj.token.length === 0) {
    return null;
  }
  // The token's signed claim is the only role we honour — the sibling
  // `obj.role` field is ignored precisely because it is user-editable. Fail
  // closed (treat as signed out) when the claim can't be read.
  const role = sessionRoleFromToken(obj.token);
  if (!role) return null;
  const is_test =
    typeof obj.is_test === "boolean" ? obj.is_test : undefined;
  // Optional — sessions issued before the column shipped won't carry it.
  // Missing reads as undefined; the UI compares with `=== true` so the
  // unset case stays safe-default "no access".
  const can_import_offices =
    typeof obj.can_import_offices === "boolean"
      ? obj.can_import_offices
      : undefined;
  return {
    id: obj.id,
    first_name: obj.first_name,
    role,
    is_test,
    can_import_offices,
    token: obj.token,
  };
}

export function useSalesperson() {
  const [salesperson, setSalespersonState] = useState<StoredSalesperson | null>(
    null,
  );
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // Reading localStorage requires the client; setting state on mount is
    // the canonical pattern despite the react-hooks/set-state-in-effect rule.
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSalespersonState(hydrateStoredSalesperson(JSON.parse(raw)));
      }
    } catch {
      // ignore corrupt JSON; treat as not-selected
    }
    setLoaded(true);
  }, []);

  const setSalesperson = useCallback((value: StoredSalesperson) => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    setSalespersonState(value);
  }, []);

  const clear = useCallback(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    setSalespersonState(null);
  }, []);

  return { salesperson, setSalesperson, clear, loaded };
}
