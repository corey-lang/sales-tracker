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

export function useLivePermissions(): {
  permissions: LivePermissions | null;
  /** True once the live fetch has resolved (success OR failure). */
  loaded: boolean;
} {
  const [permissions, setPermissions] = useState<LivePermissions | null>(
    null,
  );
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch("/api/me/permissions");
        if (cancelled) return;
        if (!res.ok) {
          // 401 (signed out / expired) and any other error fall through
          // to the loaded-with-null state. Consumers will redirect to
          // sign-in or fail closed on access checks.
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

  return { permissions, loaded };
}
