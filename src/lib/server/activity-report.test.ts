/**
 * Tests for buildActivityReport's handling of a DEACTIVATED AE.
 *
 * THE BUSINESS RULE
 *   Offboarding someone (Chanel) removes them from every LIVE roster surface,
 *   but their historical performance must stay attributed to them so past
 *   reporting is still accurate — and so a future Austin hire never inherits
 *   their numbers. The admin Activity Report can render prior weeks, so it is
 *   the one roster read that must keep a departed AE on the weeks they worked.
 */

import { describe, expect, it } from "vitest";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const { buildActivityReport } = await import("@/lib/server/activity-report");

type Row = Record<string, unknown>;

const CHANEL_ID = "44444444-4444-4444-8444-444444444444";
const ACTIVE_AE_ID = "11111111-1111-4111-8111-111111111111";

/** Chanel's last active day, Denver-time. */
const DEACTIVATED_AT = "2026-08-24T18:00:00.000Z"; // 2026-08-24 12:00 MDT

const PEOPLE: Row[] = [
  { id: ACTIVE_AE_ID, first_name: "Carli", deactivated_at: null },
  { id: CHANEL_ID, first_name: "Chanel", deactivated_at: DEACTIVATED_AT },
];

/** Rows Chanel logged before she left — these must never disappear. */
const ENTRIES: Row[] = [
  {
    salesperson_id: CHANEL_ID,
    entry_date: "2026-08-19",
    office_visits: 7,
    service_requests: 1,
    ones_scheduled: 0,
    ones_held: 0,
    presentations: 0,
    impressions: 30,
    team_meetings: 0,
    gold_list_touches: 0,
  },
  {
    salesperson_id: ACTIVE_AE_ID,
    entry_date: "2026-08-19",
    office_visits: 3,
    service_requests: 0,
    ones_scheduled: 0,
    ones_held: 0,
    presentations: 0,
    impressions: 10,
    team_meetings: 0,
    gold_list_touches: 0,
  },
];

function fakeSupabase(entries: Row[] = ENTRIES) {
  return {
    from: (table: string) => {
      const filters: Record<string, string> = {};
      const resolve = () => {
        if (table === "salespeople") {
          return Promise.resolve({ data: PEOPLE, error: null });
        }
        if (table === "activity_entries") {
          const from = filters["gte:entry_date"];
          const to = filters["lte:entry_date"];
          return Promise.resolve({
            data: entries.filter((e) => {
              const d = e.entry_date as string;
              return (!from || d >= from) && (!to || d <= to);
            }),
            error: null,
          });
        }
        // weekly_goals + working_day_adjustments: none needed for these cases.
        return Promise.resolve({ data: [], error: null });
      };
      const self: Record<string, unknown> = {
        select: () => self,
        then: (onF: unknown, onR: unknown) =>
          resolve().then(onF as never, onR as never),
      };
      for (const m of ["eq", "gte", "lte", "is", "order", "in"]) {
        self[m] = (col?: string, value?: unknown) => {
          if (col) filters[`${m}:${col}`] = String(value);
          return self;
        };
      }
      return self;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("historical attribution survives offboarding", () => {
  it("keeps a deactivated AE on a week they actually worked", async () => {
    // Business week Mon 2026-08-17 … Fri 2026-08-21 — before she left.
    const { rows, error } = await buildActivityReport(
      fakeSupabase(),
      "2026-08-17",
      "2026-08-21",
      "2026-08-17",
      "2026-08-21",
    );
    expect(error).toBeNull();
    const chanel = rows.find((r) => r.id === CHANEL_ID);
    expect(chanel).toBeDefined();
    expect(chanel?.first_name).toBe("Chanel");
    // Her activity is still HER activity — attributed, not merged or moved.
    expect(chanel?.cells.office_visits.actual).toBe(7);
    expect(chanel?.cells.impressions.actual).toBe(30);
  });

  it("does not fold her numbers into another AE's row", async () => {
    const { rows } = await buildActivityReport(
      fakeSupabase(),
      "2026-08-17",
      "2026-08-21",
      "2026-08-17",
      "2026-08-21",
    );
    const active = rows.find((r) => r.id === ACTIVE_AE_ID);
    expect(active?.cells.office_visits.actual).toBe(3);
    expect(active?.cells.impressions.actual).toBe(10);
  });

  it("drops her from weeks that start after she left", async () => {
    // Business week Mon 2026-09-07 … Fri 2026-09-11 — well after her last day.
    const { rows, error } = await buildActivityReport(
      fakeSupabase([]),
      "2026-09-07",
      "2026-09-11",
      "2026-09-07",
      "2026-09-11",
    );
    expect(error).toBeNull();
    expect(rows.find((r) => r.id === CHANEL_ID)).toBeUndefined();
    expect(rows.find((r) => r.id === ACTIVE_AE_ID)).toBeDefined();
  });

  it("keeps her on the week containing her final active day", async () => {
    // She was deactivated 2026-08-24 (a Monday), so that week still counts.
    const { rows } = await buildActivityReport(
      fakeSupabase([]),
      "2026-08-24",
      "2026-08-28",
      "2026-08-24",
      "2026-08-28",
    );
    expect(rows.find((r) => r.id === CHANEL_ID)).toBeDefined();
  });

  it("never mutates or drops the underlying entry rows", async () => {
    const entries = structuredClone(ENTRIES);
    await buildActivityReport(
      fakeSupabase(entries),
      "2026-08-17",
      "2026-08-21",
      "2026-08-17",
      "2026-08-21",
    );
    expect(entries).toEqual(ENTRIES);
    expect(
      entries.filter((e) => e.salesperson_id === CHANEL_ID),
    ).toHaveLength(1);
  });
});
