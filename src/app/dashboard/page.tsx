"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Settings } from "lucide-react";

import { formatDateMDY, todayInAppTimezone } from "@/lib/dates";
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
import { ActivityWeekContext } from "@/components/activity-week-context";
import { MyWeekCard } from "@/components/my-week-card";
import { EditWeekCard } from "@/components/edit-week-card";
import { MessagesCard } from "@/components/messages-card";
import { RecentActivityCard } from "@/components/recent-activity-card";
import { VerificationCenter } from "@/components/verification-center";
import { AiAssistantCard } from "@/components/ai-assistant/ai-assistant-card";
import { OrdersCard } from "@/components/orders-card";

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
              eligible, and Log out). Without this link, role === "assistant"
              users had no way to reach /more — the bottom nav also drops
              it for them. Under role-as-truth a row has exactly one role,
              so the prior assistant-AND-admin hybrid path (which would have
              rendered an Admin link alongside) no longer applies; a user
              who needs the admin queue must have role='admin'. */}
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
            {salesperson.role === "admin" && (
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

        {/* Production orders (Cogent) — month-to-date vs goal, pace by business
            days (weekdays minus company holidays only), and today's count.
            Reads the AE's own numbers; fails gracefully if Cogent is down. */}
        <OrdersCard />

        {/* Test-AE-only AI Assistant beta. Renders null for every other
            account, so it sits inline without an explicit role check here —
            the gate lives inside the component (and is enforced server-side
            on /api/ai/chat). Not yet in global nav. */}
        <AiAssistantCard salesperson={salesperson} />

        {/* Offices/Map now lives in the bottom nav (the "Map" tab →
            /offices?view=map) so it's one tap away without taking up a
            home-screen card. The dashboard Offices tile was removed when
            the map grew into a full territory-execution surface. */}

        <MessagesCard salespersonId={salesperson.id} />

        <ActivityWeekContext />

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

      </main>
      <BottomNav salesperson={salesperson} />
    </>
  );
}
