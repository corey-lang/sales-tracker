"use client";

import { useParams } from "next/navigation";

import { useScrollToTop } from "@/lib/use-scroll-to-top";

import { BottomNav, BOTTOM_NAV_SPACER } from "@/components/bottom-nav";
import { SwagLeadDetail } from "@/components/swag-leads/swag-lead-detail";

import { useSwagLeadsGate } from "../access";

// One swag lead: details, transfer, and its immutable history.

export default function SwagLeadPage() {
  const { id } = useParams<{ id: string }>();
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
        className={`pwa-safe-top mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-4 p-4 ${BOTTOM_NAV_SPACER}`}
      >
        <SwagLeadDetail id={id} />
      </main>
      <BottomNav salesperson={salesperson} />
    </>
  );
}
