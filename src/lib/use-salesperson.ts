"use client";

import { useCallback, useEffect, useState } from "react";

import { isUserRole, type UserRole } from "@/lib/permissions";

export const STORAGE_KEY = "sales-tracker:salesperson";

/** Window event broadcast on every login / logout in this tab. Listened to
 *  by useSalesperson() (so all hook instances stay in sync after a login
 *  even without a page reload) and by ThemeApplier (so the dark theme
 *  activates the instant a test user logs in). Native `storage` events only
 *  fire in OTHER tabs, so a same-tab custom event is required. */
export const SALESPERSON_CHANGED_EVENT = "sales-tracker:salesperson-changed";

export type StoredSalesperson = {
  id: string;
  first_name: string;
  is_admin: boolean;
  /** Authoritative test-account flag from `salespeople.is_test`. Optional only
   *  for backwards compatibility with sessions stored before this was shipped
   *  — newer sessions always carry it; isTestAccount() falls back to a
   *  case-insensitive name match when it is absent. */
  is_test?: boolean;
  role: UserRole;
  /** Signed session token issued by /api/auth/login; sent on every API call. */
  token: string;
};

// A stored session is only honored when it carries a session token. Sessions
// written before Phase 0 (name-pick login, no token) cannot authorize API
// requests, so they are treated as not-signed-in — the user signs in once more
// against /api/auth/login and gets a token. This is a one-time re-login.
function hydrate(raw: unknown): StoredSalesperson | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || typeof obj.first_name !== "string") {
    return null;
  }
  if (typeof obj.token !== "string" || obj.token.length === 0) {
    return null;
  }
  const is_admin = !!obj.is_admin;
  const role: UserRole = isUserRole(obj.role)
    ? obj.role
    : is_admin
      ? "admin"
      : "ae";
  // `is_test` only exists on sessions issued after this fix shipped; older
  // ones fall through to the name-based check in isTestAccount.
  const is_test =
    typeof obj.is_test === "boolean" ? obj.is_test : undefined;
  return {
    id: obj.id,
    first_name: obj.first_name,
    is_admin,
    is_test,
    role,
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
    const read = () => {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        return raw ? hydrate(JSON.parse(raw)) : null;
      } catch {
        return null;
      }
    };
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSalespersonState(read());
    setLoaded(true);

    // Login / logout from any component re-hydrates every hook instance, so
    // long-lived consumers (e.g. ThemeApplier in the root layout) don't get
    // stuck on a stale pre-login snapshot.
    const onChanged = () => setSalespersonState(read());
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setSalespersonState(read());
    };
    window.addEventListener(SALESPERSON_CHANGED_EVENT, onChanged);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(SALESPERSON_CHANGED_EVENT, onChanged);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const setSalesperson = useCallback((value: StoredSalesperson) => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    setSalespersonState(value);
    window.dispatchEvent(new Event(SALESPERSON_CHANGED_EVENT));
  }, []);

  const clear = useCallback(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    setSalespersonState(null);
    window.dispatchEvent(new Event(SALESPERSON_CHANGED_EVENT));
  }, []);

  return { salesperson, setSalesperson, clear, loaded };
}
