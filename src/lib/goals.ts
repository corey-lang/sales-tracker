import { supabase } from "@/lib/supabase/client";
import type { ActivityKey, ActivityValues } from "@/lib/activities";
import { ZERO_ACTIVITY } from "@/lib/activities";

// The `weekly_goals` table stores DAILY targets despite the legacy table name.
// Weekly targets = daily * WORK_DAYS_PER_WEEK.
// `salesperson_id IS NULL` = global default; a UUID = per-person override.
// gold_list_touches is in the schema but not yet in the daily entry form
// (ACTIVITIES) — admin views (which iterate ADMIN_ACTIVITY_KEYS) do read it.
export type WeeklyGoal = ActivityValues & {
  id: string;
  effective_from: string;
  salesperson_id: string | null;
  gold_list_touches: number;
  created_at?: string;
};

export const WORK_DAYS_PER_WEEK = 5;

export function dailyTargetsFrom(goal: WeeklyGoal | null): ActivityValues {
  if (!goal) return ZERO_ACTIVITY;
  const out = { ...ZERO_ACTIVITY };
  for (const key of Object.keys(ZERO_ACTIVITY) as ActivityKey[]) {
    out[key] = Number(goal[key] ?? 0);
  }
  return out;
}

export function progressColor(percent: number): {
  bar: string;
  text: string;
} {
  if (percent >= 100) {
    return { bar: "bg-green-500", text: "text-green-600 dark:text-green-400" };
  }
  if (percent >= 50) {
    return {
      bar: "bg-yellow-500",
      text: "text-yellow-600 dark:text-yellow-400",
    };
  }
  return { bar: "bg-red-500", text: "text-red-600 dark:text-red-400" };
}

// Returns the goal that should apply to this salesperson today.
// Prefers a per-person row, falls back to the global (null salesperson_id).
// Both filtered to effective_from <= today.
export async function fetchActiveGoalFor(salespersonId: string): Promise<{
  data: WeeklyGoal | null;
  error: { message: string } | null;
}> {
  const today = new Date().toISOString().slice(0, 10);
  const [personal, global] = await Promise.all([
    supabase
      .from("weekly_goals")
      .select("*")
      .eq("salesperson_id", salespersonId)
      .lte("effective_from", today)
      .order("effective_from", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("weekly_goals")
      .select("*")
      .is("salesperson_id", null)
      .lte("effective_from", today)
      .order("effective_from", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const error = personal.error ?? global.error;
  if (error) return { data: null, error };
  return {
    data: (personal.data ?? global.data) as WeeklyGoal | null,
    error: null,
  };
}

// Returns the currently effective goal for a given scope.
// scope === null  → Global default only (no per-person fallback to anything,
//                   since Global IS the top of the chain).
// scope: string   → Per-person with Global fallback (delegates to
//                   fetchActiveGoalFor, which already does that).
export async function fetchActiveGoalForScope(
  scope: string | null,
): Promise<{
  data: WeeklyGoal | null;
  error: { message: string } | null;
}> {
  if (scope !== null) return fetchActiveGoalFor(scope);
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("weekly_goals")
    .select("*")
    .is("salesperson_id", null)
    .lte("effective_from", today)
    .order("effective_from", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return { data: null, error };
  return { data: data as WeeklyGoal | null, error: null };
}
