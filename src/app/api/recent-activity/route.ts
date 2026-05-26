import { format, subDays } from "date-fns";

import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError, requireAeToolAccess } from "@/lib/server/auth";
import { ACTIVITIES, type ActivityValues } from "@/lib/activities";
import { appTimezoneMidnightUtc, todayInAppTimezone } from "@/lib/dates";

// AE Recent Activity feed.
//   GET /api/recent-activity   -> { events: RecentActivityEvent[] }
//
// SOURCE TABLES (read-only, derived from existing timestamps):
//   - ae_tasks          → Added / Edited / Completed / Deleted To-Do events
//   - business_card_scans → Submitted business card scan events
//   - activity_entries  → "Logged activity" events (one per day's row)
//
// OWNERSHIP
//   Every query is scoped to requireAeToolAccess(req).id, so an AE only
//   ever sees their own activity. Service-role Supabase bypasses RLS but
//   we still pin salesperson_id on every read.
//
// NOTE on activity_entries
//   The tracker table holds one row per (salesperson_id, entry_date) with
//   per-activity totals. There is no per-save audit row, so we cannot
//   reconstruct individual increments (e.g. "added 3 calls at 10:14 AM").
//   We surface one event per daily row at `updated_at`, summarizing the
//   row's current totals — the closest honest signal available without
//   introducing an audit table.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOOKBACK_DAYS = 14;
const RESULT_LIMIT = 15;

/** Event types the feed can emit. */
export type RecentActivityType =
  | "tracker_log"
  | "task_added"
  | "task_edited"
  | "task_completed"
  | "task_deleted"
  | "card_scan";

type RecentActivityEvent = {
  /** Stable React key. Combines source table + row id + event flavor. */
  id: string;
  /** ISO timestamp of the event. */
  occurred_at: string;
  type: RecentActivityType;
  /** Pre-rendered plain-English description, no time prefix. */
  text: string;
};

/** Compact title — long task titles would push the feed wide on mobile. */
function shortenTitle(title: string): string {
  const t = (title ?? "").trim();
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
}

/**
 * Renders the per-day tracker summary the same way EditWeekCard does:
 * "Office visits 3, Service requests 1" (zeros omitted, labels as-is).
 * Mirrors `src/components/edit-week-card.tsx` so wording stays consistent.
 *
 * Wording note: we say "Activity snapshot" rather than implying a discrete
 * increment, because activity_entries stores cumulative per-day totals.
 * The displayed numbers reflect the row's state at `updated_at`, not the
 * delta applied at that moment.
 */
function trackerLogText(row: Partial<ActivityValues>): string {
  const parts = ACTIVITIES.filter((a) => Number(row[a.key] ?? 0) > 0).map(
    (a) => `${a.label} ${Number(row[a.key])}`,
  );
  if (parts.length === 0) return "Activity snapshot";
  return `Activity snapshot (${parts.join(", ")})`;
}

export async function GET(req: Request) {
  try {
    const me = await requireAeToolAccess(req);
    const supabase = getServerSupabase();

    const today = todayInAppTimezone();
    // entry_date is a DATE; updated_at / created_at are timestamptz. Use the
    // right shape for each filter so the existing indexes apply. The ISO
    // bound is Denver-midnight expressed as UTC so the 14-day window does
    // not drift by the server's local offset (Vercel runs in UTC).
    const sinceDate = format(subDays(today, LOOKBACK_DAYS), "yyyy-MM-dd");
    const sinceIso = appTimezoneMidnightUtc(sinceDate);

    const activityCols = ACTIVITIES.map((a) => a.key).join(", ");

    const [tasksRes, scansRes, entriesRes] = await Promise.all([
      supabase
        .from("ae_tasks")
        .select("id, title, status, created_at, updated_at, completed_at")
        .eq("salesperson_id", me.id)
        // Use updated_at so a task created earlier but recently completed /
        // deleted / edited still surfaces in the window.
        .gte("updated_at", sinceIso)
        .order("updated_at", { ascending: false })
        .limit(60),
      supabase
        .from("business_card_scans")
        .select("id, created_at")
        .eq("salesperson_id", me.id)
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .limit(30),
      supabase
        .from("activity_entries")
        .select(`id, entry_date, created_at, updated_at, ${activityCols}`)
        .eq("salesperson_id", me.id)
        .gte("entry_date", sinceDate)
        .order("entry_date", { ascending: false })
        .limit(LOOKBACK_DAYS + 2),
    ]);

    if (tasksRes.error) {
      throw new Error(`Failed to load tasks: ${tasksRes.error.message}`);
    }
    if (scansRes.error) {
      throw new Error(`Failed to load scans: ${scansRes.error.message}`);
    }
    if (entriesRes.error) {
      throw new Error(`Failed to load entries: ${entriesRes.error.message}`);
    }

    const events: RecentActivityEvent[] = [];

    // ae_tasks → up to two events per row: Added (only when the create
    // itself falls inside the lookback window) plus the most recent state-
    // change (Completed / Deleted / Edited). The query is filtered by
    // updated_at, so a very old task touched recently shows up — but its
    // original creation must not be reported as if it just happened.
    // We do not try to reconstruct intermediate edits before a completion
    // — the row only remembers its latest updated_at.
    for (const t of tasksRes.data ?? []) {
      const title = shortenTitle(t.title ?? "");
      if (t.created_at >= sinceIso) {
        events.push({
          id: `task:${t.id}:added`,
          occurred_at: t.created_at,
          type: "task_added",
          text: `Added To-Do: "${title}"`,
        });
      }
      if (t.status === "done" && t.completed_at) {
        events.push({
          id: `task:${t.id}:completed`,
          occurred_at: t.completed_at,
          type: "task_completed",
          text: `Completed To-Do: "${title}"`,
        });
      } else if (t.status === "cancelled" && t.updated_at > t.created_at) {
        events.push({
          id: `task:${t.id}:deleted`,
          occurred_at: t.updated_at,
          type: "task_deleted",
          text: `Deleted To-Do: "${title}"`,
        });
      } else if (t.status === "open" && t.updated_at > t.created_at) {
        events.push({
          id: `task:${t.id}:edited`,
          occurred_at: t.updated_at,
          type: "task_edited",
          text: `Edited To-Do: "${title}"`,
        });
      }
    }

    // business_card_scans — one event per scan upload. We include every
    // scan owned by this AE in the window, including test-account rows
    // (the AE is just seeing their own activity, test flag or not).
    for (const s of scansRes.data ?? []) {
      events.push({
        id: `scan:${s.id}`,
        occurred_at: s.created_at,
        type: "card_scan",
        text: "Submitted business card scan",
      });
    }

    // activity_entries — one event per daily row, stamped at updated_at.
    // The dynamic select string defeats Supabase's static type inference, so
    // cast through `unknown` to apply our column-level shape.
    const entryRows = (entriesRes.data ?? []) as unknown as Array<
      Partial<ActivityValues> & {
        id: string;
        created_at: string;
        updated_at: string | null;
      }
    >;
    for (const r of entryRows) {
      events.push({
        id: `entry:${r.id}`,
        occurred_at: r.updated_at ?? r.created_at,
        type: "tracker_log",
        text: trackerLogText(r),
      });
    }

    // Reverse chronological, then trim to the visible window.
    events.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));

    return Response.json({ events: events.slice(0, RESULT_LIMIT) });
  } catch (err) {
    return handleApiError(err);
  }
}
