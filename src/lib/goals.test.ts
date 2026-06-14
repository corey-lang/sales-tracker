import { describe, expect, it } from "vitest";

// goals.ts imports the browser Supabase client, which throws at module load if
// these aren't set. Provide harmless placeholders before the dynamic import so
// the pure date helpers under test can be exercised without real credentials.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const { activityWeekToDateRange, businessWeekToDateRange, recentActivityWeeks } =
  await import("@/lib/goals");

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

describe("recentActivityWeeks", () => {
  it("makes the current week the Sun-Sat week that begins on Sunday", () => {
    // On Sunday 2026-06-14 the current activity week starts that very Sunday.
    const [current] = recentActivityWeeks(4, at("2026-06-14"));
    expect(current).toEqual({
      weekStart: "2026-06-14", // Sunday
      weekEnd: "2026-06-20", // Saturday
      monday: "2026-06-15", // inner Mon-Fri section start
      friday: "2026-06-19", // inner Mon-Fri section end
      label: "06-14-2026 – 06-20-2026",
      isCurrent: true,
    });
  });

  it("walks back a full 7 days per prior week, newest first", () => {
    const weeks = recentActivityWeeks(3, at("2026-06-17")); // Wednesday
    expect(weeks.map((w) => w.weekStart)).toEqual([
      "2026-06-14",
      "2026-06-07",
      "2026-05-31",
    ]);
    expect(weeks.filter((w) => w.isCurrent)).toHaveLength(1);
  });

  it("exposes a Mon-Fri inner range that is a real business week", () => {
    // The inner Mon-Fri range must match businessWeekToDateRange for its Monday,
    // so the editor's Mon-Fri section maps cleanly onto a business week.
    const [current] = recentActivityWeeks(1, at("2026-06-14"));
    const business = businessWeekToDateRange(at(current.monday));
    expect(business.since).toBe(current.monday); // Monday
    // Friday is the Monday + 4; business "through" caps at today (the Monday),
    // but the canonical Friday is the activity week's `friday`.
    expect(current.friday).toBe("2026-06-19");
  });

  it("places Sunday outside its own week's Mon-Fri (straddles two business weeks)", () => {
    // Sanity check on the documented straddle: the activity week's Sunday is
    // NOT inside that week's Mon-Fri range.
    const [current] = recentActivityWeeks(1, at("2026-06-14"));
    expect(current.weekStart < current.monday).toBe(true); // Sun before Mon
    expect(current.weekEnd > current.friday).toBe(true); // Sat after Fri
  });

  it("gates the current week's Mon-Fri section until its Monday arrives", () => {
    // EditWeekCard disables the Mon-Fri save when `monday > today` (both are
    // yyyy-MM-dd strings). Verify that invariant across the Sun→Mon boundary.

    // Sunday 2026-06-14: current week's Monday (06-15) is in the future → gated.
    const [sunWeek] = recentActivityWeeks(1, at("2026-06-14"));
    expect(sunWeek.monday > "2026-06-14").toBe(true);

    // Monday 2026-06-15: same activity week, Monday has arrived → open.
    const [monWeek] = recentActivityWeeks(1, at("2026-06-15"));
    expect(monWeek.weekStart).toBe("2026-06-14"); // still the Sun-Sat week
    expect(monWeek.monday > "2026-06-15").toBe(false);
  });
});
