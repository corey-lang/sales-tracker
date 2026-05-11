"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { format, startOfWeek } from "date-fns";
import { Trophy } from "lucide-react";

import { supabase } from "@/lib/supabase/client";
import {
  ACTIVITIES,
  type ActivityKey,
  type ActivityValues,
} from "@/lib/activities";
import { progressColor } from "@/lib/goals";
import { cn } from "@/lib/utils";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Person = { id: string; first_name: string };
type GoalRow = ActivityValues & {
  id: string;
  salesperson_id: string | null;
  effective_from: string;
  created_at?: string;
};

type Standing = {
  id: string;
  first_name: string;
  actual: number;
  paceTarget: number;
  percent: number;
};

type Props = {
  currentSalespersonId: string;
  refreshKey: number;
};

function workdaysElapsed(today: Date): number {
  const dow = today.getDay();
  if (dow === 0 || dow === 6) return 5;
  return dow;
}

function sortGoalsByRecency(a: GoalRow, b: GoalRow) {
  const eff = b.effective_from.localeCompare(a.effective_from);
  if (eff !== 0) return eff;
  return (b.created_at ?? "").localeCompare(a.created_at ?? "");
}

function activeGoalFor(
  personId: string,
  allGoals: GoalRow[],
  todayStr: string,
): GoalRow | null {
  const personal = allGoals
    .filter(
      (g) =>
        g.salesperson_id === personId && g.effective_from <= todayStr,
    )
    .sort(sortGoalsByRecency);
  if (personal[0]) return personal[0];
  const global = allGoals
    .filter(
      (g) => g.salesperson_id === null && g.effective_from <= todayStr,
    )
    .sort(sortGoalsByRecency);
  return global[0] ?? null;
}

export function MiniLeaderboardCard({
  currentSalespersonId,
  refreshKey,
}: Props) {
  const [standings, setStandings] = useState<Standing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const now = new Date();
    const todayStr = format(now, "yyyy-MM-dd");
    const weekStart = format(
      startOfWeek(now, { weekStartsOn: 0 }),
      "yyyy-MM-dd",
    );
    const days = workdaysElapsed(now);

    Promise.all([
      supabase
        .from("salespeople")
        .select("id, first_name")
        .eq("is_admin", false)
        .eq("is_test", false),
      supabase
        .from("activity_entries")
        .select(
          ["salesperson_id", ...ACTIVITIES.map((a) => a.key)].join(","),
        )
        .gte("entry_date", weekStart),
      supabase.from("weekly_goals").select("*"),
    ]).then(([peopleRes, entriesRes, goalsRes]) => {
      if (cancelled) return;
      const firstErr =
        peopleRes.error ?? entriesRes.error ?? goalsRes.error;
      if (firstErr) {
        setError(firstErr.message);
        return;
      }
      const people = (peopleRes.data ?? []) as Person[];
      const entries = (entriesRes.data ?? []) as unknown as Array<
        Partial<ActivityValues> & { salesperson_id: string }
      >;
      const allGoals = (goalsRes.data ?? []) as GoalRow[];

      const actualByPerson = new Map<string, number>();
      for (const p of people) actualByPerson.set(p.id, 0);
      for (const e of entries) {
        let sum = actualByPerson.get(e.salesperson_id) ?? 0;
        for (const a of ACTIVITIES) {
          sum += Number(e[a.key as ActivityKey] ?? 0);
        }
        actualByPerson.set(e.salesperson_id, sum);
      }

      const result: Standing[] = people.map((p) => {
        const goal = activeGoalFor(p.id, allGoals, todayStr);
        let dailySum = 0;
        if (goal) {
          for (const a of ACTIVITIES) {
            dailySum += Number(goal[a.key as ActivityKey] ?? 0);
          }
        }
        const paceTarget = dailySum * days;
        const actual = actualByPerson.get(p.id) ?? 0;
        const percent =
          paceTarget > 0 ? Math.round((actual / paceTarget) * 100) : 0;
        return {
          id: p.id,
          first_name: p.first_name,
          actual,
          paceTarget,
          percent,
        };
      });

      result.sort(
        (a, b) =>
          b.percent - a.percent ||
          a.first_name.localeCompare(b.first_name),
      );
      setStandings(result);
      setError(null);
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
      <CardHeader>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <CardTitle>Team leaderboard</CardTitle>
            <CardDescription>
              % of pace through this work week.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
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
        </div>
      </CardHeader>
      <CardContent>
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
                      "flex flex-col items-center gap-1 rounded-md border p-2 text-center sm:p-3",
                      isMe
                        ? "border-primary bg-primary/5"
                        : "border-border",
                    )}
                  >
                    <Trophy
                      className={cn(
                        "h-5 w-5 shrink-0 sm:h-6 sm:w-6",
                        trophyClass(rank),
                      )}
                      aria-label={`Rank ${rank}`}
                    />
                    <span className="text-xs font-semibold tabular-nums text-muted-foreground">
                      #{rank}
                    </span>
                    <span className="text-sm font-medium leading-tight">
                      {s.first_name}
                      {isMe && (
                        <span className="block text-xs text-muted-foreground">
                          (you)
                        </span>
                      )}
                    </span>
                    <span
                      className={cn(
                        "text-lg font-semibold tabular-nums sm:text-xl",
                        percentColor,
                      )}
                    >
                      {s.percent}%
                    </span>
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
