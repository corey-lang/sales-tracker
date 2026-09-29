/**
 * Private Test AE — direct-API privacy, ownership, duplicate links, and
 * heavy-data reporting isolation (real Postgres via PGlite, real auth).
 *
 *   * DIRECT API: what a browser holding only the public (anon) key can read
 *     or write — RLS + column grants from supabase/private_test_accounts.sql.
 *   * OWNERSHIP: another admin can't read/create/update/delete a Test AE's
 *     goals or working-day adjustments through the server routes.
 *   * DUPLICATE LINKS: a duplicate-of-contact id is validated on write and
 *     re-checked on read.
 *   * HEAVY DATA: well past the PostgREST row cap (the harness enforces the
 *     same 1000-row cap), test data must not change or truncate a single
 *     company/team number — and large REAL datasets must not truncate either.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDb, POSTGREST_MAX_ROWS, type TestDb } from "@/test/pglite-supabase";

process.env.SESSION_SECRET = "test-session-secret";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ getServerSupabase: () => holder.client }));

const { signSessionToken } = await import("@/lib/server/auth");
const { loadActiveMappings, getOrdersSummary } = await import("@/lib/server/cogent");
const { buildSingleAeActivityWeek } = await import("@/lib/server/activity-report");
const { businessCardCountsByAe } = await import("@/lib/server/coaching");
const myActivityReport = await import("@/app/api/me/activity-report/route");
const { computeStandings } = await import("@/lib/server/leaderboard-standings");

const goalsList = await import("@/app/api/admin/goals/route");
const goalById = await import("@/app/api/admin/goals/[id]/route");
const goalsMaintenance = await import("@/app/api/admin/goals/maintenance/route");
const adjustments = await import("@/app/api/admin/working-day-adjustments/route");
const adjustmentById = await import("@/app/api/admin/working-day-adjustments/[id]/route");
const availability = await import("@/app/api/admin/working-days/availability/route");
const activityMaintenance = await import("@/app/api/admin/maintenance/activity/route");
const rosterRoute = await import("@/app/api/roster/visible/route");
const markDuplicate = await import("@/app/api/business-card/mark-duplicate/route");
const verification = await import("@/app/api/business-card/verification/route");
const exportContacts = await import("@/app/api/business-card/contacts/export/route");
const leaderboard = await import("@/app/api/leaderboard/route");
const adminLeaderboard = await import("@/app/api/admin/leaderboard/route");
const scorecard = await import("@/app/api/admin/scorecard/route");
const activityReport = await import("@/app/api/admin/reports/activity/route");
const activityTotals = await import("@/app/api/admin/activity-totals/route");
const coachingList = await import("@/app/api/admin/coaching/route");

type Row = Record<string, unknown>;

const COREY = "55555555-5555-4555-8555-555555555555"; // admin, owns the Test AE
const RYAN = "66666666-6666-4666-8666-666666666666"; // another admin
const HILARY = "11111111-1111-4111-8111-111111111111"; // real AE
const KENNEDY = "22222222-2222-4222-8222-222222222222"; // real AE
const TEST_AE = "99999999-9999-4999-8999-999999999999"; // is_test, owner = Corey
const ORPHAN = "88888888-8888-4888-8888-888888888888"; // is_test, NO owner
const REAL_SCAN = "eeeeeeee-0000-4000-8000-0000000000e2";
const TEST_SCAN = "eeeeeeee-0000-4000-8000-0000000000e1";
const REAL_CONTACT = "ffffffff-0000-4000-8000-0000000000f2";
const TEST_CONTACT = "ffffffff-0000-4000-8000-0000000000f1";
const SECRET_NAME = "Zzyzx Secret Contact";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  holder.client = db.client;
}, 60_000);

const PEOPLE: Record<string, { name: string; role: string; is_test?: boolean; pin?: string }> = {
  [COREY]: { name: "Corey", role: "admin", pin: "1111" },
  [RYAN]: { name: "Ryan", role: "admin", pin: "2222" },
  [HILARY]: { name: "Hilary", role: "ae" },
  [KENNEDY]: { name: "Kennedy", role: "ae" },
  [TEST_AE]: { name: "Test AE", role: "ae", is_test: true, pin: "4242" },
  [ORPHAN]: { name: "Old Test", role: "ae", is_test: true, pin: "0000" },
};

function token(id: string) {
  const p = PEOPLE[id];
  return signSessionToken({
    sub: id,
    role: p.role as never,
    name: p.name,
    ...(p.is_test ? { tp: true as const } : {}),
  });
}
function req(who: string | null, path: string, init: { method?: string; body?: unknown } = {}) {
  return new Request(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(who ? { Authorization: `Bearer ${token(who)}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
async function json<T = Row>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

async function seed() {
  await db.reset();
  for (const [id, person] of Object.entries(PEOPLE)) {
    await db.sql(
      `INSERT INTO salespeople (id, first_name, role, is_test, admin_pin) VALUES ($1, $2, $3, $4, $5)`,
      [id, person.name, person.role, person.is_test === true, person.pin ?? null],
    );
  }
  await db.sql(`UPDATE salespeople SET test_owner_id = $1 WHERE id = $2`, [COREY, TEST_AE]);
  await db.sql(
    `INSERT INTO weekly_goals (salesperson_id, effective_from, office_visits, impressions, presentations, created_at)
     VALUES (NULL, '2026-01-05', 40, 150, 1, '2026-01-01'),
            ($1, '2026-09-28', 20, 100, 1, '2026-09-27')`,
    [TEST_AE],
  );
  await db.sql(
    `INSERT INTO activity_entries (salesperson_id, entry_date, office_visits, impressions, presentations) VALUES
       ($1, '2026-09-22', 30, 120, 1), ($1, '2026-09-28', 8, 40, 0),
       ($2, '2026-09-23', 20, 90, 1), ($2, '2026-09-29', 4, 30, 1),
       ($3, '2026-09-28', 12, 55, 1)`,
    [HILARY, KENNEDY, TEST_AE],
  );
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-29T18:00:00.000Z"));
  await seed();
});
afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------
// HIGH 1 — direct anon / PostgREST access
// ---------------------------------------------------------------------------

describe("direct anon access (public key only)", () => {
  async function seedPrivateData() {
    await db.sql(
      `INSERT INTO business_card_scans (id, salesperson_id, image_url, is_test_data) VALUES
         ($1, $2, 'x', true), ($3, $4, 'y', false)`,
      [TEST_SCAN, TEST_AE, REAL_SCAN, HILARY],
    );
    await db.sql(
      `INSERT INTO business_card_contacts (id, scan_id, salesperson_id, contact_bucket, full_name) VALUES
         ($1, $2, $3, 'agent', $4), ($5, $6, $7, 'agent', 'Real Contact')`,
      [TEST_CONTACT, TEST_SCAN, TEST_AE, SECRET_NAME, REAL_CONTACT, REAL_SCAN, HILARY],
    );
    await db.sql(
      `INSERT INTO gold_list_targets (salesperson_id, name) VALUES ($1, 'Secret Target'), ($2, 'Real Target')`,
      [TEST_AE, HILARY],
    );
    await db.sql(
      `INSERT INTO messages (salesperson_id, body) VALUES ($1, 'private to test'), ($2, 'to hilary'), (NULL, 'to all')`,
      [TEST_AE, HILARY],
    );
    await db.sql(
      `INSERT INTO team_messages (salesperson_id, salesperson_name, message) VALUES
         ($1, 'Test AE', 'test post'), ($2, 'Hilary', 'real post')`,
      [TEST_AE, HILARY],
    );
  }

  it("can't read Test AE activity, goals, scans, contacts, Gold List targets or messages — but real rows still read", async () => {
    await seedPrivateData();
    const ids = (rows: unknown) => (rows as Row[]).map((r) => r.salesperson_id);

    const activity = await db.anon.from("activity_entries").select("salesperson_id");
    expect(activity.error).toBeNull();
    expect(new Set(ids(activity.data))).toEqual(new Set([HILARY, KENNEDY]));

    const goals = await db.anon.from("weekly_goals").select("salesperson_id");
    expect(goals.error).toBeNull();
    expect(ids(goals.data)).toEqual([null]); // the global default only

    const scans = await db.anon.from("business_card_scans").select("id, salesperson_id");
    expect(scans.error).toBeNull();
    expect((scans.data as Row[]).map((r) => r.id)).toEqual([REAL_SCAN]);

    const contacts = await db.anon.from("business_card_contacts").select("id, full_name");
    expect(contacts.error).toBeNull();
    expect((contacts.data as Row[]).map((r) => r.id)).toEqual([REAL_CONTACT]);
    expect(JSON.stringify(contacts.data)).not.toContain(SECRET_NAME);

    const targets = await db.anon.from("gold_list_targets").select("name");
    expect((targets.data as Row[]).map((r) => r.name)).toEqual(["Real Target"]);

    const messages = await db.anon.from("messages").select("body").order("body");
    expect((messages.data as Row[]).map((r) => r.body)).toEqual(["to all", "to hilary"]);

    const teamMessages = await db.anon.from("team_messages").select("message");
    expect((teamMessages.data as Row[]).map((r) => r.message)).toEqual(["real post"]);
  });

  it("can't retrieve a Test AE row by guessing its id or filtering for it", async () => {
    await seedPrivateData();
    for (const [table, col, id] of [
      ["activity_entries", "salesperson_id", TEST_AE],
      ["weekly_goals", "salesperson_id", TEST_AE],
      ["business_card_scans", "id", TEST_SCAN],
      ["business_card_contacts", "id", TEST_CONTACT],
    ] as const) {
      const r = await db.anon.from(table).select("*").eq(col, id);
      expect(r.error, table).toBeNull();
      expect(r.data, table).toEqual([]);
    }
  });

  it("can't read admin_pin or test_owner_id, and can't write salespeople at all", async () => {
    const pin = await db.anon.from("salespeople").select("admin_pin");
    expect(pin.error?.code).toBe("42501");
    const owner = await db.anon.from("salespeople").select("test_owner_id");
    expect(owner.error?.code).toBe("42501");
    const star = await db.anon.from("salespeople").select("*");
    expect(star.error?.code).toBe("42501");

    // Only the accepted limitation: the roster row itself is discoverable.
    const roster = await db.anon.from("salespeople").select("id, first_name, role, is_test, deactivated_at");
    expect(roster.error).toBeNull();
    expect((roster.data as Row[]).some((r) => r.id === TEST_AE)).toBe(true);

    for (const write of [
      db.anon.from("salespeople").update({ test_owner_id: RYAN }).eq("id", TEST_AE),
      db.anon.from("salespeople").update({ is_test: false }).eq("id", TEST_AE),
      db.anon.from("salespeople").update({ role: "admin" }).eq("id", HILARY),
      db.anon.from("salespeople").insert({ first_name: "Mallory", role: "admin" }),
      db.anon.from("salespeople").delete().eq("id", HILARY),
    ]) {
      expect((await write).error?.code).toBe("42501");
    }
    expect(
      await db.sql(`SELECT test_owner_id, is_test FROM salespeople WHERE id = $1`, [TEST_AE]),
    ).toEqual([{ test_owner_id: COREY, is_test: true }]);
  });

  it("can't write Test AE rows; real activity writes still work", async () => {
    const asTest = await db.anon
      .from("activity_entries")
      .insert({ salesperson_id: TEST_AE, entry_date: "2026-09-21", office_visits: 999 });
    expect(asTest.error?.code).toBe("42501");
    const takeover = await db.anon
      .from("activity_entries")
      .update({ office_visits: 0 })
      .eq("salesperson_id", TEST_AE)
      .select("id");
    expect(takeover.data).toEqual([]); // invisible → nothing to update
    expect(
      await db.sql(`SELECT office_visits FROM activity_entries WHERE salesperson_id = $1`, [TEST_AE]),
    ).toEqual([{ office_visits: 12 }]);

    const real = await db.anon
      .from("activity_entries")
      .insert({ salesperson_id: HILARY, entry_date: "2026-09-21", office_visits: 3 });
    expect(real.error).toBeNull();

    const rpc = await db.anon.rpc("replace_activity_week", {
      p_salesperson_id: HILARY,
      p_week_start: "2026-09-27",
      p_week_end: "2026-10-03",
      p_values: {},
    });
    expect(rpc.error?.code).toBe("42501"); // server-only now
  });
});

// ---------------------------------------------------------------------------
// HIGH 2 — goals + working-day APIs enforce ownership
// ---------------------------------------------------------------------------

describe("goals and working-day adjustments: ownership on the server", () => {
  const values = {
    office_visits: 1, service_requests: 0, ones_scheduled: 0, ones_held: 0,
    presentations: 0, impressions: 0, team_meetings: 0, gold_list_touches: 0,
  };
  const goalFor = async (id: string) =>
    (await db.sql(`SELECT id FROM weekly_goals WHERE salesperson_id = $1`, [id])) as Array<{ id: string }>;

  it("GET /api/admin/goals: the owner sees Test AE's goals; another admin never receives them", async () => {
    const mine = await json<{ goals: Row[] }>(goalsList.GET(req(COREY, "/x")));
    const theirs = await json<{ goals: Row[] }>(goalsList.GET(req(RYAN, "/x")));
    expect(mine.goals.map((g) => g.salesperson_id).sort()).toEqual([null, TEST_AE].sort());
    expect(theirs.goals.map((g) => g.salesperson_id)).toEqual([null]);
    expect(JSON.stringify(theirs)).not.toContain(TEST_AE);
    expect((await goalsList.GET(req(RYAN, `/x?salesperson_id=${TEST_AE}`))).status).toBe(404);
    expect((await goalsList.GET(req(COREY, `/x?salesperson_id=${TEST_AE}`))).status).toBe(200);
    // Real AEs: unchanged.
    expect((await goalsList.GET(req(RYAN, `/x?salesperson_id=${HILARY}`))).status).toBe(200);
  });

  it("POST /api/admin/goals: another admin can't create or overwrite a Test AE goal; real AEs unchanged", async () => {
    const body = (id: string | null, from: string) => ({ salesperson_id: id, effective_from: from, ...values });
    const before = await db.sql(`SELECT * FROM weekly_goals ORDER BY id`);

    expect((await goalsList.POST(req(RYAN, "/x", { method: "POST", body: body(TEST_AE, "2026-09-28") }))).status).toBe(404);
    expect((await goalsList.POST(req(RYAN, "/x", { method: "POST", body: body(TEST_AE, "2026-10-05") }))).status).toBe(404);
    expect((await goalsList.POST(req(RYAN, "/x", { method: "POST", body: body(ORPHAN, "2026-10-05") }))).status).toBe(404);
    expect(await db.sql(`SELECT * FROM weekly_goals ORDER BY id`)).toEqual(before);

    expect((await goalsList.POST(req(COREY, "/x", { method: "POST", body: body(TEST_AE, "2026-10-05") }))).status).toBe(200);
    expect((await goalsList.POST(req(RYAN, "/x", { method: "POST", body: body(HILARY, "2026-10-05") }))).status).toBe(200);
    expect((await goalsList.POST(req(RYAN, "/x", { method: "POST", body: body(null, "2026-10-05") }))).status).toBe(200);
  });

  it("DELETE /api/admin/goals/[id] is ownership-checked (404 for another admin, row survives)", async () => {
    const [{ id }] = await goalFor(TEST_AE);
    expect((await goalById.DELETE(req(RYAN, "/x", { method: "DELETE" }), p({ id }))).status).toBe(404);
    expect(await goalFor(TEST_AE)).toHaveLength(1);
    // A missing id answers identically.
    expect((await goalById.DELETE(req(RYAN, "/x", { method: "DELETE" }), p({ id: "00000000-0000-4000-8000-000000000000" }))).status).toBe(404);
    expect((await goalById.DELETE(req(COREY, "/x", { method: "DELETE" }), p({ id }))).status).toBe(200);
    expect(await goalFor(TEST_AE)).toHaveLength(0);
  });

  it("goal maintenance never touches (or counts) goals another admin can't see", async () => {
    await db.sql(
      `INSERT INTO weekly_goals (salesperson_id, effective_from, office_visits, presentations, created_at)
       VALUES ($1, '2026-09-01', 5, 1, '2026-08-30'), ($2, '2026-09-01', 5, 1, '2026-08-30')`,
      [TEST_AE, HILARY],
    );
    const post = (who: string, action: string) =>
      json<{ deleted: number }>(goalsMaintenance.POST(req(who, "/x", { method: "POST", body: { action } })));

    // Ryan's "clear old versions": Test AE's older row must survive.
    expect((await post(RYAN, "clear_old_versions")).deleted).toBe(0);
    expect(await goalFor(TEST_AE)).toHaveLength(2);
    // Ryan's "clear all": removes only what he can see.
    const cleared = await post(RYAN, "clear_all");
    expect(cleared.deleted).toBe(2); // the global default + Hilary's row
    expect(await goalFor(TEST_AE)).toHaveLength(2);
    // The owner's clear-all includes their own test account.
    expect((await post(COREY, "clear_all")).deleted).toBe(2);
    expect(await goalFor(TEST_AE)).toHaveLength(0);
  });

  it("working-day adjustments: list/create/delete are ownership-checked; company holidays and real AEs unchanged", async () => {
    const adj = (salesperson: string | null, date: string, all = false) =>
      db.sql(
        `INSERT INTO working_day_adjustments (adjustment_date, salesperson_id, applies_to_all, reason)
         VALUES ($1, $2, $3, 'r') RETURNING id`,
        [date, salesperson, all],
      );
    const [{ id: testAdj }] = (await adj(TEST_AE, "2026-09-30")) as Array<{ id: string }>;
    const [{ id: realAdj }] = (await adj(HILARY, "2026-10-01")) as Array<{ id: string }>;
    await adj(null, "2026-10-02", true);

    const list = (who: string) =>
      json<{ adjustments: Row[] }>(adjustments.GET(req(who, "/x"))).then((b) => b.adjustments);
    const theirs = await list(RYAN);
    expect(theirs.map((a) => a.id)).not.toContain(testAdj);
    expect(theirs.map((a) => a.id)).toContain(realAdj);
    expect(theirs).toHaveLength(2);
    expect(JSON.stringify(theirs)).not.toContain(TEST_AE);
    const mine = await list(COREY);
    expect(mine).toHaveLength(3);
    expect(mine.find((a) => a.id === testAdj)).toMatchObject({ salesperson_name: "Test AE" });

    const create = (who: string, sp: string) =>
      adjustments.POST(req(who, "/x", { method: "POST", body: { salesperson_id: sp, adjustment_date: "2026-10-06", reason: "PTO" } }));
    expect((await create(RYAN, TEST_AE)).status).toBe(404);
    expect((await create(RYAN, ORPHAN)).status).toBe(404);
    expect((await create(COREY, TEST_AE)).status).toBe(200);
    expect((await create(RYAN, HILARY)).status).toBe(200);
    expect(await db.sql(`SELECT 1 FROM working_day_adjustments WHERE salesperson_id = $1`, [TEST_AE])).toHaveLength(2);

    expect((await adjustmentById.DELETE(req(RYAN, "/x", { method: "DELETE" }), p({ id: testAdj }))).status).toBe(404);
    expect(await db.sql(`SELECT 1 FROM working_day_adjustments WHERE id = $1`, [testAdj])).toHaveLength(1);
    expect((await adjustmentById.DELETE(req(COREY, "/x", { method: "DELETE" }), p({ id: testAdj }))).status).toBe(200);
    expect((await adjustmentById.DELETE(req(RYAN, "/x", { method: "DELETE" }), p({ id: realAdj }))).status).toBe(200);
  });

  it("a Test AE PTO row never changes any real AE's available days", async () => {
    const week = "2026-09-28";
    const days = async () =>
      json<{ availableDays: Record<string, number>; isHolidayWeek: boolean }>(
        availability.GET(req(COREY, `/x?weekStart=${week}`)),
      );
    const before = await days();
    expect(Object.keys(before.availableDays).sort()).toEqual([HILARY, KENNEDY].sort());
    await db.sql(
      `INSERT INTO working_day_adjustments (adjustment_date, salesperson_id, applies_to_all, reason)
       SELECT ('2026-09-28'::date + (i % 5)), $1, false, 'r' FROM generate_series(0, 4) i`,
      [TEST_AE],
    );
    expect(await days()).toEqual(before);
  });

  it("activity maintenance is scoped to what the admin owns", async () => {
    await db.sql(`INSERT INTO activity_entries (salesperson_id, entry_date, office_visits) VALUES ($1, '2026-09-21', 9)`, [ORPHAN]);
    const run = (who: string, action: string) =>
      json<{ deleted: number; accounts?: number }>(activityMaintenance.POST(req(who, "/x", { method: "POST", body: { action } })));
    const count = async (id: string) =>
      (await db.sql(`SELECT 1 FROM activity_entries WHERE salesperson_id = $1`, [id])).length;

    expect(await run(RYAN, "clear_test")).toEqual({ deleted: 0, accounts: 0 });
    expect((await run(RYAN, "clear_all")).deleted).toBe(4); // real people only
    expect(await count(TEST_AE)).toBe(1);
    expect(await count(ORPHAN)).toBe(1);
    expect(await run(COREY, "clear_test")).toEqual({ deleted: 1, accounts: 1 });
    expect(await count(TEST_AE)).toBe(0);
    expect(await count(ORPHAN)).toBe(1); // unowned test account: nobody's to delete
  });

  it("the visible-roster API hides other admins' test accounts and never returns ownership", async () => {
    const list = async (who: string) =>
      json<{ people: Row[] }>(rosterRoute.GET(req(who, "/x"))).then((b) => b.people);
    const mine = await list(COREY);
    const theirs = await list(RYAN);
    expect(mine.map((x) => x.id)).toContain(TEST_AE);
    expect(theirs.map((x) => x.id)).not.toContain(TEST_AE);
    expect([...mine, ...theirs].some((x) => x.id === ORPHAN)).toBe(false);
    expect(JSON.stringify([mine, theirs])).not.toMatch(/test_owner_id|admin_pin/);
    expect((await rosterRoute.GET(req(null, "/x"))).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// HIGH 3 — business-card duplicate links
// ---------------------------------------------------------------------------

describe("business-card duplicate links", () => {
  beforeEach(async () => {
    await db.sql(
      `INSERT INTO business_card_scans (id, salesperson_id, salesperson_name, image_url, is_test_data, extracted_full_name)
       VALUES ($1, $2, 'Test AE', 'x', true, 'Stale'), ($3, $4, 'Hilary', 'y', false, 'Real Person')`,
      [TEST_SCAN, TEST_AE, REAL_SCAN, HILARY],
    );
    await db.sql(
      `INSERT INTO business_card_contacts (id, scan_id, salesperson_id, contact_bucket, full_name, verification_status) VALUES
         ($1, $2, $3, 'agent', $4, 'approved'), ($5, $6, $7, 'agent', 'Real Original', 'approved')`,
      [TEST_CONTACT, TEST_SCAN, TEST_AE, SECRET_NAME, REAL_CONTACT, REAL_SCAN, HILARY],
    );
  });
  const mark = (who: string, scanId: string, dup?: string) =>
    markDuplicate.POST(req(who, "/x", { method: "POST", body: { scanId, ...(dup ? { duplicateOfContactId: dup } : {}) } }));
  const link = async (scanId: string) =>
    ((await db.sql(`SELECT duplicate_of_contact_id AS d FROM business_card_scans WHERE id = $1`, [scanId])) as Array<{ d: string | null }>)[0].d;

  it("real scan → real contact is allowed", async () => {
    expect((await mark(RYAN, REAL_SCAN, REAL_CONTACT)).status).toBe(200);
    expect(await link(REAL_SCAN)).toBe(REAL_CONTACT);
  });

  it("the owner's test scan → the owner's test contact is allowed", async () => {
    expect((await mark(COREY, TEST_SCAN, TEST_CONTACT)).status).toBe(200);
    expect(await link(TEST_SCAN)).toBe(TEST_CONTACT);
  });

  it("another reviewer can't link to (or act on) Corey's test contact — a supplied UUID doesn't bypass the rule", async () => {
    // On the reviewer's own visible (real) scan, pointing at the test contact:
    const viaRealScan = await mark(RYAN, REAL_SCAN, TEST_CONTACT);
    expect(viaRealScan.status).toBe(404);
    expect(JSON.stringify(await viaRealScan.json())).not.toContain(SECRET_NAME);
    expect(await link(REAL_SCAN)).toBeNull();
    // On the test scan itself:
    expect((await mark(RYAN, TEST_SCAN, TEST_CONTACT)).status).toBe(404);
    expect(await link(TEST_SCAN)).toBeNull();
    // Malformed / unknown ids can't sneak through either.
    expect((await mark(RYAN, REAL_SCAN, "not-a-uuid")).status).toBe(400);
    expect((await mark(RYAN, REAL_SCAN, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("even the owner can't cross the test/real line (real scan ↔ test contact)", async () => {
    expect((await mark(COREY, REAL_SCAN, TEST_CONTACT)).status).toBe(404);
    expect((await mark(COREY, TEST_SCAN, REAL_CONTACT)).status).toBe(404);
    expect(await link(REAL_SCAN)).toBeNull();
    expect(await link(TEST_SCAN)).toBeNull();
  });

  it("a pre-existing malicious or stale link never leaks on read", async () => {
    // Written behind the API's back (old data, direct SQL, a bug).
    await db.sql(`UPDATE business_card_scans SET duplicate_of_contact_id = $1 WHERE id = $2`, [TEST_CONTACT, REAL_SCAN]);
    await db.sql(`UPDATE business_card_scans SET duplicate_of_contact_id = $1 WHERE id = $2`, [REAL_CONTACT, TEST_SCAN]);
    for (const who of [RYAN, COREY]) {
      const res = await verification.GET(req(who, "/x"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { scans: Row[]; duplicateContacts: Row[] };
      expect(JSON.stringify(body)).not.toContain(SECRET_NAME);
      const real = body.scans.find((s) => s.id === REAL_SCAN)!;
      expect(real.duplicate_of_contact_id).toBeNull();
      expect(body.duplicateContacts.some((c) => c.id === TEST_CONTACT)).toBe(false);
      if (who === COREY) {
        // The owner sees their test scan, but its cross-side link is dropped too.
        expect(body.scans.find((s) => s.id === TEST_SCAN)!.duplicate_of_contact_id).toBeNull();
      } else {
        expect(body.scans.some((s) => s.id === TEST_SCAN)).toBe(false);
      }
    }
  });

  it("a legitimate link is still returned (real for anyone, test only for its owner)", async () => {
    await db.sql(`UPDATE business_card_scans SET duplicate_of_contact_id = $1 WHERE id = $2`, [REAL_CONTACT, REAL_SCAN]);
    await db.sql(`UPDATE business_card_scans SET duplicate_of_contact_id = $1 WHERE id = $2`, [TEST_CONTACT, TEST_SCAN]);
    const ryan = (await json<{ duplicateContacts: Row[] }>(verification.GET(req(RYAN, "/x")))).duplicateContacts;
    expect(ryan.map((c) => c.id)).toEqual([REAL_CONTACT]);
    const corey = (await json<{ duplicateContacts: Row[] }>(verification.GET(req(COREY, "/x")))).duplicateContacts;
    expect(corey.map((c) => c.id).sort()).toEqual([REAL_CONTACT, TEST_CONTACT].sort());
  });
});

// ---------------------------------------------------------------------------
// HIGH 4 / MEDIUM 2 — reporting is immune to (and complete despite) big data
// ---------------------------------------------------------------------------

describe("reporting under load (PostgREST cap = 1000 rows)", () => {
  const WEEK = "2026-09-27";
  const N = POSTGREST_MAX_ROWS + 200;

  /** Substantial test-account data in EVERY reporting source, > the row cap. */
  async function addHeavyTestData() {
    // Activity: N days each for the owned and the orphaned test account.
    await db.sql(
      `INSERT INTO activity_entries (salesperson_id, entry_date, office_visits, service_requests, ones_scheduled, ones_held, presentations, impressions, team_meetings, gold_list_touches)
       SELECT a, '2022-01-01'::date + i, 200, 50, 40, 40, 9, 900, 3, 25
         FROM generate_series(0, ${N - 1}) i, unnest(ARRAY[$1::uuid, $2::uuid]) a
       ON CONFLICT (salesperson_id, entry_date) DO NOTHING`,
      [TEST_AE, ORPHAN],
    );
    // Also inside the reporting weeks under test.
    await db.sql(
      `INSERT INTO activity_entries (salesperson_id, entry_date, office_visits, impressions, presentations, ones_held, gold_list_touches) VALUES
         ($1, '2026-09-21', 200, 900, 9, 9, 40), ($1, '2026-09-24', 150, 700, 5, 5, 40),
         ($1, '2026-09-29', 6, 30, 1, 0, 5), ($2, '2026-09-29', 500, 500, 50, 50, 50)
       ON CONFLICT (salesperson_id, entry_date) DO UPDATE SET office_visits = EXCLUDED.office_visits`,
      [TEST_AE, ORPHAN],
    );
    // Goals: > cap of dated per-account rows (one per day).
    await db.sql(
      `INSERT INTO weekly_goals (salesperson_id, effective_from, office_visits, impressions, presentations, created_at)
       SELECT $1, '2019-01-01'::date + i, 999, 9999, 99, NOW() FROM generate_series(0, ${N - 1}) i`,
      [TEST_AE],
    );
    // Office visits (both environments — worst case for the scorecard).
    await db.sql(
      `INSERT INTO offices (id, salesperson_id, name, dedupe_key, environment) VALUES
         ('bbbbbbbb-0000-4000-8000-000000000001', $1, 'T prod', 'k1', 'production'),
         ('bbbbbbbb-0000-4000-8000-000000000002', $1, 'T test', 'k2', 'test')`,
      [TEST_AE],
    );
    await db.sql(
      `INSERT INTO office_visits (office_id, salesperson_id, visited_at, environment)
       SELECT o.id, $1, '2026-09-29T15:00:00Z'::timestamptz - (i || ' minutes')::interval, o.environment
         FROM generate_series(0, ${N - 1}) i, offices o WHERE o.salesperson_id = $1`,
      [TEST_AE],
    );
    // Business-card scans and contacts (test-stamped).
    await db.sql(
      `INSERT INTO business_card_scans (salesperson_id, salesperson_name, image_url, is_test_data, created_at)
       SELECT $1, 'Test AE', 'x', true, '2026-09-29T15:00:00Z'::timestamptz - (i || ' minutes')::interval
         FROM generate_series(0, ${N - 1}) i`,
      [TEST_AE],
    );
    await db.sql(
      `INSERT INTO business_card_contacts (salesperson_id, salesperson_name, contact_bucket, full_name, verification_status, approved_at)
       SELECT $1, 'Test AE', 'agent', 'T ' || i, 'approved', '2026-09-29T15:00:00Z'::timestamptz - (i || ' minutes')::interval
         FROM generate_series(0, ${N - 1}) i`,
      [TEST_AE],
    );
    // Gold List targets, Cogent mappings.
    await db.sql(
      `INSERT INTO gold_list_targets (salesperson_id, name) SELECT $1, 'T' || i FROM generate_series(0, ${N - 1}) i`,
      [TEST_AE],
    );
    await db.sql(
      `INSERT INTO cogent_territory_mappings (sales_territory_name, salesperson_id, active)
       SELECT 'TESTLAND ' || i, $1, true FROM generate_series(0, ${N - 1}) i`,
      [TEST_AE],
    );
    // The fixture must really exceed the cap.
    const [{ n }] = (await db.sql(`SELECT count(*)::int AS n FROM activity_entries WHERE salesperson_id = $1`, [TEST_AE])) as Array<{ n: number }>;
    expect(n).toBeGreaterThan(POSTGREST_MAX_ROWS);
  }

  /** Real data every report must contain (so equality is never vacuous). */
  async function addRealFootprint() {
    await db.sql(
      `INSERT INTO cogent_territory_mappings (sales_territory_name, salesperson_id, active) VALUES ('DENVER', $1, true), ('BOULDER', $2, true)`,
      [HILARY, KENNEDY],
    );
    await db.sql(`INSERT INTO offices (id, salesperson_id, name, dedupe_key, environment) VALUES ('bbbbbbbb-0000-4000-8000-0000000000a1', $1, 'Real Office', 'r1', 'production')`, [HILARY]);
    await db.sql(
      `INSERT INTO office_visits (office_id, salesperson_id, visited_at, environment) VALUES
         ('bbbbbbbb-0000-4000-8000-0000000000a1', $1, '2026-09-29T15:00:00Z', 'production'),
         ('bbbbbbbb-0000-4000-8000-0000000000a1', $1, '2026-09-29T14:00:00Z', 'production')`,
      [HILARY],
    );
    await db.sql(
      `INSERT INTO business_card_scans (salesperson_id, salesperson_name, image_url, is_test_data, created_at) VALUES
         ($1, 'Hilary', 'x', false, '2026-09-29T15:00:00Z'), ($1, 'Hilary', 'x', false, '2026-09-29T14:00:00Z'), ($1, 'Hilary', 'x', false, '2026-09-29T13:00:00Z')`,
      [HILARY],
    );
    await db.sql(
      `INSERT INTO business_card_contacts (salesperson_id, salesperson_name, contact_bucket, full_name, verification_status, approved_at) VALUES
         ($1, 'Hilary', 'agent', 'Real 1', 'approved', '2026-09-29T15:00:00Z')`,
      [HILARY],
    );
  }

  const strip = (v: unknown) =>
    JSON.parse(JSON.stringify(v).replace(/"(computed_at|generatedAt|generated_at|last_active_at)":("[^"]*"|null)/g, '"$1":""'));
  const ok = async (name: string, res: Response | Promise<Response>) => {
    const r = await res;
    const body = await r.json();
    expect(r.status, `${name}: ${JSON.stringify(body).slice(0, 200)}`).toBe(200);
    const text = JSON.stringify(body);
    expect(text, name).toContain(HILARY);
    expect(text, name).toContain(KENNEDY);
    return body;
  };
  const reports = async (who: string) => ({
    leaderboard: await ok("leaderboard", leaderboard.GET(req(who, "/api/leaderboard"))),
    adminLeaderboard: await ok("adminLeaderboard", adminLeaderboard.GET(req(who, `/x?weekStart=${WEEK}`))),
    scorecard: await ok("scorecard", scorecard.GET(req(who, `/x?weekStart=${WEEK}`))),
    activityReport: await ok("activityReport", activityReport.GET(req(who, `/x?weekStart=${WEEK}`))),
    totalsWeek: await ok("totalsWeek", activityTotals.GET(req(who, `/x?from=2026-09-20&to=2026-10-03&salesperson=all`))),
    // A custom range spanning years — exactly where a capped read would truncate.
    totalsLong: await ok("totalsLong", activityTotals.GET(req(who, `/x?from=2022-01-01&to=2026-10-03&salesperson=all`))),
    coaching: (await json<{ summaries: Row[] }>(coachingList.GET(req(RYAN, "/api/admin/coaching")))).summaries,
    standings: (await computeStandings(db.client as never, "2026-09-28", "2026-09-29", "2026-09-28", "2026-09-29")).standings,
    mappings: (await loadActiveMappings()).map((m) => [m.sales_territory_name, m.salesperson_id]).sort(),
  });

  it("thousands of Test AE rows in every source change no company/team number (before == after, owner and non-owner)", async () => {
    await addRealFootprint();
    const beforeOwner = await reports(COREY);
    const beforeOther = await reports(RYAN);

    // Sanity: the baseline is real, populated data.
    const hilary = (beforeOwner.scorecard.rows as Row[]).find((r) => r.id === HILARY)!;
    expect(hilary).toMatchObject({ manual_visits: 8, crm_visits: 2, cards_scanned: 3, cards_approved: 1 });
    expect(beforeOwner.mappings).toEqual([["BOULDER", KENNEDY], ["DENVER", HILARY]]);

    await addHeavyTestData();
    const afterOwner = await reports(COREY);
    const afterOther = await reports(RYAN);

    expect(strip(afterOwner)).toEqual(strip(beforeOwner));
    expect(strip(afterOther)).toEqual(strip(beforeOther));
    const blob = JSON.stringify([afterOwner, afterOther]);
    for (const id of [TEST_AE, ORPHAN]) expect(blob).not.toContain(id);
    expect(blob).not.toContain("Test AE");
    expect(blob).not.toContain("TESTLAND");
  });

  it("Test AE's data never enters a real CSV export", async () => {
    await addRealFootprint();
    await addHeavyTestData();
    const res = await exportContacts.GET(req(RYAN, "/x?includeExported=true"));
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).toContain("Real 1");
    expect(csv).not.toMatch(/T \d+/);
    expect(csv.trim().split("\n")).toHaveLength(2); // header + the one real contact
  });

  it("large REAL datasets aren't truncated either (custom Activity Totals range, goals, exports)", async () => {
    // 1300 daily entries for Hilary, 1100 for Kennedy — more than one page each.
    await db.sql(
      `INSERT INTO activity_entries (salesperson_id, entry_date, office_visits, impressions, presentations)
       SELECT $1, '2021-01-01'::date + i, 2, 3, 1 FROM generate_series(0, 1299) i
       ON CONFLICT (salesperson_id, entry_date) DO NOTHING`,
      [HILARY],
    );
    await db.sql(
      `INSERT INTO activity_entries (salesperson_id, entry_date, office_visits, impressions, presentations)
       SELECT $1, '2021-01-01'::date + i, 1, 1, 0 FROM generate_series(0, 1099) i
       ON CONFLICT (salesperson_id, entry_date) DO NOTHING`,
      [KENNEDY],
    );
    // A long per-AE goal history for Hilary: the newest row must still win.
    await db.sql(
      `INSERT INTO weekly_goals (salesperson_id, effective_from, office_visits, impressions, presentations, created_at)
       SELECT $1, '2020-01-01'::date + i, 1, 1, 1, '2020-01-01' FROM generate_series(0, 1199) i`,
      [HILARY],
    );
    await db.sql(
      `INSERT INTO weekly_goals (salesperson_id, effective_from, office_visits, impressions, presentations, created_at)
       VALUES ($1, '2026-09-21', 77, 777, 7, '2026-09-20')`,
      [HILARY],
    );
    const expected = async (id: string, key: string) =>
      Number(((await db.sql(`SELECT COALESCE(SUM(${key}), 0)::int AS s FROM activity_entries WHERE salesperson_id = $1 AND entry_date BETWEEN '2021-01-01' AND '2026-10-03'`, [id])) as Array<{ s: number }>)[0].s);
    expect(await expected(HILARY, "office_visits")).toBeGreaterThan(POSTGREST_MAX_ROWS);

    const body = await json<{ rows: Array<{ id: string; actual?: Row; cells?: Row }> }>(
      activityTotals.GET(req(COREY, `/x?from=2021-01-01&to=2026-10-03&salesperson=all`)),
    );
    const row = (id: string) => body.rows.find((r) => r.id === id) as unknown as { actuals: Record<string, number> };
    expect(row(HILARY).actuals.office_visits).toBe(await expected(HILARY, "office_visits"));
    expect(row(KENNEDY).actuals.office_visits).toBe(await expected(KENNEDY, "office_visits"));
    expect(row(HILARY).actuals.impressions).toBe(await expected(HILARY, "impressions"));

    // The newest of 1200+ goal rows is the one in force.
    const standings = (await computeStandings(db.client as never, "2026-09-28", "2026-09-29", "2026-09-28", "2026-09-29")).standings;
    expect(standings.find((s) => s.id === HILARY)).toBeDefined();
    const goals = await json<{ goals: Row[] }>(goalsList.GET(req(COREY, `/x?salesperson_id=${HILARY}`)));
    expect(goals.goals.length).toBeGreaterThan(POSTGREST_MAX_ROWS);
  });
});

// ---------------------------------------------------------------------------
// MEDIUM 1 — provisioning safety
// ---------------------------------------------------------------------------

describe("provision_test_ae.template.sql", () => {
  const template = readFileSync(join(process.cwd(), "supabase/provision_test_ae.template.sql"), "utf8");
  const fill = (test: string, owner: string, pin: string) =>
    template
      .replace("<TEST_AE_UUID>", test)
      .replace("<OWNER_ADMIN_UUID>", owner)
      .replace("<CHOOSE_A_PIN>", pin);
  const state = async () =>
    db.sql(`SELECT id, test_owner_id, admin_pin FROM salespeople ORDER BY id`);

  beforeEach(async () => {
    // Un-provisioned: the test row exists (is_test) but has no owner/PIN yet.
    await db.sql(`UPDATE salespeople SET test_owner_id = NULL, admin_pin = NULL WHERE id = $1`, [TEST_AE]);
  });

  it("can't run with its placeholders — and changes nothing", async () => {
    const before = await state();
    await expect(db.asOwner(template)).rejects.toThrow();
    expect(await state()).toEqual(before);
    // No real-looking value ships in the file: no UUID literals, no digit PIN.
    expect(template).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(template).not.toMatch(/v_pin\s+text\s*:=\s*'[0-9]/);
  });

  it("provisions exactly the intended row: owner set, PIN set, everything verified", async () => {
    await db.asOwner(fill(TEST_AE, COREY, "482913"));
    expect(
      await db.sql(`SELECT test_owner_id, admin_pin, is_test, role FROM salespeople WHERE id = $1`, [TEST_AE]),
    ).toEqual([{ test_owner_id: COREY, admin_pin: "482913", is_test: true, role: "ae" }]);
    // Nobody else was touched.
    expect(await db.sql(`SELECT id FROM salespeople WHERE test_owner_id IS NOT NULL`)).toEqual([{ id: TEST_AE }]);
    expect(await db.sql(`SELECT admin_pin FROM salespeople WHERE id = $1`, [COREY])).toEqual([{ admin_pin: "1111" }]);
    // Re-running is a clean no-op re-assertion.
    await db.asOwner(fill(TEST_AE, COREY, "482913"));
  });

  it.each([
    ["a real (non-test) person as the 'test' account", () => fill(HILARY, COREY, "482913"), /not flagged is_test/],
    ["an unknown test id", () => fill("00000000-0000-4000-8000-00000000dead", COREY, "482913"), /exactly 1 salespeople row/],
    ["an unknown owner id", () => fill(TEST_AE, "00000000-0000-4000-8000-00000000dead", "482913"), /exactly 1 salespeople row/],
    ["a non-admin owner", () => fill(TEST_AE, HILARY, "482913"), /must have role = 'admin'/],
    ["a test account as owner", () => fill(TEST_AE, ORPHAN, "482913"), /owner must have role|must not be a test/],
    ["the account as its own owner", () => fill(TEST_AE, TEST_AE, "482913"), /must be different rows/],
    ["a too-short PIN", () => fill(TEST_AE, COREY, "12"), /4-12 digits/],
    ["a non-numeric PIN", () => fill(TEST_AE, COREY, "abcd"), /4-12 digits/],
  ])("stops on %s, changing nothing", async (_name, sql, message) => {
    const before = await state();
    await expect(db.asOwner(sql())).rejects.toThrow(message);
    expect(await state()).toEqual(before);
  });

  it("stops when the account already belongs to a different owner or is deactivated", async () => {
    await db.sql(`UPDATE salespeople SET test_owner_id = $1 WHERE id = $2`, [RYAN, TEST_AE]);
    await expect(db.asOwner(fill(TEST_AE, COREY, "482913"))).rejects.toThrow(/DIFFERENT owner/);
    expect(await db.sql(`SELECT test_owner_id FROM salespeople WHERE id = $1`, [TEST_AE])).toEqual([{ test_owner_id: RYAN }]);

    await db.sql(`UPDATE salespeople SET test_owner_id = NULL, deactivated_at = NOW() WHERE id = $1`, [TEST_AE]);
    await expect(db.asOwner(fill(TEST_AE, COREY, "482913"))).rejects.toThrow(/deactivated/);
    await db.sql(`UPDATE salespeople SET deactivated_at = NULL WHERE id = $1`, [TEST_AE]);
    await db.sql(`UPDATE salespeople SET deactivated_at = NOW() WHERE id = $1`, [COREY]);
    await expect(db.asOwner(fill(TEST_AE, COREY, "482913"))).rejects.toThrow(/owner is deactivated/);
  });
});

// ---------------------------------------------------------------------------
// Static guards — the public key must never be the security boundary
// ---------------------------------------------------------------------------

describe("static guards", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
    });
  }
  const browserFiles = sourceFiles(join(process.cwd(), "src")).filter((f) =>
    readFileSync(f, "utf8").includes('@/lib/supabase/client'),
  );

  it("browser code that holds the anon client never touches ownership or PINs", () => {
    expect(browserFiles.length).toBeGreaterThan(0);
    for (const file of browserFiles) {
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      expect(code, file).not.toMatch(/test_owner_id\s*[,"')]/); // no select / filter on it
      expect(code, file).not.toContain("admin_pin");
    }
  });

  it("the migration ships no personal values: no UUID literal, no PIN literal", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/private_test_accounts.sql"), "utf8");
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(code).not.toMatch(/admin_pin\s*=/i);
  });

  it("no admin card reads goals, activity or ownership straight from the browser", () => {
    for (const rel of ["src/components/admin/goals-card.tsx", "src/components/admin/maintenance-card.tsx", "src/lib/use-visible-roster.ts"]) {
      const code = readFileSync(join(process.cwd(), rel), "utf8");
      expect(code, rel).not.toContain("supabase/client");
      expect(code, rel).not.toMatch(/\.from\("(weekly_goals|activity_entries|salespeople)"\)/);
    }
  });
});

// ---------------------------------------------------------------------------
// Personal reporting is complete past the row cap; the Home tile has a score
// ---------------------------------------------------------------------------

describe("personal Activity report is complete past the API row cap", () => {
  const report = async (who: string, from: string, to: string) => {
    const res = await myActivityReport.GET(req(who, `/x?from=${from}&to=${to}`));
    expect(res.status).toBe(200);
    return (await res.json()) as {
      totalActual: number;
      activities: Array<{ key: string; actual: number }>;
    };
  };
  const actual = (r: Awaited<ReturnType<typeof report>>, key: string) =>
    r.activities.find((a) => a.key === key)!.actual;

  it("Test AE with 1,300 daily rows sees the exact personal total", async () => {
    // 1,300 rows × (2 visits, 3 impressions); plus the seeded row on 2026-09-28 (12 / 55).
    await db.sql(
      `INSERT INTO activity_entries (salesperson_id, entry_date, office_visits, impressions)
       SELECT $1, '2021-01-01'::date + i, 2, 3 FROM generate_series(0, 1299) i`,
      [TEST_AE],
    );
    const r = await report(TEST_AE, "2021-01-01", "2026-10-03");
    expect(actual(r, "office_visits")).toBe(1300 * 2 + 12);
    expect(actual(r, "impressions")).toBe(1300 * 3 + 55);
    // Every activity, not just the two seeded: the total is the exact sum.
    expect(r.totalActual).toBe(1300 * 5 + 12 + 55 + 1); // + presentations (1) on the seeded row
  });

  it("DIRECT endpoint test: signed in as Test AE, >1,000 personal rows in range, exact totals, no truncation at the PostgREST cap", async () => {
    const ROWS = POSTGREST_MAX_ROWS + 337;
    await db.sql(
      `INSERT INTO activity_entries (salesperson_id, entry_date, office_visits, service_requests, ones_scheduled, ones_held, presentations, impressions, team_meetings, gold_list_touches)
       SELECT $1, '2020-01-01'::date + i, 1, 2, 3, 4, 5, 6, 7, 8 FROM generate_series(0, ${ROWS - 1}) i`,
      [TEST_AE],
    );
    const from = "2020-01-01";
    const to = "2026-10-03";
    // Precondition: the range really holds more rows than one API response can carry…
    const inRange = await db.sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM activity_entries WHERE salesperson_id = $1 AND entry_date BETWEEN $2 AND $3`,
      [TEST_AE, from, to],
    );
    expect(inRange[0].n).toBe(ROWS + 1); // + the one seeded 2026-09-28 row
    // …and a single unpaged request DOES silently truncate (the bug this guards).
    const raw = await db.client.from("activity_entries").select("id").eq("salesperson_id", TEST_AE).gte("entry_date", from).lte("entry_date", to);
    expect((raw.data as Row[]).length).toBe(POSTGREST_MAX_ROWS);

    // The endpoint, authenticated as the Test AE session (tp token), is exact.
    const r = await report(TEST_AE, from, to);
    const seeded = { office_visits: 12, impressions: 55, presentations: 1 }; // the one seeded 2026-09-28 row
    expect(actual(r, "office_visits")).toBe(ROWS * 1 + seeded.office_visits);
    expect(actual(r, "service_requests")).toBe(ROWS * 2);
    expect(actual(r, "ones_scheduled")).toBe(ROWS * 3);
    expect(actual(r, "ones_held")).toBe(ROWS * 4);
    expect(actual(r, "presentations")).toBe(ROWS * 5 + seeded.presentations);
    expect(actual(r, "impressions")).toBe(ROWS * 6 + seeded.impressions);
    expect(actual(r, "team_meetings")).toBe(ROWS * 7);
    expect(actual(r, "gold_list_touches")).toBe(ROWS * 8);
    expect(r.totalActual).toBe(ROWS * 36 + 12 + 55 + 1);
  });

  it("real AEs get the same fix; other people's volume never leaks in", async () => {
    await db.sql(
      `INSERT INTO activity_entries (salesperson_id, entry_date, office_visits)
       SELECT $1, '2021-01-01'::date + i, 1 FROM generate_series(0, 1099) i`,
      [HILARY],
    );
    await db.sql(
      `INSERT INTO activity_entries (salesperson_id, entry_date, office_visits)
       SELECT $1, '2021-01-01'::date + i, 100 FROM generate_series(0, 1299) i`,
      [TEST_AE],
    );
    const r = await report(HILARY, "2021-01-01", "2026-10-03");
    expect(actual(r, "office_visits")).toBe(1100 + 30 + 8); // + her seeded 30 and 8
  });
});

describe("Home 'This week' tile: leaderboard route", () => {
  const WEEK_SINCE = "2026-09-28";
  const get = (who: string) => leaderboard.GET(req(who, "/api/leaderboard"));

  it("real AEs: unchanged — full team standings, no personal block", async () => {
    const body = await json<{ standings: Row[]; personal?: unknown }>(get(HILARY));
    expect(body.personal).toBeUndefined();
    const team = await computeStandings(db.client as never, WEEK_SINCE, "2026-09-29", WEEK_SINCE, "2026-09-29");
    expect(body.standings.map((s) => [s.id, s.percent]).sort()).toEqual(
      team.standings.map((s) => [s.id, s.percent]).sort(),
    );
    // Her own row keeps the pace fields; teammates' are stripped (existing behaviour).
    const mine = body.standings.find((s) => s.id === HILARY)!;
    expect(mine).toHaveProperty("availableDays");
    expect(body.standings.find((s) => s.id === KENNEDY)).not.toHaveProperty("availableDays");
  });

  it("Test AE: gets its personal score from the single-AE path, and is still absent from the team standings", async () => {
    const body = await json<{ standings: Row[]; personal?: Row }>(get(TEST_AE));
    expect(body.standings.map((s) => s.id).sort()).toEqual([HILARY, KENNEDY].sort());
    const single = await buildSingleAeActivityWeek(
      db.client as never, { id: TEST_AE, first_name: "Test AE" }, WEEK_SINCE, "2026-09-29", WEEK_SINCE, "2026-09-29",
    );
    expect(single.row!.score).not.toBeNull();
    expect(body.personal).toMatchObject({
      id: TEST_AE,
      percent: single.row!.score,
      availableDays: single.row!.available_days,
      expectedPercent: single.row!.expected_percent,
      isHolidayWeek: single.row!.is_holiday_week,
    });
    // Team numbers are what a real AE sees (test data changes nothing).
    const real = await json<{ standings: Row[] }>(get(HILARY));
    expect(body.standings.map((s) => [s.id, s.percent]).sort()).toEqual(
      real.standings.map((s) => [s.id, s.percent]).sort(),
    );
  });

  it("the tile's personal score follows the Test AE's own activity but never moves the team board", async () => {
    const before = await json<{ standings: Row[]; personal: Row }>(get(TEST_AE));
    await db.sql(
      `INSERT INTO activity_entries (salesperson_id, entry_date, office_visits, impressions, presentations)
       VALUES ($1, '2026-09-29', 40, 200, 1)`,
      [TEST_AE],
    );
    const after = await json<{ standings: Row[]; personal: Row }>(get(TEST_AE));
    expect((after.personal.percent as number) > (before.personal.percent as number)).toBe(true);
    expect(after.standings).toEqual(before.standings);
  });

  it("the tile component shows the personal row, unranked, when the viewer isn't in the standings", () => {
    const src = readFileSync(join(process.cwd(), "src/components/this-week-card.tsx"), "utf8");
    expect(src).toContain("body.personal");
    expect(src).toMatch(/myIndex >= 0 \? ranked\[myIndex\] : personal/);
    expect(src).toContain("rank > 0");
  });
});

// ---------------------------------------------------------------------------
// Inverse high-volume: large REAL office visits / scans / contacts / Cogent
// ---------------------------------------------------------------------------

describe("large real datasets are counted completely", () => {
  const WEEK = "2026-09-27";
  const M = POSTGREST_MAX_ROWS + 100;

  async function addBigRealWeek() {
    await db.sql(
      `INSERT INTO offices (id, salesperson_id, name, dedupe_key, environment) VALUES
         ('bbbbbbbb-0000-4000-8000-0000000000a1', $1, 'Real Office', 'r1', 'production')`,
      [HILARY],
    );
    await db.sql(
      `INSERT INTO office_visits (office_id, salesperson_id, visited_at, environment)
       SELECT 'bbbbbbbb-0000-4000-8000-0000000000a1', $1, '2026-09-29T15:00:00Z'::timestamptz - (i || ' minutes')::interval, 'production'
         FROM generate_series(0, ${M - 1}) i`,
      [HILARY],
    );
    await db.sql(
      `INSERT INTO business_card_scans (salesperson_id, salesperson_name, image_url, is_test_data, created_at)
       SELECT $1, 'Hilary', 'x', false, '2026-09-29T15:00:00Z'::timestamptz - (i || ' minutes')::interval FROM generate_series(0, ${M - 1}) i`,
      [HILARY],
    );
    await db.sql(
      `INSERT INTO business_card_contacts (salesperson_id, salesperson_name, contact_bucket, full_name, verification_status, approved_at)
       SELECT $1, 'Hilary', 'agent', 'Real ' || i, 'approved', '2026-09-29T15:00:00Z'::timestamptz - (i || ' minutes')::interval FROM generate_series(0, ${M - 1}) i`,
      [HILARY],
    );
  }

  it("scorecard: real visits, scans and approved contacts past the cap are exact", async () => {
    await addBigRealWeek();
    const body = await json<{ rows: Row[] }>(scorecard.GET(req(COREY, `/x?weekStart=${WEEK}`)));
    expect(body.rows.find((r) => r.id === HILARY)).toMatchObject({
      crm_visits: M,
      cards_scanned: M,
      cards_approved: M,
    });
    expect(body.rows.find((r) => r.id === KENNEDY)).toMatchObject({ crm_visits: 0, cards_scanned: 0, cards_approved: 0 });
  });

  it("coaching business-card counts are exact past the cap", async () => {
    await addBigRealWeek();
    const counts = await businessCardCountsByAe(db.client as never, [HILARY, KENNEDY], "2026-09-28", "2026-10-02");
    expect(counts.get(HILARY)).toBe(M);
    expect(counts.get(KENNEDY) ?? 0).toBe(0);
  });

  it("the CSV export contains every real contact and marks every one exported", async () => {
    await addBigRealWeek();
    const res = await exportContacts.GET(req(RYAN, "/x"));
    expect(res.status).toBe(200);
    const lines = (await res.text()).trim().split("\n");
    expect(lines).toHaveLength(M + 1); // header + every contact
    expect(await db.sql(`SELECT count(*)::int AS n FROM business_card_contacts WHERE exported_at IS NULL`)).toEqual([{ n: 0 }]);
  });
});

describe("Cogent order totals, end to end", () => {
  const stubUpstream = (rows: Array<Record<string, unknown>>) => {
    process.env.COGENT_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(rows), { status: 200 })),
    );
  };
  afterEach(() => vi.unstubAllGlobals());

  const upstream = (testTerritories: number) => [
    { salesTerritoryName: "DENVER", policyCount: 6, salesTarget: 40 },
    { salesTerritoryName: "DENVER", policyCount: 4, salesTarget: 40 },
    { salesTerritoryName: "BOULDER", policyCount: 7, salesTarget: 20 },
    ...Array.from({ length: testTerritories }, (_, i) => ({
      salesTerritoryName: `TESTLAND ${i}`, policyCount: 100, salesTarget: 500,
    })),
  ];
  const summarize = async () => {
    const s = await getOrdersSummary({ startDate: "2026-09-01", endDate: "2026-09-29" });
    return { items: s.items, mapped: s.mappedTerritories };
  };

  it("thousands of territories mapped to a test account change no AE's or company's order numbers", async () => {
    await db.sql(
      // Ids sort AFTER the ~1,200 test mappings added below, so a capped single
      // read (ordered by id) would drop exactly these real rows.
      `INSERT INTO cogent_territory_mappings (id, sales_territory_name, salesperson_id, active) VALUES
         ('ffffffff-ffff-4fff-8fff-fffffffffff1', 'DENVER', $1, true),
         ('ffffffff-ffff-4fff-8fff-fffffffffff2', 'BOULDER', $2, true)`,
      [HILARY, KENNEDY],
    );
    stubUpstream(upstream(0));
    const before = await summarize();
    expect(before.items.map((i) => [i.salespersonId, i.orderCount, i.orderTarget])).toEqual([
      [HILARY, 10, 40],
      [KENNEDY, 7, 20],
    ]);

    const N = POSTGREST_MAX_ROWS + 200;
    await db.sql(
      `INSERT INTO cogent_territory_mappings (sales_territory_name, salesperson_id, active)
       SELECT 'TESTLAND ' || i, $1, true FROM generate_series(0, ${N - 1}) i`,
      [TEST_AE],
    );
    stubUpstream(upstream(N));
    const after = await summarize();
    expect(after.items).toEqual(before.items);
    expect(after.mapped).toEqual(before.mapped);
    expect(JSON.stringify(after.items)).not.toContain(TEST_AE);
    // The company rollup is the sum of AE rows, so it can't move either.
    const sum = (x: typeof before) => x.items.reduce((n, i) => n + i.orderCount, 0);
    expect(sum(after)).toBe(sum(before));
  });
});
