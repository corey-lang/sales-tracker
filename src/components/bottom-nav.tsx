"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Citrus,
  Home,
  ListChecks,
  ScanLine,
  Trophy,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { StoredSalesperson } from "@/lib/use-salesperson";
import { useJuiceBoxUnread } from "@/components/juice-box-unread-provider";

// Mobile-first bottom tab bar. Fixed to the viewport bottom, sits on a
// translucent charcoal surface so it reads cleanly over the premium-dark
// theme. The active tab is tinted with the orange accent.
//
// Role-awareness:
//   * Juice Box       — open to the whole team; tab renders for any
//                       signed-in salesperson.
//   * To-Dos          — AE workflow, hidden from assistants.
//   * Scan Biz Card   — AE workflow, hidden from assistants.
//   Settings / logout / notifications no longer live in the nav; they're
//   reachable from the Home header (a small "More" icon links to /more).
//
// Spacing: this component is `position: fixed`, so consuming pages add
// `BOTTOM_NAV_SPACER` (a `pb-…` class) to their main wrapper so the last
// piece of scrollable content can scroll fully above the nav instead of
// being clipped by the translucent backdrop.

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

// Two "Home" variants. Admins (Corey, Ryan, …) land on /admin after
// login per `landingPathFor`, so their Home tab routes there too —
// otherwise tapping Home from /admin would silently navigate them to
// the AE log-activity page. Every other role keeps the AE dashboard
// as their Home. juice_box_only users don't see a Home tab at all
// (handled below in buildNavItems).
const HOME_AE: NavItem = { href: "/dashboard", label: "Home", icon: Home };
const HOME_ADMIN: NavItem = { href: "/admin", label: "Home", icon: Home };
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
const TODOS: NavItem = { href: "/todos", label: "To-Dos", icon: ListChecks };
const SCAN_BIZ_CARD: NavItem = {
  href: "/scan-biz-card",
  label: "Scan",
  icon: ScanLine,
};

/**
 * Bottom padding any page using BottomNav should apply to its main wrapper.
 *
 * Sized for the nav's actual rendered height (~69px = py-3 + size-6 icon
 * + gap-1 + 12px label + 1px border) plus ~43px of breathing room so the
 * last visible card doesn't sit flush against the nav's translucent edge.
 * `env(safe-area-inset-bottom)` mirrors the inset the nav itself adds, so
 * iPhone home-indicator devices get the same visual clearance as desktop.
 *
 * Was 5rem; bumped to 7rem because the previous ~11px clearance made long
 * pages look clipped by the nav.
 *
 * `!important` (the trailing `!` is Tailwind v4 syntax) is required because
 * several consuming pages combine this with a `sm:p-6` shorthand on the
 * same wrapper (admin/layout.tsx, dashboard, leaderboard). At >=640px the
 * `sm:p-6` media-query rule comes after the unprefixed `pb-…` in the
 * cascade and silently collapses bottom padding to 1.5rem — the entire
 * point of this spacer disappears at the sm breakpoint. Forcing important
 * on the constant makes the spacer survive any padding shorthand at any
 * future breakpoint, so callers can write `p-4 sm:p-6` (or md:/lg:) and
 * still get the nav clearance they asked for.
 */
export const BOTTOM_NAV_SPACER =
  "pb-[calc(7rem+env(safe-area-inset-bottom))]!";

function buildNavItems(salesperson: StoredSalesperson | null): NavItem[] {
  if (!salesperson) return [HOME_AE];
  // Juice Box-only accounts (Travis, Rizz, …) see ONLY the Juice Box
  // tab — they have no access to Home / Leaderboard / To-Dos / Scan
  // and shouldn't be tempted by tabs that would just redirect them
  // back here. Notifications + log out are reachable via the gear in
  // the Juice Box page header (see /juice-box).
  if (salesperson.role === "juice_box_only") return [JUICE_BOX];
  // Admin Home points at /admin so Home stays consistent with where
  // admins land after login (see landingPathFor). Every other role's
  // Home is the AE /dashboard.
  const home = salesperson.is_admin ? HOME_ADMIN : HOME_AE;
  // Juice Box is otherwise open to the whole team; every signed-in
  // user gets the tab. To-Dos and Scan Biz Card stay AE-only since
  // assistants have a restricted (VerificationCenter) dashboard and
  // don't use those workflows.
  const items: NavItem[] = [home, JUICE_BOX, LEADERBOARD];
  if (salesperson.role !== "assistant") {
    items.push(TODOS, SCAN_BIZ_CARD);
  }
  return items;
}

export function BottomNav({
  salesperson,
}: {
  salesperson: StoredSalesperson | null;
}) {
  const pathname = usePathname();
  // Hook is always called (rules-of-hooks); the provider is a no-op
  // for signed-out users so the value is 0 in that case.
  const { unreadCount } = useJuiceBoxUnread();

  const items = buildNavItems(salesperson);

  // Grid columns map 1:1 to the active item count so the tabs share width
  // evenly regardless of which role-gated items are present. A single tab
  // (juice_box_only users) gets `grid-cols-1` so the lone Juice Box tab
  // centers across the full bar instead of squatting in one half.
  const gridClass =
    items.length === 5
      ? "grid-cols-5"
      : items.length === 4
        ? "grid-cols-4"
        : items.length === 3
          ? "grid-cols-3"
          : items.length === 2
            ? "grid-cols-2"
            : "grid-cols-1";

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/85 backdrop-blur-md supports-[backdrop-filter]:bg-background/70"
      style={{
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <ul className={cn("mx-auto grid w-full max-w-2xl", gridClass)}>
        {items.map((item) => {
          const active =
            pathname === item.href ||
            (item.href !== "/" && pathname?.startsWith(`${item.href}/`));
          const Icon = item.icon;
          const showBadge =
            item.href === "/juice-box" && unreadCount > 0;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex flex-col items-center justify-center gap-1 px-1 py-3 text-[12px] font-medium",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                  active
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span className="relative">
                  <Icon
                    aria-hidden="true"
                    className={cn(
                      "size-6",
                      active ? "text-primary" : "text-muted-foreground",
                    )}
                  />
                  {showBadge && <UnreadBadge count={unreadCount} />}
                </span>
                <span className="max-w-full truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Small orange pill sitting on the top-right of the Juice Box icon. Caps
 * at "99+" so unbounded counts can't blow up the layout. Uses a primary-
 * foreground/primary pair (orange fill, dark numeral) for max contrast
 * against the dark backdrop.
 */
function UnreadBadge({ count }: { count: number }) {
  const display = count > 99 ? "99+" : String(count);
  return (
    <span
      aria-label={`${count} unread ${count === 1 ? "message" : "messages"}`}
      className="absolute -right-2 -top-1.5 inline-flex h-[1.1rem] min-w-[1.1rem] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground ring-2 ring-background"
    >
      {display}
    </span>
  );
}
