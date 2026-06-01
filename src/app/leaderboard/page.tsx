"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { apiFetch } from "@/lib/api-client";
import { useSalesperson } from "@/lib/use-salesperson";
import { useScrollToTop } from "@/lib/use-scroll-to-top";
import { progressColor } from "@/lib/goals";
import { DEFAULT_WORKING_DAYS, formatAvailableDays } from "@/lib/working-days";
import { cn } from "@/lib/utils";

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

// AE-facing leaderboard. Reps compare by weighted % of weekly goal — raw
// activity counts and raw goal targets are intentionally NOT shown here.
// Percentages are computed server-side by GET /api/leaderboard (the route
// also returns raw totals for admin use; this page simply ignores them).
type Standing = {
  id: string;
  first_name: string;
  percent: number | null;
  availableDays?: number;
  isHolidayWeek?: boolean;
};

export default function LeaderboardPage() {
  const router = useRouter();
  const { salesperson, loaded } = useSalesperson();
  useScrollToTop();

  const [standings, setStandings] = useState<Standing[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) return;
    if (!salesperson) {
      router.replace("/");
      return;
    }
    // juice_box_only accounts have no leaderboard access — bounce them
    // back to their only allowed surface.
    if (salesperson.role === "juice_box_only") {
      router.replace("/juice-box");
    }
  }, [loaded, salesperson, router]);

  useEffect(() => {
    if (!loaded || !salesperson) return;
    let cancelled = false;

    // Percentages are computed server-side by /api/leaderboard so raw
    // weekly_goals targets never reach the browser. Sorting stays here to
    // preserve this view's existing ranking behavior. apiFetch attaches
    // the signed session token — /api/leaderboard now gates on
    // requireAeToolAccess, so a bare fetch would 401.
    apiFetch("/api/leaderboard")
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

        // Sort by percent desc; reps with no goal (null) go last; name as
        // the tiebreaker.
        result.sort((a, b) => {
          if (a.percent === null && b.percent === null) {
            return a.first_name.localeCompare(b.first_name);
          }
          if (a.percent === null) return 1;
          if (b.percent === null) return -1;
          return (
            b.percent - a.percent ||
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
    <>
    <main className={`pwa-safe-top mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-6 p-4 sm:p-6 ${BOTTOM_NAV_SPACER}`}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            This week (Mon-Fri)
          </p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Leaderboard
          </h1>
        </div>
        <Logo width={180} height={55} priority className="shrink-0" />
        <Link
          href={salesperson.role === "admin" ? "/admin" : "/dashboard"}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          ← {salesperson.role === "admin" ? "Admin" : "Dashboard"}
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
    <BottomNav salesperson={salesperson} />
    </>
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
  const percentColor =
    percent === null ? "text-muted-foreground" : progressColor(percent).text;
  return (
    <li
      className={cn(
        "flex items-center justify-between gap-3 rounded-lg border p-3",
        isMe ? "border-primary bg-primary/5" : "border-border",
      )}
    >
      <div className="flex min-w-0 items-baseline gap-3">
        <span className="text-lg font-semibold tabular-nums text-muted-foreground">
          #{rank}
        </span>
        <div className="min-w-0">
          <span className="truncate text-base font-medium">
            {standing.first_name}
            {isMe && (
              <span className="ml-2 text-xs text-muted-foreground">(you)</span>
            )}
          </span>
          {/* Time-off context for the signed-in rep only — informational,
              never a goal reduction, and never exposes teammates' PTO. */}
          {isMe &&
          (standing.availableDays ?? DEFAULT_WORKING_DAYS) <
            DEFAULT_WORKING_DAYS ? (
            <p className="text-xs text-primary">
              {standing.isHolidayWeek ? "Holiday Week • " : ""}
              {formatAvailableDays(
                standing.availableDays ?? DEFAULT_WORKING_DAYS,
              )}{" "}
              Available Days This Week
            </p>
          ) : null}
        </div>
      </div>
      <span
        className={cn(
          "shrink-0 text-2xl font-bold tabular-nums",
          percentColor,
        )}
      >
        {percent === null ? "—" : `${percent}%`}
      </span>
    </li>
  );
}
