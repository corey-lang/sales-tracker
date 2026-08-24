import { format } from "date-fns";
import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  handleApiError,
  parseBody,
  requireAeToolAccess,
} from "@/lib/server/auth";
import { ACTIVITIES, type ActivityKey } from "@/lib/activities";
import { todayInAppTimezone } from "@/lib/dates";
import { activityWeekToDateRange } from "@/lib/goals";
import {
  fetchActivityWeekTotals,
  parseActivityWeekStart,
} from "@/lib/server/activity-week";

// POST /api/me/activity/increment   body { key, delta }
//   → { entry_date, key, value, totals }
//
// Adds `delta` to ONE activity on the signed-in AE's row for TODAY. This is the
// "Log activity" counter path; it used to run in the browser as a select +
// upsert against `activity_entries` with the anon key, scoped by a
// `salespersonId` prop read from localStorage.
//
// IDENTITY / AUTHORIZATION
//   * requireAeToolAccess verifies the signed token, re-reads the `salespeople`
//     row, 403s `juice_box_only` callers, and 401s a deactivated person even if
//     they still hold a valid-looking token.
//   * The row written is always (me.id, today). Neither the salesperson nor the
//     date is accepted from the client — `.strict()` rejects any extra field,
//     so `salesperson_id` / `entry_date` in the body is a 400, not a hint.
//   * `entry_date` is the Denver business day, so a rep tapping just past
//     midnight local time still logs to the right day (unchanged behaviour).
//   * Increments only (delta >= 1) with a per-call cap. Corrections and
//     decrements go through PUT /api/me/activity/week, which replaces a week's
//     totals wholesale.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIVITY_KEYS = ACTIVITIES.map((a) => a.key);

const BodySchema = z
  .object({
    key: z.enum(ACTIVITY_KEYS as [ActivityKey, ...ActivityKey[]]),
    // One tap = 1; the manual row entry can be larger. Capped so a tampered
    // or fat-fingered payload can't write an absurd total.
    delta: z.number().int().min(1).max(10000),
  })
  .strict();

export async function POST(req: Request) {
  try {
    const me = await requireAeToolAccess(req);
    const { key, delta } = await parseBody(req, BodySchema);

    const today = format(todayInAppTimezone(), "yyyy-MM-dd");
    const supabase = getServerSupabase();

    // Read-then-add, hard-scoped to the caller's own row for today.
    const currentRes = await supabase
      .from("activity_entries")
      .select(key)
      .eq("salesperson_id", me.id)
      .eq("entry_date", today)
      .maybeSingle();
    if (currentRes.error) {
      console.warn(
        `[my-activity-increment] read failed sub=${me.id} key=${key} code=${currentRes.error.code ?? "?"} msg=${currentRes.error.message}`,
      );
      throw new ApiError(500, "Could not save that activity.");
    }

    const currentRow = currentRes.data as Record<string, unknown> | null;
    const next = Number(currentRow?.[key] ?? 0) + delta;

    const upsertRes = await supabase.from("activity_entries").upsert(
      {
        salesperson_id: me.id,
        entry_date: today,
        [key]: next,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "salesperson_id,entry_date" },
    );
    if (upsertRes.error) {
      console.warn(
        `[my-activity-increment] write failed sub=${me.id} key=${key} code=${upsertRes.error.code ?? "?"} msg=${upsertRes.error.message}`,
      );
      throw new ApiError(500, "Could not save that activity.");
    }

    // Return the week's server-truth totals so the counter card reconciles
    // against the DB instead of its own optimistic guess. `today` is always
    // inside the current Sun-Sat activity week, weekends included.
    const bounds = parseActivityWeekStart(activityWeekToDateRange().since);
    const week = await fetchActivityWeekTotals(supabase, me.id, bounds);

    return Response.json(
      {
        entry_date: today,
        key,
        value: next,
        week_start: bounds.weekStart,
        totals: week.totals,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
