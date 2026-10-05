import { describe, expect, it } from "vitest";

import { businessDaysBetween } from "@/lib/business-days";
import {
  COMPANY_HOLIDAYS,
  calendarHolidaysInRange,
  calendarYears,
  companyHolidayValues,
  observedWeekday,
} from "@/lib/company-calendar";
import type { WorkingDayAdjustment } from "@/lib/working-days";

const dow = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay(); // 0 Sun .. 6 Sat
const Y = ["2026-01-01", "2026-12-31"] as const;
const bd = (a: string, b: string, extra: WorkingDayAdjustment[] = []) =>
  businessDaysBetween(a, b, companyHolidayValues(Y[0], Y[1], extra).values);
const adminDay = (date: string, over: Partial<WorkingDayAdjustment> = {}): WorkingDayAdjustment => ({
  id: date, adjustment_date: date, salesperson_id: null, applies_to_all: true, day_value: 1, reason: "Company day", note: null, ...over,
});

/** The twelve 2026 company holidays: [name, the holiday's own date, the date it is OBSERVED]. */
const HOLIDAYS_2026 = [
  ["New Year's Day", "2026-01-01", "2026-01-01"],
  ["Martin Luther King Jr. Day", "2026-01-19", "2026-01-19"],
  ["Presidents Day", "2026-02-16", "2026-02-16"],
  ["Memorial Day", "2026-05-25", "2026-05-25"],
  ["Juneteenth", "2026-06-19", "2026-06-19"],
  ["Independence Day", "2026-07-04", "2026-07-03"], // July 4 is a Saturday -> observed Friday
  ["Labor Day", "2026-09-07", "2026-09-07"],
  ["Columbus Day", "2026-10-12", "2026-10-12"],
  ["Veterans Day", "2026-11-11", "2026-11-11"],
  ["Thanksgiving Day", "2026-11-26", "2026-11-26"],
  ["Day after Thanksgiving", "2026-11-27", "2026-11-27"],
  ["Christmas Day", "2026-12-25", "2026-12-25"],
] as const;

describe("the 2026 company holiday calendar (data, separate from the math)", () => {
  it("lists all twelve holidays with their OBSERVED dates", () => {
    expect(COMPANY_HOLIDAYS[2026].map((h) => [h.name, h.date, h.observed])).toEqual(HOLIDAYS_2026);
  });

  it("every observed date is a WEEKDAY, and follows the Saturday->Friday / Sunday->Monday rule", () => {
    for (const year of calendarYears()) {
      for (const h of COMPANY_HOLIDAYS[year]) {
        expect([1, 2, 3, 4, 5], h.name).toContain(dow(h.observed));
        expect(h.observed, h.name).toBe(observedWeekday(h.date));
      }
    }
  });

  it("only Independence Day moves: July 4, 2026 is a Saturday, so the company is off Friday July 3", () => {
    const moved = COMPANY_HOLIDAYS[2026].filter((h) => h.date !== h.observed);
    expect(moved.map((h) => [h.name, h.date, h.observed])).toEqual([["Independence Day", "2026-07-04", "2026-07-03"]]);
    expect(dow("2026-07-04")).toBe(6); // Saturday
    expect(dow("2026-07-03")).toBe(5); // Friday
  });

  it("observedWeekday: Saturday -> Friday, Sunday -> Monday, weekdays unchanged", () => {
    expect(observedWeekday("2026-07-04")).toBe("2026-07-03"); // Sat
    expect(observedWeekday("2027-07-04")).toBe("2027-07-05"); // Sun
    expect(observedWeekday("2026-12-25")).toBe("2026-12-25"); // Fri
    expect(observedWeekday("2027-12-25")).toBe("2027-12-24"); // Sat
    expect(observedWeekday("2028-01-01")).toBe("2027-12-31"); // Sat -> the prior Friday, across a year
  });

  it("is data keyed by year: a year with no entry simply has no standard holidays", () => {
    expect(calendarYears()).toContain(2026);
    expect(calendarHolidaysInRange("2027-01-01", "2027-12-31")).toEqual([]);
    expect(calendarHolidaysInRange("2026-07-01", "2026-07-31").map((h) => h.name)).toEqual(["Independence Day"]);
    expect(calendarHolidaysInRange("2026-11-01", "2026-11-30").map((h) => h.observed)).toEqual(["2026-11-11", "2026-11-26", "2026-11-27"]);
  });
});

describe("EVERY 2026 holiday is excluded from business-day counts", () => {
  it.each(HOLIDAYS_2026.map(([name, , observed]) => [name, observed]))("%s (%s)", (_name, observed) => {
    const { values } = companyHolidayValues(Y[0], Y[1]);
    expect(values.get(observed)).toBe(1);
    expect(businessDaysBetween(observed, observed, values)).toBe(0); // the day itself is not a business day
    // …and it takes exactly one business day out of any span that contains it (a span holding two
    // holidays, like Thanksgiving + the day after, loses two).
    const before = new Date(`${observed}T12:00:00Z`);
    before.setUTCDate(before.getUTCDate() - 7);
    const after = new Date(`${observed}T12:00:00Z`);
    after.setUTCDate(after.getUTCDate() + 7);
    const span: [string, string] = [before.toISOString().slice(0, 10), after.toISOString().slice(0, 10)];
    const holidaysInSpan = HOLIDAYS_2026.filter(([, , o]) => o >= span[0] && o <= span[1]).length; // all weekdays
    expect(businessDaysBetween(...span, values)).toBe(businessDaysBetween(...span, new Map()) - holidaysInSpan);
  });

  it("whole year: 261 weekdays - 12 observed holidays = 249 business days", () => {
    expect(bd("2026-01-01", "2026-12-31")).toBe(249);
    expect(businessDaysBetween("2026-01-01", "2026-12-31", new Map())).toBe(261); // with no holidays, unchanged
    expect(companyHolidayValues(Y[0], Y[1]).holidays).toHaveLength(12);
  });

  it("the listed holidays are exactly these twelve dates, in order, all from the standard calendar", () => {
    const { holidays } = companyHolidayValues(Y[0], Y[1]);
    expect(holidays.map((h) => [h.date, h.name, h.source, h.value])).toEqual(
      HOLIDAYS_2026.map(([name, , observed]) => [observed, name, "calendar", 1]),
    );
  });
});

describe("business days around each holiday (2026)", () => {
  it("New Year's: Thu Jan 1 is NOT a business day; Fri Jan 2 is the first one", () => {
    expect(bd("2026-01-01", "2026-01-01")).toBe(0);
    expect(bd("2026-01-01", "2026-01-02")).toBe(1);
    expect(bd("2025-12-31", "2026-01-02")).toBe(2); // Dec 31 2025 is a normal weekday (outside the 2026 calendar); Jan 1 is off; Jan 2 counts
  });

  it("Martin Luther King Jr. Day: Mon Jan 19 is skipped", () => {
    expect(bd("2026-01-16", "2026-01-16")).toBe(1); // Fri
    expect(bd("2026-01-19", "2026-01-19")).toBe(0);
    expect(bd("2026-01-20", "2026-01-20")).toBe(1);
    expect(bd("2026-01-19", "2026-01-23")).toBe(4);
    expect(bd("2026-01-01", "2026-01-19")).toBe(11);
  });

  it("Presidents Day: Mon Feb 16 is skipped", () => {
    expect(bd("2026-02-13", "2026-02-13")).toBe(1);
    expect(bd("2026-02-16", "2026-02-16")).toBe(0);
    expect(bd("2026-02-17", "2026-02-17")).toBe(1);
    expect(bd("2026-02-16", "2026-02-20")).toBe(4);
  });

  it("Memorial Day: Mon May 25 is skipped — Fri May 22 and Tue May 26 are not", () => {
    expect(bd("2026-05-22", "2026-05-22")).toBe(1);
    expect(bd("2026-05-25", "2026-05-25")).toBe(0);
    expect(bd("2026-05-26", "2026-05-26")).toBe(1);
    expect(bd("2026-05-22", "2026-05-26")).toBe(2); // Fri + Tue
    expect(bd("2026-01-01", "2026-05-25")).toBe(99); // elapsed through Memorial Day = through the Friday before
  });

  it("Juneteenth: Fri Jun 19 is skipped — the week has 4 business days", () => {
    expect(bd("2026-06-18", "2026-06-18")).toBe(1);
    expect(bd("2026-06-19", "2026-06-19")).toBe(0);
    expect(bd("2026-06-22", "2026-06-22")).toBe(1);
    expect(bd("2026-06-15", "2026-06-19")).toBe(4);
  });

  it("Independence Day: Sat Jul 4 is observed Fri Jul 3 — the FRIDAY is the day off, not Monday, and the Saturday is not an extra holiday", () => {
    expect(bd("2026-07-02", "2026-07-02")).toBe(1); // Thu
    expect(bd("2026-07-03", "2026-07-03")).toBe(0); // observed Friday
    expect(bd("2026-07-04", "2026-07-05")).toBe(0); // the weekend itself
    expect(bd("2026-07-06", "2026-07-06")).toBe(1); // Monday is a normal day
    expect(bd("2026-06-29", "2026-07-03")).toBe(4); // that week has 4 business days
    expect(bd("2026-01-01", "2026-07-03")).toBe(126);
    expect(bd("2026-01-01", "2026-07-06")).toBe(127);
  });

  it("July 4 stays a plain weekend: it is NOT in the holiday set, so it can't be double-counted or subtract anything", () => {
    const { values, holidays } = companyHolidayValues(Y[0], Y[1]);
    expect(values.has("2026-07-04")).toBe(false);
    expect(holidays.some((h) => h.date === "2026-07-04")).toBe(false);
    expect(values.get("2026-07-03")).toBe(1);
    // Exactly one day is taken out for Independence Day: the same span with Jul 3 added/removed differs by 1, never 2.
    const without = new Map(values);
    without.delete("2026-07-03");
    expect(businessDaysBetween("2026-06-29", "2026-07-06", without) - businessDaysBetween("2026-06-29", "2026-07-06", values)).toBe(1);
    // An admin also entering the Saturday would subtract nothing (it is already off).
    expect(bd("2026-06-29", "2026-07-06", [adminDay("2026-07-04")])).toBe(bd("2026-06-29", "2026-07-06"));
  });

  it("Labor Day: Mon Sep 7 is skipped", () => {
    expect(bd("2026-09-04", "2026-09-04")).toBe(1);
    expect(bd("2026-09-07", "2026-09-07")).toBe(0);
    expect(bd("2026-09-08", "2026-09-08")).toBe(1);
    expect(bd("2026-09-07", "2026-09-11")).toBe(4);
  });

  it("Columbus Day: Mon Oct 12 is skipped", () => {
    expect(bd("2026-10-09", "2026-10-09")).toBe(1);
    expect(bd("2026-10-12", "2026-10-12")).toBe(0);
    expect(bd("2026-10-13", "2026-10-13")).toBe(1);
    expect(bd("2026-10-12", "2026-10-16")).toBe(4);
  });

  it("Veterans Day: Wed Nov 11 is skipped — mid-week, so the week has 4 business days", () => {
    expect(bd("2026-11-10", "2026-11-10")).toBe(1);
    expect(bd("2026-11-11", "2026-11-11")).toBe(0);
    expect(bd("2026-11-12", "2026-11-12")).toBe(1);
    expect(bd("2026-11-09", "2026-11-13")).toBe(4);
  });

  it("Thanksgiving AND the day after: Thu Nov 26 and Fri Nov 27 are both skipped (the Friday is excluded even though it is a weekday)", () => {
    expect(dow("2026-11-27")).toBe(5); // a Friday
    expect(bd("2026-11-25", "2026-11-25")).toBe(1);
    expect(bd("2026-11-26", "2026-11-26")).toBe(0);
    expect(bd("2026-11-27", "2026-11-27")).toBe(0);
    expect(bd("2026-11-30", "2026-11-30")).toBe(1);
    expect(bd("2026-11-23", "2026-11-27")).toBe(3); // Mon, Tue, Wed only
    expect(bd("2026-11-26", "2026-11-27")).toBe(0);
  });

  it("Christmas: Fri Dec 25 is skipped; the remaining days of the year are counted correctly", () => {
    expect(bd("2026-12-24", "2026-12-24")).toBe(1);
    expect(bd("2026-12-25", "2026-12-25")).toBe(0);
    expect(bd("2026-12-28", "2026-12-31")).toBe(4);
    expect(bd("2026-12-26", "2026-12-31")).toBe(4); // weekend + Mon-Thu
  });

  it("business days OUTSIDE the new holidays are unchanged (a plain week is still 5)", () => {
    expect(bd("2026-03-02", "2026-03-06")).toBe(5);
    expect(bd("2026-08-03", "2026-08-07")).toBe(5);
    expect(bd("2026-04-06", "2026-04-10")).toBe(5);
  });
});

describe("merging the standard calendar with the admin-entered holidays (working_day_adjustments)", () => {
  it("an admin-entered company-wide day that is NOT in the standard list is counted in addition (e.g. Christmas Eve)", () => {
    const extra = [adminDay("2026-12-24", { reason: "Christmas Eve" })];
    expect(bd("2026-01-01", "2026-12-31", extra)).toBe(248);
    expect(bd("2026-12-24", "2026-12-24", extra)).toBe(0);
    const { holidays } = companyHolidayValues(Y[0], Y[1], extra);
    expect(holidays).toHaveLength(13);
    expect(holidays.find((h) => h.date === "2026-12-24")).toMatchObject({ name: "Christmas Eve", source: "admin", value: 1 });
  });

  it("a date in BOTH counts once — never twice (including the day after Thanksgiving, now a standard holiday)", () => {
    for (const date of ["2026-07-03", "2026-11-27", "2026-12-25", "2026-01-19", "2026-10-12"]) {
      const extra = [adminDay(date, { reason: "Entered by an admin too" })];
      expect(bd("2026-01-01", "2026-12-31", extra), date).toBe(249);
      const listed = companyHolidayValues(Y[0], Y[1], extra).holidays.filter((h) => h.date === date);
      expect(listed, date).toHaveLength(1);
      expect(listed[0].source, date).toBe("calendar"); // the standard entry names it
      expect(listed[0].value, date).toBe(1);
    }
    // All twelve entered by an admin as well: still 249.
    const all = HOLIDAYS_2026.map(([, , observed]) => adminDay(observed));
    expect(bd("2026-01-01", "2026-12-31", all)).toBe(249);
  });

  it("a half-day admin entry on an ordinary day counts as half a business day", () => {
    expect(bd("2026-01-01", "2026-12-31", [adminDay("2026-12-24", { day_value: 0.5 })])).toBe(248.5);
  });

  it("a half-day admin entry on a standard holiday changes nothing (the full day off wins)", () => {
    expect(bd("2026-01-01", "2026-12-31", [adminDay("2026-11-27", { day_value: 0.5 })])).toBe(249);
  });

  it("individual PTO is ignored, and rows outside the range don't leak in", () => {
    const pto = adminDay("2026-03-03", { applies_to_all: false, salesperson_id: "ae-1" });
    const outside = adminDay("2027-03-03");
    expect(bd("2026-01-01", "2026-12-31", [pto, outside])).toBe(249);
  });

  it("holidays are returned sorted by date, labelled by their source", () => {
    const { holidays } = companyHolidayValues(Y[0], Y[1], [adminDay("2026-03-02", { reason: "Company offsite" })]);
    expect(holidays.map((h) => `${h.date}:${h.source}`)).toEqual([
      "2026-01-01:calendar", "2026-01-19:calendar", "2026-02-16:calendar", "2026-03-02:admin", "2026-05-25:calendar",
      "2026-06-19:calendar", "2026-07-03:calendar", "2026-09-07:calendar", "2026-10-12:calendar", "2026-11-11:calendar",
      "2026-11-26:calendar", "2026-11-27:calendar", "2026-12-25:calendar",
    ]);
  });
});
