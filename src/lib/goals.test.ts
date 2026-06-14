import { describe, expect, it } from "vitest";

// goals.ts imports the browser Supabase client, which throws at module load if
// these aren't set. Provide harmless placeholders before the dynamic import so
// the pure date helpers under test can be exercised without real credentials.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const {
  activityWeekToDateRange,
  activityWindowForBusinessWeek,
  businessWeekToDateRange,
  pairedBusinessMonday,
  recentActivityWeeks,
} = await import("@/lib/goals");

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

  it("emits weeks that satisfy the replace_activity_week RPC contract", () => {
    // The RPC validates p_week_start is a Sunday and p_week_end = start + 6.
    // EditWeekCard passes weekStart/weekEnd straight through, so every option
    // must satisfy that contract or saves would be rejected.
    const weeks = recentActivityWeeks(6, at("2026-06-17"));
    for (const w of weeks) {
      expect(at(w.weekStart).getDay()).toBe(0); // Sunday (local midnight)
      const diffDays = Math.round(
        (at(w.weekEnd).getTime() - at(w.weekStart).getTime()) / 86_400_000,
      );
      expect(diffDays).toBe(6); // Saturday = Sunday + 6
    }
  });

  it("the canonical save row (Sunday/weekStart) is always <= today", () => {
    // EditWeekCard consolidates a week's total onto its Sunday row. For any
    // selectable week that Sunday is <= today, so capped Sun-Sat readers always
    // see it (no future-dated write).
    const weeks = recentActivityWeeks(4, at("2026-06-14")); // a Sunday
    for (const w of weeks) {
      expect(w.weekStart <= "2026-06-14").toBe(true);
    }
  });
});

describe("pairedBusinessMonday", () => {
  it("rolls the week on SUNDAY, not Monday", () => {
    // Sunday 2026-06-14 → the NEW week's Monday (06-15), so a Sunday log lands
    // in the current week. businessWeekToDateRange would still point at the
    // PRIOR Monday here (it rolls Monday) — that's the bug this fixes.
    expect(pairedBusinessMonday(at("2026-06-14"))).toBe("2026-06-15");
    expect(businessWeekToDateRange(at("2026-06-14")).since).toBe("2026-06-08");
  });

  it("matches businessWeekToDateRange's Monday on Mon-Sat", () => {
    // Wednesday and Saturday of the same activity week both pair to Mon 06-15.
    expect(pairedBusinessMonday(at("2026-06-17"))).toBe("2026-06-15"); // Wed
    expect(pairedBusinessMonday(at("2026-06-20"))).toBe("2026-06-15"); // Sat
    expect(businessWeekToDateRange(at("2026-06-17")).since).toBe("2026-06-15");
  });

  it("is robust to a legacy Monday input (same week)", () => {
    // A stored/bookmarked Monday maps to the same paired Monday.
    expect(pairedBusinessMonday(at("2026-06-15"))).toBe("2026-06-15");
  });
});

describe("activityWindowForBusinessWeek", () => {
  // The split: business-Monday M ↔ activity window Sun(M-1)…Sat(M+5).
  it("maps a business Monday to its Sun-Sat activity window (mid-week cap)", () => {
    // Business week Mon 2026-06-15; viewed on Wed 2026-06-17.
    expect(activityWindowForBusinessWeek("2026-06-15", "2026-06-17")).toEqual({
      since: "2026-06-14", // Sunday before the Monday
      through: "2026-06-17", // capped at today
    });
  });

  it("returns the whole Sun-Sat span for a fully-past week", () => {
    // Same business week, but today is well past it → full Saturday included.
    expect(activityWindowForBusinessWeek("2026-06-15", "2026-07-01")).toEqual({
      since: "2026-06-14", // Sunday
      through: "2026-06-20", // Saturday (M+5), not the Mon-Fri Friday
    });
  });

  it("includes the week's own Sunday but not the next/prior week's", () => {
    // The activity window for business Mon 06-15 starts on Sun 06-14 and ends
    // on Sat 06-20 — the Sunday that belongs to THIS activity week, and the
    // Saturday a Mon-Fri window would have excluded.
    const full = activityWindowForBusinessWeek("2026-06-15", "2026-12-31");
    const business = businessWeekToDateRange(at("2026-06-15"));
    expect(business.since).toBe("2026-06-15"); // Mon-Fri starts Monday
    expect(full.since).toBe("2026-06-14"); // activity starts the Sunday before
    expect(full.through > business.through).toBe(true); // Sat 06-20 > Fri 06-19
  });
});
