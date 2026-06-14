import { describe, expect, it } from "vitest";

import { dailyBoost } from "@/lib/quotes";

describe("dailyBoost", () => {
  it("is stable for the same date key (no per-render change)", () => {
    expect(dailyBoost("2026-06-14")).toBe(dailyBoost("2026-06-14"));
  });

  it("returns a non-empty quote for a valid date key", () => {
    expect(dailyBoost("2026-06-14").length).toBeGreaterThan(0);
  });

  it("rotates across days in a week (not a single fixed line)", () => {
    const week = [
      "2026-06-14",
      "2026-06-15",
      "2026-06-16",
      "2026-06-17",
      "2026-06-18",
      "2026-06-19",
      "2026-06-20",
    ].map(dailyBoost);
    expect(new Set(week).size).toBeGreaterThan(1);
  });
});
