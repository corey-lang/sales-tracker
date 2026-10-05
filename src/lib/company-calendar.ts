import { companyHolidayValueByDate } from "@/lib/business-days";
import type { WorkingDayAdjustment } from "@/lib/working-days";

// The company holiday CALENDAR — data, kept apart from every calculation that
// uses it (business days, pace, Road to 10,000). Adding a year is adding an
// entry to COMPANY_HOLIDAYS below; no calculation code changes.
//
// HOW THIS RELATES TO THE EXISTING HOLIDAY SYSTEM
//   The app already stores company holidays as admin-entered rows in
//   `working_day_adjustments` (applies_to_all = true, managed at
//   /admin/working-days) — that is what the weekly pace and the Orders pace
//   read. Those rows are only as complete as someone's data entry, and a goal
//   that spans a whole YEAR can't depend on every future holiday having been
//   typed in. So this module supplies the standard calendar as data, and the
//   result is the UNION of the two: a standard holiday is always counted, and an
//   admin-entered company-wide day (e.g. the day after Thanksgiving) is counted
//   too. A date present in both counts ONCE, never twice.
//
// OBSERVED DATES
//   Each entry carries BOTH the holiday's own calendar date and the weekday the
//   company actually OBSERVES it. When a holiday lands on a weekend the observed
//   day is the nearest weekday (Saturday -> Friday, Sunday -> Monday), and it is
//   the OBSERVED date that removes a business day. 2026 example: July 4 is a
//   Saturday, so the company is off Friday, July 3.
//
// 2026 is the company's full list of twelve observed holidays. If the company
//   adds a day, add it here (or in /admin/working-days — both are merged and a
//   date in both counts once).

export type CompanyHoliday = {
  name: string;
  /** The holiday's own calendar date (yyyy-MM-dd). */
  date: string;
  /** The WEEKDAY it is observed (yyyy-MM-dd) — equals `date` unless that fell on a weekend. */
  observed: string;
};

export const COMPANY_HOLIDAYS: Readonly<Record<number, readonly CompanyHoliday[]>> = {
  2026: [
    { name: "New Year's Day", date: "2026-01-01", observed: "2026-01-01" }, // Thu
    { name: "Martin Luther King Jr. Day", date: "2026-01-19", observed: "2026-01-19" }, // 3rd Mon of Jan
    { name: "Presidents Day", date: "2026-02-16", observed: "2026-02-16" }, // Washington's Birthday, 3rd Mon of Feb
    { name: "Memorial Day", date: "2026-05-25", observed: "2026-05-25" }, // last Mon of May
    { name: "Juneteenth", date: "2026-06-19", observed: "2026-06-19" }, // Fri
    { name: "Independence Day", date: "2026-07-04", observed: "2026-07-03" }, // Sat -> observed Fri
    { name: "Labor Day", date: "2026-09-07", observed: "2026-09-07" }, // 1st Mon of Sep
    { name: "Columbus Day", date: "2026-10-12", observed: "2026-10-12" }, // 2nd Mon of Oct
    { name: "Veterans Day", date: "2026-11-11", observed: "2026-11-11" }, // Wed
    { name: "Thanksgiving Day", date: "2026-11-26", observed: "2026-11-26" }, // 4th Thu of Nov
    { name: "Day after Thanksgiving", date: "2026-11-27", observed: "2026-11-27" }, // Fri
    { name: "Christmas Day", date: "2026-12-25", observed: "2026-12-25" }, // Fri
  ],
};

/** Years this calendar has data for, ascending. */
export function calendarYears(): number[] {
  return Object.keys(COMPANY_HOLIDAYS)
    .map(Number)
    .sort((a, b) => a - b);
}

/**
 * The weekday a holiday on `isoDate` is observed under the standard rule:
 * Saturday -> the Friday before, Sunday -> the Monday after, otherwise itself.
 * For writing NEW calendar years; the table above stores the result explicitly
 * so the company's actual decision, not this rule, is what is counted.
 */
export function observedWeekday(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  const dow = d.getUTCDay(); // 0 Sun .. 6 Sat
  if (dow === 6) d.setUTCDate(d.getUTCDate() - 1);
  else if (dow === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** The calendar's holidays whose OBSERVED date falls in [startDate, endDate]. */
export function calendarHolidaysInRange(startDate: string, endDate: string): CompanyHoliday[] {
  const out: CompanyHoliday[] = [];
  for (const year of calendarYears()) {
    for (const h of COMPANY_HOLIDAYS[year]) {
      if (h.observed >= startDate && h.observed <= endDate) out.push(h);
    }
  }
  return out.sort((a, b) => a.observed.localeCompare(b.observed));
}

/** One counted holiday, for display ("Holidays counted"). */
export type CountedHoliday = {
  /** Observed date, yyyy-MM-dd. */
  date: string;
  name: string;
  /** 1 = full day off, 0.5 = half day. */
  value: number;
  source: "calendar" | "admin";
};

/**
 * The company-holiday day-off value per date for [startDate, endDate]: the
 * standard calendar (each a full day) UNION the admin-entered company-wide
 * adjustments (`working_day_adjustments`, applies_to_all). A date in both is
 * counted once — the larger value wins — never added up. Individual PTO rows are
 * ignored, exactly as in the Orders pace.
 */
export function companyHolidayValues(
  startDate: string,
  endDate: string,
  adminAdjustments: WorkingDayAdjustment[] = [],
): { values: Map<string, number>; holidays: CountedHoliday[] } {
  const values = new Map<string, number>();
  const names = new Map<string, { name: string; source: CountedHoliday["source"] }>();
  for (const h of calendarHolidaysInRange(startDate, endDate)) {
    values.set(h.observed, 1);
    names.set(h.observed, { name: h.name, source: "calendar" });
  }
  const admin = companyHolidayValueByDate(
    adminAdjustments.filter((a) => a.adjustment_date >= startDate && a.adjustment_date <= endDate),
  );
  for (const [date, v] of admin) {
    if (v > (values.get(date) ?? 0)) values.set(date, v);
    if (!names.has(date)) {
      const reason = adminAdjustments.find((a) => a.applies_to_all && a.adjustment_date === date)?.reason;
      names.set(date, { name: reason?.trim() || "Company holiday", source: "admin" });
    }
  }
  const holidays = [...values.entries()]
    .map(([date, value]) => ({ date, value, ...(names.get(date) as { name: string; source: CountedHoliday["source"] }) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { values, holidays };
}
