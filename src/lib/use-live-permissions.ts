"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/api-client";
import type { UserRole } from "@/lib/permissions";

/**
 * Live permission values for the current caller, fetched from
 * /api/me/permissions on mount. Used by permission-gated surfaces
 * (currently /office-imports + the office-imports link on /more) so
 * UI visibility tracks the DB state instead of the login-time
 * snapshot stored in localStorage.
 *
 * FAIL-CLOSED
 *   While the fetch is in flight, `permissions` is null and the
 *   consumer should treat that as "no access yet" — this avoids
 *   flashing a button for a user whose permission was revoked since
 *   their last login. Once the fetch resolves, true values come from
 *   the server.
 *
 * GRANT / REVOKE BEHAVIOR
 *   * Grant: a user whose row is updated to can_import_offices=true
 *     sees the gated surfaces appear on the next page mount — no
 *     logout/login needed.
 *   * Revoke: a user whose row is updated to can_import_offices=false
 *     sees the surface disappear on the next page mount (and any
 *     write the UI attempts in the meantime is still rejected by the
 *     server route, which is the final authority).
 *
 * SERVER STAYS AUTHORITATIVE
 *   This hook never gates any write. Every mutating route refreshes
 *   its own permissions via requireOfficeImporter / requireAdmin /
 *   etc., so a UI that fails to refresh permissions in time still
 *   cannot perform a forbidden action.
 */
export type LivePermissions = {
  role: UserRole;
  can_import_offices: boolean;
};

/**
 * What a consumer should DO with the result of the permission fetch.
 *
 *   "loading"  — still resolving; render a spinner, decide nothing.
 *   "expired"  — the server rejected the session (401). The honest remedy is
 *                the sign-in screen, not an error card: nothing is wrong with
 *                the app, the stored token is simply no longer valid (expired,
 *                or signed with a different SESSION_SECRET / service-role key
 *                than this environment uses). Send the user to sign in again.
 *   "error"    — the check itself failed (5xx, offline). NOT an auth failure,
 *                so bouncing to sign-in would be misleading; show the problem.
 *   "ok"       — permissions are known and usable.
 *
 * Exported as a pure function so the distinction is unit-tested rather than
 * re-derived by eye in every consumer. This is a UX routing decision only —
 * the security boundary remains the server guard on each request.
 */
export type AccessGate = "loading" | "expired" | "error" | "ok";

export function accessGateFrom(input: {
  loaded: boolean;
  permissions: LivePermissions | null;
  /** HTTP status of the last attempt; null when the request never completed. */
  status: number | null;
}): AccessGate {
  if (!input.loaded) return "loading";
  if (input.permissions) return "ok";
  return input.status === 401 ? "expired" : "error";
}

export function useLivePermissions(): {
  permissions: LivePermissions | null;
  /** True once the live fetch has resolved (success OR failure). */
  loaded: boolean;
  /** HTTP status of the last attempt; null if it never completed (offline). */
  status: number | null;
  /** Pre-computed gate for consumers — see accessGateFrom. */
  gate: AccessGate;
} {
  const [permissions, setPermissions] = useState<LivePermissions | null>(
    null,
  );
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch("/api/me/permissions");
        if (cancelled) return;
        setStatus(res.status);
        if (!res.ok) {
          // 401 (signed out / expired) and any other error fall through
          // to the loaded-with-null state; `status` tells consumers which,
          // so an expired session routes to sign-in while a real outage
          // shows an error instead of a misleading "sign in again".
          return;
        }
        const payload = (await res.json().catch(() => null)) as
          | LivePermissions
          | null;
        if (cancelled || !payload || typeof payload !== "object") return;
        setPermissions({
          role: payload.role,
          can_import_offices: payload.can_import_offices === true,
        });
      } catch {
        // Network error — leave permissions null, mark loaded so the
        // consumer can decide how to proceed (typically: redirect).
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    permissions,
    loaded,
    status,
    gate: accessGateFrom({ loaded, permissions, status }),
  };
}
