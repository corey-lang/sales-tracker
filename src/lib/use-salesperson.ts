"use client";

import { useCallback, useEffect, useState } from "react";

import { isUserRole, type UserRole } from "@/lib/permissions";

const STORAGE_KEY = "sales-tracker:salesperson";

export type StoredSalesperson = {
  id: string;
  first_name: string;
  is_admin: boolean;
  role: UserRole;
};

// Localstorage entries written before the `role` field existed only carry
// is_admin. Derive a role so already-signed-in AEs and admins don't have to
// re-log in. Assistants will only get the right role after they sign in once
// against the updated DB, which is acceptable since the assistant tools don't
// exist yet.
function hydrate(raw: unknown): StoredSalesperson | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || typeof obj.first_name !== "string") {
    return null;
  }
  const is_admin = !!obj.is_admin;
  const role: UserRole = isUserRole(obj.role)
    ? obj.role
    : is_admin
      ? "admin"
      : "ae";
  return { id: obj.id, first_name: obj.first_name, is_admin, role };
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
        setSalespersonState(hydrate(JSON.parse(raw)));
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
