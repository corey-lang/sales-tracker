import type { SupabaseClient } from "@supabase/supabase-js";

import {
  availableDaysForWeek,
  businessDaysOfWeek,
  type WorkingDayAdjustment,
} from "@/lib/working-days";

// Server-side fetch wrappers around the pure working-days math in
// @/lib/working-days. The leaderboard/scorecard call fetchWeekAdjustments once
// per week and reuse the rows across every AE; getAvailableDaysForWeek is the
// single-AE convenience the feature spec names.

/** A user-safe error string for any adjustment-read failure. Raw Supabase /
 *  provider messages are logged server-side only, never returned. */
export const ADJUSTMENTS_READ_ERROR =
  "Could not load working day adjustments. Pace can't be calculated right now.";

/**
 * All adjustment rows whose date falls in the Mon-Fri week beginning
 * `weekStart`, as `{ adjustments, error }`.
 *
 * FAILS CLOSED: on a query error it returns `error` (a user-safe string) and
 * an EMPTY array — callers MUST treat a non-null `error` as fatal and surface
 * it, NOT silently compute pace as if there were no adjustments (which would
 * wrongly restore a full 5-day week for everyone). Raw provider messages are
 * logged with safe metadata only.
 */
export async function fetchWeekAdjustments(
  supabase: SupabaseClient,
  weekStart: string,
): Promise<{ adjustments: WorkingDayAdjustment[]; error: string | null }> {
  const days = businessDaysOfWeek(weekStart);
  const res = await supabase
    .from("working_day_adjustments")
    .select("*")
    .gte("adjustment_date", days[0])
    .lte("adjustment_date", days[days.length - 1]);
  if (res.error) {
    console.warn(
      `[working-days] week fetch failed week=${weekStart} code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    return { adjustments: [], error: ADJUSTMENTS_READ_ERROR };
  }
  return {
    adjustments: (res.data ?? []) as WorkingDayAdjustment[],
    error: null,
  };
}

/** Available working days for one AE in the week beginning `weekStart`
 *  (5 minus global + individual reductions, clamped to >= 1). Throws a
 *  user-safe error (fails closed) if the adjustment read fails. */
export async function getAvailableDaysForWeek(
  supabase: SupabaseClient,
  salespersonId: string,
  weekStart: string,
): Promise<number> {
  const { adjustments, error } = await fetchWeekAdjustments(supabase, weekStart);
  if (error) throw new Error(error);
  return availableDaysForWeek(weekStart, salespersonId, adjustments);
}
