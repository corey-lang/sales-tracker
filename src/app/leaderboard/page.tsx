"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { format, startOfWeek } from "date-fns";

import { supabase } from "@/lib/supabase/client";
import { useSalesperson } from "@/lib/use-salesperson";
import {
  ACTIVITIES,
  ZERO_ACTIVITY,
  type ActivityKey,
  type ActivityValues,
} from "@/lib/activities";
import { cn } from "@/lib/utils";

import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Salesperson = { id: string; first_name: string };

type EntryRow = ActivityValues & { salesperson_id: string };

type Standing = {
  id: string;
  first_name: string;
  total: number;
  totals: ActivityValues;
};

export default function LeaderboardPage() {
  const router = useRouter();
  const { salesperson, loaded } = useSalesperson();

  const [standings, setStandings] = useState<Standing[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loaded && !salesperson) router.replace("/");
  }, [loaded, salesperson, router]);

  useEffect(() => {
    if (!loaded || !salesperson) return;
    let cancelled = false;
    const since = format(
      startOfWeek(new Date(), { weekStartsOn: 0 }),
      "yyyy-MM-dd",
    );

    Promise.all([
      // Admins (is_admin=true) and test accounts (is_test=true) don't compete.
      supabase
        .from("salespeople")
        .select("id, first_name")
        .eq("is_admin", false)
        .eq("is_test", false),
      supabase
        .from("activity_entries")
        .select(["salesperson_id", ...ACTIVITIES.map((a) => a.key)].join(","))
        .gte("entry_date", since),
    ]).then(([peopleRes, entriesRes]) => {
      if (cancelled) return;
      const firstErr = peopleRes.error ?? entriesRes.error;
      if (firstErr) {
        setError(firstErr.message);
        return;
      }
      const people = (peopleRes.data ?? []) as Salesperson[];
      const entries = (entriesRes.data ?? []) as unknown as EntryRow[];

      const byPerson = new Map<string, ActivityValues>();
      for (const p of people) {
        byPerson.set(p.id, { ...ZERO_ACTIVITY });
      }
      for (const e of entries) {
        const bucket = byPerson.get(e.salesperson_id);
        if (!bucket) continue;
        for (const a of ACTIVITIES) {
          bucket[a.key] += Number(e[a.key] ?? 0);
        }
      }

      const result: Standing[] = people.map((p) => {
        const totals = byPerson.get(p.id) ?? { ...ZERO_ACTIVITY };
        const total = (Object.keys(totals) as ActivityKey[]).reduce(
          (sum, k) => sum + totals[k],
          0,
        );
        return { id: p.id, first_name: p.first_name, total, totals };
      });
      result.sort(
        (a, b) => b.total - a.total || a.first_name.localeCompare(b.first_name),
      );
      setStandings(result);
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
          <p className="text-sm text-muted-foreground">This week (Sun–Sat)</p>
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
            Ranked by total activities this week (Sun–Sat).
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
        <span className="text-2xl font-semibold tabular-nums">
          {standing.total}
        </span>
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
