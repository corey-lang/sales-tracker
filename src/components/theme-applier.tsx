"use client";

import { useEffect } from "react";

import { isTestAccount } from "@/lib/permissions";
import {
  SALESPERSON_CHANGED_EVENT,
  STORAGE_KEY,
} from "@/lib/use-salesperson";

// Premium dark-orange theme preview — TEST ACCOUNTS ONLY.
//
// ThemeApplier mounts once in the root layout and persists across client
// navigations. It reads the stored salesperson DIRECTLY from localStorage on
// mount (and on every change), so the dark theme activates even when login
// happens from a different component — no React-state pipeline between
// useSalesperson() instances to keep in sync, no stale pre-login snapshot.
//
// On login/logout from any component, useSalesperson dispatches a custom
// window event (sales-tracker:salesperson-changed); we re-read localStorage
// when we hear it. Cross-tab logins/logouts fire the native `storage` event,
// which we also listen for.

const THEME_CLASS = "theme-premium-dark";

/** Reads just the fields isTestAccount() needs, directly from localStorage. */
function readStored(): { first_name?: string; is_test?: boolean } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return {
      first_name:
        typeof obj.first_name === "string" ? obj.first_name : undefined,
      is_test: typeof obj.is_test === "boolean" ? obj.is_test : undefined,
    };
  } catch {
    return null;
  }
}

export function ThemeApplier() {
  useEffect(() => {
    const apply = () => {
      const stored = readStored();
      const active = !!stored && isTestAccount(stored);
      const root = document.documentElement;
      if (active) {
        root.classList.add(THEME_CLASS);
      } else {
        root.classList.remove(THEME_CLASS);
      }
    };

    // Initial pass — runs after hydration with whatever is in localStorage
    // right now.
    apply();

    // Same-tab login/logout (dispatched by useSalesperson setSalesperson/clear).
    const onChanged = () => apply();
    // Cross-tab login/logout: the native `storage` event only fires in OTHER
    // tabs, but we listen anyway so multi-tab sessions stay in sync.
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) apply();
    };
    window.addEventListener(SALESPERSON_CHANGED_EVENT, onChanged);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(SALESPERSON_CHANGED_EVENT, onChanged);
      window.removeEventListener("storage", onStorage);
      // Best-effort cleanup so a teardown can't leave the theme stuck on.
      document.documentElement.classList.remove(THEME_CLASS);
    };
  }, []);

  return null;
}
