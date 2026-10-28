/**
 * Transferring James's DFW West book to Kimberlee — runs the REAL
 * supabase/onboard_kimberlee_dfw_west.sql then transfer_james_dfw_west_to_kimberlee.sql
 * against a REAL Postgres (PGlite + the project's migrations), and checks the
 * result through the real routes.
 *
 * Pinned rules: only offices + Gold List agents move; every other column on a
 * moved row is untouched (notes, next actions, contact details, ids, external
 * ids); James is recorded as the previous owner; his activity, visits and Juice
 * Box posts stay attributed to him; unsafe or ambiguous situations leave rows
 * with James and say so, or stop without changing anything; re-running is safe.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDb, type TestDb } from "@/test/pglite-supabase";

process.env.SESSION_SECRET = "test-session-secret";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ getServerSupabase: () => holder.client }));
vi.mock("@/lib/server/push", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fanOutJuiceBoxPush: vi.fn(),
}));

const { signSessionToken } = await import("@/lib/server/auth");
const mapRoute = await import("./offices/map/route");
const officesRoute = await import("./offices/route");
const goldRoute = await import("./gold-list/agents/route");
const messagesRoute = await import("./team-messages/route");
const importRoute = await import("./admin/offices/import/route");

const JAMES = "5f156683-b660-4684-b673-1afd5709fa27";
const HILARY = "9dd4ed6d-3216-4b49-8549-2489406aeedb";
const COREY = "0eae4385-dffd-4df9-ba17-0538ae7811e9";

type Row = Record<string, unknown>;

const read = (f: string) => readFileSync(join(process.cwd(), "supabase", f), "utf8");
const ONBOARD = read("onboard_kimberlee_dfw_west.sql");
const TRANSFER = read("transfer_james_dfw_west_to_kimberlee.sql");
const LEFTOVERS = read("transfer_james_dfw_west_leftovers.sql");
const N_OFFICES = 40;
const N_AGENTS = 6;
/** The shipped transfer script with the approved counts swapped for the fixture's. */
const transferFor = (offices = N_OFFICES, agents = N_AGENTS) =>
  TRANSFER.replace("v_expected_offices CONSTANT INTEGER := 1751;", `v_expected_offices CONSTANT INTEGER := ${offices};`).replace(
    "v_expected_agents  CONSTANT INTEGER := 15;",
    `v_expected_agents  CONSTANT INTEGER := ${agents};`,
  );

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  holder.client = db.client;
}, 60_000);

const tok = (id: string, role = "ae") => signSessionToken({ sub: id, role: role as never, name: "x" });
const call = (fn: (r: Request) => Promise<Response>, path: string, who: string, init: { method?: string; body?: unknown; role?: string } = {}) =>
  fn(
    new Request(`http://localhost${path}`, {
      method: init.method ?? "GET",
      headers: { ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${tok(who, init.role)}` },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    }),
  );

const OFFICE_COLS = "id, name, street, city, state, zip, latitude, longitude, source, dedupe_key, environment, office_notes, next_action, next_action_due_date, office_phone, office_email, external_badger_id, import_batch_id, archived_at, created_at";
const AGENT_COLS = "id, agent_name, brokerage, phone, email, notes, archived_at, created_at, created_by, created_in_meeting_id, edited_by, edited_in_meeting_id, edited_at";

async function seed() {
  await db.reset();
  await db.sql(
    `INSERT INTO salespeople (id, first_name, role, is_test) VALUES ($1,'James','ae',false), ($2,'Hilary','ae',false), ($3,'Corey','admin',false)`,
    [JAMES, HILARY, COREY],
  );
  await db.sql(`INSERT INTO cogent_territory_mappings (sales_territory_name, salesperson_id) VALUES ('DFW West',$1)`, [JAMES]);
  const batch = (await db.sql<{ id: string }>(`INSERT INTO office_import_batches (source, uploaded_by, environment, row_count) VALUES ('Badger CSV',$1,'production',$2) RETURNING id`, [JAMES, N_OFFICES]))[0].id;
  // James's Badger book: stable external ids, coordinates, a couple of notes.
  await db.sql(
    `INSERT INTO offices (salesperson_id, name, street, latitude, longitude, source, dedupe_key, environment, external_badger_id, import_batch_id, office_notes, office_phone)
     SELECT $1, 'DFW Office ' || g, g || ' Elm St', 32.7 + g * 0.001, -97.1 - g * 0.001, 'Badger CSV', 'dfw office ' || g || '|' || g || ' elm st|', 'production',
            'badger-' || g, $2, CASE WHEN g IN (3, 7) THEN 'Met the broker; wants lunch-and-learn' END, CASE WHEN g = 5 THEN '817-555-0100' END
       FROM generate_series(1, $3::int) g`,
    [JAMES, batch, N_OFFICES],
  );
  await db.sql(`UPDATE offices SET next_action = 'Follow up on proposal', next_action_due_date = '2026-11-10' WHERE salesperson_id = $1 AND name = 'DFW Office 7'`, [JAMES]);
  const oid = (await db.sql<{ id: string }>(`SELECT id FROM offices WHERE name = 'DFW Office 3'`))[0].id;
  await db.sql(`INSERT INTO office_visits (office_id, salesperson_id, note, visited_at) VALUES ($1,$2,'dropped off donuts','2026-06-23T20:00:00Z')`, [oid, JAMES]);
  await db.sql(
    `INSERT INTO gold_list_agents (salesperson_id, agent_name, brokerage, phone, email, notes)
     SELECT $1, 'Agent ' || g, 'Keller Williams DFW', '214-555-01' || lpad(g::text, 2, '0'), 'agent' || g || '@kw.test', 'Top producer. Prefers texts. Kids: ' || g
       FROM generate_series(1, $2::int) g`,
    [JAMES, N_AGENTS],
  );
  for (const [d, n] of [["2026-10-19", 4], ["2026-10-20", 6]]) {
    await db.sql(`INSERT INTO activity_entries (salesperson_id, entry_date, office_visits) VALUES ($1,$2,$3)`, [JAMES, d, n]);
  }
  const post = await call(messagesRoute.POST, "/api/team-messages", JAMES, { method: "POST", body: { message: "Dallas is on fire" } });
  expect(post.status).toBeLessThan(300);
}

/** The two scripts, in the required order. */
async function onboardThenTransfer() {
  await db.asOwner(ONBOARD);
  await db.asOwner(transferFor());
}

async function snapshot() {
  const kim = (await db.sql<{ id: string }>(`SELECT id FROM salespeople WHERE first_name='Kimberlee'`))[0]?.id;
  return {
    offices: await db.sql<Row>(`SELECT ${OFFICE_COLS}, salesperson_id, transferred_from_salesperson_id FROM offices ORDER BY name`),
    agents: await db.sql<Row>(`SELECT ${AGENT_COLS}, salesperson_id, transferred_from_salesperson_id FROM gold_list_agents ORDER BY agent_name`),
    kim,
  };
}
/** Everything James produced that must never move. */
async function history() {
  const q = (sql: string) => db.sql<Row>(sql, [JAMES]);
  return {
    activity: await q(`SELECT * FROM activity_entries WHERE salesperson_id=$1 ORDER BY entry_date`),
    visits: await q(`SELECT * FROM office_visits WHERE salesperson_id=$1 ORDER BY id`),
    messages: await q(`SELECT * FROM team_messages WHERE salesperson_id=$1::text ORDER BY id`),
    batches: await q(`SELECT * FROM office_import_batches WHERE uploaded_by=$1 ORDER BY id`),
  };
}

beforeEach(seed);

describe("transfer: what moves", () => {
  it("moves every office and every Gold List agent to Kimberlee and records James as the previous owner", async () => {
    await onboardThenTransfer();
    const { offices, agents, kim } = await snapshot();
    expect(offices).toHaveLength(N_OFFICES);
    expect(agents).toHaveLength(N_AGENTS);
    for (const r of [...offices, ...agents]) {
      expect(r.salesperson_id).toBe(kim);
      expect(r.transferred_from_salesperson_id).toBe(JAMES);
    }
    expect((await db.sql(`SELECT 1 FROM offices WHERE transferred_at IS NOT NULL`))).toHaveLength(N_OFFICES);
    expect((await db.sql(`SELECT 1 FROM gold_list_agents WHERE transferred_at IS NOT NULL`))).toHaveLength(N_AGENTS);
    expect(await db.sql(`SELECT 1 FROM offices WHERE salesperson_id=$1`, [JAMES])).toHaveLength(0);
    expect(await db.sql(`SELECT 1 FROM gold_list_agents WHERE salesperson_id=$1`, [JAMES])).toHaveLength(0);
  });

  it("changes NOTHING else on those rows: ids, notes, next actions, contacts, external ids, coordinates, import batch", async () => {
    await db.asOwner(ONBOARD);
    const before = await snapshot();
    await db.asOwner(transferFor());
    const after = await snapshot();
    // Everything except the two columns the transfer is allowed to change.
    const strip = (rows: Row[]) =>
      rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "salesperson_id" && k !== "transferred_from_salesperson_id")));
    expect(strip(after.offices)).toEqual(strip(before.offices));
    expect(strip(after.agents)).toEqual(strip(before.agents));
    // Spot-check the ones that carry real information.
    const seven = after.offices.find((o) => o.name === "DFW Office 7")!;
    expect(seven).toMatchObject({ office_notes: "Met the broker; wants lunch-and-learn", next_action: "Follow up on proposal", external_badger_id: "badger-7" });
    expect(after.agents[0].notes).toMatch(/Top producer/);
    expect(after.offices.every((o) => o.latitude !== null && o.import_batch_id !== null)).toBe(true);
  });

  it("keeps James's history attributed to James: activity, visits, Juice Box posts, import batch", async () => {
    const before = await history();
    await onboardThenTransfer();
    expect(await history()).toEqual(before);
    const [v] = await db.sql<Row>(`SELECT salesperson_id, note FROM office_visits`);
    expect(v).toMatchObject({ salesperson_id: JAMES, note: "dropped off donuts" });
    const [m] = await db.sql<Row>(`SELECT salesperson_name FROM team_messages WHERE salesperson_id=$1::text`, [JAMES]);
    expect(m.salesperson_name).toBe("James");
  });

  it("leaves the moved offices' notes and visits history readable: James's visit stays his, Kimberlee starts her own", async () => {
    await onboardThenTransfer();
    const { kim } = await snapshot();
    const map = (await (await call(mapRoute.GET, "/api/offices/map", kim!)).json()) as { total: number; offices: Array<{ name: string; last_visit_at: string | null; next_action: string | null }> };
    expect(map.total).toBe(N_OFFICES);
    // James's June visit is not Kimberlee's visit, so no "last visit" yet on her Map.
    expect(map.offices.filter((o) => o.last_visit_at !== null)).toHaveLength(0);
    expect(map.offices.find((o) => o.name === "DFW Office 7")!.next_action).toBe("Follow up on proposal");
  });
});

describe("transfer: what Kimberlee gets to use", () => {
  it("her Map, List and Gold List show the transferred book; James's are empty", async () => {
    await onboardThenTransfer();
    const { kim } = await snapshot();
    const list = (await (await call(officesRoute.GET, "/api/offices?q=DFW%20Office%207", kim!)).json()) as { offices: Array<{ name: string }> };
    expect(list.offices.map((o) => o.name)).toEqual(["DFW Office 7"]);
    const gold = await call(goldRoute.GET, "/api/gold-list/agents", kim!);
    expect(gold.status).toBe(200);
    const body = (await gold.json()) as { agents: Array<{ agent_name: string; notes: string | null }> };
    expect(body.agents).toHaveLength(N_AGENTS);
    expect(body.agents.every((a) => /Top producer/.test(a.notes ?? ""))).toBe(true);
    // James can no longer reach anything (deactivated) …
    expect((await call(goldRoute.GET, "/api/gold-list/agents", JAMES)).status).toBe(401);
    // … and none of it is left under his id.
    expect(await db.sql(`SELECT 1 FROM gold_list_agents WHERE salesperson_id=$1`, [JAMES])).toHaveLength(0);
  });

  it("a later Badger import for Kimberlee matches the transferred offices by external id — no duplicates", async () => {
    await onboardThenTransfer();
    const { kim } = await snapshot();
    const res = await call(importRoute.POST, "/api/admin/offices/import", COREY, {
      method: "POST",
      role: "admin",
      body: {
        source: "Badger CSV",
        default_salesperson_id: kim,
        rows: Array.from({ length: N_OFFICES }, (_, i) => ({ name: `DFW Office ${i + 1}`, street: `${i + 1} Elm St`, zip: "76102", external_badger_id: `badger-${i + 1}` })),
      },
    });
    const body = (await res.json()) as { created: number; updated: number; unchanged: number };
    expect(body.created).toBe(0);
    expect(body.updated).toBe(N_OFFICES); // zip filled on each, nothing else
    expect(await db.sql(`SELECT 1 FROM offices`)).toHaveLength(N_OFFICES);
  });
});

describe("transfer: safe to re-run", () => {
  it("a second run moves nothing and changes no timestamps", async () => {
    await onboardThenTransfer();
    const first = await snapshot();
    const stamps = await db.sql<Row>(`SELECT id, updated_at, transferred_at FROM offices ORDER BY id`);
    await db.asOwner(transferFor());
    await db.asOwner(ONBOARD);
    await db.asOwner(transferFor());
    expect(await snapshot()).toEqual(first);
    expect(await db.sql<Row>(`SELECT id, updated_at, transferred_at FROM offices ORDER BY id`)).toEqual(stamps);
  });
});

describe("transfer: ambiguous or unsafe situations", () => {
  it("leaves an office with James if Kimberlee already has the same office, moves the rest, then finishes after it is resolved", async () => {
    await db.asOwner(ONBOARD);
    const kim = (await db.sql<{ id: string }>(`SELECT id FROM salespeople WHERE first_name='Kimberlee'`))[0].id;
    // Kimberlee (started Oct 26) already added / imported one of the same offices herself.
    await db.sql(
      `INSERT INTO offices (salesperson_id, name, street, dedupe_key, environment) VALUES ($1,'DFW Office 12','12 Elm St','dfw office 12|12 elm st|','production')`,
      [kim],
    );
    await db.asOwner(transferFor());
    expect(await db.sql(`SELECT 1 FROM offices WHERE salesperson_id=$1`, [JAMES])).toHaveLength(1);
    expect((await db.sql(`SELECT name FROM offices WHERE salesperson_id=$1`, [JAMES]))[0].name).toBe("DFW Office 12");
    expect(await db.sql(`SELECT 1 FROM offices WHERE salesperson_id=$1 AND transferred_from_salesperson_id=$2`, [kim, JAMES])).toHaveLength(N_OFFICES - 1);
    // Her own office is untouched (no provenance — she made it).
    expect((await db.sql(`SELECT transferred_from_salesperson_id AS t FROM offices WHERE salesperson_id=$1 AND transferred_from_salesperson_id IS NULL`, [kim]))).toHaveLength(1);

    // Resolve the duplicate by hand, re-run: only the remainder moves.
    await db.sql(`DELETE FROM offices WHERE salesperson_id=$1 AND transferred_from_salesperson_id IS NULL`, [kim]);
    await db.asOwner(transferFor());
    expect(await db.sql(`SELECT 1 FROM offices WHERE salesperson_id=$1`, [JAMES])).toHaveLength(0);
    expect(await db.sql(`SELECT 1 FROM offices WHERE salesperson_id=$1`, [kim])).toHaveLength(N_OFFICES);
  });

  it("leaves a Gold List agent that has activities with James (immutable history) and moves the others", async () => {
    await db.asOwner(ONBOARD);
    const agent = (await db.sql<{ id: string }>(`SELECT id FROM gold_list_agents WHERE agent_name='Agent 2'`))[0].id;
    await db.sql(`INSERT INTO gold_list_activities (agent_id, salesperson_id, activity_type, description, scheduled_for) VALUES ($1,$2,'call','Quarterly check-in','2026-11-05')`, [agent, JAMES]);
    await db.asOwner(transferFor());
    expect((await db.sql(`SELECT agent_name FROM gold_list_agents WHERE salesperson_id=$1`, [JAMES])).map((r) => r.agent_name)).toEqual(["Agent 2"]);
    expect(await db.sql(`SELECT 1 FROM gold_list_activities WHERE salesperson_id=$1`, [JAMES])).toHaveLength(1);
    expect(await db.sql(`SELECT 1 FROM gold_list_agents WHERE transferred_from_salesperson_id=$1`, [JAMES])).toHaveLength(N_AGENTS - 1);
  });

  it("stops without moving anything if the set differs from the approved counts", async () => {
    await db.asOwner(ONBOARD);
    await db.sql(`INSERT INTO offices (salesperson_id, name, street, dedupe_key, environment) VALUES ($1,'Brand New Office','1 New St','brand new office|1 new st|','production')`, [JAMES]);
    await expect(db.asOwner(transferFor())).rejects.toThrow(/Offices do not add up: approved scope is 40/);
    expect(await db.sql(`SELECT 1 FROM offices WHERE salesperson_id=$1`, [JAMES])).toHaveLength(N_OFFICES + 1);
    expect(await db.sql(`SELECT 1 FROM gold_list_agents WHERE salesperson_id=$1`, [JAMES])).toHaveLength(N_AGENTS);
  });

  it("the shipped approved counts (1,751 / 15) are what stop it against a different book", async () => {
    await db.asOwner(ONBOARD);
    await expect(db.asOwner(TRANSFER)).rejects.toThrow(/Offices do not add up: approved scope is 1751/);
  });

  it("refuses to run before onboarding (James still active / Kimberlee missing)", async () => {
    await expect(db.asOwner(transferFor())).rejects.toThrow(/does not exist yet/);
    await db.sql(`INSERT INTO salespeople (first_name, role) VALUES ('Kimberlee','ae')`);
    await expect(db.asOwner(transferFor())).rejects.toThrow(/still active/);
    expect(await db.sql(`SELECT 1 FROM offices WHERE salesperson_id=$1`, [JAMES])).toHaveLength(N_OFFICES);
  });

  it("refuses to hand the book to a Kimberlee who is not an active real AE", async () => {
    await db.asOwner(ONBOARD);
    await db.sql(`UPDATE salespeople SET deactivated_at = NOW() WHERE first_name='Kimberlee'`);
    await expect(db.asOwner(transferFor())).rejects.toThrow(/not an active, real AE/);
    expect(await db.sql(`SELECT 1 FROM offices WHERE salesperson_id=$1`, [JAMES])).toHaveLength(N_OFFICES);
  });
});

describe("transfer: the script never touches history", () => {
  it("contains no statement that changes a history table", () => {
    const stmts = TRANSFER.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    for (const t of ["activity_entries", "weekly_goals", "office_visits", "team_messages", "team_message_reactions", "team_message_reads", "business_card_scans", "business_card_contacts", "one_on_ones", "one_on_one_meetings", "one_on_one_gold_list_notes", "ae_tasks", "gold_list_activities", "working_day_adjustments", "office_import_batches"]) {
      expect(stmts, t).not.toMatch(new RegExp(`(UPDATE|DELETE\\s+FROM|INSERT\\s+INTO)\\s+${t}\\b`, "i"));
    }
    expect(stmts).not.toMatch(/DELETE\s+FROM/i);
    expect(stmts).not.toMatch(/\bUPDATE\s+salespeople\b/i);
    // Only the two approved tables are ever updated, and only by owner/provenance columns.
    const updates = [...stmts.matchAll(/UPDATE\s+(\w+)/gi)].map((m) => m[1]);
    expect(updates.sort()).toEqual(["gold_list_agents", "offices"]);
    expect(stmts).not.toMatch(/SET\s+(?!salesperson_id|transferred_from_salesperson_id|transferred_at)[a-z_]+\s*=/i);
  });
});

describe("ownership_transfer_provenance.sql is additive", () => {
  const sql = read("ownership_transfer_provenance.sql").split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
  it("adds only nullable provenance columns — no default, backfill, drop or data change", () => {
    expect(sql.match(/ADD COLUMN IF NOT EXISTS transferred_from_salesperson_id UUID/gi)).toHaveLength(2);
    expect(sql.match(/ADD COLUMN IF NOT EXISTS transferred_at TIMESTAMPTZ/gi)).toHaveLength(2);
    expect(sql).not.toMatch(/NOT NULL|DEFAULT|\bUPDATE\b|\bINSERT\b|\bDROP\b|DELETE\s+FROM|CREATE\s+(UNIQUE\s+)?INDEX|POLICY|GRANT|REVOKE/i);
  });
  it("leaves every existing row with no provenance", async () => {
    await db.asOwner("SELECT 1;"); // (columns already applied by the harness)
    expect(await db.sql(`SELECT 1 FROM offices WHERE transferred_from_salesperson_id IS NOT NULL OR transferred_at IS NOT NULL`)).toHaveLength(0);
    expect(await db.sql(`SELECT 1 FROM gold_list_agents WHERE transferred_from_salesperson_id IS NOT NULL OR transferred_at IS NOT NULL`)).toHaveLength(0);
  });
});

// ===========================================================================
// Hardening: collisions by Badger id, every-run accounting, active-only agents,
// atomic rollback, and the read-only leftovers query.
// ===========================================================================
const leftovers = () => db.sql<Row>(LEFTOVERS);
const kimId = async () => (await db.sql<{ id: string }>(`SELECT id FROM salespeople WHERE first_name='Kimberlee'`))[0].id;
const jamesOffices = async () => (await db.sql<Row>(`SELECT name FROM offices WHERE salesperson_id=$1 ORDER BY name`, [JAMES])).map((r) => r.name);
async function kimOffice(fields: { name: string; street: string; dedupe_key: string; external_badger_id?: string | null; environment?: string; archived?: boolean; zip?: string | null }) {
  const kim = await kimId();
  await db.sql(
    `INSERT INTO offices (salesperson_id, name, street, zip, dedupe_key, environment, external_badger_id, archived_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [kim, fields.name, fields.street, fields.zip ?? null, fields.dedupe_key, fields.environment ?? "production", fields.external_badger_id ?? null, fields.archived ? new Date().toISOString() : null],
  );
}

describe("collisions use the application's real matching scope (finding 1)", () => {
  beforeEach(async () => {
    await db.asOwner(ONBOARD);
  });

  it("an office Kimberlee already has with the same Badger id — even under a different name and address — is left behind, not duplicated", async () => {
    await kimOffice({ name: "Totally Renamed Realty", street: "99 Other Blvd", dedupe_key: "totally renamed realty|99 other blvd|", external_badger_id: "badger-12" });
    await db.asOwner(transferFor());
    expect(await jamesOffices()).toEqual(["DFW Office 12"]);
    const kim = await kimId();
    expect(await db.sql(`SELECT 1 FROM offices WHERE salesperson_id=$1 AND external_badger_id='badger-12'`, [kim])).toHaveLength(1); // exactly one, hers
    expect(await db.sql(`SELECT 1 FROM offices WHERE salesperson_id=$1`, [kim])).toHaveLength(N_OFFICES); // 39 moved + her own
  });

  it("the Badger-id match is scoped to the same environment: a 'test' office with that id is not a collision", async () => {
    await kimOffice({ name: "Sandbox Realty", street: "1 Test St", dedupe_key: "sandbox realty|1 test st|", external_badger_id: "badger-12", environment: "test" });
    await db.asOwner(transferFor());
    expect(await jamesOffices()).toEqual([]);
  });

  it("blank or NULL Badger ids never collide with each other", async () => {
    await db.sql(`UPDATE offices SET external_badger_id = NULL WHERE name = 'DFW Office 12'`);
    await db.sql(`UPDATE offices SET external_badger_id = '   ' WHERE name = 'DFW Office 13'`);
    await kimOffice({ name: "Unrelated A", street: "1 A St", dedupe_key: "unrelated a|1 a st|", external_badger_id: null });
    await kimOffice({ name: "Unrelated B", street: "2 B St", dedupe_key: "unrelated b|2 b st|", external_badger_id: "  " });
    await db.asOwner(transferFor());
    expect(await jamesOffices()).toEqual([]);
  });

  it("matches the application's stored OR recomputed key: a stale stored key on Kimberlee's side cannot hide a duplicate", async () => {
    // Her stored dedupe_key is stale (as after an edit), but the office's current name+street+zip normalize to James's key.
    await kimOffice({ name: "DFW  Office 12!", street: "12 ELM St.", dedupe_key: "stale|key|", zip: null });
    await db.asOwner(transferFor());
    expect(await jamesOffices()).toEqual(["DFW Office 12"]);
  });

  it("the reverse: James's own stored key being stale cannot hide a duplicate either", async () => {
    await db.sql(`UPDATE offices SET dedupe_key = 'stale james key' WHERE name = 'DFW Office 12'`);
    await kimOffice({ name: "DFW Office 12", street: "12 Elm St", dedupe_key: "dfw office 12|12 elm st|" });
    await db.asOwner(transferFor());
    expect(await jamesOffices()).toEqual(["DFW Office 12"]);
  });

  it("an ARCHIVED office of hers still counts (the importer matches archived rows too)", async () => {
    await kimOffice({ name: "Old Shop", street: "7 Gone St", dedupe_key: "old shop|7 gone st|", external_badger_id: "badger-20", archived: true });
    await db.asOwner(transferFor());
    expect(await jamesOffices()).toEqual(["DFW Office 20"]);
  });

  it("the leftovers query names each office and the exact reason", async () => {
    await kimOffice({ name: "Renamed", street: "9 Z St", dedupe_key: "renamed|9 z st|", external_badger_id: "badger-12" });
    await kimOffice({ name: "DFW Office 14", street: "14 Elm St", dedupe_key: "dfw office 14|14 elm st|" });
    await db.asOwner(transferFor());
    const rows = (await leftovers()).filter((r) => r.kind === "office");
    expect(rows.map((r) => r.name)).toEqual(["DFW Office 12", "DFW Office 14"]);
    expect(String(rows[0].reason)).toMatch(/COLLISION: same external_badger_id as Kimberlee's office/);
    expect(String(rows[1].reason)).toMatch(/COLLISION: same name\+address\+zip as Kimberlee's office/);
    // …and it is the same set the script left behind.
    expect(rows.map((r) => r.name)).toEqual(await jamesOffices());
  });
});

describe("every record is accounted for on EVERY run (finding 2)", () => {
  beforeEach(async () => {
    await db.asOwner(ONBOARD);
  });

  it("a legitimate re-run after a complete transfer is supported by destination provenance (nothing left at the source)", async () => {
    await db.asOwner(transferFor());
    expect(await jamesOffices()).toEqual([]);
    await db.asOwner(transferFor()); // no source rows remain; passes only because 40 + 6 are provably Kimberlee's
  });

  it("still passes after Kimberlee archives a transferred office or agent (provenance, not active-ness, explains them)", async () => {
    await db.asOwner(transferFor());
    await db.sql(`UPDATE offices SET archived_at = NOW() WHERE name = 'DFW Office 4'`);
    await db.sql(`UPDATE gold_list_agents SET archived_at = NOW() WHERE agent_name = 'Agent 3'`);
    await db.asOwner(transferFor());
  });

  it("FAILS atomically if a transferred office has since gone missing (source empty, destination short)", async () => {
    await db.asOwner(transferFor());
    const before = await snapshot();
    await db.sql(`DELETE FROM offices WHERE name = 'DFW Office 9'`);
    await expect(db.asOwner(transferFor())).rejects.toThrow(/Offices do not add up/);
    expect((await snapshot()).offices).toHaveLength(before.offices.length - 1);
  });

  it("FAILS if nothing remains at the source and nothing is provably at the destination", async () => {
    await db.sql(`DELETE FROM offices WHERE salesperson_id=$1`, [JAMES]);
    await expect(db.asOwner(transferFor())).rejects.toThrow(/Offices do not add up: approved scope is 40, but 0 still belong/);
  });

  it("FAILS if offices were moved away WITHOUT provenance (unexplained), changing nothing", async () => {
    await db.sql(`UPDATE offices SET salesperson_id=$1 WHERE name IN ('DFW Office 1','DFW Office 2','DFW Office 3')`, [HILARY]);
    const before = await snapshot();
    await expect(db.asOwner(transferFor())).rejects.toThrow(/Offices do not add up/);
    expect(await snapshot()).toEqual(before);
  });

  it("FAILS if provenance was lost on a moved row (it can no longer be explained)", async () => {
    await db.asOwner(transferFor());
    await db.sql(`UPDATE offices SET transferred_from_salesperson_id = NULL WHERE name = 'DFW Office 6'`);
    await expect(db.asOwner(transferFor())).rejects.toThrow(/Offices do not add up/);
  });

  it("applies to Gold List agents too: a missing agent fails the re-run", async () => {
    await db.asOwner(transferFor());
    await db.sql(`DELETE FROM gold_list_agents WHERE agent_name = 'Agent 5'`);
    await expect(db.asOwner(transferFor())).rejects.toThrow(/Gold List agents do not add up/);
  });

  it("the leftovers summary reports OK after a clean transfer and MISMATCH when records are missing", async () => {
    await db.asOwner(transferFor());
    const ok = await leftovers();
    expect(ok.map((r) => r.kind)).toEqual(["summary", "summary"]); // nothing left behind
    const offices = ok.find((r) => r.name === "offices")!;
    expect(offices.detail).toMatch(/with James: 0 \| moved to Kimberlee \(by provenance\): 40/);
    // The summary encodes the SHIPPED approved totals (1751 / 15), so against this 40-office fixture it reads
    // MISMATCH — proving it really checks the approved totals rather than always saying OK.
    expect(String(offices.reason)).toMatch(/MISMATCH/);
  });
});

describe("only ACTIVE Gold List agents are in scope (finding 3)", () => {
  beforeEach(async () => {
    await db.asOwner(ONBOARD);
    await db.sql(`INSERT INTO gold_list_agents (salesperson_id, agent_name, brokerage, notes, archived_at) VALUES ($1,'Archived Agent','Old Brokerage','archived notes', NOW())`, [JAMES]);
  });

  it("leaves archived agents with James — untouched, no provenance — and moves the active ones", async () => {
    await db.asOwner(transferFor()); // approved = 6 ACTIVE; the 7th row is archived
    const archived = (await db.sql<Row>(`SELECT salesperson_id, transferred_from_salesperson_id, transferred_at, notes FROM gold_list_agents WHERE agent_name='Archived Agent'`))[0];
    expect(archived).toMatchObject({ salesperson_id: JAMES, transferred_from_salesperson_id: null, transferred_at: null, notes: "archived notes" });
    expect(await db.sql(`SELECT 1 FROM gold_list_agents WHERE transferred_from_salesperson_id=$1`, [JAMES])).toHaveLength(N_AGENTS);
    expect(await db.sql(`SELECT 1 FROM gold_list_agents WHERE salesperson_id=$1 AND archived_at IS NULL`, [JAMES])).toHaveLength(0);
  });

  it("counts only active agents toward the approved total (7 rows with 1 archived must NOT satisfy an approved 7)", async () => {
    await expect(db.asOwner(transferFor(N_OFFICES, N_AGENTS + 1))).rejects.toThrow(/Gold List agents do not add up: approved scope is 7 active agents, but 6 active/);
  });

  it("a re-run stays valid, and the leftovers query lists the archived agent as left by design", async () => {
    await db.asOwner(transferFor());
    await db.asOwner(transferFor());
    const agent = (await leftovers()).filter((r) => r.kind === "agent");
    expect(agent.map((r) => r.name)).toEqual(["Archived Agent"]);
    expect(String(agent[0].reason)).toMatch(/^ARCHIVED: outside the approved scope/);
  });

  it("an agent with activities is reported as such, separately from archived ones", async () => {
    const id = (await db.sql<{ id: string }>(`SELECT id FROM gold_list_agents WHERE agent_name='Agent 2'`))[0].id;
    await db.sql(`INSERT INTO gold_list_activities (agent_id, salesperson_id, activity_type, description, scheduled_for) VALUES ($1,$2,'call','Check-in','2026-11-05')`, [id, JAMES]);
    await db.asOwner(transferFor());
    const reasons = Object.fromEntries((await leftovers()).filter((r) => r.kind === "agent").map((r) => [r.name, String(r.reason)]));
    expect(reasons["Agent 2"]).toMatch(/^HAS ACTIVITIES \(1\)/);
    expect(reasons["Archived Agent"]).toMatch(/^ARCHIVED/);
  });
});

describe("the whole transaction rolls back on a late failure", () => {
  it("a Gold List validation failure AFTER the offices were updated leaves every office with James", async () => {
    await db.asOwner(ONBOARD);
    const before = await snapshot();
    // Offices pass (40 = 40) and are updated first; the agents check then fails (6 active vs an approved 7).
    await expect(db.asOwner(transferFor(N_OFFICES, N_AGENTS + 1))).rejects.toThrow(/Gold List agents do not add up/);
    const after = await snapshot();
    expect(after).toEqual(before);
    expect(await db.sql(`SELECT 1 FROM offices WHERE salesperson_id=$1 AND transferred_from_salesperson_id IS NULL`, [JAMES])).toHaveLength(N_OFFICES);
    expect(await db.sql(`SELECT 1 FROM offices WHERE transferred_at IS NOT NULL`)).toHaveLength(0);
    expect(await db.sql(`SELECT 1 FROM gold_list_agents WHERE transferred_at IS NOT NULL`)).toHaveLength(0);
  });
});

describe("the leftovers query is read-only", () => {
  it("contains a single SELECT and no statement that can change data", () => {
    const stmts = LEFTOVERS.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    expect(stmts.match(/;/g)).toHaveLength(1);
    expect(stmts).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i);
  });
  it("does not modify anything when run", async () => {
    await db.asOwner(ONBOARD);
    const before = await snapshot();
    await leftovers();
    await leftovers();
    expect(await snapshot()).toEqual(before);
  });
});


describe("at the real approved size, with the scripts exactly as shipped (1,751 offices / 15 agents)", () => {
  beforeEach(async () => {
    // Replace the small fixture with a production-sized book.
    await db.sql(`DELETE FROM offices WHERE salesperson_id=$1`, [JAMES]);
    await db.sql(`DELETE FROM gold_list_agents WHERE salesperson_id=$1`, [JAMES]);
    await db.sql(
      `INSERT INTO offices (salesperson_id, name, street, latitude, longitude, source, dedupe_key, environment, external_badger_id)
       SELECT $1, 'Badger Office ' || g, g || ' Main St', 32.5 + g * 0.0001, -97.0 - g * 0.0001, 'Badger CSV', 'badger office ' || g || '|' || g || ' main st|', 'production', 'bid-' || g
         FROM generate_series(1, 1751) g`,
      [JAMES],
    );
    await db.sql(`INSERT INTO gold_list_agents (salesperson_id, agent_name, notes) SELECT $1, 'Gold Agent ' || g, 'notes ' || g FROM generate_series(1, 15) g`, [JAMES]);
  });

  it("transfers everything, the leftovers summary reads OK with nothing left behind, and a re-run passes", async () => {
    await db.asOwner(ONBOARD); // shipped, unmodified
    await db.asOwner(TRANSFER); // shipped, unmodified: approved counts 1751 / 15
    const kim = await kimId();
    expect(await db.sql(`SELECT 1 FROM offices WHERE salesperson_id=$1 AND transferred_from_salesperson_id=$2`, [kim, JAMES])).toHaveLength(1751);
    expect(await db.sql(`SELECT 1 FROM gold_list_agents WHERE salesperson_id=$1 AND transferred_from_salesperson_id=$2`, [kim, JAMES])).toHaveLength(15);
    const rows = await leftovers();
    expect(rows.map((r) => r.kind)).toEqual(["summary", "summary"]);
    expect(rows.every((r) => r.reason === "status: OK")).toBe(true);
    await db.asOwner(TRANSFER); // legitimate re-run, nothing left at the source
    expect(await db.sql(`SELECT 1 FROM offices WHERE salesperson_id=$1`, [JAMES])).toHaveLength(0);
  }, 60_000);

  it("Kimberlee's Map serves all 1,751 offices through the real route", async () => {
    await db.asOwner(ONBOARD);
    await db.asOwner(TRANSFER);
    const kim = await kimId();
    const body = (await (await call(mapRoute.GET, "/api/offices/map", kim)).json()) as { total: number; truncated: boolean };
    expect(body.total).toBe(1751);
    expect(body.truncated).toBe(false);
  }, 60_000);
});
