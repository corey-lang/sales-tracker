"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { addDays, format, parseISO } from "date-fns";
import { ArrowRight, ClipboardList, Repeat, Trophy } from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { mondayOfWeek, progressColor } from "@/lib/goals";
import { cn } from "@/lib/utils";
import type { CoachingAeSummary } from "@/lib/one-on-ones";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Admin → Coaching (Weekly Focus) index. One row per AE:
//   * current week % + rank from the leaderboard
//   * "This week" / "Week of …" label derived from the AE's latest Weekly
//     Focus row's week_start (or "New this week" when none yet)
//   * count of open commitments on the current week + carryover from prior
//     weeks (motivational, not punitive)
//   * link into the per-AE Weekly Focus detail page
//
// Tone is coaching/momentum first — not HR. Layout reads like a team
// momentum board, with the active percent doing the visual heavy lifting.

export default function CoachingIndexPage() {
  const [summaries, setSummaries] = useState<CoachingAeSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/admin/coaching")
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as {
          summaries?: CoachingAeSummary[];
          error?: string;
        } | null;
        if (cancelled) return;
        if (!res.ok || !body) {
          setError(body?.error ?? `Couldn't load (${res.status}).`);
          return;
        }
        setSummaries(body.summaries ?? []);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Couldn't load.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Weekly Focus</CardTitle>
          <CardDescription>
            Pick an AE to set this week&apos;s focus, capture wins, and carry
            commitments forward. Sorted by this week&apos;s pace.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <p className="text-sm text-destructive">Couldn&apos;t load: {error}</p>
          ) : !summaries ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : summaries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No AEs yet. Seed some salespeople with role &lsquo;ae&rsquo; first.
            </p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {summaries.map((s) => (
                <AeRow key={s.id} summary={s} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AeRow({ summary }: { summary: CoachingAeSummary }) {
  const pctColor =
    summary.percent === null
      ? "text-muted-foreground"
      : progressColor(summary.percent).text;
  const weekLabel = describeWeek(summary.latest_week_start);
  return (
    <li>
      <Link
        href={`/admin/coaching/${summary.id}`}
        className="group block rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-base font-semibold">
              {summary.first_name}
            </p>
            <p className="text-xs text-muted-foreground">{weekLabel}</p>
          </div>
          <span
            className={cn(
              "shrink-0 text-2xl font-bold tabular-nums",
              pctColor,
            )}
          >
            {summary.percent === null ? "—" : `${summary.percent}%`}
          </span>
        </div>
        <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <Trophy aria-hidden="true" className="size-3.5" />
              {summary.rank === null ? "—" : `#${summary.rank}`}
            </span>
            <span className="inline-flex items-center gap-1">
              <ClipboardList aria-hidden="true" className="size-3.5" />
              {summary.open_commitments} open
            </span>
            {summary.carried_commitments > 0 && (
              <span
                className="inline-flex items-center gap-1 text-primary"
                title="Open commitments carried forward from prior weeks"
              >
                <Repeat aria-hidden="true" className="size-3.5" />
                +{summary.carried_commitments} carried
              </span>
            )}
          </div>
          <span className="inline-flex items-center gap-1 text-primary opacity-0 transition-opacity group-hover:opacity-100">
            Open
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </span>
        </div>
      </Link>
    </li>
  );
}

/**
 * Describes an AE's latest Weekly Focus row in human terms.
 *   * `null`            → "New this week" (manager hasn't opened them yet)
 *   * current week      → "This week"
 *   * any past week     → "Week of MMM d – MMM d"
 *
 * Compared against `mondayOfWeek()` rather than today so a Saturday-night
 * load still shows the just-closed Mon-Fri week as "this week" until the
 * next Monday rolls over.
 */
function describeWeek(weekStart: string | null): string {
  if (!weekStart) return "New this week";
  const current = mondayOfWeek();
  if (weekStart === current) return "This week";
  const monday = parseISO(weekStart);
  const friday = addDays(monday, 4);
  return `Week of ${format(monday, "MMM d")} – ${format(friday, "MMM d")}`;
}
