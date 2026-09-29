/**
 * Fresh-install safety: however the migrations and seed are ordered, and
 * however often the seed is re-run, the seeded "Test" account is a TEST
 * account — never a real, reportable AE.
 *
 * Each scenario builds its own database from the real supabase/*.sql files in
 * a different order (PGlite).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestDb, MIGRATIONS, type TestDb } from "@/test/pglite-supabase";

// goals.ts (reached through the standings code) builds the browser client at load.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
const { computeStandings } = await import("@/lib/server/leaderboard-standings");

/** MIGRATIONS starts: schema.sql, add_role.sql, salespeople_auth_columns.sql, … */
const [SCHEMA, ADD_ROLE, AUTH_COLUMNS, ...REST] = MIGRATIONS;
const SEED = "seed.sql";

/** The seed exactly as it inserted "Test" BEFORE the fix (a normal row when the
 *  is_test column doesn't exist yet). */
const LEGACY_SEED = `
  INSERT INTO salespeople (first_name, location) VALUES ('Test', 'HQ'), ('Alex', 'HQ'), ('Jordan', 'HQ')
  ON CONFLICT (first_name) DO NOTHING;`;

const seedSql = () => readFileSync(join(process.cwd(), "supabase", SEED), "utf8");

async function testRows(db: TestDb) {
  return db.sql<{ first_name: string; is_test: boolean; role: string }>(
    `SELECT first_name::text AS first_name, is_test, role FROM salespeople WHERE first_name ILIKE 'test%' ORDER BY first_name`,
  );
}

/** The seeded account must be a test account, exactly once, and out of every real-AE predicate. */
async function expectSafe(db: TestDb) {
  expect(await testRows(db)).toEqual([{ first_name: "Test", is_test: true, role: "ae" }]);
  // No non-test row that looks like the seeded account.
  expect(await db.sql(`SELECT 1 FROM salespeople WHERE first_name ILIKE 'test' AND NOT is_test`)).toEqual([]);
  // The login name list and reporting roster predicates.
  const roster = await db.sql<{ first_name: string }>(
    `SELECT first_name::text AS first_name FROM salespeople WHERE role = 'ae' AND is_test = false AND deactivated_at IS NULL ORDER BY 1`,
  );
  expect(roster.map((r) => r.first_name)).toEqual(["Alex", "Jordan"]);
  // …and the real reporting code path.
  const standings = await computeStandings(db.client as never, "2026-09-28", "2026-09-29", "2026-09-28", "2026-09-29");
  expect(standings.error).toBeNull();
  expect(standings.standings.map((s) => s.first_name).sort()).toEqual(["Alex", "Jordan"]);
}

describe("fresh install: the seeded Test account is never a real AE", () => {
  it("documented order (schema → seed → add_role → auth columns …)", async () => {
    const db = await createTestDb({ migrations: [SCHEMA, SEED, ADD_ROLE, AUTH_COLUMNS, ...REST] });
    await expectSafe(db);
  }, 60_000);

  it("seed AFTER the auth columns", async () => {
    const db = await createTestDb({ migrations: [SCHEMA, ADD_ROLE, AUTH_COLUMNS, SEED, ...REST] });
    await expectSafe(db);
  }, 60_000);

  it("seed with NO other file having created is_test (the seed alone makes the column)", async () => {
    const db = await createTestDb({ migrations: [SCHEMA, SEED, ADD_ROLE] });
    const rows = await db.sql(`SELECT first_name::text AS n, is_test FROM salespeople WHERE first_name ILIKE 'test'`);
    expect(rows).toEqual([{ n: "Test", is_test: true }]);
  }, 60_000);

  it("re-running the seed (either side of the auth columns) creates no duplicate and no real 'Test'", async () => {
    const db = await createTestDb({ migrations: [SCHEMA, SEED, ADD_ROLE, AUTH_COLUMNS, ...REST] });
    const before = await db.sql(`SELECT count(*)::int AS n FROM salespeople`);
    await db.asOwner(seedSql());
    await db.asOwner(seedSql());
    expect(await db.sql(`SELECT count(*)::int AS n FROM salespeople`)).toEqual(before);
    await expectSafe(db);
    // Re-running the migrations too.
    for (const file of [AUTH_COLUMNS, "private_test_accounts.sql"]) {
      await db.asOwner(readFileSync(join(process.cwd(), "supabase", file), "utf8"));
    }
    await expectSafe(db);
  }, 60_000);

  it("a renamed test account (e.g. 'Test AE') is not shadowed by a new 'Test' on seed re-run", async () => {
    const db = await createTestDb({ migrations: [SCHEMA, SEED, ADD_ROLE, AUTH_COLUMNS, ...REST] });
    await db.sql(`UPDATE salespeople SET first_name = 'Test AE' WHERE first_name ILIKE 'test'`);
    await db.asOwner(seedSql());
    await db.asOwner(seedSql());
    expect(await testRows(db)).toEqual([{ first_name: "Test AE", is_test: true, role: "ae" }]);
    expect(await db.sql(`SELECT count(*)::int AS n FROM salespeople WHERE is_test`)).toEqual([{ n: 1 }]);
  }, 60_000);
});

describe("legacy databases: an ambiguous 'Test' row is never reclassified automatically", () => {
  const ADMIN = "55555555-5555-4555-8555-555555555555";
  const LEGACY = "77777777-7777-4777-8777-777777777777";
  const template = () => readFileSync(join(process.cwd(), "supabase/provision_test_ae.template.sql"), "utf8");
  const provision = (test: string, owner: string, convert: boolean) =>
    template()
      .replace("<TEST_AE_UUID>", test)
      .replace("<OWNER_ADMIN_UUID>", owner)
      .replace("<CHOOSE_A_PIN>", "482913")
      .replace("v_convert_legacy_row boolean := false", `v_convert_legacy_row boolean := ${convert}`);
  const flags = (db: TestDb) =>
    db.sql(`SELECT first_name::text AS n, is_test FROM salespeople WHERE first_name ILIKE 'test%' ORDER BY 1`);

  /** A database seeded by the OLD seed: "Test" is a normal row, no test account exists. */
  async function legacyDb() {
    const db = await createTestDb({
      migrations: [SCHEMA, `inline:${LEGACY_SEED}`, ADD_ROLE, AUTH_COLUMNS, ...REST],
    });
    await db.sql(`UPDATE salespeople SET id = $1 WHERE first_name = 'Test'`, [LEGACY]);
    await db.sql(`INSERT INTO salespeople (id, first_name, role, admin_pin) VALUES ($1, 'Corey', 'admin', '1111')`, [ADMIN]);
    return db;
  }

  it("a legitimate real salesperson named Test at HQ stays real through every migration and seed re-run", async () => {
    const db = await legacyDb();
    expect(await flags(db)).toEqual([{ n: "Test", is_test: false }]);
    for (const file of [AUTH_COLUMNS, "private_test_accounts.sql", SEED, SEED]) {
      await db.asOwner(readFileSync(join(process.cwd(), "supabase", file), "utf8"));
    }
    expect(await flags(db)).toEqual([{ n: "Test", is_test: false }]); // untouched, and no duplicate created
    expect(await db.sql(`SELECT count(*)::int AS n FROM salespeople WHERE is_test`)).toEqual([{ n: 0 }]);
    // Real means real: still in the login/reporting roster.
    const roster = await db.sql<{ n: string }>(`SELECT first_name::text AS n FROM salespeople WHERE role = 'ae' AND NOT is_test ORDER BY 1`);
    expect(roster.map((r) => r.n)).toContain("Test");
  }, 60_000);

  it("the ambiguous state needs explicit provisioning: the template refuses by default", async () => {
    const db = await legacyDb();
    await expect(db.asOwner(provision(LEGACY, ADMIN, false))).rejects.toThrow(/not flagged is_test/);
    expect(await flags(db)).toEqual([{ n: "Test", is_test: false }]);
  }, 60_000);

  it("…and converts exactly the named id when the operator opts in", async () => {
    const db = await legacyDb();
    await db.asOwner(provision(LEGACY, ADMIN, true));
    expect(await flags(db)).toEqual([{ n: "Test", is_test: true }]);
    expect(await db.sql(`SELECT test_owner_id, admin_pin FROM salespeople WHERE id = $1`, [LEGACY])).toEqual([
      { test_owner_id: ADMIN, admin_pin: "482913" },
    ]);
    expect(await db.sql(`SELECT count(*)::int AS n FROM salespeople WHERE is_test`)).toEqual([{ n: 1 }]);
  }, 60_000);

  it("the opt-in still refuses a second test account, or a PIN-holding row", async () => {
    const db = await legacyDb();
    // A row that looks in use (has a PIN) is not convertible.
    await db.sql(`UPDATE salespeople SET admin_pin = '9999' WHERE id = $1`, [LEGACY]);
    await expect(db.asOwner(provision(LEGACY, ADMIN, true))).rejects.toThrow(/looks like a real, in-use account/);
    await db.sql(`UPDATE salespeople SET admin_pin = NULL WHERE id = $1`, [LEGACY]);
    // Another test account already exists.
    await db.sql(`INSERT INTO salespeople (first_name, role, is_test) VALUES ('Sandbox', 'ae', true)`);
    await expect(db.asOwner(provision(LEGACY, ADMIN, true))).rejects.toThrow(/test account already exists/);
    expect(await db.sql(`SELECT is_test FROM salespeople WHERE id = $1`, [LEGACY])).toEqual([{ is_test: false }]);
  }, 60_000);

  it("a database that already has a correctly flagged test row keeps it exactly as is (and gains no duplicate)", async () => {
    const db = await createTestDb({ migrations: [SCHEMA, SEED, ADD_ROLE, AUTH_COLUMNS, ...REST] });
    await db.sql(`UPDATE salespeople SET first_name = 'Test AE', admin_pin = '4242' WHERE is_test`);
    await db.sql(`INSERT INTO salespeople (first_name, location, role) VALUES ('Test', 'HQ', 'ae')`); // a real person
    const before = await db.sql(`SELECT id, first_name::text AS n, is_test, admin_pin FROM salespeople ORDER BY id`);
    for (const file of [AUTH_COLUMNS, "private_test_accounts.sql", SEED]) {
      await db.asOwner(readFileSync(join(process.cwd(), "supabase", file), "utf8"));
    }
    expect(await db.sql(`SELECT id, first_name::text AS n, is_test, admin_pin FROM salespeople ORDER BY id`)).toEqual(before);
    expect(await flags(db)).toEqual([{ n: "Test", is_test: false }, { n: "Test AE", is_test: true }]);
  }, 60_000);

  it("a fresh install still creates exactly one test row, and the seed re-run adds no duplicate", async () => {
    const db = await createTestDb({ migrations: [SCHEMA, SEED, ADD_ROLE, AUTH_COLUMNS, ...REST] });
    await db.asOwner(seedSql());
    await db.asOwner(seedSql());
    expect(await flags(db)).toEqual([{ n: "Test", is_test: true }]);
  }, 60_000);
});
