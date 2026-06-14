import { describe, expect, it } from "vitest";

// goals.ts imports the browser Supabase client, which throws at module load if
// these aren't set. Provide harmless placeholders before the dynamic import so
// the pure date helpers under test can be exercised without real credentials.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const { activityWeekToDateRange, businessWeekToDateRange } = await import(
  "@/lib/goals"
);

// All dates constructed at local midnight so date-fns reasons about the
// intended calendar day (mirrors todayInAppTimezone's anchor).
const at = (yyyyMmDd: string) => new Date(`${yyyyMmDd}T00:00:00`);

describe("activityWeekToDateRange", () => {
  it("anchors the week to Sunday and caps `through` at today (mid-week)", () => {
    // 2026-06-17 is a Wednesday; its Sunday is 2026-06-14.
    expect(activityWeekToDateRange(at("2026-06-17"))).toEqual({
      since: "2026-06-14",
      through: "2026-06-17",
    });
  });

  it("includes Saturday in the same Sun-Sat week", () => {
    // 2026-06-20 is a Saturday; week still starts Sunday 2026-06-14.
    expect(activityWeekToDateRange(at("2026-06-20"))).toEqual({
      since: "2026-06-14",
      through: "2026-06-20",
    });
  });

  it("treats Sunday as the first day of its own week", () => {
    // 2026-06-14 is a Sunday: since == through == that Sunday.
    expect(activityWeekToDateRange(at("2026-06-14"))).toEqual({
      since: "2026-06-14",
      through: "2026-06-14",
    });
  });

  it("covers weekend days that the Mon-Fri business week excludes", () => {
    // On Saturday, the business week starts Monday 2026-06-15 and ends Friday;
    // the activity week starts the prior Sunday and includes Saturday itself.
    const saturday = at("2026-06-20");
    const activity = activityWeekToDateRange(saturday);
    const business = businessWeekToDateRange(saturday);

    expect(activity.since).toBe("2026-06-14");
    expect(business.since).toBe("2026-06-15");
    // The Saturday save lands inside the activity range but past the business
    // week's Friday cutoff — exactly the gap that hid weekend totals before.
    expect(activity.through).toBe("2026-06-20");
    expect(business.through).toBe("2026-06-19");
  });
});
