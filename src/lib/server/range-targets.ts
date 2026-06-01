import type { SupabaseClient } from "@supabase/supabase-js";

import { buildRangeTargets, type RangeTargets } from "@/lib/range-targets";
import type { WeeklyGoal } from "@/lib/goals";
import { fetchRangeAdjustments } from "@/lib/server/working-days";

// Server wrapper around the pure Range Goal Engine (src/lib/range-targets).
//
// calculateRangeTargets is the single-AE convenience the spec names — it
// fetches the inputs and computes one AE's range target. Surfaces that score
// MANY AEs (the Dashboard Activity Totals route) instead fetch goals +
// adjustments ONCE and call buildRangeTargets per AE; this wrapper exists for
// the future "My Activity Report" (one AE) and any other single-AE caller.
//
// Reads are server-only and FAIL CLOSED: an adjustment-read failure throws a
// user-safe error rather than silently computing as if there were no time off.
// Raw provider text is logged server-side only; weekly_goals is never mutated.

/**
 * Computes one AE's adjusted + original targets for [startDate, endDate].
 * Throws a user-safe Error on any read failure (fail closed).
 */
export async function calculateRangeTargets(
  supabase: SupabaseClient,
  salespersonId: string,
  startDate: string,
  endDate: string,
): Promise<RangeTargets> {
  const [goalsRes, adj] = await Promise.all([
    supabase.from("weekly_goals").select("*"),
    fetchRangeAdjustments(supabase, startDate, endDate),
  ]);

  if (goalsRes.error) {
    console.error(
      `[range-targets] goals read failed code=${goalsRes.error.code ?? "?"} msg=${goalsRes.error.message}`,
    );
    throw new Error("Could not load weekly goals.");
  }
  if (adj.error) {
    // Already a user-safe string (raw text logged in fetchRangeAdjustments).
    throw new Error(adj.error);
  }

  return buildRangeTargets({
    salespersonId,
    startDate,
    endDate,
    goals: (goalsRes.data ?? []) as WeeklyGoal[],
    adjustments: adj.adjustments,
  });
}
