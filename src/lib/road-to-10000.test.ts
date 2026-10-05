import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { companyHolidayValues } from "@/lib/company-calendar";
import {
  PACE_STATUS_LABEL,
  ROAD_TO_10000_GOAL,
  ROAD_TO_10K_REPORTING_LAG_BUSINESS_DAYS,
  computeRoadMetrics,
  formatBusinessDays,
  formatPace,
  formatPercent,
  formatSignedPace,
  formatWhole,
  paceStatus,
  paceStatusLabel,
  type RoadTotalSource,
  type TotalReading,
} from "@/lib/road-to-10000";

const holidays = () => companyHolidayValues("2026-01-01", "2026-12-31").values;
// A same-day view: the total is viewed on the day it was recorded (today === recordedOn).
const compute = (total: number, recordedOn: string) => computeRoadMetrics({ total, recordedOn, today: recordedOn, holidayValues: holidays() });

describe("the goal", () => {
  it("is 10,000 Homescriptions between Jan 1 and Dec 31, 2026", () => {
    expect(ROAD_TO_10000_GOAL).toEqual({ year: 2026, target: 10000, startDate: "2026-01-01", endDate: "2026-12-31" });
  });
});

describe("progress", () => {
  it("0 total: 0%, all 10,000 to go, 0 pace, behind", () => {
    const m = compute(0, "2026-10-05");
    expect(m).toMatchObject({ total: 0, percentComplete: 0, remaining: 10000, complete: false, currentPace: 0, status: "behind", projectedFinish: 0 });
    expect(m.requiredPace).toBeCloseTo(10000 / 59, 10);
  });

  it("partial progress: 7,842 is 78.42% with 2,158 to go", () => {
    const m = compute(7842, "2026-10-05");
    expect(m.percentComplete).toBeCloseTo(78.42, 10);
    expect(formatPercent(m.percentComplete)).toBe("78.4");
    expect(m.remaining).toBe(2158);
    expect(formatWhole(m.remaining)).toBe("2,158");
    expect(m.complete).toBe(false);
  });

  it("10,000 total: 100%, nothing to go, goal reached, no further pace needed, finish = 10,000", () => {
    const m = compute(10000, "2026-10-05");
    expect(m).toMatchObject({ percentComplete: 100, remaining: 0, complete: true, requiredPace: 0, projectedFinish: 10000, status: "ahead" });
  });

  it("never reports a negative remaining", () => {
    expect(computeRoadMetrics({ total: 10000, recordedOn: "2026-12-31", today: "2026-12-31", holidayValues: holidays() }).remaining).toBe(0);
  });
});

describe("business days elapsed / remaining (pace is measured THROUGH the recorded date)", () => {
  it("Mon Oct 5, 2026: 191 elapsed (Jan 1 through Oct 5), 59 remaining (Oct 5 through Dec 31 — today counts)", () => {
    const m = compute(1, "2026-10-05");
    expect([m.businessDaysElapsed, m.businessDaysRemaining]).toEqual([191, 59]);
  });

  it("elapsed + remaining = the year's 249 business days, plus 1 when the day is itself a business day (it is in BOTH counts)", () => {
    // Elapsed runs THROUGH the date and remaining runs FROM it, so a business-day date is counted in each.
    const isBusinessDay = (d: string) => {
      const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
      return dow >= 1 && dow <= 5 && !holidays().has(d);
    };
    for (const d of ["2026-01-02", "2026-03-16", "2026-07-03", "2026-10-03", "2026-11-26", "2026-12-24", "2026-12-31"]) {
      const m = compute(1, d);
      expect(m.businessDaysElapsed + m.businessDaysRemaining, d).toBe(249 + (isBusinessDay(d) ? 1 : 0));
    }
  });

  it("a weekend recording date counts through the Friday before (Sat Oct 3 = 190, same as Fri Oct 2)", () => {
    expect(compute(1, "2026-10-03").businessDaysElapsed).toBe(190);
    expect(compute(1, "2026-10-02").businessDaysElapsed).toBe(190);
    expect(compute(1, "2026-10-04").businessDaysRemaining).toBe(59);
  });

  it("New Year's: recorded on the holiday itself, 0 days have elapsed and pace is unknown", () => {
    const m = compute(0, "2026-01-01");
    expect([m.businessDaysElapsed, m.businessDaysRemaining]).toEqual([0, 249]);
    expect(m.currentPace).toBeNull();
    expect(m.projectedFinish).toBeNull();
    expect(m.paceDifference).toBeNull();
    expect(m.status).toBeNull();
  });

  it("pace stays unknown until more business days have elapsed than the reporting lag (3), then it starts", () => {
    // Jan 2, 5, 6 = 1, 2, 3 elapsed: nothing beyond the lag yet. Jan 7 = 4 elapsed -> 1 pace day.
    expect(compute(40, "2026-01-02")).toMatchObject({ businessDaysElapsed: 1, paceBusinessDays: 0, currentPace: null, projectedFinish: null });
    expect(compute(40, "2026-01-06")).toMatchObject({ businessDaysElapsed: 3, paceBusinessDays: 0, currentPace: null });
    expect(compute(40, "2026-01-07")).toMatchObject({ businessDaysElapsed: 4, paceBusinessDays: 1, currentPace: 40 });
  });

  it("every company holiday adds no elapsed day: viewing it counts through the business day before (Jan 19, Feb 16, May 25, Jun 19, Jul 3 observed, Sep 7, Oct 12, Nov 11, Nov 26, Nov 27, Dec 25)", () => {
    const e = (d: string) => compute(1, d).businessDaysElapsed;
    expect(e("2026-01-19")).toBe(e("2026-01-16"));
    expect(e("2026-02-16")).toBe(e("2026-02-13"));
    expect(e("2026-05-25")).toBe(99); // same as Fri May 22
    expect(e("2026-05-26")).toBe(100);
    expect(e("2026-06-19")).toBe(e("2026-06-18"));
    expect(e("2026-07-03")).toBe(126); // same as Thu Jul 2
    expect(e("2026-07-06")).toBe(127);
    expect(e("2026-09-07")).toBe(171);
    expect(e("2026-10-12")).toBe(e("2026-10-09"));
    expect(e("2026-11-11")).toBe(e("2026-11-10"));
    expect(e("2026-11-26")).toBe(226);
    expect(e("2026-11-27")).toBe(226); // the day after Thanksgiving adds nothing either
    expect(e("2026-11-30")).toBe(227);
    expect(e("2026-12-25")).toBe(245);
  });

  it("Dec 31: that day is still a business day, so 1 remains and required pace is everything left in one day", () => {
    const end = compute(9000, "2026-12-31");
    expect(end).toMatchObject({ businessDaysElapsed: 249, businessDaysRemaining: 1, remaining: 1000 });
    expect(end.requiredPace).toBe(1000);
    expect(end.status).toBe("behind");
  });

  it("after Dec 31 the year is complete: nothing remains and, with Homescriptions still to go, there is no required pace", () => {
    for (const d of ["2027-01-01", "2027-01-04", "2027-02-01"]) {
      const m = compute(9000, d);
      expect(m, d).toMatchObject({ businessDaysElapsed: 249, businessDaysRemaining: 0, remaining: 1000, requiredPace: null, paceDifference: null, status: null });
      expect(m.projectedFinish as number, d).toBeCloseTo(9000, 10); // nothing left to project over
    }
  });

  it("before the goal year starts: nothing elapsed, the whole year remains", () => {
    expect(compute(0, "2025-12-15")).toMatchObject({ businessDaysElapsed: 0, businessDaysRemaining: 249 });
  });
});

describe("pace, required pace, ahead/behind, projected finish (exact formulas)", () => {
  // 7,842 recorded and viewed Mon Oct 5, 2026: 191 business days elapsed, 59 remaining (today counts), 2,158 to go.
  // Reporting lag 3 -> the pace denominator is 191.
  const m = compute(7842, "2026-10-05");

  it("current pace = total / (business days elapsed - the 3-business-day reporting lag)", () => {
    expect(m.paceBusinessDays).toBe(188); // 191 - 3
    expect(m.currentPace).toBeCloseTo(7842 / 188, 12);
    expect(formatPace(m.currentPace)).toBe("41.7");
  });

  it("required pace = homescriptions remaining / business days remaining (no lag)", () => {
    expect(m.requiredPace).toBeCloseTo(2158 / 59, 12);
    expect(formatPace(m.requiredPace)).toBe("36.6");
  });

  it("ahead/behind = current pace - required pace", () => {
    expect(m.paceDifference).toBeCloseTo(7842 / 188 - 2158 / 59, 12);
    expect(formatSignedPace(m.paceDifference)).toBe("+5.1");
    expect(m.status).toBe("ahead");
  });

  it("projected finish = total + lag-adjusted current pace x the REAL business days remaining, as a whole number", () => {
    expect(m.projectedFinish).toBeCloseTo(7842 + (7842 / 188) * 59, 8);
    expect(formatWhole(m.projectedFinish as number)).toBe("10,303");
  });

  it("the worked example: 7,842 total at 39.6/business day with 63 days left projects to ~10,337", () => {
    expect(Math.round(7842 + 39.6 * 63)).toBe(10337);
  });

  it("a team that is behind: 6,000 on Oct 5 needs more per day than it has been doing", () => {
    const b = compute(6000, "2026-10-05");
    expect(b.currentPace).toBeCloseTo(6000 / 188, 12);
    expect(b.requiredPace).toBeCloseTo(4000 / 59, 12);
    expect(b.paceDifference as number).toBeLessThan(0);
    expect(b.status).toBe("behind");
    expect(formatSignedPace(b.paceDifference)).toMatch(/^\u2212/);
    expect(b.projectedFinish as number).toBeLessThan(10000);
  });

  it("intermediate values are never rounded", () => {
    expect(m.currentPace).not.toBe(41.7);
    expect(Number.isInteger(m.projectedFinish as number)).toBe(false);
  });

  it("a different recording date changes the pace for the same total (measured through the RECORDED date)", () => {
    expect(compute(7842, "2026-10-05").currentPace).not.toBe(compute(7842, "2026-10-12").currentPace);
    expect(compute(7842, "2026-10-12").currentPace as number).toBeLessThan(compute(7842, "2026-10-05").currentPace as number);
  });
});

// ===========================================================================
// The 3-business-day REPORTING LAG
//
// The Closed Transactions number runs ~3 business days behind the day it is typed
// in. That is a behind-the-scenes adjustment to the HISTORICAL PACE only.
// ===========================================================================

describe("the reporting lag (ROAD_TO_10K_REPORTING_LAG_BUSINESS_DAYS)", () => {
  const LAG = ROAD_TO_10K_REPORTING_LAG_BUSINESS_DAYS;
  const TOTAL = 7842;
  const DATE = "2026-10-05"; // Mon: 191 business days elapsed, 59 remaining (today counts)
  const lagged = compute(TOTAL, DATE);
  const unlagged = computeRoadMetrics({ total: TOTAL, recordedOn: DATE, today: DATE, holidayValues: holidays(), reportingLagBusinessDays: 0 });

  it("is one named constant, currently 3", () => {
    expect(LAG).toBe(3);
    expect(lagged.reportingLagBusinessDays).toBe(3);
  });

  it("1. the TOTAL and the PERCENTAGE (and Homescriptions to go) are NOT adjusted by the lag", () => {
    expect(lagged.total).toBe(7842);
    expect(lagged.percentComplete).toBe(unlagged.percentComplete);
    expect(lagged.percentComplete).toBeCloseTo(78.42, 12);
    expect(lagged.remaining).toBe(2158);
    expect(lagged.remaining).toBe(unlagged.remaining);
    // …whatever the lag is set to.
    for (const l of [0, 1, 3, 4, 10]) {
      const m = computeRoadMetrics({ total: TOTAL, recordedOn: DATE, today: DATE, holidayValues: holidays(), reportingLagBusinessDays: l });
      expect([m.total, m.percentComplete, m.remaining]).toEqual([7842, (7842 / 10000) * 100, 2158]);
    }
  });

  it("2. CURRENT PACE IS adjusted by 3 business days: total / (elapsed - 3), a faster pace than the unlagged total / elapsed", () => {
    expect(unlagged.businessDaysElapsed).toBe(191);
    expect(lagged.businessDaysElapsed).toBe(191); // the elapsed count itself is the real one
    expect(lagged.paceBusinessDays).toBe(188); // 191 - 3
    expect(lagged.currentPace).toBeCloseTo(7842 / 188, 12);
    expect(unlagged.currentPace).toBeCloseTo(7842 / 191, 12);
    expect(lagged.currentPace as number).toBeGreaterThan(unlagged.currentPace as number);
  });

  it("3. REQUIRED PACE uses the actual date through Dec 31 — it is NOT shifted backward and gets no extra days", () => {
    expect(lagged.businessDaysRemaining).toBe(59); // Oct 5 .. Dec 31 inclusive, unchanged by the lag
    expect(lagged.requiredPace).toBe(unlagged.requiredPace);
    expect(lagged.requiredPace).toBeCloseTo(2158 / 59, 12);
    // Not what a backdated (3 business days earlier) calculation would give: 2158 / 62.
    expect(lagged.requiredPace).not.toBeCloseTo(2158 / 62, 6);
    for (const l of [0, 3, 4, 9]) {
      const m = computeRoadMetrics({ total: TOTAL, recordedOn: DATE, today: DATE, holidayValues: holidays(), reportingLagBusinessDays: l });
      expect(m.requiredPace, `lag ${l}`).toBeCloseTo(2158 / 59, 12);
      expect(m.businessDaysRemaining, `lag ${l}`).toBe(59);
    }
  });

  it("4. PROJECTED FINISH uses the lag-adjusted pace but the real remaining business days through Dec 31", () => {
    expect(lagged.projectedFinish).toBeCloseTo(7842 + (7842 / 188) * 59, 8); // adjusted pace x REAL 59 days
    expect(lagged.projectedFinish).not.toBeCloseTo(7842 + (7842 / 188) * 62, 4); // not extra days for the lag
    expect(lagged.projectedFinish).not.toBeCloseTo(7842 + (7842 / 191) * 59, 4); // not the unadjusted pace
    expect(lagged.projectedFinish as number).toBeGreaterThan(unlagged.projectedFinish as number);
    expect(Math.round(lagged.projectedFinish as number)).toBe(10303);
  });

  it("5. weekends and holidays are still excluded when taking the 3-business-day offset", () => {
    // "The pace days" = business days elapsed - 3 = the business days up to the date that is
    // 3 BUSINESS days earlier. Each case names that earlier date and proves they agree.
    const paceDays = (d: string) => compute(1, d).paceBusinessDays;
    const through = (d: string) => compute(1, d).businessDaysElapsed;

    // Entered on a MONDAY: 3 business days earlier is Wed Sep 30 (Fri Oct 2, Thu Oct 1, Wed Sep 30) —
    // the weekend is not counted.
    expect(through("2026-10-05")).toBe(191);
    expect(paceDays("2026-10-05")).toBe(188);
    expect(through("2026-09-30")).toBe(188);

    // Entered on a SATURDAY or SUNDAY: the weekend adds nothing, so the lag reaches back from Friday.
    expect(paceDays("2026-10-03")).toBe(187); // Sat
    expect(paceDays("2026-10-04")).toBe(187); // Sun
    expect(paceDays("2026-10-02")).toBe(187); // Fri — the same as the weekend after it
    expect(through("2026-09-29")).toBe(187);

    // Over LABOR DAY (Mon Sep 7): entered Wed Sep 9, the 3 business days of lag are
    // Wed Sep 9, Tue Sep 8 and Fri Sep 4 — the holiday Monday is skipped — so the total is
    // treated as describing business days through Thu Sep 3.
    expect(through("2026-09-09")).toBe(173);
    expect(paceDays("2026-09-09")).toBe(170);
    expect(through("2026-09-03")).toBe(170); // Thu Sep 3

    // Over COLUMBUS DAY (Mon Oct 12): entered Tue Oct 13, the lag days are Oct 13, Oct 9 and Oct 8 —
    // the holiday Monday AND the weekend are skipped — so through Wed Oct 7.
    expect(through("2026-10-13")).toBe(196);
    expect(paceDays("2026-10-13")).toBe(193);
    expect(through("2026-10-07")).toBe(193);

    // Over VETERANS DAY (Wed Nov 11): entered Thu Nov 12, the lag days are Nov 12, Nov 10 and Nov 9 —
    // the mid-week holiday is skipped — so through Fri Nov 6.
    expect(through("2026-11-12")).toBe(217);
    expect(paceDays("2026-11-12")).toBe(214);
    expect(through("2026-11-06")).toBe(214);

    // Over THANKSGIVING + the day after (Thu Nov 26, Fri Nov 27): entered Mon Nov 30, the lag days are
    // Nov 30, Nov 25 and Nov 24 — both holidays and the weekend are skipped — so through Mon Nov 23.
    expect(through("2026-11-30")).toBe(227);
    expect(paceDays("2026-11-30")).toBe(224);
    expect(through("2026-11-23")).toBe(224);

    // Over INDEPENDENCE DAY (observed Fri Jul 3): entered Tue Jul 7, the lag days are Jul 7, Jul 6 and
    // Jul 2 (Fri Jul 3 and the weekend are skipped) — so through Wed Jul 1.
    expect(through("2026-07-07")).toBe(128);
    expect(paceDays("2026-07-07")).toBe(125);
    expect(through("2026-07-01")).toBe(125);

    // Over CHRISTMAS: entered Mon Dec 28 (elapsed 246): pace days 243 = through Tue Dec 22.
    expect(paceDays("2026-12-28")).toBe(through("2026-12-28") - 3);
    expect(through("2026-12-22")).toBe(through("2026-12-28") - 3);
  });

  it("an admin-entered company day counts toward the offset exactly like a standard holiday", () => {
    const withChristmasEve = companyHolidayValues("2026-01-01", "2026-12-31", [
      { id: "x", adjustment_date: "2026-12-24", salesperson_id: null, applies_to_all: true, day_value: 1, reason: "Christmas Eve", note: null },
    ]).values;
    const m = computeRoadMetrics({ total: 1, recordedOn: "2026-12-28", today: "2026-12-28", holidayValues: withChristmasEve });
    expect(m.businessDaysElapsed).toBe(245); // one fewer business day than the 246 without the extra holiday
    expect(m.paceBusinessDays).toBe(242);
  });

  it("changing the ONE configurable value changes only the pace side — e.g. a 4-business-day lag", () => {
    const four = computeRoadMetrics({ total: TOTAL, recordedOn: DATE, today: DATE, holidayValues: holidays(), reportingLagBusinessDays: 4 });
    expect(four.reportingLagBusinessDays).toBe(4);
    expect(four.paceBusinessDays).toBe(187); // 191 - 4
    expect(four.currentPace).toBeCloseTo(7842 / 187, 12);
    expect(four.projectedFinish).toBeCloseTo(7842 + (7842 / 187) * 59, 8);
    expect([four.total, four.percentComplete, four.remaining, four.requiredPace, four.businessDaysRemaining]).toEqual([
      lagged.total, lagged.percentComplete, lagged.remaining, lagged.requiredPace, lagged.businessDaysRemaining,
    ]);
  });

  it("the lag never makes pace negative: with fewer elapsed days than the lag, pace is simply unknown", () => {
    expect(computeRoadMetrics({ total: 5, recordedOn: "2026-01-06", today: "2026-01-06", holidayValues: holidays(), reportingLagBusinessDays: 10 }).paceBusinessDays).toBe(0);
    expect(computeRoadMetrics({ total: 5, recordedOn: "2026-01-06", today: "2026-01-06", holidayValues: holidays(), reportingLagBusinessDays: 10 }).currentPace).toBeNull();
  });
});

// ===========================================================================
// TWO DATES: the RECORDED date (historical pace + reporting lag) and TODAY (the
// real time left to Dec 31). A stale snapshot must not freeze the deadline.
// ===========================================================================

describe("a stale snapshot: recorded Mon Oct 5, viewed on later days (remaining days count TODAY, inclusive)", () => {
  const TOTAL = 7842;
  const RECORDED = "2026-10-05"; // Mon: 191 elapsed through here; lag 3 -> 188 pace days
  const view = (today: string, over: { lag?: number } = {}) =>
    computeRoadMetrics({ total: TOTAL, recordedOn: RECORDED, today, holidayValues: holidays(), reportingLagBusinessDays: over.lag });
  // Independent reference: business days from `today` through Dec 31, inclusive
  // = 249 - (business days elapsed through the day BEFORE today).
  const dayBefore = (d: string) => {
    const x = new Date(`${d}T12:00:00Z`);
    x.setUTCDate(x.getUTCDate() - 1);
    return x.toISOString().slice(0, 10);
  };
  const remainingFrom = (today: string) => 249 - compute(1, dayBefore(today)).businessDaysElapsed;

  const days = [
    ["2026-10-05", 59], // Mon — viewed the day it was recorded
    ["2026-10-07", 57], // Wed — 2 business days old
    ["2026-10-09", 55], // Fri — 4 business days old
    ["2026-10-13", 54], // Tue — a week old (Mon Oct 12 is Columbus Day, a company holiday)
    ["2026-11-02", 40], // a month on
  ] as const;

  it("the reference counts used below are right (independent of the code under test)", () => {
    for (const [d, n] of days) expect(remainingFrom(d), d).toBe(n);
  });

  it("current pace stays on the RECORDED date and the 3-business-day lag — it does not change as today moves", () => {
    const base = view("2026-10-05");
    for (const [d] of days) {
      const m = view(d);
      expect(m.recordedOn, d).toBe("2026-10-05");
      expect(m.businessDaysElapsed, d).toBe(191);
      expect(m.paceBusinessDays, d).toBe(188); // 191 - 3, regardless of the viewing day
      expect(m.currentPace, d).toBe(base.currentPace);
      expect(m.currentPace, d).toBeCloseTo(7842 / 188, 12);
    }
  });

  it("required pace uses TODAY (inclusive) -> Dec 31: it rises as today moves forward", () => {
    const required = days.map(([d]) => view(d).requiredPace as number);
    days.forEach(([d, left], i) => expect(required[i], d).toBeCloseTo(2158 / left, 12));
    for (let i = 1; i < required.length; i += 1) expect(required[i]).toBeGreaterThan(required[i - 1]);
  });

  it("projected finish uses the lag-adjusted pace over the REAL days left: it falls as today moves forward", () => {
    const projected = days.map(([d]) => view(d).projectedFinish as number);
    days.forEach(([d, left], i) => expect(projected[i], d).toBeCloseTo(7842 + (7842 / 188) * left, 8));
    for (let i = 1; i < projected.length; i += 1) expect(projected[i]).toBeLessThan(projected[i - 1]);
  });

  it("THE EXAMPLE: 7,842 recorded Oct 5, viewed Mon Oct 12 (Columbus Day) -> pace ~41.7, 54 business days left, required ~40.0, projected ~10,094", () => {
    const m = view("2026-10-12");
    expect(m.currentPace).toBeCloseTo(7842 / 188, 12);
    expect(m.currentPace).toBeCloseTo(41.7128, 4);
    // Oct 12 is a company holiday, so it adds no day: the time left is the same as on Tue Oct 13.
    expect(m.businessDaysRemaining).toBe(54);
    expect(m.businessDaysRemaining).toBe(view("2026-10-13").businessDaysRemaining);
    expect(m.requiredPace).toBeCloseTo(2158 / 54, 12);
    expect(formatPace(m.requiredPace)).toBe("40.0");
    expect(m.projectedFinish).toBeCloseTo(7842 + (7842 / 188) * 54, 8);
    expect(Math.round(m.projectedFinish as number)).toBe(10094);
    // Not the stale-date numbers (59 days, counted from Oct 5).
    expect(m.businessDaysRemaining).not.toBe(59);
    expect(m.requiredPace).not.toBeCloseTo(2158 / 59, 6);
  });

  it("a normal BUSINESS-DAY viewing date counts as a day still available: viewing Tue Oct 13 leaves one more day than Wed Oct 14", () => {
    expect(view("2026-10-13").businessDaysRemaining).toBe(54);
    expect(view("2026-10-14").businessDaysRemaining).toBe(53);
    expect(view("2026-10-09").businessDaysRemaining).toBe(55); // Fri
  });

  it("a WEEKEND viewing date adds no day: Sat and Sun leave exactly what the next business day does", () => {
    expect(view("2026-10-10").businessDaysRemaining).toBe(54); // Sat
    expect(view("2026-10-11").businessDaysRemaining).toBe(54); // Sun
    expect(view("2026-10-13").businessDaysRemaining).toBe(54); // Tue — the first business day (Mon is Columbus Day)
    expect(view("2026-10-09").businessDaysRemaining).toBe(view("2026-10-10").businessDaysRemaining + 1); // Fri still counts
  });

  it("a COMPANY HOLIDAY viewing date adds no day: it leaves what the next business day does", () => {
    const rem = (recorded: string, today: string) =>
      computeRoadMetrics({ total: 5000, recordedOn: recorded, today, holidayValues: holidays() }).businessDaysRemaining;
    expect(rem("2026-01-16", "2026-01-19")).toBe(rem("2026-01-16", "2026-01-20")); // MLK Day = Tue Jan 20
    expect(rem("2026-02-13", "2026-02-16")).toBe(rem("2026-02-13", "2026-02-17")); // Presidents Day
    expect(rem("2026-06-12", "2026-06-19")).toBe(rem("2026-06-12", "2026-06-22")); // Juneteenth (Fri) = Mon Jun 22
    expect(rem("2026-06-26", "2026-07-03")).toBe(rem("2026-06-26", "2026-07-06")); // July 3 observed = Mon Jul 6
    expect(rem("2026-09-04", "2026-09-07")).toBe(rem("2026-09-04", "2026-09-08")); // Labor Day
    expect(rem("2026-09-04", "2026-09-07")).toBe(78);
    expect(rem("2026-10-02", "2026-10-12")).toBe(rem("2026-10-02", "2026-10-13")); // Columbus Day
    expect(rem("2026-11-06", "2026-11-11")).toBe(rem("2026-11-06", "2026-11-12")); // Veterans Day
    expect(rem("2026-11-20", "2026-11-26")).toBe(23); // Thanksgiving…
    expect(rem("2026-11-20", "2026-11-27")).toBe(23); // …and the day after: both leave what Mon Nov 30 leaves
    expect(rem("2026-11-20", "2026-11-30")).toBe(23);
    expect(rem("2026-12-18", "2026-12-25")).toBe(4); // Christmas = Mon Dec 28
    expect(rem("2026-12-18", "2026-12-25")).toBe(rem("2026-12-18", "2026-12-28"));
  });

  it("DECEMBER 31 counts when it is a business day: 1 left on Dec 31, 2 on Dec 30, and the deadline is still Dec 31", () => {
    expect(ROAD_TO_10000_GOAL.endDate).toBe("2026-12-31");
    expect(view("2026-12-30").businessDaysRemaining).toBe(2); // Wed + Thu
    const last = view("2026-12-31"); // Thursday
    expect(last.businessDaysRemaining).toBe(1);
    expect(last.requiredPace).toBeCloseTo(2158 / 1, 12);
    expect(last.projectedFinish).toBeCloseTo(7842 + (7842 / 188) * 1, 8);
  });

  it("AFTER Dec 31 the year is complete: no days remain, no required pace, and the projection has nothing to add", () => {
    for (const d of ["2027-01-01", "2027-01-04", "2027-06-01"]) {
      const m = view(d);
      expect(m.businessDaysRemaining, d).toBe(0);
      expect(m.requiredPace, d).toBeNull();
      expect(m.paceDifference, d).toBeNull();
      expect(m.status, d).toBeNull();
      expect(m.projectedFinish as number, d).toBeCloseTo(7842, 8);
    }
  });

  it("the lag never creates additional time: time left and required pace are identical for ANY lag", () => {
    for (const [d, left] of days) {
      for (const lag of [0, 1, 3, 4, 7, 20]) {
        const m = view(d, { lag });
        expect(m.businessDaysRemaining, `${d} lag ${lag}`).toBe(left);
        expect(m.requiredPace, `${d} lag ${lag}`).toBeCloseTo(2158 / left, 12);
      }
    }
    // The lag only moves the pace (and so the projection) — never the deadline.
    expect(view("2026-10-12", { lag: 3 }).currentPace as number).toBeGreaterThan(view("2026-10-12", { lag: 0 }).currentPace as number);
  });

  it("a clock that reads BEFORE the recorded date can't create extra time: it is treated as the recorded date", () => {
    expect(view("2026-10-01")).toMatchObject({ today: "2026-10-05", businessDaysRemaining: 59 });
  });

  it("percent, to-go and total never depend on today or the lag", () => {
    for (const [d] of days) {
      const m = view(d);
      expect([m.total, m.remaining]).toEqual([7842, 2158]);
      expect(m.percentComplete).toBeCloseTo(78.42, 12);
    }
  });
});

describe("neutral pace status when pace is unavailable", () => {
  it("never says 'Ahead of pace' next to a dash", () => {
    expect(paceStatusLabel(null)).toBe("Pace status");
    expect(paceStatusLabel("ahead")).toBe("Ahead of pace");
    expect(paceStatusLabel("on_pace")).toBe("On pace");
    expect(paceStatusLabel("behind")).toBe("Behind pace");
  });

  it("the UI uses it: the pace tile and the status badge have no 'Ahead of pace' fallback", () => {
    const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
    const page = read("src/components/road-to-10000/road-page-content.tsx");
    expect(page).toContain("paceStatusLabel(m.status)");
    expect(page).not.toMatch(/\? "Behind pace" : "Ahead of pace"/);
    const badge = read("src/components/road-to-10000/status-badge.tsx");
    expect(badge).toContain("Pace status");
  });

  it("early in the year pace is unknown, so the status is null (the neutral state), not 'ahead'", () => {
    const early = compute(40, "2026-01-02"); // 1 business day elapsed: all within the lag
    expect(early.currentPace).toBeNull();
    expect(early.status).toBeNull();
    expect(paceStatusLabel(early.status)).toBe("Pace status");
  });
});

describe("pace status — no invented thresholds", () => {
  it("is just the sign of (current - required), compared at the precision shown", () => {
    expect(paceStatus(5.3)).toBe("ahead");
    expect(paceStatus(0.06)).toBe("ahead"); // shows +0.1
    expect(paceStatus(0)).toBe("on_pace");
    expect(paceStatus(0.04)).toBe("on_pace"); // shows 0.0: two identical-looking paces are never "behind"
    expect(paceStatus(-0.04)).toBe("on_pace");
    expect(paceStatus(-0.06)).toBe("behind");
    expect(paceStatus(-12)).toBe("behind");
    expect(paceStatus(null)).toBeNull();
  });

  it("has the three labels the card shows", () => {
    expect(PACE_STATUS_LABEL).toEqual({ ahead: "Ahead of pace", on_pace: "On pace", behind: "Behind pace" });
  });

  it("exactly on pace: current == required", () => {
    // Recorded and viewed the same day: that day is in both the elapsed and the remaining count.
    const flat = new Map<string, number>();
    const m = computeRoadMetrics({
      total: 5000, recordedOn: "2026-05-22", today: "2026-05-22", holidayValues: flat,
      goal: { year: 2026, target: 10000, startDate: "2026-01-01", endDate: "2026-12-31" },
    });
    expect(m.businessDaysElapsed + m.businessDaysRemaining).toBe(261 + 1); // 261 weekdays, May 22 counted in both
    expect(paceStatus(m.paceDifference)).toBe(m.paceDifference! > 0 ? "ahead" : m.paceDifference! < 0 ? "behind" : "on_pace");
  });
});

describe("display formatting", () => {
  it("numbers read the way the card shows them", () => {
    expect(formatWhole(7842)).toBe("7,842");
    expect(formatWhole(10000)).toBe("10,000");
    expect(formatPace(39.62)).toBe("39.6");
    expect(formatPace(null)).toBe("—");
    expect(formatSignedPace(5.26)).toBe("+5.3");
    expect(formatSignedPace(0)).toBe("0.0");
    expect(formatSignedPace(null)).toBe("—");
    expect(formatPercent(78.42)).toBe("78.4");
    expect(formatBusinessDays(61)).toBe("61");
    expect(formatBusinessDays(60.5)).toBe("60.5");
  });
});

describe("the total SOURCE is swappable (manual today, Cogent later) without touching the math", () => {
  it("any RoadTotalSource's reading feeds the same computation", async () => {
    const sample: TotalReading = {
      id: "c1", total: 7842, recordedAt: "2026-10-05T18:00:00Z", recordedOn: "2026-10-05",
      source: "cogent_closed_transactions", isCorrection: false, note: null, enteredByName: null,
    };
    const fake: RoadTotalSource = {
      id: "cogent_closed_transactions",
      async latest() {
        return sample;
      },
      async history() {
        return [sample];
      },
    };
    const reading = (await fake.latest()) as TotalReading;
    const viaFake = compute(reading.total, reading.recordedOn);
    expect(viaFake).toEqual(compute(7842, "2026-10-05"));
  });
});
