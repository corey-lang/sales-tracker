"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Settings } from "lucide-react";

import { formatDateMDY, todayInAppTimezone } from "@/lib/dates";
import { nextQuote } from "@/lib/quotes";
import { useSalesperson } from "@/lib/use-salesperson";
import { useScrollToTop } from "@/lib/use-scroll-to-top";

import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Logo } from "@/components/logo";
import { BottomNav, BOTTOM_NAV_SPACER } from "@/components/bottom-nav";
import { ThisWeekCard } from "@/components/this-week-card";
import { DailyEntryForm } from "@/components/daily-entry-form";
import { MyWeekCard } from "@/components/my-week-card";
import { EditWeekCard } from "@/components/edit-week-card";
import { MessagesCard } from "@/components/messages-card";
import { RecentActivityCard } from "@/components/recent-activity-card";
import { VerificationCenter } from "@/components/verification-center";

// Home dashboard. Slimmer than the pre-nav-rollout version — the To-Do
// section and the biz-card / log-activity quick actions have moved into
// dedicated routes reachable from the bottom nav. What remains here is the
// daily-momentum read (greeting + weekly progress + messages + activity
// logging + week edit) so Home is the "what's my week look like, what did
// I just do" view, not a launcher.
//
// Account chrome (notifications opt-in, log out, admin link) lives on
// /more, reachable via the small Settings icon in the header.

export default function DashboardPage() {
  const router = useRouter();
  const { salesperson, loaded } = useSalesperson();
  const [entryVersion, setEntryVersion] = useState(0);
  const [quote, setQuote] = useState<string>("");

  useEffect(() => {
    if (!loaded) return;
    if (!salesperson) {
      router.replace("/");
      return;
    }
    // juice_box_only accounts (Travis, Rizz, …) only have access to
    // /juice-box; bounce them away from Home so the URL bar can't be
    // used to peek at the full dashboard.
    if (salesperson.role === "juice_box_only") {
      router.replace("/juice-box");
    }
  }, [loaded, salesperson, router]);

  useScrollToTop();

  useEffect(() => {
    // Picking a random quote on the client only (avoids SSR/CSR hydration
    // mismatch from Math.random). Synchronous setState here is the right
    // pattern for this case.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQuote(nextQuote());
  }, []);

  if (!loaded || !salesperson) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  if (salesperson.role === "assistant") {
    return (
      <>
        <main
          className={`pwa-safe-top mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 p-4 sm:p-6 ${BOTTOM_NAV_SPACER}`}
        >
          {/* Assistant header mirrors the AE header's account chrome: a
              small Settings gear linking to /more (which hosts the
              account summary, notification opt-in when Juice Box-
              eligible, the admin shortcut, and Log out). Without this
              link, role === "assistant" users had no way to reach /more
              — the bottom nav also drops it for them. The Admin link
              is rendered alongside for admin-assistant accounts (e.g.
              Tonja) so the admin queue stays one tap away. */}
          <header className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                  Hi, {salesperson.first_name}
                </h1>
              </div>
              <Logo width={180} height={55} priority className="shrink-0" />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {salesperson.is_admin && (
                <Link
                  href="/admin"
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  Admin
                </Link>
              )}
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
            </div>
          </header>
          <VerificationCenter />
        </main>
        <BottomNav salesperson={salesperson} />
      </>
    );
  }

  // "Today" reads from the Denver business calendar so the greeting matches
  // what the dashboard, leaderboard, and Weekly Focus all consider "now".
  const now = todayInAppTimezone();
  const today = `${format(now, "EEEE")}, ${formatDateMDY(now)}`;

  return (
    <>
      <main
        className={`pwa-safe-top mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-3 p-4 ${BOTTOM_NAV_SPACER}`}
      >
        {/* Compact greeting — the weekly momentum card is the visual hero.
            The settings icon on the right links to /more, which hosts
            notification opt-in, the admin shortcut, and log out. */}
        <header className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            {/* Subtle white brand mark next to the greeting. */}
            <Logo width={120} height={37} className="shrink-0 opacity-90" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground">{today}</p>
              <h1 className="truncate text-xl font-bold tracking-tight">
                Hi, {salesperson.first_name} 👋
              </h1>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {salesperson.is_admin && (
              <Link
                href="/admin"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Admin
              </Link>
            )}
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
          </div>
        </header>

        <ThisWeekCard salespersonId={salesperson.id} refreshKey={entryVersion} />

        {/* Offices entry point — sits directly under the weekly
            momentum hero so it's the first action the AE sees once
            they've scanned their numbers for the day. The Offices
            surface now consolidates the old Map + List views under
            a single `/offices` URL; the destination defaults to
            the Map view with auto-locate so the AE lands ready to
            see what's around them.
            Gated on `is_test === true` because the /offices surface
            is itself test-account-only today; showing the card to
            non-test AEs would result in a tap → redirect dead-end.
            Once the office surface graduates to all AEs, the gate
            can drop. */}
        {salesperson.is_test === true && (
          <Card size="sm">
            <CardHeader>
              <CardTitle>📍 Offices</CardTitle>
              <CardDescription>
                See what&apos;s around you on the map, search your full
                office list, get directions, and log visits.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link
                href="/offices"
                className={buttonVariants({ size: "sm" })}
              >
                Open Offices
              </Link>
            </CardContent>
          </Card>
        )}

        <MessagesCard salespersonId={salesperson.id} />

        <Card id="log-activity" size="sm" className="scroll-mt-4">
          <CardHeader>
            <CardTitle>Log activity</CardTitle>
            <CardDescription>
              Enter only what you just did — it adds to your weekly total.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DailyEntryForm
              salespersonId={salesperson.id}
              refreshKey={entryVersion}
              onSaved={() => setEntryVersion((n) => n + 1)}
            />
          </CardContent>
        </Card>

        <RecentActivityCard refreshKey={entryVersion} />

        <MyWeekCard salespersonId={salesperson.id} refreshKey={entryVersion} />

        <EditWeekCard
          salespersonId={salesperson.id}
          refreshKey={entryVersion}
          onSaved={() => setEntryVersion((n) => n + 1)}
        />

        {quote && (
          <p className="px-3 pb-1 text-center text-xs italic text-muted-foreground/70">
            &ldquo;{quote}&rdquo;
          </p>
        )}
      </main>
      <BottomNav salesperson={salesperson} />
    </>
  );
}
