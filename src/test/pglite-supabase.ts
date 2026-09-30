/**
 * Test harness: a REAL Postgres (PGlite, in-process WASM) with the project's
 * actual migrations applied, behind a minimal supabase-js-compatible client.
 *
 * WHY
 *   The 1:1 workspace's correctness lives partly in the database — the
 *   one-in-progress-meeting index, the freeze + lock triggers, and the
 *   transactional complete_one_on_one_meeting() function. Route tests that
 *   fake Supabase in JS can only re-implement those rules; these tests run
 *   the real SQL from supabase/*.sql.
 *
 * WHAT'S SUPPORTED
 *   Only the PostgREST surface the 1:1 / coaching / Gold List server code
 *   uses: select (plain column lists), insert, update, upsert(onConflict),
 *   delete, eq / neq / is / in / gt / gte / lt / lte / not(is null) / or(),
 *   order (PostgREST null ordering), limit, range, single, maybeSingle, and
 *   rpc() for functions returning a row, plus one embedded many-to-one
 *   resource (`table:fk_column(cols)` or `salespeople(cols)`). Responses are truncated to
 *   POSTGREST_MAX_ROWS like the real API. `db.anon` is the same client
 *   running as the `anon` role (RLS + column grants apply) — what a browser
 *   holding only the public key can do. Anything else throws, so a test
 *   can't silently pass through an unsupported query.
 *
 * PRIVILEGES
 *   Migrations run as the owner; everything the app does afterwards runs as
 *   a NON-superuser `service_role` (BYPASSRLS, table privileges like
 *   Supabase's defaults, but NO default function grants). So a function the
 *   server calls without an explicit GRANT fails here instead of in prod.
 *
 * LIMITATION
 *   PGlite is a single connection, so two transactions can't block each
 *   other here. Race tests inject the competing statement between a route's
 *   check and its write via `beforeWrite()`; lock-wait behavior itself is
 *   stock Postgres.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";

const SUPABASE_DIR = join(process.cwd(), "supabase");

/**
 * Real migrations, in README order, limited to what these tables need.
 * `DRIFT` recreates production columns that no migration file declares
 * (see supabase/README.md "Authoritative vs. drifted").
 */
export const MIGRATIONS = [
  "schema.sql",
  "add_role.sql",
  "salespeople_auth_columns.sql",
  "STORAGE_STUB",
  "business_card_scans.sql",
  "business_card_scans_phase5.sql",
  "business_card_contacts.sql",
  "business_card_rls.sql",
  "business_card_crm_hardening.sql",
  "business_card_phone_contact.sql",
  "business_card_image_rotation.sql",
  "ae_tasks.sql",
  "add_juice_box_only_role.sql",
  "manager_one_on_ones.sql",
  "weekly_focus.sql",
  "weekly_focus_v2.sql",
  "DRIFT",
  "weekly_goals_lockdown.sql",
  "offices.sql",
  "salespeople_can_import_offices.sql",
  "offices_persistent_notes.sql",
  "offices_badger_fields.sql",
  "offices_next_action_due_date.sql",
  "ae_tasks_office_link.sql",
  "offices_archived_at.sql",
  "working_day_adjustments.sql",
  "salespeople_state_code.sql",
  "salespeople_deactivated_at.sql",
  "gold_list.sql",
  "one_on_one_meetings.sql",
  "one_on_one_workspace_v2.sql",
  "one_on_one_followup_v2_1.sql",
  "replace_activity_week.sql",
  "cogent_territory_mappings.sql",
  "team_messages.sql",
  "juice_box_pass4_conversations.sql",
  "private_test_accounts.sql",
];

/** Just enough of Supabase's `storage` schema for business_card_scans.sql. */
export const STORAGE_STUB_SQL = `
  CREATE SCHEMA IF NOT EXISTS storage;
  CREATE TABLE IF NOT EXISTS storage.buckets (id TEXT PRIMARY KEY, name TEXT, public BOOLEAN);
  CREATE TABLE IF NOT EXISTS storage.objects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id TEXT, name TEXT
  );
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
`;

/**
 * PostgREST's `max-rows` (Supabase default 1000): every response is silently
 * truncated to it, whatever `limit`/`range` asked for. The fake enforces the
 * same so a test with more rows than that reproduces the truncation risk.
 */
export const POSTGREST_MAX_ROWS = 1000;

export const DRIFT_SQL = `
  CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    salesperson_id UUID REFERENCES salespeople(id) ON DELETE CASCADE,
    body TEXT NOT NULL DEFAULT '',
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE weekly_goals ADD COLUMN IF NOT EXISTS salesperson_id UUID REFERENCES salespeople(id);
  ALTER TABLE weekly_goals ADD COLUMN IF NOT EXISTS presentations INT DEFAULT 0;
  ALTER TABLE weekly_goals ADD COLUMN IF NOT EXISTS created_by UUID;
  ALTER TABLE activity_entries ADD COLUMN IF NOT EXISTS presentations INT DEFAULT 0;
`;

type Role = "service_role" | "anon" | "authenticated";
type Row = Record<string, unknown>;
type PgError = { code: string; message: string };
type Result = { data: unknown; error: PgError | null; count?: number | null };

export type WriteKind = "insert" | "update" | "upsert" | "delete" | "rpc";
type Hook = { table: string; kind: WriteKind; fn: () => Promise<void> };

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`pglite-supabase: unsupported identifier "${name}"`);
  return `"${name}"`;
}

function toIso(v: string): string {
  // Postgres text "2026-09-29 18:00:00.123456+00" → "2026-09-29T18:00:00.123456+00:00",
  // keeping full microsecond precision the way PostgREST does, so keyset
  // cursors round-trip exactly (session time zone is UTC).
  return v.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
}

/** Splits a PostgREST logic list on top-level commas. */
function splitTopLevel(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (const ch of expr) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === "(") depth += 1;
    if (!quoted && ch === ")") depth -= 1;
    if (!quoted && ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** A column VALUE (insert/update payload, rpc arg): objects/arrays are jsonb. */
function value(v: unknown): unknown {
  if (v !== null && typeof v === "object" && !(v instanceof Date)) return JSON.stringify(v);
  return v;
}

export async function createTestDb(
  opts: {
    /**
     * Override the migration order. Entries are file names under supabase/,
     * or `inline:<sql>` for a literal statement (e.g. a legacy seed).
     */
    migrations?: string[];
  } = {},
) {
  const pg = new PGlite({
    extensions: { citext },
    parsers: {
      1184: (v: string) => toIso(v), // timestamptz
      1114: (v: string) => toIso(v), // timestamp
      1082: (v: string) => v, // date stays yyyy-mm-dd, like PostgREST
    },
  });
  await pg.exec(`
    SET TIME ZONE 'UTC';
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE PUBLICATION supabase_realtime;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  `);
  for (const file of opts.migrations ?? MIGRATIONS) {
    await pg.exec(
      file === "DRIFT"
        ? DRIFT_SQL
        : file === "STORAGE_STUB"
          ? STORAGE_STUB_SQL
          : file.startsWith("inline:")
            ? file.slice("inline:".length)
            : readFileSync(join(SUPABASE_DIR, file), "utf8"),
    );
  }
  await pg.exec(`SET ROLE service_role`);
  const tables = (
    await pg.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    )
  ).rows.map((r) => r.tablename);

  let hooks: Hook[] = [];

  async function run(
    sql: string,
    params: unknown[],
    role: Role = "service_role",
  ): Promise<Result & { rows: Row[] }> {
    try {
      // anon/authenticated run inside a transaction with SET LOCAL ROLE so the
      // switch can't leak into (or interleave with) another statement.
      const res =
        role === "service_role"
          ? await pg.query<Row>(sql, params)
          : await pg.transaction(async (tx) => {
              await tx.exec(`SET LOCAL ROLE ${role}`);
              return tx.query<Row>(sql, params);
            });
      return { data: res.rows, rows: res.rows, error: null };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { data: null, rows: [], error: { code: e.code ?? "XX000", message: e.message ?? String(err) } };
    }
  }

  class Query implements PromiseLike<Result> {
    private where: string[] = [];
    private params: unknown[] = [];
    private columns = "*";
    private returning: string | null = null;
    private orderBy: string[] = [];
    private limitN: number | null = null;
    private offsetN = 0;
    private op: { kind: "select" } | { kind: WriteKind; payload?: Row | Row[]; onConflict?: string[] } = {
      kind: "select",
    };

    constructor(
      private table: string,
      private role: Role,
    ) {
      ident(table);
    }

    private p(v: unknown): string {
      this.params.push(v);
      return `$${this.params.length}`;
    }

    private cols(list: string): string {
      const trimmed = list.trim();
      if (trimmed === "*" || trimmed === "") return "*";
      return splitTopLevel(trimmed)
        .map((c) => {
          const col = c.trim();
          // Embedded many-to-one: `alias:fk_column(a, b)` where alias is the
          // related TABLE (PostgREST resolves it through the foreign key).
          const emb = /^([a-z_][a-z0-9_]*)(?::([a-z_][a-z0-9_]*))?\((.*)\)$/.exec(col);
          if (emb) {
            const [, rel, explicitFk, inner] = emb;
            // `salespeople(...)` alone resolves through salesperson_id.
            const fk = explicitFk ?? (rel === "salespeople" ? "salesperson_id" : null);
            if (!fk) throw new Error(`pglite-supabase: embed "${col}" needs alias:fk_column`);
            const innerCols = inner.split(",").map((x) => ident(x.trim())).join(", ");
            return `(SELECT to_jsonb(e) FROM (SELECT ${innerCols} FROM ${ident(rel)} WHERE ${ident(rel)}."id" = ${ident(this.table)}.${ident(fk)}) e) AS ${ident(rel)}`;
          }
          return ident(col);
        })
        .join(", ");
    }

    select(list = "*") {
      if (this.op.kind === "select") this.columns = this.cols(list);
      else this.returning = this.cols(list);
      return this;
    }
    insert(payload: Row | Row[]) {
      this.op = { kind: "insert", payload };
      return this;
    }
    update(payload: Row) {
      this.op = { kind: "update", payload };
      return this;
    }
    upsert(payload: Row | Row[], opts: { onConflict: string }) {
      this.op = { kind: "upsert", payload, onConflict: opts.onConflict.split(",").map((c) => c.trim()) };
      return this;
    }
    delete(_opts?: { count?: "exact" }) {
      void _opts;
      this.op = { kind: "delete" };
      return this;
    }

    eq(c: string, v: unknown) {
      this.where.push(`${ident(c)} = ${this.p(v)}`);
      return this;
    }
    neq(c: string, v: unknown) {
      this.where.push(`${ident(c)} IS DISTINCT FROM ${this.p(v)}`);
      return this;
    }
    is(c: string, v: null | boolean) {
      this.where.push(`${ident(c)} IS ${v === null ? "NULL" : v ? "TRUE" : "FALSE"}`);
      return this;
    }
    in(c: string, v: unknown[]) {
      this.where.push(v.length ? `${ident(c)} = ANY(${this.p(v)})` : "FALSE");
      return this;
    }
    gt(c: string, v: unknown) {
      this.where.push(`${ident(c)} > ${this.p(v)}`);
      return this;
    }
    gte(c: string, v: unknown) {
      this.where.push(`${ident(c)} >= ${this.p(v)}`);
      return this;
    }
    lt(c: string, v: unknown) {
      this.where.push(`${ident(c)} < ${this.p(v)}`);
      return this;
    }
    lte(c: string, v: unknown) {
      this.where.push(`${ident(c)} <= ${this.p(v)}`);
      return this;
    }
    not(c: string, operator: string, v: unknown) {
      if (operator !== "is" || v !== null) throw new Error("pglite-supabase: unsupported not()");
      this.where.push(`${ident(c)} IS NOT NULL`);
      return this;
    }
    /** PostgREST logic tree: `a.eq.1,and(b.gt.2,c.is.null)`, quoted values ok. */
    private logic(expr: string, joiner: "OR" | "AND"): string {
      const parts = splitTopLevel(expr).map((term) => {
        const nested = /^(and|or)\((.*)\)$/.exec(term);
        if (nested) return this.logic(nested[2], nested[1] === "and" ? "AND" : "OR");
        const [col, op, ...rest] = term.split(".");
        const val = rest.join(".").replace(/^"(.*)"$/, "$1");
        const c = ident(col);
        if (op === "is" && val === "null") return `${c} IS NULL`;
        if (op === "in") {
          const list = val.replace(/^\(|\)$/g, "").split(",").filter(Boolean);
          return list.length ? `${c} = ANY(${this.p(list)})` : "FALSE";
        }
        const ops: Record<string, string> = { eq: "=", gte: ">=", lte: "<=", gt: ">", lt: "<" };
        if (!ops[op]) throw new Error(`pglite-supabase: unsupported logic op "${op}"`);
        return `${c} ${ops[op]} ${this.p(val)}`;
      });
      return `(${parts.join(` ${joiner} `)})`;
    }
    or(expr: string) {
      this.where.push(this.logic(expr, "OR"));
      return this;
    }
    order(c: string, o: { ascending?: boolean; nullsFirst?: boolean } = {}) {
      const asc = o.ascending !== false;
      const nullsFirst = o.nullsFirst ?? !asc; // PostgREST default
      this.orderBy.push(`${ident(c)} ${asc ? "ASC" : "DESC"} NULLS ${nullsFirst ? "FIRST" : "LAST"}`);
      return this;
    }
    limit(n: number) {
      this.limitN = n;
      return this;
    }
    range(from: number, to: number) {
      this.offsetN = from;
      this.limitN = to - from + 1;
      return this;
    }

    private whereSql(): string {
      return this.where.length ? ` WHERE ${this.where.join(" AND ")}` : "";
    }

    private build(): string {
      const t = ident(this.table);
      const ret = ` RETURNING ${this.returning ?? "*"}`;
      if (this.op.kind === "select") {
        let sql = `SELECT ${this.columns} FROM ${t}${this.whereSql()}`;
        if (this.orderBy.length) sql += ` ORDER BY ${this.orderBy.join(", ")}`;
        // PostgREST max-rows: never more than the cap, whatever was asked.
        sql += ` LIMIT ${Math.min(this.limitN ?? POSTGREST_MAX_ROWS, POSTGREST_MAX_ROWS)}`;
        if (this.offsetN) sql += ` OFFSET ${this.offsetN}`;
        return sql;
      }
      if (this.op.kind === "delete") return `DELETE FROM ${t}${this.whereSql()}${ret}`;
      if (this.op.kind === "update") {
        const sets = Object.entries(this.op.payload as Row).map(
          ([k, v]) => `${ident(k)} = ${this.p(value(v))}`,
        );
        return `UPDATE ${t} SET ${sets.join(", ")}${this.whereSql()}${ret}`;
      }
      // insert / upsert
      const list = Array.isArray(this.op.payload) ? this.op.payload : [this.op.payload as Row];
      const keys = [...new Set(list.flatMap((r) => Object.keys(r)))];
      const values = list.map(
        (r) => `(${keys.map((k) => (k in r ? this.p(value(r[k])) : "DEFAULT")).join(", ")})`,
      );
      let sql = `INSERT INTO ${t} (${keys.map(ident).join(", ")}) VALUES ${values.join(", ")}`;
      if (this.op.kind === "upsert") {
        const conflict = this.op.onConflict!;
        const updates = keys.filter((k) => !conflict.includes(k));
        sql += ` ON CONFLICT (${conflict.map(ident).join(", ")}) DO ${
          updates.length
            ? `UPDATE SET ${updates.map((k) => `${ident(k)} = EXCLUDED.${ident(k)}`).join(", ")}`
            : "NOTHING"
        }`;
      }
      return sql + ret;
    }

    private async exec(): Promise<Result> {
      if (this.op.kind !== "select") {
        const idx = hooks.findIndex((h) => h.table === this.table && h.kind === this.op.kind);
        if (idx >= 0) {
          const [hook] = hooks.splice(idx, 1);
          await hook.fn();
        }
      }
      const sql = this.build();
      const res = await run(sql, this.params, this.role);
      // `{ count: "exact" }` on writes: the affected row count.
      return {
        data: res.data,
        error: res.error,
        count: this.op.kind === "select" ? undefined : res.rows.length,
      };
    }

    async single(): Promise<Result> {
      const res = await this.exec();
      if (res.error) return res;
      const rows = res.data as Row[];
      if (rows.length !== 1)
        return { data: null, error: { code: "PGRST116", message: `expected 1 row, got ${rows.length}` } };
      return { data: rows[0], error: null };
    }
    async maybeSingle(): Promise<Result> {
      const res = await this.exec();
      if (res.error) return res;
      const rows = res.data as Row[];
      if (rows.length > 1)
        return { data: null, error: { code: "PGRST116", message: `expected 0-1 rows, got ${rows.length}` } };
      return { data: rows[0] ?? null, error: null };
    }
    then<A = Result, B = never>(
      ok?: ((v: Result) => A | PromiseLike<A>) | null,
      bad?: ((e: unknown) => B | PromiseLike<B>) | null,
    ): PromiseLike<A | B> {
      return this.exec().then(ok, bad);
    }
  }

  const makeClient = (role: Role) => ({
    from: (table: string) => new Query(table, role),
    /** rpc() for a function that RETURNS one row (composite). */
    async rpc(fn: string, args: Row): Promise<Result> {
      const idx = hooks.findIndex((h) => h.table === fn && h.kind === "rpc");
      if (idx >= 0) {
        const [hook] = hooks.splice(idx, 1);
        await hook.fn();
      }
      const entries = Object.entries(args);
      const call = entries.map(([k], i) => `${ident(k)} => $${i + 1}`).join(", ");
      const res = await run(
        `SELECT * FROM ${ident(fn)}(${call})`,
        entries.map(([, v]) => value(v)),
        role,
      );
      if (res.error) return { data: null, error: res.error };
      return { data: res.rows[0] ?? null, error: null };
    },
  });
  const client = makeClient("service_role");

  return {
    pg,
    client,
    /** The browser's view: same API as `client`, but as the `anon` role. */
    anon: makeClient("anon"),
    /** Empties every table (no row triggers fire on TRUNCATE). */
    async reset() {
      hooks = [];
      await pg.exec(
        `RESET ROLE; TRUNCATE ${tables.map(ident).join(", ")} RESTART IDENTITY CASCADE; SET ROLE service_role;`,
      );
    },
    /** Runs `fn` just before the next `kind` write to `table` (or, for
     *  kind "rpc", the next call of function `table`) — a race window. */
    beforeWrite(table: string, kind: WriteKind, fn: () => Promise<void>) {
      hooks.push({ table, kind, fn });
    },
    /** Runs raw SQL as the database owner (e.g. re-applying a migration). */
    async asOwner(text: string): Promise<void> {
      await pg.exec(`RESET ROLE`);
      try {
        await pg.exec(text);
      } finally {
        // A failing statement must not leave the connection as the owner.
        await pg.exec(`SET ROLE service_role`);
      }
    },
    async sql<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> {
      return (await pg.query<T>(text, params.map(value))).rows;
    },
  };
}

export type TestDb = Awaited<ReturnType<typeof createTestDb>>;
