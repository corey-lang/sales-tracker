"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";

import { formatDateMDY } from "@/lib/dates";
import { nextQuote } from "@/lib/quotes";
import { useSalesperson } from "@/lib/use-salesperson";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DailyEntryForm } from "@/components/daily-entry-form";
import { MyWeekCard } from "@/components/my-week-card";
import { MiniLeaderboardCard } from "@/components/mini-leaderboard-card";
import { EditEntryCard } from "@/components/edit-entry-card";
import { MessagesCard } from "@/components/messages-card";

export default function DashboardPage() {
  const router = useRouter();
  const { salesperson, clear, loaded } = useSalesperson();
  const [entryVersion, setEntryVersion] = useState(0);
  const [quote, setQuote] = useState<string>("");

  useEffect(() => {
    if (loaded && !salesperson) router.replace("/");
  }, [loaded, salesperson, router]);

  useEffect(() => {
    // Defeat browser/framework scroll-restoration on:
    // (1) initial mount  (2) the next animation frame
    // (3) bfcache restore (iOS Safari reopening a closed tab/PWA)
    const scroll = () => window.scrollTo(0, 0);
    scroll();
    const rafId = requestAnimationFrame(scroll);
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) scroll();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

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

  const now = new Date();
  const today = `${format(now, "EEEE")}, ${formatDateMDY(now)}`;

  const handleSwitchUser = () => {
    clear();
    router.push("/");
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div>
              <p className="text-sm text-muted-foreground">{today}</p>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                Hi, {salesperson.first_name}
              </h1>
            </div>
            <Image
              src="/logo.png"
              alt="Elevate Homescriptions"
              width={180}
              height={55}
              priority
              className="shrink-0"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/leaderboard"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Leaderboard
            </Link>
            {salesperson.is_admin && (
              <Link
                href="/admin"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Admin
              </Link>
            )}
            <Button variant="outline" size="sm" onClick={handleSwitchUser}>
              Log out
            </Button>
          </div>
        </div>
        {quote && (
          <p className="max-w-xl rounded-md border-l-4 border-primary bg-primary/5 px-3 py-2 text-base font-semibold italic sm:text-lg">
            &ldquo;{quote}&rdquo;
          </p>
        )}
      </header>

      <MessagesCard salespersonId={salesperson.id} />

      <MiniLeaderboardCard
        currentSalespersonId={salesperson.id}
        refreshKey={entryVersion}
      />

      <Card>
        <CardHeader>
          <CardTitle>Log activity</CardTitle>
          <CardDescription>
            Enter what you did, then tap Save on that row. The number resets
            so you can log more later.
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

      <MyWeekCard
        salespersonId={salesperson.id}
        refreshKey={entryVersion}
      />

      <EditEntryCard
        salespersonId={salesperson.id}
        refreshKey={entryVersion}
        onSaved={() => setEntryVersion((n) => n + 1)}
      />
    </main>
  );
}
