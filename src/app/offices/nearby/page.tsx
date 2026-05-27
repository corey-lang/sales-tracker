"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// /offices/nearby — deprecated standalone URL.
//
// The Nearby Offices feature was merged into the unified `/offices`
// surface (Map + List with a top-level view toggle). This page
// remains as a redirect so any saved deep link, dashboard
// shortcut, or external bookmark still lands on the right surface.
//
// `router.replace` (not `push`) keeps the deprecated URL out of
// browser history — back-button behavior stays clean.
//
// The redirect runs as soon as the client hydrates; the body
// renders a brief "Opening Offices…" line so the user sees
// something rather than a flash of blank screen during the swap.

export default function NearbyOfficesRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/offices");
  }, [router]);
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <p className="text-sm text-muted-foreground">Opening Offices…</p>
    </main>
  );
}
