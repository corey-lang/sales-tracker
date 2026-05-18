"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { useSalesperson } from "@/lib/use-salesperson";
import { useScrollToTop } from "@/lib/use-scroll-to-top";
import { ACTIVITIES, type ActivityKey, type ActivityValues } from "@/lib/activities";
import { progressColor } from "@/lib/goals";
import { cn } from "@/lib/utils";

import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Shape returned by GET /api/leaderboard. Percentages are computed
// server-side; raw weekly_goals targets never reach the browser.
type Standing = {
  id: string;
  first_name: string;
  total: number;
  totals: ActivityValues;
  percent: number | null;
};

export default function LeaderboardPage() {
  const router = useRouter();
  const { salesperson, loaded } = useSalesperson();
  useScrollToTop();

  const [standings, setStandings] = useState<Standing[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loaded && !salesperson) router.replace("/");
  }, [loaded, salesperson, router]);

  useEffect(() => {
    if (!loaded || !salesperson) return;
    let cancelled = false;

    // Percentages are computed server-side by /api/leaderboard so raw
    // weekly_goals targets never reach the browser. Sorting stays here to
    // preserve this view's existing ranking behavior.
    fetch("/api/leaderboard")
      .then(async (res) => {
        const body = (await res.json()) as {
          standings?: Standing[];
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error ?? "Couldn't load leaderboard.");
          return;
        }
        const result = body.standings ?? [];

        // Sort by percent desc (null goes last); name as tiebreaker.
        result.sort((a, b) => {
          if (a.percent === null && b.percent === null) {
            return (
              b.total - a.total || a.first_name.localeCompare(b.first_name)
            );
          }
          if (a.percent === null) return 1;
          if (b.percent === null) return -1;
          return (
            b.percent - a.percent ||
            b.total - a.total ||
            a.first_name.localeCompare(b.first_name)
          );
        });
        setStandings(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Couldn't load leaderboard.",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [loaded, salesperson]);

  if (!loaded || !salesperson) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            This week (Mon-Fri)
          </p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Leaderboard
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
        <Link
          href={salesperson.is_admin ? "/admin" : "/dashboard"}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          ← {salesperson.is_admin ? "Admin" : "Dashboard"}
        </Link>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Team standings</CardTitle>
          <CardDescription>
            Ranked by % of weekly goal completed Monday-Friday.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <p className="text-sm text-destructive">Couldn&apos;t load: {error}</p>
          ) : !standings ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : standings.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No salespeople yet. Seed some rows in <code>salespeople</code>.
            </p>
          ) : (
            <ol className="space-y-2">
              {standings.map((s, i) => (
                <StandingRow
                  key={s.id}
                  rank={i + 1}
                  standing={s}
                  isMe={s.id === salesperson.id}
                />
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function StandingRow({
  rank,
  standing,
  isMe,
}: {
  rank: number;
  standing: Standing;
  isMe: boolean;
}) {
  const percent = standing.percent;
  const { text: percentColor } =
    percent === null ? { text: "" } : progressColor(percent);
  return (
    <li
      className={cn(
        "rounded-lg border p-3",
        isMe ? "border-primary bg-primary/5" : "border-border",
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <span className="text-lg font-semibold tabular-nums text-muted-foreground">
            #{rank}
          </span>
          <span className="text-base font-medium">
            {standing.first_name}
            {isMe && (
              <span className="ml-2 text-xs text-muted-foreground">(you)</span>
            )}
          </span>
        </div>
        <div className="flex flex-col items-end leading-tight">
          <span className="text-2xl font-semibold tabular-nums">
            {standing.total}
          </span>
          {percent !== null && (
            <span
              className={cn("text-sm font-semibold tabular-nums", percentColor)}
            >
              {percent}%
            </span>
          )}
        </div>
      </div>
      <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1 text-xs text-muted-foreground sm:grid-cols-6">
        {ACTIVITIES.map((a) => (
          <div key={a.key} className="flex items-baseline justify-between">
            <dt className="truncate">{shortLabel(a.key)}</dt>
            <dd className="ml-1 tabular-nums text-foreground">
              {standing.totals[a.key]}
            </dd>
          </div>
        ))}
      </dl>
    </li>
  );
}

function shortLabel(key: ActivityKey): string {
  switch (key) {
    case "office_visits":
      return "Visits";
    case "service_requests":
      return "Reqs";
    case "ones_scheduled":
      return "1:1 Sch";
    case "ones_held":
      return "1:1 Held";
    case "presentations":
      return "Pres";
    case "impressions":
      return "Impr";
    case "team_meetings":
      return "Mtgs";
  }
}
