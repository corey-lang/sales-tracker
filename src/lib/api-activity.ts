"use client";

import { apiFetchJson } from "@/lib/api-client";
import { ZERO_ACTIVITY, type ActivityKey, type ActivityValues } from "@/lib/activities";
import type { WeeklyGoal } from "@/lib/goals";

// Client bindings for the AE's OWN activity endpoints (/api/me/activity/*).
//
// These replace the direct browser Supabase reads/writes the dashboard activity
// cards used to perform against `activity_entries`. The important difference is
// not the transport but the identity: there is no salesperson parameter here at
// all. The server takes the AE from the signed session token, re-reads their
// `salespeople` row, and rejects `juice_box_only` (403) and deactivated (401)
// callers — so no client-side value decides whose activity is read or written.
//
// Every call goes through apiFetchJson, which attaches the bearer token and
// turns a JSON error response into an ApiResponseError carrying its status.

/** Response of GET /api/me/activity/week and PUT (which omits `goal`). */
export type ActivityWeekResponse = {
  week_start: string;
  week_end: string;
  business_monday?: string;
  totals: ActivityValues;
  entry_count: number;
  /** The caller's own weekly goal in effect for the week's paired Mon-Fri
   *  week, or null when no goal is set. Never another AE's override. */
  goal?: WeeklyGoal | null;
};

/** Response of POST /api/me/activity/increment. */
export type ActivityIncrementResponse = {
  entry_date: string;
  key: ActivityKey;
  /** The activity's new value on today's row. */
  value: number;
  week_start: string;
  /** The caller's Sun-Sat week totals AFTER the write (server truth). */
  totals: ActivityValues;
};

/** Normalizes a wire `totals` object so a missing key can never render NaN. */
export function activityValuesFrom(raw: unknown): ActivityValues {
  const out: ActivityValues = { ...ZERO_ACTIVITY };
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(out) as ActivityKey[]) {
    out[key] = Number(obj[key] ?? 0) || 0;
  }
  return out;
}

/**
 * Reads the caller's own Sun-Sat activity week. `weekStart` (a Sunday) is
 * optional — the server defaults to the current activity week, so live
 * surfaces don't have to compute a date the server would only re-validate.
 */
export function fetchMyActivityWeek(
  weekStart?: string,
): Promise<ActivityWeekResponse> {
  const qs = weekStart ? `?week_start=${encodeURIComponent(weekStart)}` : "";
  return apiFetchJson<ActivityWeekResponse>(`/api/me/activity/week${qs}`);
}

/** Adds `delta` to one activity on the caller's row for today (server's date). */
export function incrementMyActivity(
  key: ActivityKey,
  delta: number,
): Promise<ActivityIncrementResponse> {
  return apiFetchJson<ActivityIncrementResponse>("/api/me/activity/increment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, delta }),
  });
}

/** Replaces the caller's totals for one Sun-Sat week (atomic, server-side). */
export function saveMyActivityWeek(
  weekStart: string,
  values: ActivityValues,
): Promise<ActivityWeekResponse> {
  return apiFetchJson<ActivityWeekResponse>("/api/me/activity/week", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ week_start: weekStart, values }),
  });
}
