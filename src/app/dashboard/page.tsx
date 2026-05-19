"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Camera, ListChecks, type LucideIcon } from "lucide-react";

import { formatDateMDY } from "@/lib/dates";
import { nextQuote } from "@/lib/quotes";
import { cn } from "@/lib/utils";
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
import { ThisWeekCard } from "@/components/this-week-card";
import { AeTasksCard } from "@/components/ae-tasks-card";
import { BusinessCardPanel } from "@/components/business-card-panel";
import { DailyEntryForm } from "@/components/daily-entry-form";
import { MyWeekCard } from "@/components/my-week-card";
import { EditWeekCard } from "@/components/edit-week-card";
import { MessagesCard } from "@/components/messages-card";
import { VerificationCenter } from "@/components/verification-center";

/** A compact, light quick-action button. */
function QuickAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center justify-center gap-2 rounded-lg bg-card px-3 py-2.5 text-sm font-medium ring-1 ring-foreground/10 transition-colors hover:bg-muted hover:ring-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <Icon aria-hidden="true" className="size-4 text-primary" />
      {label}
    </button>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const { salesperson, clear, loaded } = useSalesperson();
  const [entryVersion, setEntryVersion] = useState(0);
  const [quote, setQuote] = useState<string>("");
  const [scanOpen, setScanOpen] = useState(false);

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
  const isAe = salesperson.role === "ae";

  const scrollToLog = () => {
    document
      .getElementById("log-activity")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-3 p-4">
      {/* Compact greeting — the weekly momentum card is the visual hero. */}
      <header className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">{today}</p>
          <h1 className="truncate text-xl font-bold tracking-tight">
            Hi, {salesperson.first_name} 👋
          </h1>
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
          <Button variant="ghost" size="sm" onClick={handleSwitchUser}>
            Log out
          </Button>
        </div>
      </header>

      {/* 1 — This week: personal momentum + leaderboard context */}
      <ThisWeekCard salespersonId={salesperson.id} refreshKey={entryVersion} />

      <MessagesCard salespersonId={salesperson.id} />

      {/* 2 — Quick actions */}
      <section className="space-y-1.5">
        <h2 className="px-0.5 text-sm font-medium text-muted-foreground">
          Quick actions
        </h2>
        {isAe && scanOpen ? (
          <BusinessCardPanel
            salesperson={salesperson}
            onClose={() => setScanOpen(false)}
          />
        ) : (
          <div
            className={cn(
              "grid gap-2",
              isAe ? "grid-cols-2" : "grid-cols-1",
            )}
          >
            {isAe && (
              <QuickAction
                icon={Camera}
                label="Scan card"
                onClick={() => setScanOpen(true)}
              />
            )}
            <QuickAction
              icon={ListChecks}
              label="Log activity"
              onClick={scrollToLog}
            />
          </div>
        )}
      </section>

      {/* 3 — To-Do / follow-ups */}
      <AeTasksCard />

      {/* Daily activity logging — kept, de-prioritized below the dashboard. */}
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

      <MyWeekCard salespersonId={salesperson.id} refreshKey={entryVersion} />

      <EditWeekCard
        salespersonId={salesperson.id}
        refreshKey={entryVersion}
        onSaved={() => setEntryVersion((n) => n + 1)}
      />

      {/* 5 — Motivation, intentionally last and low-weight. */}
      {quote && (
        <p className="px-3 pb-1 text-center text-xs italic text-muted-foreground/70">
          &ldquo;{quote}&rdquo;
        </p>
      )}
    </main>
  );
}
