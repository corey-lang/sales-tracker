"use client";

import { Suspense } from "react";

import { useScrollToTop } from "@/lib/use-scroll-to-top";

import { BottomNav, BOTTOM_NAV_SPACER } from "@/components/bottom-nav";
import { SwagLeadsBoard } from "@/components/swag-leads/swag-leads-board";

import { useSwagLeadsGate } from "./access";

// Swag Leads — social-media prospecting leads (NOT swag orders). An AE sees
// "My Swag Leads"; the leads team (admins, Tonja, Faith) sees the team
// dashboard with an AE selector. Which one is decided by the server.

export default function SwagLeadsPage() {
  const { salesperson, ready } = useSwagLeadsGate();
  useScrollToTop();

  if (!ready) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }
  return (
    <>
      <main
        className={`pwa-safe-top mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-4 p-4 ${BOTTOM_NAV_SPACER}`}
      >
        <Suspense fallback={<p>Loading…</p>}>
          <SwagLeadsBoard />
        </Suspense>
      </main>
      <BottomNav salesperson={salesperson} />
    </>
  );
}
