import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays, format, parseISO } from "date-fns";

import {
  ACTIVITIES,
  ZERO_ACTIVITY,
  type ActivityValues,
} from "@/lib/activities";
import { todayInAppTimezone } from "@/lib/dates";
import {
  activityWeekToDateRange,
  pairedBusinessMonday,
  resolveActiveGoal,
  type WeeklyGoal,
} from "@/lib/goals";
import { ApiError, badRequest } from "@/lib/server/auth";

// Server-side helpers for the AE's OWN activity week — the read/write path
// behind /api/me/activity/*.
//
// WHY THIS EXISTS
//   The dashboard activity cards (DailyEntryForm, MyWeekCard, EditWeekCard)
//   used to read and write `activity_entries` straight from the browser with
//   the anon key, passing a `salespersonId` prop that came from localStorage.
//   That made the AE boundary advisory: any signed-in user (including a
//   `juice_box_only` guest) could edit the stored role, reach the dashboard,
//   and read or overwrite ANY salesperson's activity by changing one id.
//
//   These helpers are only ever called with `me.id` from a verified session
//   (see requireAeToolAccess), so the salesperson is never client-supplied.
//
// WEEK MODEL (unchanged — see src/lib/goals.ts for the full rationale)
//   Activity totals are summed over the Sun-Sat ACTIVITY week. Targets,
//   availability, PTO and pace stay on the paired Mon-Fri BUSINESS week.
//   `weekStart` is therefore always a SUNDAY, and the goal is resolved as of
//   that week's paired Monday — the same anchor the client used before.
//
// Server-only. Never import from a "use client" component.

const ACTIVITY_KEYS = ACTIVITIES.map((a) => a.key);

/** yyyy-MM-dd. */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type ActivityWeekBounds = {
  /** Sunday, yyyy-MM-dd. */
  weekStart: string;
  /** Saturday, yyyy-MM-dd. */
  weekEnd: string;
  /** The paired Mon-Fri business Monday — the goal/availability anchor. */
  businessMonday: string;
};

/**
 * Validates a caller-supplied activity-week start and derives its bounds.
 *
 * Rejects (400) anything that isn't a yyyy-MM-dd SUNDAY, and any week that
 * starts after the current activity week — an AE can log/edit this week and
 * past weeks, never a future one. Bounds are derived here rather than taken
 * from the request so a client can't widen the window it writes to.
 */
export function parseActivityWeekStart(
  raw: string | null | undefined,
  today: Date = todayInAppTimezone(),
): ActivityWeekBounds {
  if (!raw || !DATE_RE.test(raw)) {
    throw badRequest("week_start is required (YYYY-MM-DD).");
  }
  const parsed = parseISO(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw badRequest("week_start is not a valid date.");
  }
  if (parsed.getDay() !== 0) {
    throw badRequest("week_start must be a Sunday (activity weeks are Sun-Sat).");
  }
  const currentWeekStart = activityWeekToDateRange(today).since;
  if (raw > currentWeekStart) {
    throw badRequest("week_start cannot be in the future.");
  }
  return {
    weekStart: raw,
    weekEnd: format(addDays(parsed, 6), "yyyy-MM-dd"),
    businessMonday: pairedBusinessMonday(parsed),
  };
}

export type ActivityWeekTotals = {
  totals: ActivityValues;
  /** How many `activity_entries` rows the week has (0 = nothing logged yet). */
  entryCount: number;
};

/**
 * Sums one salesperson's Sun-Sat activity week.
 *
 * `salespersonId` MUST come from the verified session. Throws ApiError(500)
 * with a user-safe message on a read failure (raw provider text is logged
 * server-side only) so a caller never silently renders zeros.
 */
export async function fetchActivityWeekTotals(
  supabase: SupabaseClient,
  salespersonId: string,
  bounds: Pick<ActivityWeekBounds, "weekStart" | "weekEnd">,
): Promise<ActivityWeekTotals> {
  const res = await supabase
    .from("activity_entries")
    .select(ACTIVITY_KEYS.join(","))
    .eq("salesperson_id", salespersonId)
    .gte("entry_date", bounds.weekStart)
    .lte("entry_date", bounds.weekEnd);

  if (res.error) {
    console.warn(
      `[my-activity-week] totals read failed sub=${salespersonId} week=${bounds.weekStart} code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    throw new ApiError(500, "Could not load your activity for that week.");
  }

  const rows = (res.data ?? []) as unknown as Array<Partial<ActivityValues>>;
  const totals: ActivityValues = { ...ZERO_ACTIVITY };
  for (const row of rows) {
    for (const key of ACTIVITY_KEYS) {
      totals[key] += Number(row[key] ?? 0);
    }
  }
  return { totals, entryCount: rows.length };
}

/**
 * The weekly goal in effect for one salesperson as of `asOf` (their own
 * override, else the global default) — the server-side twin of the client's
 * `fetchActiveGoalFor`, using the same pure `resolveActiveGoal` resolution so
 * targets are identical to what the browser computed before.
 *
 * Only the CALLER's resolved goal is returned; other AEs' override rows never
 * leave the server.
 */
export async function fetchResolvedGoal(
  supabase: SupabaseClient,
  salespersonId: string,
  asOf: string,
): Promise<WeeklyGoal | null> {
  const res = await supabase.from("weekly_goals").select("*");
  if (res.error) {
    console.warn(
      `[my-activity-week] goal read failed sub=${salespersonId} as_of=${asOf} code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    throw new ApiError(500, "Could not load your weekly targets.");
  }
  return resolveActiveGoal(
    salespersonId,
    (res.data ?? []) as WeeklyGoal[],
    asOf,
  );
}
