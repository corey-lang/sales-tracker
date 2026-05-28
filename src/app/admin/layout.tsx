"use client";

import Link from "next/link";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Settings } from "lucide-react";

import { cn } from "@/lib/utils";
import { useSalesperson } from "@/lib/use-salesperson";

import { Button, buttonVariants } from "@/components/ui/button";
import { Logo } from "@/components/logo";
import { BottomNav, BOTTOM_NAV_SPACER } from "@/components/bottom-nav";

// Shared shell for every /admin/* page. It owns the one admin-role guard, the
// top bar (logo + log out), and the section navigation — so each admin page
// only renders its own content. Non-admins are redirected away here, before
// any admin page mounts.

/** Admin sections, in nav order. Each is its own route under /admin
 *  except `/office-imports`, which lives at the top level so non-admin
 *  assistants (who can't pass this layout's `is_admin` gate) can still
 *  reach it via their own /more entry point. The Link still highlights
 *  correctly here because the active-state check matches the exact
 *  href. */
const ADMIN_NAV = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/coaching", label: "Weekly Focus" },
  { href: "/admin/business-cards", label: "Business Cards" },
  { href: "/admin/leaderboard", label: "Leaderboard" },
  { href: "/admin/reports/activity", label: "Activity Reports" },
  { href: "/office-imports", label: "Office Imports" },
];

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { salesperson, clear, loaded } = useSalesperson();

  useEffect(() => {
    if (!loaded) return;
    if (!salesperson) {
      router.replace("/");
      return;
    }
    if (!salesperson.is_admin) {
      router.replace("/dashboard");
    }
  }, [loaded, salesperson, router]);

  if (!loaded || !salesperson || !salesperson.is_admin) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  const handleLogout = () => {
    clear();
    router.push("/");
  };

  return (
    <>
      <div
        className={cn(
          "pwa-safe-top mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-4 p-4 sm:p-6",
          BOTTOM_NAV_SPACER,
        )}
      >
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-muted-foreground">Admin</p>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Hi, {salesperson.first_name}
            </h1>
          </div>
          <Logo width={160} height={49} priority className="shrink-0" />
          {/* Admins land on /admin per landingPathFor and never see the
              /dashboard or /juice-box headers, so their only path to /more
              (notification opt-in, account summary) lives here. Mirrors the
              ghost-icon Settings gear used by the AE/assistant dashboard
              and the Juice Box page header. Log out stays as the right-most
              affordance to preserve muscle memory. */}
          <div className="flex shrink-0 items-center gap-2">
            <Link
              href="/more"
              aria-label="Account and notification settings"
              className={buttonVariants({
                variant: "ghost",
                size: "icon",
              })}
            >
              <Settings aria-hidden="true" className="size-5" />
            </Link>
            <Button variant="outline" size="sm" onClick={handleLogout}>
              Log out
            </Button>
          </div>
        </header>

        <nav
          aria-label="Admin sections"
          className="flex flex-wrap gap-1.5 rounded-lg border bg-muted/40 p-1.5"
        >
          {ADMIN_NAV.map((item) => {
            // /admin matches exactly (no prefix-match — otherwise every
            // /admin/* page would also highlight Dashboard). Every other
            // tab matches its own path OR any nested sub-path so an AE
            // detail page like /admin/coaching/<ae_id> keeps Coaching
            // highlighted in the nav.
            const active =
              item.href === "/admin"
                ? pathname === "/admin"
                : pathname === item.href ||
                  pathname?.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                    : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {children}
      </div>
      <BottomNav salesperson={salesperson} />
    </>
  );
}
