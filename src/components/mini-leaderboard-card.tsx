"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Trophy } from "lucide-react";

import { progressColor } from "@/lib/goals";
import { cn } from "@/lib/utils";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

// Percent score per rep, as returned by GET /api/leaderboard. The endpoint
// returns `percent` as number | null; this card treats "no goal" as 0%,
// unchanged from the prior client-side behavior.
type Standing = {
  id: string;
  first_name: string;
  percent: number;
};

type Props = {
  currentSalespersonId: string;
  refreshKey: number;
};

export function MiniLeaderboardCard({
  currentSalespersonId,
  refreshKey,
}: Props) {
  const [standings, setStandings] = useState<Standing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Percentages come from /api/leaderboard so raw weekly_goals targets
    // never reach the browser. Sorting stays here to preserve this card's
    // existing ranking behavior.
    fetch("/api/leaderboard")
      .then(async (res) => {
        const body = (await res.json()) as {
          standings?: Array<{
            id: string;
            first_name: string;
            percent: number | null;
          }>;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error ?? "Couldn't load leaderboard.");
          return;
        }
        const result: Standing[] = (body.standings ?? []).map((s) => ({
          id: s.id,
          first_name: s.first_name,
          percent: s.percent ?? 0,
        }));
        result.sort(
          (a, b) =>
            b.percent - a.percent ||
            a.first_name.localeCompare(b.first_name),
        );
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
  }, [currentSalespersonId, refreshKey]);

  const trophyClass = (rank: number) =>
    rank === 1
      ? "text-yellow-500"
      : rank === 2
        ? "text-slate-400"
        : "text-amber-700";

  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-end gap-2">
          {standings && standings.length > 3 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Show top 3" : `Show all (${standings.length})`}
            </Button>
          )}
          <Link
            href="/leaderboard"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            View full →
          </Link>
        </div>
        {error ? (
          <p className="text-sm text-destructive">Couldn&apos;t load: {error}</p>
        ) : !standings ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : standings.length === 0 ? (
          <p className="text-sm text-muted-foreground">No salespeople yet.</p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
              {standings.slice(0, 3).map((s, i) => {
                const rank = i + 1;
                const { text: percentColor } = progressColor(s.percent);
                const isMe = s.id === currentSalespersonId;
                return (
                  <div
                    key={s.id}
                    className={cn(
                      "rounded-md border p-2 text-center",
                      isMe
                        ? "border-primary bg-primary/5"
                        : "border-border",
                    )}
                  >
                    <div className="flex items-center justify-center gap-1">
                      <span className="text-xs font-semibold tabular-nums text-muted-foreground">
                        #{rank}
                      </span>
                      <Trophy
                        className={cn(
                          "h-3.5 w-3.5 shrink-0",
                          trophyClass(rank),
                        )}
                        aria-label={`Rank ${rank}`}
                      />
                      <span className="truncate text-sm font-medium">
                        {s.first_name}
                      </span>
                    </div>
                    <p
                      className={cn(
                        "mt-0.5 text-base font-semibold tabular-nums",
                        percentColor,
                      )}
                    >
                      {s.percent}%
                    </p>
                  </div>
                );
              })}
            </div>

            {expanded && standings.length > 3 && (
              <ol className="space-y-2">
                {standings.slice(3).map((s, i) => {
                  const rank = i + 4;
                  const isMe = s.id === currentSalespersonId;
                  const { text: percentColor } = progressColor(s.percent);
                  return (
                    <li
                      key={s.id}
                      className={cn(
                        "flex items-center justify-between rounded-md border px-3 py-2",
                        isMe
                          ? "border-primary bg-primary/5"
                          : "border-border",
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <span className="w-5 text-center text-sm font-semibold tabular-nums text-muted-foreground">
                          #{rank}
                        </span>
                        <span className="text-sm font-medium">
                          {s.first_name}
                          {isMe && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              (you)
                            </span>
                          )}
                        </span>
                      </div>
                      <span
                        className={cn(
                          "text-base font-semibold tabular-nums",
                          percentColor,
                        )}
                      >
                        {s.percent}%
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
