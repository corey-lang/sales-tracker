/**
 * Boots a REAL PostgreSQL (the `embedded-postgres` npm package — real server
 * binaries, not a project dependency) or connects to REAL_PG_URL, applies the
 * project's actual migrations, and hands out independent backend connections
 * running as the non-superuser `service_role`. For the opt-in real-PG
 * concurrency suites; see supabase/swag-leads-concurrency.realpg.test.ts.
 *
 *   REAL_PG=1 REAL_PG_MODULES=/dir/with/node_modules npx vitest run <suite>
 *   (mkdir /tmp/realpg && cd /tmp/realpg && npm i embedded-postgres pg)
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { DRIFT_SQL, MIGRATIONS, STORAGE_STUB_SQL } from "@/test/pglite-supabase";

export type Row = Record<string, unknown>;
type PgClient = {
  processID: number;
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
  end(): Promise<void>;
};

export const REAL_PG_ENABLED = process.env.REAL_PG === "1" || Boolean(process.env.REAL_PG_URL);

export type Attempt = { ok: true; rows: Row[] } | { ok: false; code: string; message: string };

export class Session {
  constructor(readonly c: PgClient) {}
  get pid() {
    return this.c.processID;
  }
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

export async function startRealPg() {
  const base = process.env.REAL_PG_MODULES ?? process.cwd();
  const req = createRequire(join(base, "noop.js"));
  const pg = req("pg") as { Client: new (cfg: unknown) => PgClient };

  let connect: () => Promise<PgClient>;
  let stopServer: () => Promise<void> = async () => {};
  if (process.env.REAL_PG_URL) {
    const url = process.env.REAL_PG_URL;
    connect = async () => {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      return c;
    };
  } else {
    const EmbeddedPostgres = (
      (await import(pathToFileURL(req.resolve("embedded-postgres")).href)) as {
        default: new (cfg: unknown) => { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
      }
    ).default;
    const port = await new Promise<number>((resolve) => {
      const srv = createServer();
      srv.listen(0, () => {
        const p = (srv.address() as { port: number }).port;
        srv.close(() => resolve(p));
      });
    });
    const dir = mkdtempSync(join(tmpdir(), "realpg-"));
    const server = new EmbeddedPostgres({
      databaseDir: join(dir, "data"), user: "postgres", password: "pw", port, persistent: false,
      onLog: () => undefined, onError: () => undefined,
    });
    await server.initialise();
    await server.start();
    stopServer = async () => {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    };
    connect = async () => {
      const c = new pg.Client({ host: "localhost", port, user: "postgres", password: "pw", database: "postgres" });
      await c.connect();
      return c;
    };
  }

  const admin = new Session(await connect());
  const [{ v: version }] = (await admin.q(`SELECT version() AS v`)) as Array<{ v: string }>;
  await admin.q(`SET TIME ZONE 'UTC'`);
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
      file === "DRIFT"
        ? DRIFT_SQL
        : file === "STORAGE_STUB"
          ? STORAGE_STUB_SQL
          : readFileSync(join(process.cwd(), "supabase", file), "utf8"),
    );
  }
  const tables = (await admin.q(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).map(
    (r) => r.tablename as string,
  );

  const open: Session[] = [];
  return {
    admin,
    version,
    tables,
    /** A new backend connection acting as the app does: non-superuser service_role. */
    async session(): Promise<Session> {
      const s = new Session(await connect());
      await s.q(`SET ROLE service_role`);
      open.push(s);
      return s;
    },
    async closeSessions() {
      for (const s of open.splice(0)) await s.c.end().catch(() => undefined);
    },
    /** Polls until backend `pid` is WAITING on a lock held by `holder` — a real lock wait. */
    async waitBlockedBy(pid: number, holder: number) {
      for (let i = 0; i < 200; i += 1) {
        const [row] = await admin.q(`SELECT pg_blocking_pids($1) AS b`, [pid]);
        if ((row.b as number[]).includes(holder)) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`backend ${pid} never blocked on ${holder}`);
    },
    async reset() {
      await admin.q(`TRUNCATE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
    },
    async stop() {
      for (const s of open.splice(0)) await s.c.end().catch(() => undefined);
      await admin.c.end().catch(() => undefined);
      await stopServer();
    },
  };
}

/** True while `p` has not settled within `ms` (i.e. it is genuinely waiting). */
export async function isPending(p: Promise<unknown>, ms = 300): Promise<boolean> {
  return (await Promise.race([p.then(() => "done"), new Promise((r) => setTimeout(() => r("pending"), ms))])) === "pending";
}
