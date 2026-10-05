"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { useSalesperson } from "@/lib/use-salesperson";
import { useScrollToTop } from "@/lib/use-scroll-to-top";

import { BottomNav, BOTTOM_NAV_SPACER } from "@/components/bottom-nav";
import { RoadPageContent } from "@/components/road-to-10000/road-page-content";

// Road to 10,000 — the full view. Open to everyone signed in except juice_box_only
// guests (chrome only: /api/road-to-10000 re-checks every request). The Update
// control inside is shown only when the server says the caller may update.

export default function RoadTo10000Page() {
  const router = useRouter();
  const { salesperson, loaded } = useSalesperson();
  useScrollToTop();

  useEffect(() => {
    if (!loaded) return;
    if (!salesperson) router.replace("/");
    else if (salesperson.role === "juice_box_only") router.replace("/juice-box");
  }, [loaded, salesperson, router]);

  if (!loaded || !salesperson || salesperson.role === "juice_box_only") {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }
  return (
    <>
      <main className={`pwa-safe-top mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-4 p-4 ${BOTTOM_NAV_SPACER}`}>
        <RoadPageContent />
      </main>
      <BottomNav salesperson={salesperson} />
    </>
  );
}
