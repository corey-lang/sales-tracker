import { businessDaysBetween } from "@/lib/business-days";
import type { CountedHoliday } from "@/lib/company-calendar";

// ROAD TO 10,000 — the company goal: 10,000 Homescriptions sold in 2026.
//
// THREE LAYERS, kept apart so the data source can change without touching the
// rest:
//   1. SOURCE  (RoadTotalSource) — where the cumulative total comes from. V1 is a
//      manually entered number (server/road-to-10000.ts → manualTotalSource).
//      Later this can be the Cogent Closed Transactions total: implement the same
//      interface and nothing below changes.
//   2. MATH    (computeRoadMetrics, this file) — a pure function of the total, the
//      date the total was recorded, today's date, the goal, the holiday set and
//      the reporting lag. No I/O.
//   3. UI      — renders RoadMetrics; knows nothing about where the total came from.
//
// The goal is "Homescriptions Sold" — never "homes sold".

/** The one goal. A different year/target is a new entry here, not a rewrite. */
export const ROAD_TO_10000_GOAL = {
  year: 2026,
  target: 10000,
  startDate: "2026-01-01",
  endDate: "2026-12-31",
} as const;
export type RoadGoal = {
  year: number;
  target: number;
  startDate: string;
  endDate: string;
};

/**
 * REPORTING LAG, in business days. The Cogent Closed Transactions number runs
 * roughly this many business days behind the day it is typed in, so the latest
 * total is treated as describing the state of the world this many business days
 * EARLIER when working out the HISTORICAL pace. If the real lag turns out to be 4,
 * change this one value — no calculation changes.
 *
 * It is a behind-the-scenes adjustment to PACE ONLY (current pace, and so the
 * ahead/behind and the projection). It never touches the reported total, the
 * percent complete, Homescriptions to go, the required pace, or the deadline
 * (the team gets no extra days). Weekends and company holidays are excluded from
 * the offset the same way they are from every other business-day count.
 */
export const ROAD_TO_10K_REPORTING_LAG_BUSINESS_DAYS = 3;

export type TotalSourceId = "manual" | "cogent_closed_transactions";

/** One cumulative total as a source reports it. */
export type TotalReading = {
  id: string;
  /** Cumulative Homescriptions sold. */
  total: number;
  /** ISO instant the total was recorded. */
  recordedAt: string;
  /** The America/Denver calendar date of recordedAt — pace is measured THROUGH this date. */
  recordedOn: string;
  source: TotalSourceId;
  /** True when the entry replaced an earlier value because that one was wrong. */
  isCorrection: boolean;
  note: string | null;
  enteredByName: string | null;
};

/**
 * Where the cumulative total comes from. The UI and the math only ever see
 * TotalReadings; swapping the manual total for Cogent later means a new class
 * implementing this, not a UI or calculation change.
 */
export interface RoadTotalSource {
  readonly id: TotalSourceId;
  /** The current total — the latest valid reading — or null when none exists. */
  latest(): Promise<TotalReading | null>;
  /** Every reading, NEWEST first (the audit trail). */
  history(): Promise<TotalReading[]>;
}

export type PaceStatus = "ahead" | "on_pace" | "behind";

export type RoadMetrics = {
  target: number;
  total: number;
  /** total / target × 100, unrounded. */
  percentComplete: number;
  /** target − total (never negative). */
  remaining: number;
  complete: boolean;
  /** Business days from the start of the goal year THROUGH the date the total was recorded. */
  businessDaysElapsed: number;
  /** Business days from TODAY through the end of the goal year, INCLUSIVE — the REAL time left.
   *  A business day today counts; a weekend/holiday today doesn't; Dec 31 counts if it is a
   *  business day; 0 once the year is over. Never shifted by the reporting lag, and not
   *  measured from the (possibly older) recorded date. */
  businessDaysRemaining: number;
  /** The reporting lag applied to the pace (see ROAD_TO_10K_REPORTING_LAG_BUSINESS_DAYS). */
  reportingLagBusinessDays: number;
  /** businessDaysElapsed minus the reporting lag (never below 0): the business days the
   *  total is treated as having taken. Used ONLY as the pace's denominator. */
  paceBusinessDays: number;
  /** total / paceBusinessDays — the lag-adjusted historical pace. null until any business
   *  day has elapsed beyond the lag. */
  currentPace: number | null;
  /** remaining / businessDaysRemaining. 0 once the goal is met; null when Homescriptions
   *  remain but no business day does. */
  requiredPace: number | null;
  /** currentPace − requiredPace (negative = behind). null when either is unknown. */
  paceDifference: number | null;
  status: PaceStatus | null;
  /** total + currentPace × businessDaysRemaining, unrounded. Equals the total once the goal is met. */
  projectedFinish: number | null;
  /** The date the HISTORICAL pace is measured through (yyyy-MM-dd): when the total was recorded. */
  recordedOn: string;
  /** The date the REMAINING time is measured from (yyyy-MM-dd): the day the metrics are viewed. */
  today: string;
};

/** What GET /api/road-to-10000 returns — everything the card and the page render. */
export type RoadView = {
  /** False until supabase/road_to_10000.sql has been applied. */
  configured: boolean;
  goal: RoadGoal;
  source: TotalSourceId;
  /** The latest total, or null before the first one is recorded. */
  latest: TotalReading | null;
  metrics: RoadMetrics | null;
  /** Calendar days since the latest total was recorded (0 = today). */
  daysSinceUpdate: number | null;
  /** Newest first. */
  history: TotalReading[];
  holidays: CountedHoliday[];
  /** True when the admin-entered holidays couldn't be read — only the standard calendar was counted. */
  extraHolidaysUnavailable: boolean;
  can_update: boolean;
};

/** Rounds to one decimal — the precision pace is DISPLAYED at. */
export const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Pace status from the difference between current and required pace. No
 * threshold is invented: it compares the two paces at the precision they are
 * shown (one decimal), so a card never says "Behind" over two identical-looking
 * numbers.
 *   difference > 0  -> ahead of pace
 *   difference = 0  -> on pace
 *   difference < 0  -> behind pace
 */
export function paceStatus(difference: number | null): PaceStatus | null {
  if (difference === null) return null;
  const d = round1(difference);
  if (d > 0) return "ahead";
  if (d < 0) return "behind";
  return "on_pace";
}

export const PACE_STATUS_LABEL: Record<PaceStatus, string> = {
  ahead: "Ahead of pace",
  on_pace: "On pace",
  behind: "Behind pace",
};

/** The pace tile's label: the status when there is one, otherwise a NEUTRAL "Pace status"
 *  — never "Ahead of pace" next to a "—". */
export const paceStatusLabel = (status: PaceStatus | null): string =>
  status ? PACE_STATUS_LABEL[status] : "Pace status";

/**
 * Everything the card and page show, computed from the cumulative total.
 *
 * TWO SEPARATE DATES
 *   recordedOn — the day the total was entered. It drives ONLY the historical
 *                pace (and the reporting-lag adjustment): "how fast have we been
 *                going, as of the snapshot we have".
 *   today      — the day the metrics are being viewed. It drives ONLY the real
 *                time left: "how many business days do we actually still have".
 * Keeping them apart matters when the snapshot is a few days old: the pace stays
 * tied to the snapshot, but the deadline pressure keeps moving with the calendar.
 *
 *   percentComplete       = total / target × 100                (not lag-adjusted)
 *   remaining             = target − total                      (not lag-adjusted)
 *   businessDaysElapsed   = business days from Jan 1 THROUGH recordedOn (inclusive)
 *   paceBusinessDays      = max(0, businessDaysElapsed − reportingLag)
 *   currentPace           = total / paceBusinessDays            (recorded date, lag-adjusted)
 *   businessDaysRemaining = business days from today THROUGH Dec 31, inclusive
 *   requiredPace          = remaining / businessDaysRemaining   (today, NOT lag-adjusted)
 *   paceDifference        = currentPace − requiredPace
 *   projectedFinish       = total + currentPace × businessDaysRemaining   (today)
 *
 * THE REPORTING LAG. The Closed Transactions total trails the day it is entered by
 * about `reportingLag` business days, so for the HISTORICAL pace the total is
 * treated as having been earned over `reportingLag` fewer business days than have
 * elapsed to the recorded date. Everything that looks FORWARD — the required pace
 * and the projection's remaining days — uses the real today through the real
 * Dec 31: the lag buys the team no extra time. Because the offset is taken from a
 * business-day count that already skips weekends and company holidays, the lag
 * skips them too.
 *
 * "Business day" = Monday–Friday minus the supplied holiday set (see
 * lib/company-calendar.ts). `today` before `recordedOn` (clock skew) is treated as
 * `recordedOn`. Intermediate values are NOT rounded.
 */
export function computeRoadMetrics(input: {
  total: number;
  /** The date the total was recorded, yyyy-MM-dd (Denver). Historical pace + lag ONLY. */
  recordedOn: string;
  /** The date the metrics are being viewed, yyyy-MM-dd (Denver). Time remaining ONLY.
   *  Required on purpose: there is no default, so a caller can't silently reuse the
   *  recorded date for the deadline. */
  today: string;
  holidayValues: Map<string, number>;
  goal?: RoadGoal;
  /** Override the reporting lag (defaults to ROAD_TO_10K_REPORTING_LAG_BUSINESS_DAYS). */
  reportingLagBusinessDays?: number;
}): RoadMetrics {
  const goal = input.goal ?? ROAD_TO_10000_GOAL;
  const lag = Math.max(0, input.reportingLagBusinessDays ?? ROAD_TO_10K_REPORTING_LAG_BUSINESS_DAYS);
  const { total, recordedOn, holidayValues } = input;
  const today = input.today < recordedOn ? recordedOn : input.today;
  const { startDate, endDate, target } = goal;

  // RECORDED date: how much of the year the snapshot covers (historical pace).
  const elapsedEnd = recordedOn > endDate ? endDate : recordedOn;
  const businessDaysElapsed =
    recordedOn < startDate ? 0 : businessDaysBetween(startDate, elapsedEnd, holidayValues);
  // The only place the lag is applied.
  const paceBusinessDays = Math.max(0, businessDaysElapsed - lag);

  // TODAY: how much time is actually left — today THROUGH Dec 31, INCLUSIVE at both
  // ends. A business day today still counts (it is still available to work); a weekend
  // or company holiday adds nothing; Dec 31 counts if it is a business day; and once
  // today is past Dec 31 the year is over (0). Not the recorded date, and not lag-shifted.
  const remainingStart = today < startDate ? startDate : today;
  const businessDaysRemaining =
    today > endDate ? 0 : businessDaysBetween(remainingStart, endDate, holidayValues);

  const remaining = Math.max(0, target - total);
  const complete = total >= target;
  const currentPace = paceBusinessDays > 0 ? total / paceBusinessDays : null;
  const requiredPace =
    remaining === 0 ? 0 : businessDaysRemaining > 0 ? remaining / businessDaysRemaining : null;
  const paceDifference =
    currentPace !== null && requiredPace !== null ? currentPace - requiredPace : null;
  const projectedFinish = complete
    ? total
    : currentPace !== null
      ? total + currentPace * businessDaysRemaining
      : null;

  return {
    target,
    total,
    percentComplete: (total / target) * 100,
    remaining,
    complete,
    businessDaysElapsed,
    businessDaysRemaining,
    reportingLagBusinessDays: lag,
    paceBusinessDays,
    currentPace,
    requiredPace,
    paceDifference,
    status: paceStatus(paceDifference),
    projectedFinish,
    recordedOn,
    today,
  };
}

// ---------------------------------------------------------------------------
// Display helpers (one place, so the card and the page always agree)
// ---------------------------------------------------------------------------

/** 7842 -> "7,842". */
export const formatWhole = (n: number) => Math.round(n).toLocaleString("en-US");
/** 39.62 -> "39.6". */
export const formatPace = (n: number | null) => (n === null ? "—" : round1(n).toFixed(1));
/** +5.3 / −2.1 / 0.0 (a real minus sign). */
export function formatSignedPace(n: number | null): string {
  if (n === null) return "—";
  const r = round1(n);
  if (r > 0) return `+${r.toFixed(1)}`;
  if (r < 0) return `−${Math.abs(r).toFixed(1)}`;
  return "0.0";
}
/** 78.42 -> "78.4". */
export const formatPercent = (n: number) => round1(n).toFixed(1);
/** Business days: whole numbers plain, half-days with one decimal. */
export const formatBusinessDays = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
