"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { format, parseISO } from "date-fns";
import { ArrowRight, ClipboardList, Repeat, Trophy } from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { progressColor } from "@/lib/goals";
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
//   * last COMPLETED 1:1 date (1:1s are irregular, so this is a date, not a
//     week), or "1:1 in progress" when a draft is open
//   * open 1:1 commitments, plus legacy Weekly Focus commitments still open
//   * link into the per-AE 1:1 workspace
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
            Pick an AE to open their 1:1 workspace. Sorted by this
            week&apos;s pace.
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
  // Weekly Focus commitments still open (current week + carried) — they
  // surface as carryover in the next 1:1.
  const legacyOpen = summary.open_commitments + summary.carried_commitments;
  const statusLabel = summary.one_on_one_in_progress
    ? "1:1 in progress"
    : summary.last_one_on_one_date
      ? `Last 1:1 ${format(parseISO(summary.last_one_on_one_date), "MMM d")}`
      : "No 1:1 yet";
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
            <p
              className={cn(
                "text-xs",
                summary.one_on_one_in_progress ? "font-medium text-primary" : "text-muted-foreground",
              )}
            >
              {statusLabel}
            </p>
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
              {summary.open_one_on_one_commitments} open
            </span>
            {legacyOpen > 0 && (
              <span
                className="inline-flex items-center gap-1 text-primary"
                title="Open Weekly Focus commitments — shown as carryover in the next 1:1"
              >
                <Repeat aria-hidden="true" className="size-3.5" />
                +{legacyOpen} Weekly Focus
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
