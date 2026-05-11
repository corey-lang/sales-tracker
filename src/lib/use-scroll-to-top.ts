"use client";

import { useEffect } from "react";

/**
 * Force scroll to (0, 0) on mount, overriding browser/framework scroll
 * restoration. Fires at increasing delays to defeat late layout shifts
 * from async data loads, and re-scrolls on bfcache restoration so
 * closing & reopening a mobile tab also lands at the top.
 */
export function useScrollToTop() {
  useEffect(() => {
    if ("scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual";
    }
    const scroll = () => window.scrollTo(0, 0);
    scroll();
    const rafId = requestAnimationFrame(scroll);
    const timers = [50, 200, 500, 1000].map((delay) =>
      setTimeout(scroll, delay),
    );
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) scroll();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => {
      cancelAnimationFrame(rafId);
      timers.forEach(clearTimeout);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);
}
