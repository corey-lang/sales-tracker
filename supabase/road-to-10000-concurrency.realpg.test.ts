/**
 * REAL multi-connection PostgreSQL tests for Road to 10,000
 * (supabase/road_to_10000.sql). PGlite is one connection, so it cannot show two
 * recorders contending; here each actor is its own backend connection to a real
 * server and the tests assert real lock waits (pg_blocking_pids).
 *
 * OPT-IN: REAL_PG=1 REAL_PG_MODULES=/dir/with/node_modules npx vitest run \
 *   supabase/road-to-10000-concurrency.realpg.test.ts   (see src/test/real-pg.ts)
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { REAL_PG_ENABLED, isPending, startRealPg } from "@/test/real-pg";

const COREY = "55555555-5555-4555-8555-555555555555";
const TONJA = "77777777-7777-4777-8777-777777777777";
const HILARY = "11111111-1111-4111-8111-111111111111";

type Pg = Awaited<ReturnType<typeof startRealPg>>;
const RECORD = `SELECT id, total FROM record_road_to_10000_total($1, $2, $3, $4, $5, 2026)`;

describe.skipIf(!REAL_PG_ENABLED)("REAL PostgreSQL: Road to 10,000 recorder", () => {
  let pg: Pg;
  beforeAll(async () => {
    pg = await startRealPg();
  }, 180_000);
  afterAll(async () => {
    await pg?.stop();
  }, 60_000);
  beforeEach(async () => {
    await pg.closeSessions();
    await pg.reset();
    await pg.admin.q(
      `INSERT INTO salespeople (id, first_name, role) VALUES ($1,'Corey','admin'), ($2,'Tonja','assistant'), ($3,'Hilary','ae')`,
      [COREY, TONJA, HILARY],
    );
  });
  const totals = async () => (await pg.admin.q(`SELECT total FROM road_to_10000_totals ORDER BY seq`)).map((r) => r.total);
  const latestId = async () => ((await pg.admin.q(`SELECT id FROM road_to_10000_totals ORDER BY seq DESC LIMIT 1`))[0]?.id ?? null) as string | null;

  it("runs on a real PostgreSQL server with the real migration", async () => {
    expect(pg.version).toMatch(/^PostgreSQL \d+/);
    console.log(`[real-pg] ${pg.version.split(",")[0]}`);
    expect((await pg.admin.q(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'record_road_to_10000_total'`))[0].n).toBe(1);
  });

  it("two people saving from the SAME screen at once: the second really waits, then is told it's stale — exactly one total is recorded", async () => {
    const a = await pg.session();
    const b = await pg.session();
    await a.q(`BEGIN`);
    expect((await a.attempt(RECORD, [COREY, 7000, false, null, null])).ok).toBe(true); // holds the lock, uncommitted
    const second = b.attempt(RECORD, [TONJA, 7100, false, null, null]); // same starting screen (no total yet)
    await pg.waitBlockedBy(b.pid, a.pid); // REAL wait on the advisory lock
    expect(await isPending(second)).toBe(true);
    await a.q(`COMMIT`);
    expect(await second).toMatchObject({ ok: false, code: "40001" });
    expect(await totals()).toEqual([7000]);
  });

  it("a LOWER total can't slip past the 'not lower' rule by racing a higher one", async () => {
    const seed = await pg.session();
    await seed.attempt(RECORD, [COREY, 7000, false, null, null]);
    const base = await latestId();
    const a = await pg.session();
    const b = await pg.session();
    await a.q(`BEGIN`);
    expect((await a.attempt(RECORD, [COREY, 8000, false, null, base])).ok).toBe(true);
    const lower = b.attempt(RECORD, [TONJA, 7500, false, null, base]); // 7500 > 7000 on its own, < 8000 once A lands
    await pg.waitBlockedBy(b.pid, a.pid);
    await a.q(`COMMIT`);
    expect(await lower).toMatchObject({ ok: false, code: "40001" }); // it never gets to write beneath 8000
    expect(await totals()).toEqual([7000, 8000]);
    // Even re-submitted on the fresh screen it is refused as lower (not a correction).
    expect(await b.attempt(RECORD, [TONJA, 7500, false, null, await latestId()])).toMatchObject({ ok: false, code: "23514" });
    expect(await totals()).toEqual([7000, 8000]);
  });

  it("many people hammering the same screen: exactly one wins per round, totals never go down, no deadlocks", async () => {
    const [{ deadlocks: before }] = await pg.admin.q(`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`);
    const sessions = await Promise.all([1, 2, 3, 4, 5, 6].map(() => pg.session()));
    for (let round = 0; round < 15; round += 1) {
      const base = await latestId();
      const current = ((await totals()).at(-1) as number | undefined) ?? 0;
      const results = await Promise.all(
        sessions.map((s, i) => s.attempt(RECORD, [i % 2 ? TONJA : COREY, current + 10 + i, false, null, base])),
      );
      expect(results.filter((r) => r.ok), `round ${round}`).toHaveLength(1);
      expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === "40001"), `round ${round}`).toBe(true);
    }
    const all = (await totals()) as number[];
    expect(all).toHaveLength(15);
    expect(all.every((t, i) => i === 0 || t > all[i - 1])).toBe(true); // monotonic
    await new Promise((r) => setTimeout(r, 1500));
    const [{ deadlocks: after }] = await pg.admin.q(`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`);
    expect(Number(after) - Number(before)).toBe(0);
  }, 120_000);

  it("the protections hold on a real server: only admin/assistant may record, history is append-only, anon is locked out", async () => {
    const s = await pg.session();
    expect(await s.attempt(RECORD, [HILARY, 5, false, null, null])).toMatchObject({ ok: false, code: "42501" });
    expect((await s.attempt(RECORD, [TONJA, 5, false, null, null])).ok).toBe(true);
    expect(await s.attempt(`UPDATE road_to_10000_totals SET total = 9`)).toMatchObject({ ok: false, code: "23514" });
    expect(await s.attempt(`DELETE FROM road_to_10000_totals`)).toMatchObject({ ok: false, code: "23514" });
    const anon = await pg.session();
    await anon.q(`RESET ROLE`);
    await anon.q(`SET ROLE anon`);
    expect(await anon.attempt(`SELECT * FROM road_to_10000_totals`)).toMatchObject({ ok: false, code: "42501" });
    expect(await anon.attempt(RECORD, [TONJA, 6, false, null, null])).toMatchObject({ ok: false, code: "42501" });
    expect(await totals()).toEqual([5]);
  });
});
