"use client";

import { useEffect } from "react";

import { isTestAccount } from "@/lib/permissions";
import { useSalesperson } from "@/lib/use-salesperson";

// Premium dark-orange theme preview — TEST ACCOUNTS ONLY.
//
// This is a pure visual layer: it toggles a single class on <html> based on
// who is signed in. Every theme change lives in CSS variable overrides on
// that class (see .theme-premium-dark in globals.css). Production users never
// match the gate and so never see the class — their UI is byte-identical.
// No app logic, workflows, permissions, or APIs are affected.

const THEME_CLASS = "theme-premium-dark";

export function ThemeApplier() {
  const { salesperson, loaded } = useSalesperson();

  useEffect(() => {
    if (!loaded) return;
    const active = !!salesperson && isTestAccount(salesperson);
    const root = document.documentElement;
    if (active) {
      root.classList.add(THEME_CLASS);
    } else {
      root.classList.remove(THEME_CLASS);
    }
    return () => {
      // Remove the class when the applier unmounts so a route change can't
      // leave the theme stuck on for a non-test session.
      root.classList.remove(THEME_CLASS);
    };
  }, [loaded, salesperson]);

  return null;
}
