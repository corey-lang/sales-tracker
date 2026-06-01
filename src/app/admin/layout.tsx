"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown, Settings } from "lucide-react";

import { cn } from "@/lib/utils";
import { isAdminUser } from "@/lib/role-routing";
import { useSalesperson } from "@/lib/use-salesperson";

import { Button, buttonVariants } from "@/components/ui/button";
import { Logo } from "@/components/logo";
import { BottomNav, BOTTOM_NAV_SPACER } from "@/components/bottom-nav";

// Shared shell for every /admin/* page. It owns the one admin-role guard, the
// top bar (logo + log out), and the section navigation — so each admin page
// only renders its own content. Non-admins are redirected away here, before
// any admin page mounts.

/** Top-level admin sections. Some are direct links; "Reports" and "Tools"
 *  are dropdown groups so the row stays scannable without cutting any
 *  destinations.
 *
 *  /office-imports lives outside /admin so non-admin assistants (who
 *  can't pass this layout's role==='admin' gate) can still reach it via /more.
 *  It still nests cleanly under the admin "Tools" group here because the
 *  active-state matcher keys off pathname, not URL ancestry. */
type NavLeaf = { href: string; label: string };
type NavItem =
  | { kind: "link"; href: string; label: string }
  | { kind: "group"; label: string; items: NavLeaf[] };

const ADMIN_NAV: NavItem[] = [
  { kind: "link", href: "/admin", label: "Dashboard" },
  { kind: "link", href: "/admin/coaching", label: "Weekly Focus" },
  { kind: "link", href: "/admin/scorecard", label: "Scorecard" },
  {
    kind: "group",
    label: "Reports",
    items: [
      // The leaderboard is the meeting/team view — percentage-only by
      // product rule, no raw KPI counts. Labeled here as "Meeting View"
      // so its purpose is obvious from the menu without renaming the
      // page or its /admin/leaderboard URL.
      { href: "/admin/leaderboard", label: "Leaderboard / Meeting View" },
      { href: "/admin/reports/activity", label: "Activity Reports" },
    ],
  },
  {
    kind: "group",
    label: "Tools",
    items: [
      { href: "/admin/business-cards", label: "Business Cards" },
      { href: "/office-imports", label: "Office Imports" },
      { href: "/admin/cogent", label: "Cogent Orders" },
      { href: "/admin/working-days", label: "Working Day Adjustments" },
    ],
  },
];

/** Active-state rule: exact match for "/admin" (otherwise every sub-page
 *  would also light Dashboard), prefix match for everything else so a
 *  nested route like /admin/coaching/<ae_id> keeps its parent tab lit. */
function isLinkActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}

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
    // Same admin gate as landingPathFor and server-side requireAdmin:
    // role === 'admin'. Non-admins get bounced to /dashboard.
    if (!isAdminUser(salesperson)) {
      router.replace("/dashboard");
    }
  }, [loaded, salesperson, router]);

  if (!loaded || !salesperson || !isAdminUser(salesperson)) {
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
          {ADMIN_NAV.map((item) =>
            item.kind === "link" ? (
              <NavLink
                key={item.href}
                href={item.href}
                label={item.label}
                active={isLinkActive(pathname, item.href)}
              />
            ) : (
              <NavGroupMenu
                key={item.label}
                label={item.label}
                items={item.items}
                pathname={pathname}
              />
            ),
          )}
        </nav>

        {children}
      </div>
      <BottomNav salesperson={salesperson} />
    </>
  );
}

function NavLink({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm ring-1 ring-border"
          : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
      )}
    >
      {label}
    </Link>
  );
}

/** Click-to-open dropdown group for nav lanes ("Reports", "Tools").
 *  Closes on outside click, Escape, or route change. Active state lights
 *  when the current pathname matches any child route. */
function NavGroupMenu({
  label,
  items,
  pathname,
}: {
  label: string;
  items: NavLeaf[];
  pathname: string | null;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const anyChildActive = items.some((it) => isLinkActive(pathname, it.href));

  // Auto-close when navigating to a new route. The group button still
  // lights via anyChildActive once the new pathname resolves. Pathname
  // is the only thing this effect responds to, and a single setOpen
  // call is the simplest expression — matches the same eslint exception
  // used by other admin pages for similar route-change resets.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(false);
  }, [pathname]);

  // Outside click + Escape, only while open so we don't keep listeners
  // attached for every nav menu on every page.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-current={anyChildActive ? "page" : undefined}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
          anyChildActive
            ? "bg-background text-foreground shadow-sm ring-1 ring-border"
            : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
        )}
      >
        {label}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-3.5 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={label}
          className="absolute left-0 top-full z-50 mt-1 min-w-[12rem] rounded-md border bg-background p-1 shadow-md"
        >
          {items.map((it) => {
            const active = isLinkActive(pathname, it.href);
            return (
              <Link
                key={it.href}
                href={it.href}
                role="menuitem"
                aria-current={active ? "page" : undefined}
                className={cn(
                  "block rounded-sm px-2.5 py-1.5 text-sm transition-colors",
                  active
                    ? "bg-muted font-medium text-foreground"
                    : "text-foreground hover:bg-muted",
                )}
              >
                {it.label}
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
