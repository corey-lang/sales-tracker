"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Citrus, Trophy, MoreHorizontal, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { isTestAccount } from "@/lib/permissions";
import type { StoredSalesperson } from "@/lib/use-salesperson";

// Mobile-first bottom tab bar. Fixed to the viewport bottom, sits on a
// translucent charcoal surface so it reads cleanly over the premium-dark
// theme. The active tab is tinted with the orange accent.
//
// Role-awareness: the Juice Box tab is gated to admins and test accounts only,
// matching the same gate enforced inside /juice-box. Everyone else sees a
// 3-tab bar (Home / Leaderboard / More).
//
// Spacing: this component is `position: fixed`, so consuming pages add
// `pb-24` (or similar) to their main wrapper. We expose `BOTTOM_NAV_SPACER`
// as the canonical class to use, but plain `pb-24` is fine too.

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

const HOME: NavItem = { href: "/dashboard", label: "Home", icon: Home };
const JUICE_BOX: NavItem = {
  href: "/juice-box",
  label: "Juice Box",
  icon: Citrus,
};
const LEADERBOARD: NavItem = {
  href: "/leaderboard",
  label: "Leaderboard",
  icon: Trophy,
};
const MORE: NavItem = { href: "/more", label: "More", icon: MoreHorizontal };

/** Bottom padding any page using BottomNav should apply to its main wrapper. */
export const BOTTOM_NAV_SPACER =
  "pb-[calc(5rem+env(safe-area-inset-bottom))]";

export function canSeeJuiceBox(
  salesperson: Pick<StoredSalesperson, "first_name" | "is_admin" | "is_test"> | null,
): boolean {
  if (!salesperson) return false;
  if (salesperson.is_admin) return true;
  return isTestAccount(salesperson);
}

export function BottomNav({
  salesperson,
}: {
  salesperson: StoredSalesperson | null;
}) {
  const pathname = usePathname();
  const showJuiceBox = canSeeJuiceBox(salesperson);

  const items: NavItem[] = showJuiceBox
    ? [HOME, JUICE_BOX, LEADERBOARD, MORE]
    : [HOME, LEADERBOARD, MORE];

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/85 backdrop-blur-md supports-[backdrop-filter]:bg-background/70"
      style={{
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <ul
        className={cn(
          "mx-auto grid w-full max-w-2xl",
          items.length === 4 ? "grid-cols-4" : "grid-cols-3",
        )}
      >
        {items.map((item) => {
          const active =
            pathname === item.href ||
            (item.href !== "/" && pathname?.startsWith(`${item.href}/`));
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex flex-col items-center justify-center gap-0.5 py-2.5 text-[11px] font-medium",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                  active
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon
                  aria-hidden="true"
                  className={cn(
                    "size-5",
                    active ? "text-primary" : "text-muted-foreground",
                  )}
                />
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
