/**
 * Road to 10,000 — route + database tests against a REAL Postgres (PGlite
 * running the project's actual migrations) with real signed session tokens and
 * the real auth chain. Nothing about the feature is faked, except where a test
 * deliberately simulates a failure (the migration not applied, a holiday read
 * failing).
 *
 * The goal: 10,000 Homescriptions sold in 2026. V1's total is typed in by hand
 * (Corey / Tonja) as a CUMULATIVE number; pace is computed from it, through the
 * date it was recorded, over business days (Mon-Fri minus company holidays).
 *
 * The app clock is pinned to Mon 2026-10-05 12:00 America/Denver.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDb, type TestDb } from "@/test/pglite-supabase";

process.env.SESSION_SECRET = "test-session-secret";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ getServerSupabase: () => holder.client }));

const { signSessionToken } = await import("@/lib/server/auth");
const { buildRoadView } = await import("@/lib/server/road-to-10000");
const route = await import("./route");

type Row = Record<string, unknown>;

const HILARY = "11111111-1111-4111-8111-111111111111"; // AE
const KENNEDY = "22222222-2222-4222-8222-222222222222"; // AE
const COREY = "55555555-5555-4555-8555-555555555555"; // admin
const RYAN = "66666666-6666-4666-8666-666666666666"; // admin
const TONJA = "77777777-7777-4777-8777-777777777777"; // assistant
const LEAH = "99999999-9999-4999-8999-999999999991"; // juice_box_only
const OLD_ADMIN = "99999999-9999-4999-8999-999999999992"; // deactivated admin

const roleOf: Record<string, string> = {
  [HILARY]: "ae", [KENNEDY]: "ae", [COREY]: "admin", [RYAN]: "admin", [TONJA]: "assistant", [LEAH]: "juice_box_only", [OLD_ADMIN]: "admin",
};
const nameOf: Record<string, string> = {
  [HILARY]: "Hilary", [KENNEDY]: "Kennedy", [COREY]: "Corey", [RYAN]: "Ryan", [TONJA]: "Tonja", [LEAH]: "Leah", [OLD_ADMIN]: "Old Admin",
};

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  holder.client = db.client;
}, 60_000);

const NOW = "2026-10-05T18:00:00.000Z"; // Mon Oct 5, 12:00 Denver

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  await db.reset();
  await db.sql(
    `INSERT INTO salespeople (id, first_name, role, deactivated_at) VALUES
       ($1,'Hilary','ae',NULL), ($2,'Kennedy','ae',NULL), ($3,'Corey','admin',NULL), ($4,'Ryan','admin',NULL),
       ($5,'Tonja','assistant',NULL), ($6,'Leah','juice_box_only',NULL), ($7,'Old Admin','admin','2026-06-01T00:00:00Z')`,
    [HILARY, KENNEDY, COREY, RYAN, TONJA, LEAH, OLD_ADMIN],
  );
});
afterEach(() => {
  vi.useRealTimers();
  holder.client = db.client;
});

function req(who: string | null, init: { method?: string; body?: unknown } = {}) {
  return new Request("http://localhost/api/road-to-10000", {
    method: init.method ?? "GET",
    headers: {
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(who ? { Authorization: `Bearer ${signSessionToken({ sub: who, role: roleOf[who] as never, name: nameOf[who] })}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}
type View = {
  configured: boolean; goal: Row; source: string; can_update: boolean; extraHolidaysUnavailable: boolean;
  latest: (Row & { id: string; total: number; recordedOn: string }) | null;
  metrics: Record<string, number | string | boolean | null> | null;
  daysSinceUpdate: number | null;
  history: Array<Row & { id: string; total: number; isCorrection: boolean; note: string | null; enteredByName: string }>;
  holidays: Array<{ date: string; name: string; source: string; value: number }>;
};
const json = async <T = Row>(res: Response | Promise<Response>) => (await (await res).json()) as T;
const get = (who: string | null) => route.GET(req(who));
const post = (who: string | null, body: unknown) => route.POST(req(who, { method: "POST", body }));
const rows = () => db.sql(`SELECT * FROM road_to_10000_totals ORDER BY seq`);

/** Records a total on top of the CURRENT latest (a well-behaved screen). */
async function record(who: string, total: number, extra: Row = {}) {
  const cur = await json<View>(get(who));
  return post(who, { total, expected_latest_id: cur.latest?.id ?? null, ...extra });
}
const at = (iso: string) => vi.setSystemTime(new Date(iso));

// ===========================================================================
// 1) Reading
// ===========================================================================

describe("reading the goal", () => {
  it("before any total: configured, no metrics, the standard holidays listed, nothing invented", async () => {
    const v = await json<View>(get(HILARY));
    expect(v).toMatchObject({
      configured: true, source: "manual", latest: null, metrics: null, daysSinceUpdate: null, history: [],
      goal: { year: 2026, target: 10000, startDate: "2026-01-01", endDate: "2026-12-31" },
    });
    expect(v.holidays.map((h) => `${h.date} ${h.name}`)).toEqual([
      "2026-01-01 New Year's Day", "2026-01-19 Martin Luther King Jr. Day", "2026-02-16 Presidents Day",
      "2026-05-25 Memorial Day", "2026-06-19 Juneteenth", "2026-07-03 Independence Day",
      "2026-09-07 Labor Day", "2026-10-12 Columbus Day", "2026-11-11 Veterans Day",
      "2026-11-26 Thanksgiving Day", "2026-11-27 Day after Thanksgiving", "2026-12-25 Christmas Day",
    ]);
  });

  it("every signed-in AE-tool user can read it; AEs get a VIEW-ONLY payload", async () => {
    for (const [who, canUpdate] of [[HILARY, false], [KENNEDY, false], [COREY, true], [RYAN, true], [TONJA, true]] as const) {
      const res = await get(who);
      expect(res.status, nameOf[who]).toBe(200);
      expect((await res.json()).can_update, nameOf[who]).toBe(canUpdate);
    }
  });

  it("signed-out callers get 401; a juice_box_only guest and a deactivated admin are refused", async () => {
    expect((await get(null)).status).toBe(401);
    expect((await get(LEAH)).status).toBe(403);
    expect((await get(OLD_ADMIN)).status).toBe(401);
  });
});

// ===========================================================================
// 2) Updating the cumulative total
// ===========================================================================

describe("updating the cumulative total", () => {
  it("stores the CUMULATIVE number, who entered it and when; the latest is the current total", async () => {
    at("2026-10-03T16:00:00Z");
    expect((await record(COREY, 7650)).status).toBe(201);
    at(NOW);
    const res = await record(TONJA, 7842);
    expect(res.status).toBe(201);
    const v = await json<View>(res);

    expect(v.latest).toMatchObject({ total: 7842, recordedOn: "2026-10-05", enteredByName: "Tonja", source: "manual", isCorrection: false });
    expect(v.history.map((h) => [h.total, h.enteredByName])).toEqual([[7842, "Tonja"], [7650, "Corey"]]); // newest first
    const [first, second] = await rows();
    expect([first.total, second.total]).toEqual([7650, 7842]);
    expect(first).toMatchObject({ entered_by: COREY, entered_by_name: "Corey", source: "manual", is_correction: false, goal_year: 2026 });
  });

  it("computes everything from that total: percent, to go, business days, pace, required pace, projected finish", async () => {
    const v = await json<View>(await record(COREY, 7842));
    const m = v.metrics!;
    expect(m).toMatchObject({
      target: 10000, total: 7842, remaining: 2158, complete: false, businessDaysElapsed: 191, businessDaysRemaining: 59,
      recordedOn: "2026-10-05", status: "ahead",
    });
    expect(m.percentComplete).toBeCloseTo(78.42, 10);
    // The 3-business-day reporting lag applies to the historical pace only: 191 elapsed - 3 = 188.
    expect(m).toMatchObject({ reportingLagBusinessDays: 3, paceBusinessDays: 188 });
    expect(m.currentPace).toBeCloseTo(7842 / 188, 10);
    expect(m.requiredPace).toBeCloseTo(2158 / 59, 10); // no lag on the forward-looking side
    expect(m.paceDifference).toBeCloseTo(7842 / 188 - 2158 / 59, 10);
    expect(m.projectedFinish).toBeCloseTo(7842 + (7842 / 188) * 59, 8); // adjusted pace x the real 59 days
  });

  it("accepts the whole range 0..10,000, including the finish line", async () => {
    expect((await record(COREY, 0)).status).toBe(201);
    expect((await record(COREY, 10000)).status).toBe(201);
    const v = await json<View>(get(HILARY));
    expect(v.metrics).toMatchObject({ complete: true, remaining: 0, percentComplete: 100, requiredPace: 0, projectedFinish: 10000 });
  });

  it("rejects invalid totals: not whole, negative, over 10,000, not a number, unknown fields", async () => {
    const bad = async (body: Row) => (await post(COREY, { expected_latest_id: null, ...body })).status;
    expect(await bad({ total: 7842.5 })).toBe(400);
    expect(await bad({ total: -1 })).toBe(400);
    expect(await bad({ total: 10001 })).toBe(400);
    expect(await bad({ total: "7842" })).toBe(400);
    expect(await bad({ total: null })).toBe(400);
    expect(await bad({})).toBe(400);
    expect(await bad({ total: 100, delta: 5 })).toBe(400); // no daily/weekly adds, no deltas
    expect(await bad({ total: 100, added_today: 5 })).toBe(400);
    expect((await post(COREY, { total: 100 })).status).toBe(400); // expected_latest_id is required (may be null)
    expect(await rows()).toEqual([]);
  });

  it("the database refuses the same things on its own", async () => {
    const call = (total: number | null) =>
      db.client.rpc("record_road_to_10000_total", { p_actor: COREY, p_total: total, p_is_correction: false, p_note: null, p_expected_latest_id: null });
    expect((await call(10001)).error?.code).toBe("22023");
    expect((await call(-5)).error?.code).toBe("22023");
    expect((await call(null)).error?.code).toBe("22004");
    expect(await rows()).toEqual([]);
    await expect(db.sql(`INSERT INTO road_to_10000_totals (total, entered_by, entered_by_name) VALUES (10001, $1, 'x')`, [COREY])).rejects.toMatchObject({ code: "23514" });
  });

  it("recording the same total again is allowed (it refreshes 'last updated') and moves the pace date", async () => {
    at("2026-10-02T18:00:00Z");
    await record(COREY, 7842);
    at(NOW);
    const v = await json<View>(await record(COREY, 7842));
    expect(v.history).toHaveLength(2);
    expect(v.latest!.recordedOn).toBe("2026-10-05");
    expect(v.metrics!.businessDaysElapsed).toBe(191);
  });

  it("no daily update is required: a total entered days ago stays current and visibly old — pace from the RECORDED date, time left from TODAY", async () => {
    at("2026-10-02T18:00:00Z"); // Fri
    await record(COREY, 7650);
    at("2026-10-05T18:00:00Z"); // Mon — three days later, nobody updated
    const v = await json<View>(get(HILARY));
    expect(v.latest).toMatchObject({ total: 7650, recordedOn: "2026-10-02" });
    expect(v.daysSinceUpdate).toBe(3);
    expect(v.metrics).toMatchObject({ recordedOn: "2026-10-02", today: "2026-10-05", businessDaysElapsed: 190, paceBusinessDays: 187 });
    // Historical pace: through the recorded date (Fri Oct 2), less the 3-business-day lag.
    expect((v.metrics!.currentPace as number)).toBeCloseTo(7650 / 187, 10);
    // Time left: from TODAY (Mon Oct 5, inclusive) to Dec 31 = 59 business days — not 60, which counted from Oct 2.
    expect(v.metrics!.businessDaysRemaining).toBe(59);
    expect(v.metrics!.requiredPace as number).toBeCloseTo(2350 / 59, 10);
    expect(v.metrics!.projectedFinish as number).toBeCloseTo(7650 + (7650 / 187) * 59, 8);
  });

  it("a stale snapshot (recorded Oct 5, viewed Oct 12 — Columbus Day, a company holiday): pace stays on the Oct 5 snapshot, required pace and projection move to Oct 12 -> Dec 31", async () => {
    at("2026-10-05T18:00:00Z");
    await record(COREY, 7842);
    const viewOn = async (iso: string) => {
      at(iso);
      return (await json<View>(get(HILARY))).metrics!;
    };
    const oct5 = await viewOn("2026-10-05T18:00:00Z");
    const oct12 = await viewOn("2026-10-12T18:00:00Z");

    // Historical pace: the Oct 5 snapshot, 3-business-day lag — identical on both days.
    expect([oct5.paceBusinessDays, oct12.paceBusinessDays]).toEqual([188, 188]);
    expect(oct12.currentPace).toBe(oct5.currentPace);
    expect(oct12).toMatchObject({ recordedOn: "2026-10-05", today: "2026-10-12", businessDaysElapsed: 191 });
    // The real time left shrank by the 5 business days that passed (Oct 5-9). Oct 12 is a holiday, so it adds none.
    expect([oct5.businessDaysRemaining, oct12.businessDaysRemaining]).toEqual([59, 54]);
    expect(oct12.requiredPace as number).toBeCloseTo(2158 / 54, 10);
    expect(oct12.requiredPace as number).toBeGreaterThan(oct5.requiredPace as number);
    expect(oct12.projectedFinish as number).toBeCloseTo(7842 + (7842 / 188) * 54, 8);
    expect(Math.round(oct12.projectedFinish as number)).toBe(10094);
    expect(oct12.projectedFinish as number).toBeLessThan(oct5.projectedFinish as number);
    // Not the old behaviour (counting from the recorded date).
    expect(oct12.requiredPace as number).not.toBeCloseTo(2158 / 59, 6);
  });

  it("'recorded on' is the DENVER calendar date: 9 pm Mountain on Oct 5 is still Oct 5 even though it's Oct 6 in UTC", async () => {
    at("2026-10-06T03:00:00Z"); // 21:00 MDT Oct 5
    const v = await json<View>(await record(COREY, 100));
    expect(v.latest!.recordedOn).toBe("2026-10-05");
    expect(v.daysSinceUpdate).toBe(0);
  });
});

// ===========================================================================
// 3) Lower totals, corrections, history
// ===========================================================================

describe("a total can't silently go down; corrections keep the history", () => {
  it("a lower total is refused unless it is an explicit correction — nothing is saved", async () => {
    await record(COREY, 7842);
    const cur = await json<View>(get(COREY));
    const res = await post(COREY, { total: 7000, expected_latest_id: cur.latest!.id });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("lower_than_current");
    expect(body.error).toMatch(/lower than the current total \(7842\)/);
    expect((await rows()).map((r) => r.total)).toEqual([7842]);
    expect((await json<View>(get(COREY))).latest!.total).toBe(7842);
  });

  it("a correction needs a reason", async () => {
    await record(COREY, 7842);
    const cur = await json<View>(get(COREY));
    for (const note of [undefined, "", "   "]) {
      const res = await post(COREY, { total: 7000, expected_latest_id: cur.latest!.id, is_correction: true, ...(note === undefined ? {} : { note }) });
      expect(res.status).toBe(400);
    }
    expect(await rows()).toHaveLength(1);
  });

  it("a correction lowers the current total — and the earlier value STAYS in the history", async () => {
    at("2026-10-03T16:00:00Z");
    await record(COREY, 7842); // entered by mistake (a typo)
    at(NOW);
    const cur = await json<View>(get(TONJA));
    const res = await post(TONJA, { total: 7482, expected_latest_id: cur.latest!.id, is_correction: true, note: "Typo: 7842 should have been 7482" });
    expect(res.status).toBe(201);
    const v = await json<View>(res);

    expect(v.latest!.total).toBe(7482); // the latest valid total is current
    expect(v.history.map((h) => [h.total, h.isCorrection])).toEqual([[7482, true], [7842, false]]);
    expect(v.history[0].note).toBe("Typo: 7842 should have been 7482");
    expect(v.history[0].enteredByName).toBe("Tonja");
    expect((await rows()).map((r) => r.total)).toEqual([7842, 7482]); // nothing overwritten
  });

  it("a correction can also fix a number that was too LOW", async () => {
    await record(COREY, 7482);
    const cur = await json<View>(get(COREY));
    expect((await post(COREY, { total: 7842, expected_latest_id: cur.latest!.id, is_correction: true, note: "Missed a day" })).status).toBe(201);
    expect((await json<View>(get(COREY))).latest!.total).toBe(7842);
  });

  it("history can't be edited or deleted — not even by the service role", async () => {
    await record(COREY, 100);
    await expect(db.sql(`UPDATE road_to_10000_totals SET total = 999`)).rejects.toMatchObject({ code: "23514" });
    await expect(db.sql(`UPDATE road_to_10000_totals SET entered_by_name = 'Forged'`)).rejects.toMatchObject({ code: "23514" });
    await expect(db.sql(`DELETE FROM road_to_10000_totals`)).rejects.toMatchObject({ code: "23514" });
    expect((await rows())[0]).toMatchObject({ total: 100, entered_by_name: "Corey" });
  });

  it("the newest entry is 'current' by insertion order, not by clock (a clock that goes backwards can't resurrect an old total)", async () => {
    at("2026-10-05T18:00:00Z");
    await record(COREY, 8000);
    at("2026-10-01T18:00:00Z"); // clock skew
    const cur = await json<View>(get(COREY));
    await post(COREY, { total: 8100, expected_latest_id: cur.latest!.id });
    expect((await json<View>(get(COREY))).latest!.total).toBe(8100);
  });
});

// ===========================================================================
// 4) Permissions
// ===========================================================================

describe("who can update the total", () => {
  it("Corey (admin) and Tonja (assistant) can — and so can another admin", async () => {
    for (const who of [COREY, TONJA, RYAN]) {
      expect((await record(who, 100 + (await rows()).length)).status, nameOf[who]).toBe(201);
    }
    expect((await rows()).map((r) => r.entered_by_name)).toEqual(["Corey", "Tonja", "Ryan"]);
  });

  it("an AE cannot — 403, and nothing is written", async () => {
    const res = await post(HILARY, { total: 9999, expected_latest_id: null });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/admin or the assistant/);
    expect(await rows()).toEqual([]);
  });

  it("a guest, a deactivated admin, and a signed-out caller cannot either", async () => {
    expect((await post(LEAH, { total: 1, expected_latest_id: null })).status).toBe(403);
    expect((await post(OLD_ADMIN, { total: 1, expected_latest_id: null })).status).toBe(401);
    expect((await post(null, { total: 1, expected_latest_id: null })).status).toBe(401);
    expect(await rows()).toEqual([]);
  });

  it("the database re-checks the actor itself (a caller that skipped the route)", async () => {
    const call = (actor: string) =>
      db.client.rpc("record_road_to_10000_total", { p_actor: actor, p_total: 5000, p_is_correction: false, p_note: null, p_expected_latest_id: null });
    for (const actor of [HILARY, KENNEDY, LEAH, OLD_ADMIN, "99999999-0000-4000-8000-000000000000"]) {
      expect((await call(actor)).error?.code, actor).toBe("42501");
    }
    expect(await rows()).toEqual([]);
    expect((await call(TONJA)).error).toBeNull();
  });

  it("the public (anon) key can neither read the history nor record a total", async () => {
    await record(COREY, 100);
    expect((await db.anon.from("road_to_10000_totals").select("*")).data ?? []).toEqual([]);
    expect(
      (await db.anon.rpc("record_road_to_10000_total", { p_actor: COREY, p_total: 5, p_is_correction: false, p_note: null, p_expected_latest_id: null })).error?.code,
    ).toBe("42501");
    expect((await rows()).map((r) => r.total)).toEqual([100]);
  });
});

// ===========================================================================
// 5) Two people at once
// ===========================================================================

describe("stale screens and races", () => {
  it("a save based on an out-of-date screen is refused with the current view; nothing is overwritten", async () => {
    const seen = await json<View>(get(COREY)); // Corey's screen: no total yet
    await record(TONJA, 7000); // Tonja saves first
    const res = await post(COREY, { total: 6500, expected_latest_id: seen.latest?.id ?? null });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("stale");
    expect(body.view.latest).toMatchObject({ total: 7000, enteredByName: "Tonja" });
    expect((await rows()).map((r) => r.total)).toEqual([7000]);
  });

  it("two saves from the same starting screen: exactly one wins", async () => {
    await record(COREY, 7000);
    const seen = await json<View>(get(COREY));
    const a = await post(COREY, { total: 7100, expected_latest_id: seen.latest!.id });
    const b = await post(TONJA, { total: 7200, expected_latest_id: seen.latest!.id });
    expect([a.status, b.status]).toEqual([201, 409]);
    expect((await rows()).map((r) => r.total)).toEqual([7000, 7100]);
  });

  it("a competing save landing between the route's check and the database call is still refused", async () => {
    await record(COREY, 7000);
    const seen = await json<View>(get(TONJA));
    db.beforeWrite("record_road_to_10000_total", "rpc", async () => {
      expect((await record(COREY, 7500)).status).toBe(201);
    });
    expect((await post(TONJA, { total: 7600, expected_latest_id: seen.latest!.id })).status).toBe(409);
    expect((await rows()).map((r) => r.total)).toEqual([7000, 7500]);
  });
});

// ===========================================================================
// 6) Holidays: the standard calendar + the existing company-holiday rows
// ===========================================================================

describe("holidays in the business-day count", () => {
  const addAdminDay = (date: string, reason: string, over: Row = {}) =>
    db.sql(
      `INSERT INTO working_day_adjustments (adjustment_date, applies_to_all, salesperson_id, day_value, reason) VALUES ($1, TRUE, NULL, $2, $3)`,
      [date, over.day_value ?? 1, reason],
    );

  it("with only the standard calendar: 249 business days in 2026 (elapsed + remaining, with the viewing day in both)", async () => {
    const m = (await json<View>(await record(COREY, 100))).metrics!;
    expect((m.businessDaysElapsed as number) + (m.businessDaysRemaining as number)).toBe(249 + 1); // Mon Oct 5 is in both
  });

  it("a company-wide day an admin entered in the EXISTING holiday table (e.g. Christmas Eve) is counted too", async () => {
    await addAdminDay("2026-12-24", "Christmas Eve");
    const v = await json<View>(await record(COREY, 7842));
    expect(v.metrics).toMatchObject({ businessDaysElapsed: 191, businessDaysRemaining: 58 }); // was 59
    expect(v.holidays.find((h) => h.date === "2026-12-24")).toMatchObject({ name: "Christmas Eve", source: "admin" });
  });

  it("a day that is both standard and admin-entered counts ONCE (Christmas, and the day after Thanksgiving)", async () => {
    await addAdminDay("2026-12-25", "Christmas");
    await addAdminDay("2026-11-27", "Day after Thanksgiving");
    const v = await json<View>(await record(COREY, 100));
    expect(v.metrics!.businessDaysRemaining).toBe(59); // unchanged from the standard calendar alone
    expect(v.holidays.filter((h) => h.date === "2026-12-25" || h.date === "2026-11-27")).toHaveLength(2);
  });

  it("a half-day in the existing table is half a business day; individual PTO is ignored", async () => {
    await addAdminDay("2026-12-24", "Christmas Eve (half day)", { day_value: 0.5 });
    await db.sql(
      `INSERT INTO working_day_adjustments (adjustment_date, applies_to_all, salesperson_id, day_value, reason) VALUES ('2026-10-20', FALSE, $1, 1, 'PTO')`,
      [HILARY],
    );
    const m = (await json<View>(await record(COREY, 100))).metrics!;
    expect(m.businessDaysRemaining).toBe(58.5);
  });

  it("if the admin-entered holidays can't be read, the standard calendar still applies and the view says so", async () => {
    const real = db.client;
    holder.client = {
      rpc: real.rpc.bind(real),
      from: (table: string) => {
        if (table !== "working_day_adjustments") return real.from(table);
        const chain: Record<string, unknown> = {};
        for (const m of ["select", "gte", "lte", "or", "order", "eq"]) chain[m] = () => chain;
        chain.range = async () => ({ data: null, error: { code: "XX000", message: "boom" } });
        return chain as never;
      },
    };
    const v = await json<View>(await record(COREY, 7842));
    expect(v.extraHolidaysUnavailable).toBe(true);
    expect(v.metrics).toMatchObject({ businessDaysElapsed: 191, businessDaysRemaining: 59 });
  });
});

// ===========================================================================
// 7) Not set up yet / swappable source
// ===========================================================================

describe("before the migration is applied", () => {
  const missingTable = () => {
    const real = db.client;
    return {
      rpc: async () => ({ data: null, error: { code: "42883", message: "function record_road_to_10000_total does not exist" } }),
      from: (table: string) => {
        if (table !== "road_to_10000_totals") return real.from(table);
        const chain: Record<string, unknown> = {};
        for (const m of ["select", "eq", "order", "limit"]) chain[m] = () => chain;
        chain.range = async () => ({ data: null, error: { code: "42P01", message: 'relation "road_to_10000_totals" does not exist' } });
        return chain as never;
      },
    };
  };

  it("reading answers 'not configured' (200) instead of breaking Home; writing is a clear 503", async () => {
    holder.client = missingTable();
    const v = await json<View>(get(HILARY));
    expect(v).toMatchObject({ configured: false, latest: null, metrics: null, can_update: false });
    expect((await json<View>(get(COREY))).can_update).toBe(true);
    const res = await post(COREY, { total: 100, expected_latest_id: null });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/isn't set up yet/);
  });
});

describe("the data source is swappable", () => {
  it("buildRoadView renders ANY RoadTotalSource (the Cogent total later) with no other change", async () => {
    const sample = {
      id: "c1", total: 7842, recordedAt: "2026-10-05T18:00:00Z", recordedOn: "2026-10-05",
      source: "cogent_closed_transactions" as const, isCorrection: false, note: null, enteredByName: null,
    };
    const v = await buildRoadView(
      db.client as never,
      { id: "cogent_closed_transactions", latest: async () => sample, history: async () => [sample] },
      { canUpdate: false, today: "2026-10-05" },
    );
    expect(v.source).toBe("cogent_closed_transactions");
    expect(v.latest!.total).toBe(7842);
    expect(v.metrics).toMatchObject({ businessDaysElapsed: 191, businessDaysRemaining: 59, remaining: 2158 });
    expect(v.can_update).toBe(false);
  });
});

// ===========================================================================
// 8) Nothing else moves
// ===========================================================================

describe("isolation", () => {
  it("recording totals changes no other table (orders, holidays, activity)", async () => {
    await db.sql(`INSERT INTO working_day_adjustments (adjustment_date, applies_to_all, salesperson_id, day_value, reason) VALUES ('2026-12-24', TRUE, NULL, 1, 'Christmas Eve')`);
    const snap = async () => ({
      adj: await db.sql(`SELECT * FROM working_day_adjustments ORDER BY id`),
      people: await db.sql(`SELECT id, role, deactivated_at FROM salespeople ORDER BY id`),
    });
    const before = await snap();
    await record(COREY, 100);
    await record(TONJA, 200);
    expect(await snap()).toEqual(before);
  });
});
