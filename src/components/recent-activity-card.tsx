"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { formatActivityStamp } from "@/lib/dates";
import { cn } from "@/lib/utils";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Read-only AE Recent Activity feed. The card pulls a merged list of
// recent To-Do changes, business-card scans, and tracker entry-day
// writes from /api/recent-activity, which derives events from existing
// timestamps (no audit-log table). Tracker rows surface one "Logged
// activity" event per day with the current totals — we cannot
// reconstruct individual increments from the per-day schema.

type RecentActivityType =
  | "tracker_log"
  | "task_added"
  | "task_edited"
  | "task_completed"
  | "task_deleted"
  | "card_scan";

type RecentActivityEvent = {
  id: string;
  occurred_at: string;
  type: RecentActivityType;
  text: string;
};

type Props = {
  /**
   * Bumps when the dashboard reports a fresh entry save. Used to refetch
   * the feed so a just-logged activity appears without a page reload.
   */
  refreshKey: number;
};

function errorOf(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const value = (payload as { error?: unknown }).error;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return fallback;
}

/**
 * Default visible count before the user expands the list. The API still
 * returns the full window — this is purely a client-side display cap to
 * keep the card compact when the user has been busy.
 */
const DEFAULT_VISIBLE = 3;

export function RecentActivityCard({ refreshKey }: Props) {
  const [events, setEvents] = useState<RecentActivityEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch("/api/recent-activity");
        const payload = (await res.json().catch(() => null)) as
          | { events?: RecentActivityEvent[]; error?: string }
          | null;
        if (cancelled) return;
        if (!res.ok) {
          throw new Error(errorOf(payload, `Request failed (${res.status})`));
        }
        setEvents(Array.isArray(payload?.events) ? payload.events : []);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load.");
        setEvents([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const total = events?.length ?? 0;
  const overflow = total > DEFAULT_VISIBLE;
  const visible = events
    ? expanded
      ? events
      : events.slice(0, DEFAULT_VISIBLE)
    : null;
  const hiddenCount = total - DEFAULT_VISIBLE;

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Your Recent Activity</CardTitle>
        <CardDescription>The latest things you logged.</CardDescription>
      </CardHeader>
      <CardContent>
        {events === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : total === 0 ? (
          <p className="text-sm text-muted-foreground">
            No recent activity yet. Log your first win.
          </p>
        ) : (
          <div className="space-y-1.5">
            <ul className="divide-y divide-border/60">
              {visible?.map((ev) => (
                <li
                  key={ev.id}
                  className="flex flex-col gap-0.5 py-1 first:pt-0 last:pb-0 sm:flex-row sm:items-baseline sm:gap-2"
                >
                  <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground tabular-nums">
                    {formatActivityStamp(ev.occurred_at)}
                  </span>
                  <span className="min-w-0 text-sm leading-snug break-words">
                    {ev.text}
                  </span>
                </li>
              ))}
            </ul>
            {overflow && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    "size-3.5 transition-transform",
                    expanded && "rotate-180",
                  )}
                />
                {expanded ? "Show Less" : `Show ${hiddenCount} More`}
              </button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
