import { describe, expect, it } from "vitest";

import { appDateOnly, isRosteredDuring } from "./roster-window";

const W = { since: "2026-11-02", through: "2026-11-08" }; // a Mon–Sun window

describe("isRosteredDuring", () => {
  it("includes everyone with no boundaries — existing salespeople are unaffected", () => {
    expect(isRosteredDuring({}, W.since, W.through)).toBe(true);
    expect(isRosteredDuring({ started_on: null, deactivated_at: null }, W.since, W.through)).toBe(true);
  });

  it("excludes a person who starts AFTER the window ends, includes them from their start day", () => {
    expect(isRosteredDuring({ started_on: "2026-11-09" }, W.since, W.through)).toBe(false);
    expect(isRosteredDuring({ started_on: "2026-11-08" }, W.since, W.through)).toBe(true);
    expect(isRosteredDuring({ started_on: "2026-11-02" }, W.since, W.through)).toBe(true);
    expect(isRosteredDuring({ started_on: "2026-01-05" }, W.since, W.through)).toBe(true);
  });

  it("keeps a departed person on every window that overlaps their final active day", () => {
    // Left Wed 2026-11-04 → still on the week of Nov 2, gone from the week after.
    const left = { deactivated_at: "2026-11-04T17:00:00Z" };
    expect(isRosteredDuring(left, W.since, W.through)).toBe(true);
    expect(isRosteredDuring(left, "2026-10-26", "2026-11-01")).toBe(true); // earlier week: history kept
    expect(isRosteredDuring(left, "2026-11-09", "2026-11-15")).toBe(false);
  });

  it("measures the final active DAY in America/Denver, not UTC", () => {
    // 03:00 UTC on Nov 9 is still Nov 8 evening in Denver — still inside the Nov 2–8 window's successor boundary.
    const left = { deactivated_at: "2026-11-09T03:00:00Z" };
    expect(appDateOnly(left.deactivated_at)).toBe("2026-11-08");
    expect(isRosteredDuring(left, "2026-11-08", "2026-11-14")).toBe(true);
    expect(isRosteredDuring(left, "2026-11-09", "2026-11-15")).toBe(false);
  });

  it("handles a replacement: one leaves, one starts — each appears only for their own time", () => {
    const james = { deactivated_at: "2026-11-01T20:00:00Z" };
    const kim = { started_on: "2026-11-02" };
    const before = { since: "2026-10-26", through: "2026-11-01" };
    const after = { since: "2026-11-02", through: "2026-11-08" };
    expect(isRosteredDuring(james, before.since, before.through)).toBe(true);
    expect(isRosteredDuring(kim, before.since, before.through)).toBe(false);
    expect(isRosteredDuring(james, after.since, after.through)).toBe(false);
    expect(isRosteredDuring(kim, after.since, after.through)).toBe(true);
  });
});
