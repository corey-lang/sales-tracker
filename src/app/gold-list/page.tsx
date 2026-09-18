"use client";

import { Suspense, useEffect } from "react";
import { useRouter } from "next/navigation";

import { useSalesperson } from "@/lib/use-salesperson";
import { useScrollToTop } from "@/lib/use-scroll-to-top";

import { BottomNav, BOTTOM_NAV_SPACER } from "@/components/bottom-nav";
import { GoldListBoard } from "@/components/gold-list-board";

// Gold List — the AE's own relationship follow-up list, on its own route so it
// persists independently of any Weekly Focus / 1:1 record. Nothing on this page
// is week-scoped: agents and their activity history carry across weeks.
//
// Thin wrapper, same shape as /todos: the page owns the route guard and the
// nav chrome, and <GoldListBoard> owns the header (title + live agent count),
// data fetching, the admin AE filter, and every mutation.
//
// GATING (chrome only — the real boundary is the /api/gold-list/* routes)
//   * signed out      -> sign-in screen
//   * juice_box_only  -> /juice-box, their only surface
//   * assistant       -> /dashboard; like To-Dos and Scan, this is an AE
//                        workflow and assistants have a restricted dashboard
//   * ae / admin      -> the board. Admins additionally get the AE filter and
//                        read-only visibility into every AE's list, which the
//                        server decides, not this component.

export default function GoldListPage() {
  const router = useRouter();
  const { salesperson, loaded } = useSalesperson();
  useScrollToTop();

  useEffect(() => {
    if (!loaded) return;
    if (!salesperson) {
      router.replace("/");
      return;
    }
    if (salesperson.role === "assistant") {
      router.replace("/dashboard");
      return;
    }
    if (salesperson.role === "juice_box_only") {
      router.replace("/juice-box");
    }
  }, [loaded, salesperson, router]);

  if (
    !loaded ||
    !salesperson ||
    salesperson.role === "assistant" ||
    salesperson.role === "juice_box_only"
  ) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  return (
    <>
      <main
        className={`pwa-safe-top mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-4 p-4 ${BOTTOM_NAV_SPACER}`}
      >
        <Suspense fallback={<p>Loading…</p>}>
          <GoldListBoard />
        </Suspense>
      </main>
      <BottomNav salesperson={salesperson} />
    </>
  );
}
