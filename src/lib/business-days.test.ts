import { describe, expect, it } from "vitest";

import { businessDaysBetween, companyHolidayValueByDate } from "@/lib/business-days";
import type { WorkingDayAdjustment } from "@/lib/working-days";

const none = new Map<string, number>();
const adj = (over: Partial<WorkingDayAdjustment>): WorkingDayAdjustment => ({
  id: "x", adjustment_date: "2026-11-27", salesperson_id: null, applies_to_all: true,
  day_value: 1, reason: "Holiday", note: null, ...over,
});

describe("businessDaysBetween (the Orders pace algorithm, now shared)", () => {
  it("counts Monday-Friday only: a full week is 5, a weekend alone is 0", () => {
    expect(businessDaysBetween("2026-10-05", "2026-10-09", none)).toBe(5); // Mon-Fri
    expect(businessDaysBetween("2026-10-05", "2026-10-11", none)).toBe(5); // Mon-Sun
    expect(businessDaysBetween("2026-10-03", "2026-10-04", none)).toBe(0); // Sat-Sun
    expect(businessDaysBetween("2026-10-09", "2026-10-12", none)).toBe(2); // Fri + Mon
  });

  it("is inclusive at both ends, and 0 when start is after end", () => {
    expect(businessDaysBetween("2026-10-05", "2026-10-05", none)).toBe(1);
    expect(businessDaysBetween("2026-10-06", "2026-10-05", none)).toBe(0);
  });

  it("subtracts company holidays, and a holiday on a weekend subtracts nothing extra", () => {
    const hol = new Map([["2026-11-26", 1], ["2026-11-28", 1]]); // Thu + a Saturday
    expect(businessDaysBetween("2026-11-23", "2026-11-29", hol)).toBe(4); // 5 weekdays - Thanksgiving
  });

  it("supports half-day holidays", () => {
    expect(businessDaysBetween("2026-11-23", "2026-11-27", new Map([["2026-11-27", 0.5]]))).toBe(4.5);
  });

  it("a whole year: 261 weekdays in 2026", () => {
    expect(businessDaysBetween("2026-01-01", "2026-12-31", none)).toBe(261);
  });
});

describe("companyHolidayValueByDate", () => {
  it("uses company-wide rows ONLY — individual PTO never counts", () => {
    const m = companyHolidayValueByDate([
      adj({ adjustment_date: "2026-11-27" }),
      adj({ id: "y", adjustment_date: "2026-12-01", applies_to_all: false, salesperson_id: "ae-1" }),
    ]);
    expect([...m.entries()]).toEqual([["2026-11-27", 1]]);
  });

  it("caps a day at 1 and clamps bad values", () => {
    const m = companyHolidayValueByDate([
      adj({ day_value: 0.5 }), adj({ id: "b", day_value: 1 }), adj({ id: "c", adjustment_date: "2026-12-02", day_value: -3 }),
    ]);
    expect(m.get("2026-11-27")).toBe(1);
    expect(m.get("2026-12-02")).toBe(0);
  });
});
