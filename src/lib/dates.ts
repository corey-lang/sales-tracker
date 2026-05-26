import { format, parseISO, subDays } from "date-fns";

// User-facing date display: mm-dd-yyyy.
// Inputs and DB values stay yyyy-mm-dd (ISO) so they remain sortable / valid
// for Postgres DATE and HTML <input type="date">.
export function formatDateMDY(input: string | Date): string {
  const d = typeof input === "string" ? parseISO(input) : input;
  return format(d, "MM-dd-yyyy");
}

/**
 * Internal helper shared by formatTaskMoment / formatActivityStamp. Returns
 * the calendar-day token ("today" / "yesterday" / "MM-dd-yyyy") and the
 * time-of-day, both computed in `APP_TIMEZONE` so a late-night write in
 * Denver reads consistently regardless of where the browser is.
 */
function appMomentParts(iso: string): { day: string; time: string } {
  const instant = parseISO(iso);
  const dateFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const tsDate = dateFmt.format(instant);
  const today = todayInAppTimezone();
  const todayDate = format(today, "yyyy-MM-dd");
  const yesterdayDate = format(subDays(today, 1), "yyyy-MM-dd");
  const time = timeFmt.format(instant);
  if (tsDate === todayDate) return { day: "today", time };
  if (tsDate === yesterdayDate) return { day: "yesterday", time };
  return { day: formatDateMDY(tsDate), time };
}

/**
 * Friendly "today at 9:42 AM" / "yesterday at 9:42 AM" / fallback to
 * "MM-dd-yyyy at 9:42 AM" for older timestamps. Designed to read naturally
 * after a verb prefix ("Added today at 9:42 AM").
 */
export function formatTaskMoment(iso: string): string {
  const { day, time } = appMomentParts(iso);
  return `${day} at ${time}`;
}

/**
 * Headline-style stamp for the Recent Activity feed: "Today 10:14 AM" /
 * "Yesterday 4:30 PM" / "MM-dd-yyyy 4:30 PM". Capitalized so it reads as
 * a leading timestamp on its own row.
 */
export function formatActivityStamp(iso: string): string {
  const { day, time } = appMomentParts(iso);
  const label =
    day === "today" ? "Today" : day === "yesterday" ? "Yesterday" : day;
  return `${label} ${time}`;
}

/**
 * The app's authoritative business timezone.
 *
 * Everything user-facing — leaderboard week, Weekly Focus week, daily-entry
 * "today" — should be computed against this zone so a manager in Denver
 * never sees the week roll over a few hours early because the Vercel
 * function ran in UTC.
 *
 * Why Denver: the sales team is co-located in Denver. Tying the boundary
 * to a single explicit zone (vs. "server local" or UTC) avoids
 * DST-edge-case off-by-one bugs at week boundaries.
 *
 * --------------------------------------------------------------------
 * Boundary cases this module is verified against (`now` → result):
 *
 *   (1) Late Friday evening in Denver, e.g. Fri 2026-02-27 22:00 MST
 *       -> server in UTC sees `new Date()` already on Sat 05:00.
 *          todayInAppTimezone() returns the Friday Date, so:
 *            * mondayOfWeek() stays on Mon 2026-02-23
 *            * businessWeekToDateRange().through stays on Fri 2026-02-27
 *            * a tap on the AE app still logs to entry_date = 2026-02-27
 *          A naïve `new Date()` on the server would flip "today" to Sat
 *          and silently bump entries onto next week's empty row.
 *
 *   (2) Sunday late evening in Denver, e.g. Sun 2026-03-01 23:30 MST
 *       -> server-UTC `new Date()` is already Mon 06:30.
 *          todayInAppTimezone() returns Sunday, so:
 *            * mondayOfWeek() stays on Mon 2026-02-23 (the OLD week);
 *              Weekly Focus does not yet rotate to the new week.
 *          Without this, a Sunday-night refresh on the manager dashboard
 *          would auto-create next week's Weekly Focus rows hours early.
 *
 *   (3) Monday early morning Denver, e.g. Mon 2026-03-02 00:15 MST
 *       -> Denver has rolled over, UTC has been on Mon for hours.
 *          todayInAppTimezone() returns Mon 2026-03-02; mondayOfWeek()
 *          now equals that date and the current Weekly Focus row gets
 *          created on the FIRST manager visit of the new week — which
 *          is exactly the rollover semantics we want.
 *
 *   (4) Browser timezone differs from Denver (e.g. an admin opens the
 *       dashboard from JFK):
 *          Every client-side surface that previously used `new Date()`
 *          now goes through todayInAppTimezone() (admin filters card,
 *          dashboard greeting, this-week-card business-days-left,
 *          ae-tasks-card "today" bucket, daily-entry-form entry_date,
 *          recentBusinessWeeks picker, activity-report "through" date,
 *          admin dashboard "This week" defaults). Result: the JFK admin
 *          sees the same "this week" as their Denver teammate.
 *
 *   (5) Server in UTC (Vercel default):
 *          /api/leaderboard, /api/admin/leaderboard, and every coaching
 *          helper compute weeks from todayInAppTimezone(), so the API
 *          responses agree with the browser-side surfaces above.
 *
 *   (6) DST cutover:
 *          appTimezoneMidnightUtc() probes Denver via Intl, so the
 *          offset it applies is always the offset that's actually in
 *          effect on the target date. Tested informally against the
 *          two cutover Sundays in March / November.
 * --------------------------------------------------------------------
 */
export const APP_TIMEZONE = "America/Denver" as const;

/**
 * Returns a JS Date whose LOCAL calendar fields (year/month/day) equal the
 * current calendar date in `APP_TIMEZONE`. Use this as the input to any
 * `date-fns` function (`startOfWeek`, `addDays`, …) that should reason
 * about "today" in the app's business zone.
 *
 * The returned Date is NOT the same instant as `now` in general — it's a
 * convenience anchor at midnight local-time whose calendar matches Denver.
 * That keeps the week-boundary math timezone-agnostic on the consumer
 * side: `startOfWeek(todayInAppTimezone(), { weekStartsOn: 1 })` is the
 * Monday of the current Denver business week, full stop.
 */
export function todayInAppTimezone(now: Date = new Date()): Date {
  // en-CA formats as YYYY-MM-DD, which we can hand straight to the Date
  // constructor at local midnight.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "01";
  return new Date(
    `${get("year")}-${get("month")}-${get("day")}T00:00:00`,
  );
}

/**
 * Converts a Denver-local calendar date (YYYY-MM-DD) into the UTC instant
 * of that date's MIDNIGHT in `APP_TIMEZONE`. Returns the ISO string with
 * an explicit `Z` (UTC).
 *
 * Use this whenever a Denver-aware DATE range needs to be applied to a
 * `timestamptz` column — naively pasting `T00:00:00Z` onto a YYYY-MM-DD
 * derived from Denver would query the wrong window (UTC midnight is
 * 6–7h earlier than Denver's, so rows created late in the evening on
 * either Friday or Sunday end up on the wrong side of the bound).
 *
 * Works by asking `Intl.DateTimeFormat` what time-of-day in UTC matches
 * Denver-midnight on that date. Two iterations are enough to converge
 * even across DST cutovers, since the timezone offset is constant within
 * any given day in Denver.
 */
export function appTimezoneMidnightUtc(dateOnlyYyyyMmDd: string): string {
  // First guess: pretend Denver-midnight is UTC-midnight, then read back
  // what time Denver actually shows for that UTC moment to compute the
  // offset. Apply the offset; one more readback handles the DST edge.
  const probe = (utc: Date): { y: number; m: number; d: number; h: number; mi: number } => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: APP_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(utc);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
    return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), mi: get("minute") };
  };

  const wantY = Number(dateOnlyYyyyMmDd.slice(0, 4));
  const wantM = Number(dateOnlyYyyyMmDd.slice(5, 7));
  const wantD = Number(dateOnlyYyyyMmDd.slice(8, 10));

  // Start with an instant somewhere on the target Denver day so the
  // readback isn't a day off, then refine.
  let candidate = new Date(Date.UTC(wantY, wantM - 1, wantD, 12, 0, 0));
  for (let i = 0; i < 2; i++) {
    const seen = probe(candidate);
    // Difference between what Denver SHOWS at the candidate instant and
    // what we want it to show (midnight on the target day).
    const deltaDays =
      (Date.UTC(seen.y, seen.m - 1, seen.d) -
        Date.UTC(wantY, wantM - 1, wantD)) /
      (24 * 3600 * 1000);
    const deltaMinutes = seen.h * 60 + seen.mi + deltaDays * 24 * 60;
    if (deltaMinutes === 0) break;
    candidate = new Date(candidate.getTime() - deltaMinutes * 60 * 1000);
  }
  return candidate.toISOString();
}
