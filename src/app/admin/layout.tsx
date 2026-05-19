"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

import { cn } from "@/lib/utils";
import { useSalesperson } from "@/lib/use-salesperson";

import { Button } from "@/components/ui/button";

// Shared shell for every /admin/* page. It owns the one admin-role guard, the
// top bar (logo + log out), and the section navigation — so each admin page
// only renders its own content. Non-admins are redirected away here, before
// any admin page mounts.

/** Admin sections, in nav order. Each is its own route under /admin. */
const ADMIN_NAV = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/business-cards", label: "Business Cards" },
  { href: "/admin/leaderboard", label: "Leaderboard" },
  { href: "/admin/reports/activity", label: "Activity Reports" },
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
    <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">Admin</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Hi, {salesperson.first_name}
          </h1>
        </div>
        <Image
          src="/logo.png"
          alt="Elevate Homescriptions"
          width={160}
          height={49}
          priority
          className="shrink-0"
        />
        <Button variant="outline" size="sm" onClick={handleLogout}>
          Log out
        </Button>
      </header>

      <nav
        aria-label="Admin sections"
        className="flex flex-wrap gap-1.5 rounded-lg border bg-muted/40 p-1.5"
      >
        {ADMIN_NAV.map((item) => {
          const active = pathname === item.href;
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
  );
}
