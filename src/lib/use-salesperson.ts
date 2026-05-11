"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "sales-tracker:salesperson";

export type StoredSalesperson = {
  id: string;
  first_name: string;
  is_admin: boolean;
};

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
        setSalespersonState(JSON.parse(raw) as StoredSalesperson);
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
