"use client";

import { addDays, format, parseISO } from "date-fns";

import { todayInAppTimezone } from "@/lib/dates";
import { activityWeekToDateRange } from "@/lib/goals";
import { dailyBoost } from "@/lib/quotes";

// Compact context strip shown directly above the activity tracker. Surfaces, in
// one slim note: today's date, the Sun-Sat activity-tracking week range, a
// date-stable motivational line, and — on Sunday/Monday only — a subtle
// "new week" nudge.
//
// Display-only: it fetches nothing and changes no saving, goal, or business-day
// math. The week range reuses activityWeekToDateRange()'s Sunday so it always
// agrees with where logged-activity totals are summed. Everything here is
// derived deterministically from the Denver date, so server and client render
// the same markup (no hydration mismatch, no per-render flicker).
export function ActivityWeekContext() {
  const today = todayInAppTimezone();

  // `since` is the Sunday of the activity week. We add 6 for Saturday so the
  // strip shows the FULL Sun-Sat span, not activityWeekToDateRange's
  // today-capped `through` (which is meant for querying, not display).
  const { since } = activityWeekToDateRange(today);
  const sunday = parseISO(since);
  const saturday = addDays(sunday, 6);

  const todayLabel = format(today, "EEEE, MMM d");
  const rangeLabel = `${format(sunday, "MMM d")} – ${format(saturday, "MMM d")}`;
  const boost = dailyBoost(format(today, "yyyy-MM-dd"));

  // getDay() on the Denver-anchored date: 0 = Sunday, 1 = Monday.
  const dow = today.getDay();
  const isNewWeek = dow === 0 || dow === 1;

  return (
    <div className="rounded-xl bg-card px-3 py-2.5 text-sm ring-1 ring-foreground/10">
      <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
        <span className="font-medium">Today: {todayLabel}</span>
        <span className="text-muted-foreground">
          Tracking week: {rangeLabel}
        </span>
      </div>
      {isNewWeek && (
        <p className="mt-1.5 text-xs font-medium text-primary">
          New week, fresh start — log what you do and build momentum.
        </p>
      )}
      <p className="mt-1.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground/80">Daily boost:</span>{" "}
        <span className="italic">{boost}</span>
      </p>
    </div>
  );
}
