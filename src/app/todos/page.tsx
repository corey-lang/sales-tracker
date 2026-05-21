"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { useSalesperson } from "@/lib/use-salesperson";
import { useScrollToTop } from "@/lib/use-scroll-to-top";

import { BottomNav, BOTTOM_NAV_SPACER } from "@/components/bottom-nav";
import { AeTasksCard } from "@/components/ae-tasks-card";

// AE To-Dos — dedicated route reachable from the bottom nav. The page is a
// thin wrapper around <AeTasksCard>; the card still owns task fetching,
// quick-add, due-date entry, completion, the completed-section reveal, and
// the /api/tasks read/write behavior. The dashboard no longer renders it.
//
// Gating: assistants (admin-assistant role) don't use the AE tasks API, so
// they're bounced back to /dashboard. Everyone else (AE + admin AEs) sees
// their own task list as before.

export default function TodosPage() {
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
        <header className="space-y-1 pt-1">
          <p className="text-sm text-muted-foreground">Personal</p>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            To-Dos
          </h1>
        </header>

        <AeTasksCard />
      </main>
      <BottomNav salesperson={salesperson} />
    </>
  );
}
