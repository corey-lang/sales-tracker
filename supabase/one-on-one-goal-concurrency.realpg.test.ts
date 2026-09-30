/**
 * REAL multi-connection PostgreSQL concurrency tests for the goal-change vs
 * completion race (supabase/one_on_one_workspace_v2.sql, sections 4-5).
 *
 * WHY THIS EXISTS
 *   The PGlite route tests (src/app/api/admin/one-on-one-meetings/
 *   workspace-v2.test.ts) run ONE connection, so two transactions can never
 *   block each other there — they prove atomicity and ordering logic, NOT lock
 *   waiting. Here every actor is its own backend connection to a real
 *   PostgreSQL server, and the tests assert actual lock waits
 *   (pg_blocking_pids), NOWAIT failures, and the server's own deadlock
 *   counter.
 *
 * OPT-IN (skipped in the normal `npm test`)
 *   REAL_PG=1 npx vitest run supabase/one-on-one-goal-concurrency.realpg.test.ts
 *   It boots a throwaway server with the `embedded-postgres` npm package
 *   (real PostgreSQL binaries; not a project dependency) and the `pg` driver.
 *   Install them anywhere and point REAL_PG_MODULES at that directory:
 *       mkdir /tmp/realpg && cd /tmp/realpg && npm i embedded-postgres pg
 *       REAL_PG=1 REAL_PG_MODULES=/tmp/realpg npx vitest run <this file>
 *   (or `npm i --no-save embedded-postgres pg` in the project and omit
 *   REAL_PG_MODULES). Or set REAL_PG_URL=postgres://superuser@host/db to use
 *   an existing EMPTY scratch database instead — it is migrated and TRUNCATED.
 *
 * The actors call the SQL functions directly (the same RPCs the routes call),
 * as the non-superuser `service_role`, with the real migrations applied.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DRIFT_SQL, MIGRATIONS, STORAGE_STUB_SQL } from "@/test/pglite-supabase";

type Row = Record<string, unknown>;
type PgClient = {
  processID: number;
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
  end(): Promise<void>;
};

const ENABLED = process.env.REAL_PG === "1" || Boolean(process.env.REAL_PG_URL);

const AE = "11111111-1111-4111-8111-111111111111";
const ADMIN = "55555555-5555-4555-8555-555555555555";
const THIS_MONDAY = "2026-09-28";
const NEXT_MONDAY = "2026-10-05";
const BASELINE_GOAL = 40; // the global goal row
const GOALS = {
  office_visits: 30, service_requests: 0, ones_scheduled: 0, ones_held: 0,
  presentations: 2, impressions: 120, team_meetings: 0, gold_list_touches: 0,
};
const goals = (office_visits: number) => ({ ...GOALS, office_visits });

/** Outcome of one statement: a pg error's SQLSTATE, never a thrown exception. */
type Attempt = { ok: true; rows: Row[] } | { ok: false; code: string; message: string };

class Session {
  constructor(readonly c: PgClient) {}
  get pid() { return this.c.processID; }
  async q(sql: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.c.query(sql, params)).rows;
  }
  async attempt(sql: string, params: unknown[] = []): Promise<Attempt> {
    try {
      return { ok: true, rows: await this.q(sql, params) };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { ok: false, code: e.code ?? "?", message: e.message ?? String(err) };
    }
  }
}

describe.skipIf(!ENABLED)("REAL PostgreSQL: goal change vs completion (multi-connection)", () => {
  let admin: Session;
  let connect: () => Promise<PgClient>;
  let stopServer: () => Promise<void> = async () => {};
  const open: Session[] = [];
  let tables: string[] = [];
  let meeting = "";
  let serverVersion = "";

  /** A new backend connection acting as the app does: non-superuser service_role. */
  async function session(): Promise<Session> {
    const s = new Session(await connect());
    await s.q(`SET ROLE service_role`);
    open.push(s);
    return s;
  }

  /** Polls until backend `pid` is WAITING on a lock held by `holder` (a real lock wait). */
  async function waitBlockedBy(pid: number, holder: number) {
    for (let i = 0; i < 200; i += 1) {
      const [row] = await admin.q(`SELECT pg_blocking_pids($1) AS b`, [pid]);
      if ((row.b as number[]).includes(holder)) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`backend ${pid} never blocked on ${holder}`);
  }
  const pending = async (p: Promise<unknown>, ms = 300) =>
    (await Promise.race([p.then(() => "done"), new Promise((r) => setTimeout(() => r("pending"), ms))])) === "pending";

  const goalSql = `SELECT update_weekly_goal_in_one_on_one($1, $2, $3, $4, $5::jsonb, $6)`;
  const goalArgs = (id: string, start: "this_week" | "next_week", v: number) => [
    id, AE, start, start === "this_week" ? THIS_MONDAY : NEXT_MONDAY, JSON.stringify(goals(v)), ADMIN,
  ];
  const completeSql = `SELECT complete_one_on_one_meeting($1, $2, $3::jsonb, $4)`;

  /** The goal "this week" resolves to as of Monday — what the app's snapshot freezes. */
  async function resolvedThisWeekGoal(s: Session, ae: string): Promise<number> {
    const [row] = await s.q(
      `SELECT office_visits FROM weekly_goals
        WHERE salesperson_id = $1 AND effective_from <= $2 ORDER BY effective_from DESC LIMIT 1`,
      [ae, THIS_MONDAY],
    );
    return row ? Number(row.office_visits) : BASELINE_GOAL;
  }

  /**
   * Mirrors completeMeeting() in src/lib/server/one-on-one-meetings.ts: read the
   * goal-change count, compute the snapshot from LIVE goals, call the function,
   * and on 40001 recompute and retry.
   */
  async function appCompletion(
    s: Session,
    id: string,
    between: () => Promise<void> = async () => {},
    ae: string = AE,
  ): Promise<{ ok: true; attempts: number } | { ok: false; code: string; attempts: number }> {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const [{ n }] = await s.q(
        `SELECT jsonb_array_length(goal_changes) AS n FROM one_on_one_meetings WHERE id = $1`, [id]);
      const snapshot = { version: 1, this_week_office_visits_goal: await resolvedThisWeekGoal(s, ae) };
      await between();
      const r = await s.attempt(completeSql, [id, ADMIN, JSON.stringify(snapshot), n]);
      if (r.ok) return { ok: true, attempts: attempt };
      if (r.code !== "40001") return { ok: false, code: r.code, attempts: attempt };
    }
    return { ok: false, code: "40001", attempts: 8 };
  }

  const meetingRow = async (id = meeting) =>
    (await admin.q(`SELECT status, goal_changes, activity_snapshot FROM one_on_one_meetings WHERE id = $1`, [id]))[0];
  const liveGoals = async (monday?: string) =>
    admin.q(`SELECT effective_from::text AS effective_from, office_visits FROM weekly_goals
              WHERE salesperson_id = $1 ${monday ? `AND effective_from = '${monday}'` : ""} ORDER BY effective_from`, [AE]);

  async function seed(aeIds: string[] = [AE]): Promise<string[]> {
    await admin.q(`RESET ROLE`).catch(() => undefined);
    await admin.q(`TRUNCATE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
    await admin.q(
      `INSERT INTO salespeople (id, first_name, role) VALUES ($1, 'Corey', 'admin')`, [ADMIN]);
    const ids: string[] = [];
    for (const ae of aeIds) {
      await admin.q(`INSERT INTO salespeople (id, first_name, role) VALUES ($1, $2, 'ae')`, [ae, `AE-${ae.slice(0, 4)}`]);
      const [m] = await admin.q(
        `INSERT INTO one_on_one_meetings (ae_id, manager_id, meeting_date) VALUES ($1, $2, $3) RETURNING id`,
        [ae, ADMIN, THIS_MONDAY]);
      ids.push(m.id as string);
    }
    await admin.q(
      `INSERT INTO weekly_goals (salesperson_id, effective_from, office_visits, impressions, presentations)
       VALUES (NULL, '2026-01-05', $1, 150, 1)`, [BASELINE_GOAL]);
    return ids;
  }

  beforeAll(async () => {
    const base = process.env.REAL_PG_MODULES ?? process.cwd();
    const req = createRequire(join(base, "noop.js"));
    const pg = req("pg") as { Client: new (cfg: unknown) => PgClient };

    if (process.env.REAL_PG_URL) {
      const url = process.env.REAL_PG_URL;
      connect = async () => { const c = new pg.Client({ connectionString: url }); await c.connect(); return c; };
    } else {
      const EmbeddedPostgres = (
        (await import(pathToFileURL(req.resolve("embedded-postgres")).href)) as { default: new (cfg: unknown) => {
          initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void>;
        } }
      ).default;
      const port = await new Promise<number>((resolve) => {
        const srv = createServer();
        srv.listen(0, () => { const p = (srv.address() as { port: number }).port; srv.close(() => resolve(p)); });
      });
      const dir = mkdtempSync(join(tmpdir(), "realpg-"));
      const server = new EmbeddedPostgres({
        databaseDir: join(dir, "data"), user: "postgres", password: "pw", port, persistent: false,
        onLog: () => undefined, onError: () => undefined,
      });
      await server.initialise();
      await server.start();
      stopServer = async () => { await server.stop(); rmSync(dir, { recursive: true, force: true }); };
      connect = async () => {
        const c = new pg.Client({ host: "localhost", port, user: "postgres", password: "pw", database: "postgres" });
        await c.connect();
        return c;
      };
    }

    admin = new Session(await connect());
    [{ v: serverVersion }] = (await admin.q(`SELECT version() AS v`)) as Array<{ v: string }>;
    await admin.q(`ALTER DATABASE ${"postgres"} SET timezone = 'UTC'`).catch(() => undefined);
    await admin.q(`SET TIME ZONE 'UTC'`);
    // Fast deadlock detection: a real deadlock would be reported within 50ms.
    await admin.q(`ALTER SYSTEM SET deadlock_timeout = '50ms'`).catch(() => undefined);
    await admin.q(`SELECT pg_reload_conf()`);
    await admin.q(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE PUBLICATION supabase_realtime;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    `);
    for (const file of MIGRATIONS) {
      await admin.q(
        file === "DRIFT" ? DRIFT_SQL
          : file === "STORAGE_STUB" ? STORAGE_STUB_SQL
            : readFileSync(join(process.cwd(), "supabase", file), "utf8"));
    }
    tables = (await admin.q(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).map((r) => r.tablename as string);
    // Re-applying the migration over a live schema must be a no-op (idempotent).
    await admin.q(readFileSync(join(process.cwd(), "supabase", "one_on_one_workspace_v2.sql"), "utf8"));
  }, 180_000);

  beforeEach(async () => {
    for (const s of open.splice(0)) await s.c.end().catch(() => undefined);
    [meeting] = await seed();
  });

  afterAll(async () => {
    for (const s of open.splice(0)) await s.c.end().catch(() => undefined);
    await admin?.c.end().catch(() => undefined);
    await stopServer();
  }, 60_000);

  it("runs against a real PostgreSQL server with the real migrations", async () => {
    expect(serverVersion).toMatch(/^PostgreSQL \d+/);
    console.log(`[real-pg] ${serverVersion.split(",")[0]}`);
    const [{ n }] = await admin.q(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'update_weekly_goal_in_one_on_one'`);
    expect(n).toBe(1);
  });

  // -------------------------------------------------------------------------
  it("1. GOAL UPDATE FIRST, completion second: completion really waits, then is told to recompute; the retry freezes the new goal", async () => {
    const A = await session(); // the goal change
    const B = await session(); // completion (the app flow)

    await A.q(`BEGIN`);
    expect((await A.attempt(goalSql, goalArgs(meeting, "this_week", 35))).ok).toBe(true); // holds the meeting + goal row, UNcommitted

    // Completion reads 0 goal changes + the OLD goal (40), then calls the function.
    let betweenRan = false;
    const completion = appCompletion(B, meeting, async () => { betweenRan = true; });
    await waitBlockedBy(B.pid, A.pid); // REAL lock wait: completion's FOR UPDATE is queued behind the goal change
    expect(betweenRan).toBe(true);
    expect(await pending(completion)).toBe(true);
    expect((await meetingRow()).status).toBe("in_progress");

    await A.q(`COMMIT`);
    const result = await completion;
    expect(result).toEqual({ ok: true, attempts: 2 }); // attempt 1: 40001 (stale snapshot), attempt 2 committed

    const row = await meetingRow();
    expect(row.status).toBe("completed");
    const history = row.goal_changes as Array<{ values: { office_visits: number } }>;
    expect(history).toHaveLength(1);
    expect(history[0].values.office_visits).toBe(35);
    // THE invariant: the frozen comparison used the same goal version the history records.
    expect((row.activity_snapshot as { this_week_office_visits_goal: number }).this_week_office_visits_goal).toBe(35);
    expect(await liveGoals()).toEqual([{ effective_from: THIS_MONDAY, office_visits: 35 }]);
  });

  it("1b. OLD 3-ARGUMENT WRAPPER: already waiting when a goal change commits, it REFUSES (40001) instead of freezing the stale snapshot", async () => {
    // This interleaving previously FROZE a stale goal (the wrapper skipped the
    // check). It must now fail, change nothing, and leave the meeting completable.
    const A = await session();
    const B = await session();
    await A.q(`BEGIN`);
    await A.attempt(goalSql, goalArgs(meeting, "this_week", 35));
    // Stale snapshot (goal 40) handed to the legacy 3-arg function.
    const legacy = B.attempt(`SELECT complete_one_on_one_meeting($1, $2, $3::jsonb)`, [
      meeting, ADMIN, JSON.stringify({ version: 1, this_week_office_visits_goal: BASELINE_GOAL }),
    ]);
    await waitBlockedBy(B.pid, A.pid); // really waiting on the goal change's lock
    expect(await pending(legacy)).toBe(true);
    await A.q(`COMMIT`);
    expect(await legacy).toMatchObject({ ok: false, code: "40001" });

    const row = await meetingRow();
    expect(row.status).toBe("in_progress");
    expect(row.activity_snapshot).toBeNull(); // nothing frozen, nothing partial
    expect((row.goal_changes as unknown[]).length).toBe(1);
    expect(await liveGoals()).toEqual([{ effective_from: THIS_MONDAY, office_visits: 35 }]);
    // The checked path then completes it with the right goal.
    expect(await appCompletion(B, meeting)).toMatchObject({ ok: true });
    const done = await meetingRow();
    expect(done.status).toBe("completed");
    expect((done.activity_snapshot as { this_week_office_visits_goal: number }).this_week_office_visits_goal).toBe(35);
  });

  it("1c. old 3-argument wrapper with no goal history completes normally; with history it is refused; NULL is rejected on the checked function", async () => {
    const A = await session();
    const [other] = await seed([AE, "33333333-3333-4333-8333-333333333333"]).then((ids) => ids.slice(1));
    const ok = await A.attempt(`SELECT complete_one_on_one_meeting($1, $2, $3::jsonb)`, [other, ADMIN, JSON.stringify({ version: 1 })]);
    expect(ok.ok).toBe(true);
    expect(
      (await admin.q(`SELECT status FROM one_on_one_meetings WHERE id = $1`, [other]))[0].status,
    ).toBe("completed");

    const [mine] = await admin.q(`SELECT id FROM one_on_one_meetings WHERE ae_id = $1`, [AE]);
    expect((await A.attempt(goalSql, goalArgs(mine.id as string, "this_week", 35))).ok).toBe(true);
    expect(await A.attempt(`SELECT complete_one_on_one_meeting($1, $2, $3::jsonb)`, [mine.id, ADMIN, JSON.stringify({ version: 1 })]))
      .toMatchObject({ ok: false, code: "40001" });
    expect(await A.attempt(completeSql, [mine.id, ADMIN, JSON.stringify({ version: 1 }), null]))
      .toMatchObject({ ok: false, code: "22004" });
    expect((await meetingRow(mine.id as string)).status).toBe("in_progress");
  });

  // -------------------------------------------------------------------------
  it("2. COMPLETION FIRST, goal update second: the goal fails AT ONCE (NOWAIT, 55P03), writes nothing, and is refused after commit (23514)", async () => {
    const A = await session(); // goal change
    const B = await session(); // completion

    await B.q(`BEGIN`);
    expect((await B.attempt(completeSql, [meeting, ADMIN, JSON.stringify({ version: 1 }), 0])).ok).toBe(true); // holds FOR UPDATE, uncommitted

    const started = Date.now();
    const refused = await A.attempt(goalSql, goalArgs(meeting, "this_week", 99));
    expect(refused).toMatchObject({ ok: false, code: "55P03" });
    expect(Date.now() - started).toBeLessThan(2000); // never waited on completion
    expect(await liveGoals()).toEqual([]); // live goal unchanged

    await B.q(`COMMIT`);
    const after = await A.attempt(goalSql, goalArgs(meeting, "this_week", 99));
    expect(after).toMatchObject({ ok: false, code: "23514" });
    expect(await liveGoals()).toEqual([]);
    const row = await meetingRow();
    expect(row.status).toBe("completed");
    expect(row.goal_changes).toEqual([]); // the completed record doesn't claim the rejected change
  });

  it("2b. a goal change refused inside an open transaction leaves nothing behind when that transaction ends", async () => {
    const A = await session();
    const B = await session();
    await B.q(`BEGIN`);
    await B.attempt(completeSql, [meeting, ADMIN, JSON.stringify({ version: 1 }), 0]);
    await A.q(`BEGIN`);
    expect(await A.attempt(goalSql, goalArgs(meeting, "next_week", 99))).toMatchObject({ ok: false, code: "55P03" });
    await A.q(`ROLLBACK`);
    await B.q(`ROLLBACK`); // completion abandoned too
    expect(await liveGoals()).toEqual([]);
    expect((await meetingRow()).status).toBe("in_progress");
  });

  // -------------------------------------------------------------------------
  it("3. atomic rollback: an abandoned or failing goal transaction leaves NEITHER the live goal NOR the history", async () => {
    const A = await session();
    await A.q(`BEGIN`);
    await A.attempt(goalSql, goalArgs(meeting, "this_week", 35));
    expect(await liveGoals()).toEqual([]); // uncommitted: invisible to others
    expect((await meetingRow()).goal_changes).toEqual([]);
    await A.q(`ROLLBACK`);
    expect(await liveGoals()).toEqual([]);
    expect((await meetingRow()).goal_changes).toEqual([]);

    // Force the history step to fail: the live write (step 2) must roll back.
    await admin.q(`
      CREATE OR REPLACE FUNCTION test_fail_goal_history() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.goal_changes IS DISTINCT FROM OLD.goal_changes THEN
          RAISE EXCEPTION 'forced goal-history failure' USING ERRCODE = 'XX001';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_fail_goal_history BEFORE UPDATE ON one_on_one_meetings
        FOR EACH ROW EXECUTE FUNCTION test_fail_goal_history();`);
    try {
      const r = await A.attempt(goalSql, goalArgs(meeting, "this_week", 35));
      expect(r).toMatchObject({ ok: false, code: "XX001" });
    } finally {
      await admin.q(`DROP TRIGGER test_fail_goal_history ON one_on_one_meetings; DROP FUNCTION test_fail_goal_history()`);
    }
    expect(await liveGoals()).toEqual([]);
    expect((await meetingRow()).goal_changes).toEqual([]);
  });

  // -------------------------------------------------------------------------
  it("4. a completion already QUEUED behind a goal change does not deadlock with that change's lock upgrade", async () => {
    // The goal function takes FOR KEY SHARE, later FOR NO KEY UPDATE on the same
    // row. Reproduce with a completion queued in between (manual steps).
    const A = await session();
    const B = await session();
    await A.q(`BEGIN`);
    await A.q(`SELECT lock_open_one_on_one_meeting($1, $2)`, [meeting, AE]); // KEY SHARE
    // Expected count 1: A's upgrade below appends one goal-change entry.
    const completion = B.attempt(completeSql, [meeting, ADMIN, JSON.stringify({ version: 1 }), 1]);
    await waitBlockedBy(B.pid, A.pid); // completion's FOR UPDATE is now waiting
    // A upgrades to NO KEY UPDATE with the waiter queued: must proceed, not deadlock.
    const upgrade = await A.attempt(
      `UPDATE one_on_one_meetings SET goal_changes = goal_changes || '[{"x":1}]'::jsonb WHERE id = $1`, [meeting]);
    expect(upgrade.ok).toBe(true);
    await A.q(`COMMIT`);
    expect((await completion).ok).toBe(true);
    expect((await meetingRow()).status).toBe("completed");
  });

  it("5. autosave / commitment / Gold List / legacy writes racing a goal change and completion: each either commits before or is refused — never hangs", async () => {
    const A = await session();
    const autosave = await session();
    const B = await session();
    await A.q(`BEGIN`);
    await A.attempt(goalSql, goalArgs(meeting, "this_week", 35)); // holds NO KEY UPDATE on the meeting
    // An autosave (same row, NO KEY UPDATE) simply queues behind the goal change…
    const save = autosave.attempt(
      `UPDATE one_on_one_meetings SET wins = 'note', wins_rev = wins_rev + 1 WHERE id = $1 AND status = 'in_progress' RETURNING id`, [meeting]);
    await waitBlockedBy(autosave.pid, A.pid);
    // …and completion queues too.
    const completion = appCompletion(B, meeting);
    await A.q(`COMMIT`);
    expect((await save).ok).toBe(true);
    expect(await completion).toMatchObject({ ok: true });
    const row = await meetingRow();
    expect(row.status).toBe("completed");
    const [{ wins }] = await admin.q(`SELECT wins FROM one_on_one_meetings WHERE id = $1`, [meeting]);
    expect(wins).toBe("note");
  });

  // -------------------------------------------------------------------------
  it("7. v2.1: concurrent follow-up email saves on a COMPLETED meeting — exactly one compare-and-set wins; the frozen record never moves", async () => {
    const A = await session();
    const B = await session();
    expect((await appCompletion(A, meeting)).ok).toBe(true);
    const frozen = async () => {
      const [row] = await admin.q(
        `SELECT to_jsonb(m) - ARRAY['followup_subject','followup_subject_rev','followup_body','followup_body_rev','followup_generated_at','followup_context_hash','followup_model','updated_at'] AS frozen
           FROM one_on_one_meetings m WHERE id = $1`, [meeting]);
      return row.frozen;
    };
    const before = await frozen();
    const cas = `UPDATE one_on_one_meetings SET followup_body = $2, followup_body_rev = followup_body_rev + 1
                  WHERE id = $1 AND followup_body_rev = 0 RETURNING followup_body_rev`;

    // A holds the row (uncommitted email edit); B's edit really waits, then matches nothing.
    await A.q(`BEGIN`);
    expect((await A.attempt(cas, [meeting, "from A"])).ok).toBe(true);
    const b = B.attempt(cas, [meeting, "from B"]);
    await waitBlockedBy(B.pid, A.pid);
    await A.q(`COMMIT`);
    const rb = await b;
    expect(rb.ok && rb.rows.length).toBe(0); // stale revision: the app turns this into a 409 + current text
    expect((await admin.q(`SELECT followup_body FROM one_on_one_meetings WHERE id = $1`, [meeting]))[0].followup_body).toBe("from A");

    // The database still refuses anything but the email, even mid-contention.
    expect(await A.attempt(`UPDATE one_on_one_meetings SET wins = 'x' WHERE id = $1`, [meeting])).toMatchObject({ ok: false, code: "23514" });
    expect(await A.attempt(`UPDATE one_on_one_meetings SET followup_body = 'y', status = 'in_progress' WHERE id = $1`, [meeting])).toMatchObject({ ok: false, code: "23514" });
    expect(await A.attempt(`DELETE FROM one_on_one_meetings WHERE id = $1`, [meeting])).toMatchObject({ ok: false, code: "23514" });
    expect(await frozen()).toEqual(before);
  });

  // -------------------------------------------------------------------------
  it("6. DEADLOCK HUNT: goal changes, autosaves, commitments, Gold List + legacy writes and completion, hammered concurrently across many meetings — zero deadlocks, every outcome accounted for, invariants hold", async () => {
    const ROUNDS = Number(process.env.REAL_PG_ROUNDS ?? 25);
    const [{ deadlocks: deadlocksBefore }] = await admin.q(
      `SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`);

    const outcomes = new Map<string, number>();
    const tally = (who: string, code: string) =>
      outcomes.set(`${who}:${code}`, (outcomes.get(`${who}:${code}`) ?? 0) + 1);
    const pause = () => new Promise<void>((r) => setTimeout(r, Math.floor(Math.random() * 6)));
    const ALLOWED: Record<string, string[]> = {
      goal: ["ok", "55P03", "23514", "23505"],
      autosave: ["ok", "none"], // plain UPDATE: no lock_open; `none` = already completed (status filter)
      commitment: ["ok", "55P03", "23514"],
      gold: ["ok", "55P03", "23514", "23505"],
      legacy: ["ok", "55P03", "23514"],
      legacyOld: ["ok"],
      completion: ["ok", "23514-none"],
    };

    for (let round = 0; round < ROUNDS; round += 1) {
      const AE_ROUND = `${(round + 1).toString(16).padStart(8, "0")}-2222-4222-8222-222222222222`;
      const [m] = await seed([AE_ROUND]);
      const week = (await admin.q(
        `INSERT INTO one_on_ones (ae_id, week_start, meeting_date) VALUES ($1, '2026-09-14', '2026-09-15') RETURNING id`, [AE_ROUND]))[0].id as string;
      const legacyIds: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        legacyIds.push((await admin.q(
          `INSERT INTO one_on_one_commitments (one_on_one_id, ae_id, content) VALUES ($1, $2, 'L') RETURNING id`, [week, AE_ROUND]))[0].id as string);
      }
      const agentIds: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        agentIds.push((await admin.q(
          `INSERT INTO gold_list_agents (salesperson_id, agent_name) VALUES ($1, $2) RETURNING id`, [AE_ROUND, `Agent ${i}`]))[0].id as string);
      }

      const s = await Promise.all(Array.from({ length: 9 }, () => session()));
      const successes: Array<{ start: string; monday: string; v: number }> = [];
      let n = 0;

      const goalWorker = (sess: Session, base: number) => async () => {
        for (let i = 0; i < 6; i += 1) {
          await pause();
          const start = Math.random() < 0.7 ? "this_week" : "next_week";
          const v = base + i;
          const r = await sess.attempt(goalSql, [m, AE_ROUND, start, start === "this_week" ? THIS_MONDAY : NEXT_MONDAY,
            JSON.stringify(goals(v)), ADMIN]);
          tally("goal", r.ok ? "ok" : r.code);
          if (r.ok) successes.push({ start, monday: start === "this_week" ? THIS_MONDAY : NEXT_MONDAY, v });
        }
      };
      const workers: Array<() => Promise<void>> = [
        goalWorker(s[0], 100), goalWorker(s[1], 200), goalWorker(s[2], 300),
        async () => { // autosave
          for (let i = 0; i < 8; i += 1) {
            await pause();
            const r = await s[3].attempt(
              `UPDATE one_on_one_meetings SET wins = $2, wins_rev = wins_rev + 1 WHERE id = $1 AND status = 'in_progress' RETURNING id`, [m, `w${i}`]);
            tally("autosave", r.ok ? (r.rows.length ? "ok" : "none") : r.code);
          }
        },
        async () => { // commitments (attributed to the meeting)
          for (let i = 0; i < 6; i += 1) {
            await pause();
            const r = await s[4].attempt(
              `INSERT INTO one_on_one_meeting_commitments (ae_id, origin_meeting_id, description) VALUES ($1, $2, $3)`, [AE_ROUND, m, `c${i}`]);
            tally("commitment", r.ok ? "ok" : r.code);
          }
        },
        async () => { // Gold List action attributed to the meeting
          for (let i = 0; i < agentIds.length; i += 1) {
            await pause();
            const r = await s[5].attempt(
              `INSERT INTO gold_list_activities (agent_id, salesperson_id, scheduled_for, description, created_in_meeting_id, created_by)
               VALUES ($1, $2, '2026-10-01', 'Coffee', $3, $4)`, [agentIds[i], AE_ROUND, m, ADMIN]);
            tally("gold", r.ok ? "ok" : r.code);
          }
        },
        async () => { // legacy Weekly Focus, from inside the 1:1
          for (let i = 0; i < 6; i += 1) {
            await pause();
            const r = await s[6].attempt(`SELECT update_legacy_commitment_in_one_on_one($1, $2, $3::jsonb)`,
              [m, legacyIds[i % 3], JSON.stringify({ content: `lc${i}` })]);
            tally("legacy", r.ok ? "ok" : r.code);
          }
        },
        async () => { // the ORIGINAL Weekly Focus route's write (old client)
          for (let i = 0; i < 6; i += 1) {
            await pause();
            const r = await s[7].attempt(`SELECT update_legacy_commitment($1, $2, $3::jsonb)`,
              [week, legacyIds[i % 3], JSON.stringify({ content: `old${i}` })]);
            tally("legacyOld", r.ok ? "ok" : r.code);
          }
        },
        async () => { // completion, mid-storm
          await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 60)));
          const r = await appCompletion(s[8], m, pause, AE_ROUND);
          n = r.attempts;
          tally("completion", r.ok ? "ok" : r.code);
        },
      ];
      await Promise.all(workers.map((w) => w()));
      void n;

      // ---- invariants for this meeting ----
      const row = await meetingRow(m);
      expect(row.status, `round ${round}: completion must succeed`).toBe("completed");
      const history = row.goal_changes as Array<{ start: string; effective_from: string; values: { office_visits: number } }>;
      // Every committed goal change is in history, and ONLY those (atomic: no phantom, no omission).
      expect(history.length, `round ${round}: history vs committed changes`).toBe(successes.length);
      expect([...history.map((h) => `${h.effective_from}:${h.values.office_visits}`)].sort())
        .toEqual([...successes.map((x) => `${x.monday}:${x.v}`)].sort());
      // Live goals equal the LAST recorded change per Monday (history is append-ordered under the lock).
      for (const monday of [THIS_MONDAY, NEXT_MONDAY]) {
        const last = history.filter((h) => h.effective_from === monday).at(-1);
        const live = (await admin.q(`SELECT office_visits FROM weekly_goals WHERE salesperson_id = $1 AND effective_from = $2`, [AE_ROUND, monday]))[0];
        expect(live?.office_visits, `round ${round}: live goal @ ${monday}`).toBe(last?.values.office_visits);
      }
      // The frozen comparison used exactly the goal the history ends on.
      const lastThisWeek = history.filter((h) => h.effective_from === THIS_MONDAY).at(-1)?.values.office_visits ?? BASELINE_GOAL;
      expect((row.activity_snapshot as { this_week_office_visits_goal: number }).this_week_office_visits_goal,
        `round ${round}: snapshot goal vs history`).toBe(lastThisWeek);
      for (const x of s) await x.c.end().catch(() => undefined);
      open.length = 0;
    }

    // ---- global invariants ----
    const unexpected = [...outcomes.keys()].filter((k) => {
      const [who, code] = k.split(":");
      return !(ALLOWED[who] ?? []).includes(code);
    });
    console.log(`[real-pg] deadlock hunt, ${ROUNDS} rounds, outcomes: ${JSON.stringify(Object.fromEntries([...outcomes].sort()))}`);
    expect(unexpected, "every statement ended in an accounted-for outcome (no 40P01 deadlock, no other error)").toEqual([]);
    expect([...outcomes.keys()].some((k) => k.endsWith(":40P01"))).toBe(false);
    // The server's own counter.
    await new Promise((r) => setTimeout(r, 1500));
    const [{ deadlocks: deadlocksAfter }] = await admin.q(
      `SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`);
    expect(Number(deadlocksAfter) - Number(deadlocksBefore)).toBe(0);
    // The storm really exercised contention, not just the happy path.
    expect([...outcomes].filter(([k]) => k.startsWith("goal:ok")).reduce((a, [, v]) => a + v, 0)).toBeGreaterThan(0);
  }, 300_000);
});
