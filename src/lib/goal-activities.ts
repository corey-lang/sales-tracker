import type { WeeklyGoalValues } from "@/lib/one-on-ones";

// Single source of truth for the activity columns the coaching goal
// surface renders + validates. The Weekly Goals card, the Next Week
// Goals form, the server-side goal-resolver, and the goal-validation
// schema all read this list — keeping it in one place stops the client
// and server lists from drifting (a previous version had two duplicated
// arrays that could quietly disagree about which keys mattered).
//
// Lives in `lib/` (not `lib/server/`) so it's safe to import from both
// server routes and `"use client"` components.

export const GOAL_ACTIVITY_KEYS: ReadonlyArray<{
  key: keyof WeeklyGoalValues;
  label: string;
}> = [
  { key: "office_visits", label: "Office visits" },
  { key: "service_requests", label: "Service requests" },
  { key: "ones_scheduled", label: "1:1s scheduled" },
  { key: "ones_held", label: "1:1s held" },
  { key: "presentations", label: "Presentations" },
  { key: "impressions", label: "Impressions" },
  { key: "team_meetings", label: "Team meetings" },
  { key: "gold_list_touches", label: "Gold list" },
];

/** Zero-initialised goal-values object — convenient seed for forms. */
export const ZERO_GOAL_VALUES: WeeklyGoalValues = {
  office_visits: 0,
  service_requests: 0,
  ones_scheduled: 0,
  ones_held: 0,
  presentations: 0,
  impressions: 0,
  team_meetings: 0,
  gold_list_touches: 0,
};
