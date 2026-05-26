"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { LogOut, ShieldCheck, MapPin, Building2 } from "lucide-react";

import { useSalesperson } from "@/lib/use-salesperson";
import { useScrollToTop } from "@/lib/use-scroll-to-top";
import { useLivePermissions } from "@/lib/use-live-permissions";
import { BottomNav, BOTTOM_NAV_SPACER } from "@/components/bottom-nav";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { NotificationOptIn } from "@/components/notification-opt-in";

// "More" tab — a minimal account/links page so the bottom nav has a sensible
// fourth destination. Intentionally lightweight: profile summary, an Admin
// link when applicable, and Log out. Anything else (settings, preferences,
// help) can land here later without changing the nav surface.

export default function MorePage() {
  const router = useRouter();
  const { salesperson, clear, loaded } = useSalesperson();
  // Live permission refresh — used to decide whether to show the
  // Office Imports link. Fail-closed during the in-flight window
  // (link stays hidden until the server confirms access). Doesn't
  // gate the rest of /more — account info / logout / admin shortcut
  // all derive from the cached session.
  const { permissions, loaded: permsLoaded } = useLivePermissions();
  useScrollToTop();

  useEffect(() => {
    if (loaded && !salesperson) router.replace("/");
  }, [loaded, salesperson, router]);

  if (!loaded || !salesperson) {
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
      <main
        className={`pwa-safe-top mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-4 p-4 ${BOTTOM_NAV_SPACER}`}
      >
        <header className="space-y-1 pt-1">
          <p className="text-sm text-muted-foreground">Account</p>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            More
          </h1>
        </header>

        <Card>
          <CardContent className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Signed in as
            </p>
            <p className="text-lg font-semibold">{salesperson.first_name}</p>
            <p className="text-xs text-muted-foreground">
              {salesperson.is_admin
                ? "Admin"
                : salesperson.role === "assistant"
                  ? "Assistant"
                  : salesperson.role === "juice_box_only"
                    ? "Juice Box"
                    : "Account Executive"}
            </p>
          </CardContent>
        </Card>

        {/* Notifications opt-in. Now available to every signed-in
            salesperson — Juice Box is open to the whole team and the
            matching server route (/api/juice-box/push/subscribe) just
            requires a session. */}
        <Card>
          <CardContent className="space-y-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Notifications
            </p>
            <NotificationOptIn />
          </CardContent>
        </Card>

        <div className="flex flex-col gap-2">
          {salesperson.is_admin && (
            <Link
              href="/admin"
              className={buttonVariants({ variant: "outline" })}
            >
              <ShieldCheck aria-hidden="true" className="size-4" />
              Admin
            </Link>
          )}
          {/* My Offices (Test) — Phase 1B test-only office list. The
              link only appears for `is_test === true` salespeople; the
              server route + the /offices page itself both re-check
              `requireTestAccount`, so this is UI discoverability only.
              juice_box_only is excluded by the role check, and
              `is_test` is a static account property (no live grant)
              so the cached session value is the authority here. */}
          {salesperson.is_test === true &&
            salesperson.role !== "juice_box_only" && (
              <Link
                href="/offices"
                className={buttonVariants({ variant: "outline" })}
              >
                <Building2 aria-hidden="true" className="size-4" />
                My Offices (Test)
              </Link>
            )}
          {(() => {
            // Visibility prefers LIVE permissions from
            // /api/me/permissions so grant/revoke takes effect on the
            // next mount of /more without a logout/login cycle. If
            // the live fetch fails (transient network/server error),
            // we fall back to the cached session flag so a valid user
            // doesn't lose their link during an outage. The Office
            // Imports page + import API both re-check the live
            // permission, so this fallback is UI-only.
            //
            // juice_box_only is excluded outright regardless of
            // resolution branch.
            //
            // While the live fetch is still in flight (permsLoaded
            // false), the link stays hidden so a slow fetch can't
            // flash an out-of-date affordance.
            if (!permsLoaded) return null;
            const effective =
              permissions ??
              (salesperson
                ? {
                    is_admin: salesperson.is_admin === true,
                    role: salesperson.role,
                    can_import_offices:
                      salesperson.can_import_offices === true,
                  }
                : null);
            if (!effective) return null;
            if (effective.role === "juice_box_only") return null;
            const allowed =
              effective.is_admin === true ||
              effective.can_import_offices === true;
            if (!allowed) return null;
            return (
              <Link
                href="/office-imports"
                className={buttonVariants({ variant: "outline" })}
              >
                <MapPin aria-hidden="true" className="size-4" />
                Office Imports (Test)
              </Link>
            );
          })()}
          <Button variant="outline" onClick={handleLogout}>
            <LogOut aria-hidden="true" className="size-4" />
            Log out
          </Button>
        </div>
      </main>
      <BottomNav salesperson={salesperson} />
    </>
  );
}
