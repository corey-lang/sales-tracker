"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { format } from "date-fns";
import { Trophy } from "lucide-react";

import { supabase } from "@/lib/supabase/client";
import {
  ACTIVITIES,
  ZERO_ACTIVITY,
  type ActivityKey,
  type ActivityValues,
} from "@/lib/activities";
import { averagePercent, businessWeekToDateRange, progressColor } from "@/lib/goals";
import { cn } from "@/lib/utils";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

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
  percent: number;
};

const ACTIVITY_KEYS = ACTIVITIES.map((a) => a.key);

type Props = {
  currentSalespersonId: string;
  refreshKey: number;
};

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
    const { since, through } = businessWeekToDateRange(now);

    Promise.all([
      supabase
        .from("salespeople")
        .select("id, first_name")
        .eq("is_admin", false)
        .eq("is_test", false)
        .neq("role", "assistant"),
      supabase
        .from("activity_entries")
        .select(
          ["salesperson_id", ...ACTIVITIES.map((a) => a.key)].join(","),
        )
        .gte("entry_date", since)
        .lte("entry_date", through),
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

      const totalsByPerson = new Map<string, ActivityValues>();
      for (const p of people) totalsByPerson.set(p.id, { ...ZERO_ACTIVITY });
      for (const e of entries) {
        const bucket = totalsByPerson.get(e.salesperson_id);
        if (!bucket) continue;
        for (const a of ACTIVITIES) {
          bucket[a.key] += Number(e[a.key as ActivityKey] ?? 0);
        }
      }

      const result: Standing[] = people.map((p) => {
        const totals = totalsByPerson.get(p.id) ?? { ...ZERO_ACTIVITY };
        const goal = activeGoalFor(p.id, allGoals, todayStr);
        const weeklyTargets = { ...ZERO_ACTIVITY };
        if (goal) {
          for (const a of ACTIVITIES) {
            weeklyTargets[a.key] = Number(goal[a.key as ActivityKey] ?? 0);
          }
        }
        const percent =
          averagePercent(totals, weeklyTargets, ACTIVITY_KEYS) ?? 0;
        return { id: p.id, first_name: p.first_name, percent };
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
