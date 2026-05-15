"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";

import { formatDateMDY } from "@/lib/dates";
import { nextQuote } from "@/lib/quotes";
import { useSalesperson } from "@/lib/use-salesperson";
import { useScrollToTop } from "@/lib/use-scroll-to-top";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BusinessCardScanner } from "@/components/business-card-scanner";
import { DailyEntryForm } from "@/components/daily-entry-form";
import { MyWeekCard } from "@/components/my-week-card";
import { MiniLeaderboardCard } from "@/components/mini-leaderboard-card";
import { EditWeekCard } from "@/components/edit-week-card";
import { MessagesCard } from "@/components/messages-card";
import { VerificationCenter } from "@/components/verification-center";

export default function DashboardPage() {
  const router = useRouter();
  const { salesperson, clear, loaded } = useSalesperson();
  const [entryVersion, setEntryVersion] = useState(0);
  const [quote, setQuote] = useState<string>("");

  useEffect(() => {
    if (loaded && !salesperson) router.replace("/");
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

  const handleSwitchUser = () => {
    clear();
    router.push("/");
  };

  if (salesperson.role === "assistant") {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 p-4 sm:p-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div>
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
          <Button variant="outline" size="sm" onClick={handleSwitchUser}>
            Log out
          </Button>
        </header>
        <VerificationCenter />
      </main>
    );
  }

  const now = new Date();
  const today = `${format(now, "EEEE")}, ${formatDateMDY(now)}`;

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
          <div className="flex flex-wrap items-start gap-2">
            {salesperson.is_admin && (
              <Link
                href="/admin"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Admin
              </Link>
            )}
            <div className="flex flex-col items-end">
              <Button variant="outline" size="sm" onClick={handleSwitchUser}>
                Log out
              </Button>
              <span className="mt-0.5 max-w-[140px] text-right text-[10px] leading-tight text-muted-foreground">
                Stay signed in to skip retyping your name
              </span>
            </div>
          </div>
        </div>
        {quote && (
          <p className="max-w-xl rounded-md border-l-4 border-primary bg-primary/5 px-3 py-2 text-base font-semibold italic sm:text-lg">
            &ldquo;{quote}&rdquo;
          </p>
        )}
        <Link
          href="/leaderboard"
          className={buttonVariants({ variant: "outline", size: "sm" })}
          style={{ width: "fit-content" }}
        >
          Leaderboard
        </Link>
      </header>

      {salesperson.role === "ae" && (
        <BusinessCardScanner salesperson={salesperson} />
      )}

      <MessagesCard salespersonId={salesperson.id} />

      <MiniLeaderboardCard
        currentSalespersonId={salesperson.id}
        refreshKey={entryVersion}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Log activity</CardTitle>
          <CardDescription className="rounded-md border-l-4 border-primary bg-primary/5 px-3 py-2 text-base font-medium text-foreground">
            Enter only what you just did — <strong>not your total</strong>.
            Numbers add to your running count. Tap <strong>Save</strong> for
            the amount you typed, or <strong>+1 (quick add)</strong> to add
            one instantly. Daily entries feed your Monday-Friday weekly
            progress.
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

      <EditWeekCard
        salespersonId={salesperson.id}
        refreshKey={entryVersion}
        onSaved={() => setEntryVersion((n) => n + 1)}
      />
    </main>
  );
}
