/**
 * Swag Leads — route + database tests against a REAL Postgres (PGlite running
 * the project's actual migrations), with real signed session tokens and the
 * real auth chain. Nothing about Swag Leads is faked.
 *
 * Swag Leads are social-media PROSPECTING leads (not swag orders). The tests
 * pin down: the exact spreadsheet fields and their meanings, who can see / edit
 * / transfer what (enforced server-side AND in the database), the immutable
 * history, reporting that counts each lead once under its CURRENT owner with
 * OOA as a separate bucket, and that a dashboard count is always the same set
 * as the list behind it.
 *
 * LIMITATION: PGlite is one connection, so true lock contention is staged with
 * `beforeWrite()` (a competing write injected between a route's check and its
 * database call). Real multi-connection locking is covered by
 * supabase/swag-leads-concurrency.realpg.test.ts (opt-in, REAL_PG=1).
 *
 * The app clock is pinned to Tue 2026-09-29 12:00 America/Denver.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDb, type TestDb } from "@/test/pglite-supabase";

process.env.SESSION_SECRET = "test-session-secret";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ getServerSupabase: () => holder.client }));

const { signSessionToken } = await import("@/lib/server/auth");
const { computeStandings } = await import("@/lib/server/leaderboard-standings");
const { SWAG_METRIC_KEYS, matchesMetric } = await import("@/lib/swag-leads");

const listRoute = await import("./route");
const leadRoute = await import("./[id]/route");
const transferRoute = await import("./[id]/transfer/route");

type Row = Record<string, unknown>;

const HILARY = "11111111-1111-4111-8111-111111111111";
const KENNEDY = "22222222-2222-4222-8222-222222222222";
const CHANEL = "33333333-3333-4333-8333-333333333333"; // deactivated AE
const COREY = "55555555-5555-4555-8555-555555555555"; // admin
const RYAN = "66666666-6666-4666-8666-666666666666"; // another admin
const TONJA = "77777777-7777-4777-8777-777777777777"; // assistant + flag
const FAITH = "88888888-8888-4888-8888-888888888888"; // juice_box_only + flag
const LEAH = "99999999-9999-4999-8999-999999999991"; // juice_box_only, NO flag
const PAT = "99999999-9999-4999-8999-999999999992"; // assistant, NO flag
const TEST_AE = "99999999-9999-4999-8999-999999999999"; // Corey's private test AE

const roleOf: Record<string, string> = {
  [HILARY]: "ae", [KENNEDY]: "ae", [CHANEL]: "ae", [COREY]: "admin", [RYAN]: "admin",
  [TONJA]: "assistant", [FAITH]: "juice_box_only", [LEAH]: "juice_box_only", [PAT]: "assistant",
  [TEST_AE]: "ae",
};
const nameOf: Record<string, string> = {
  [HILARY]: "Hilary", [KENNEDY]: "Kennedy", [CHANEL]: "Chanel", [COREY]: "Corey", [RYAN]: "Ryan",
  [TONJA]: "Tonja", [FAITH]: "Faith", [LEAH]: "Leah", [PAT]: "Pat", [TEST_AE]: "Test AE",
};

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  holder.client = db.client;
}, 60_000);

async function seed() {
  await db.reset();
  await db.sql(
    `INSERT INTO salespeople (id, first_name, role, is_test, deactivated_at) VALUES
       ($1,'Hilary','ae',false,NULL), ($2,'Kennedy','ae',false,NULL),
       ($3,'Chanel','ae',false,'2026-06-01T00:00:00Z'),
       ($4,'Corey','admin',false,NULL), ($5,'Ryan','admin',false,NULL),
       ($6,'Tonja','assistant',false,NULL), ($7,'Faith','juice_box_only',false,NULL),
       ($8,'Leah','juice_box_only',false,NULL), ($9,'Pat','assistant',false,NULL),
       ($10,'Test AE','ae',true,NULL)`,
    [HILARY, KENNEDY, CHANEL, COREY, RYAN, TONJA, FAITH, LEAH, PAT, TEST_AE],
  );
  await db.sql(`UPDATE salespeople SET test_owner_id = $1 WHERE id = $2`, [COREY, TEST_AE]);
  // The capability flag the migration seeds for Tonja and Faith (the tables
  // were empty when it ran, so set it the way production has it).
  await db.sql(`UPDATE salespeople SET can_manage_swag_leads = TRUE WHERE id IN ($1, $2)`, [TONJA, FAITH]);
  await db.sql(
    `INSERT INTO cogent_territory_mappings (sales_territory_name, salesperson_id, active) VALUES
       ('Wasatch Front', $1, true), ('Utah County', $1, true), ('Davis', $2, true), ('Old Territory', $2, false)`,
    [HILARY, KENNEDY],
  );
}

function req(who: string | null, path: string, init: { method?: string; body?: unknown } = {}) {
  return new Request(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(who
        ? {
            Authorization: `Bearer ${signSessionToken({
              sub: who,
              role: roleOf[who] as never,
              name: nameOf[who],
              ...(who === TEST_AE ? { tp: true as const } : {}),
            })}`,
          }
        : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
async function json<T = Row>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

type Lead = Row & { id: string; revision: number };
type ListBody = {
  scope: Row; metrics: Record<string, number>; by_ae: Array<{ ae_id: string; name: string; metrics: Record<string, number> }> | null;
  ae_total: Record<string, number> | null; ooa_metrics: Record<string, number> | null;
  leads: Lead[]; matched: number; active_metric: string | null; ae_options: Row[]; territories: string[];
};

const api = {
  list: (who: string | null, qs = "") => listRoute.GET(req(who, `/api/swag-leads${qs ? `?${qs}` : ""}`)),
  create: (who: string | null, body: unknown) => listRoute.POST(req(who, "/api/swag-leads", { method: "POST", body })),
  get: (who: string | null, id: string) => leadRoute.GET(req(who, "/x"), p({ id })),
  patch: (who: string | null, id: string, revision: number, patch: unknown) =>
    leadRoute.PATCH(req(who, "/x", { method: "PATCH", body: { expected_revision: revision, patch } }), p({ id })),
  transfer: (who: string | null, id: string, body: unknown) =>
    transferRoute.POST(req(who, "/x", { method: "POST", body }), p({ id })),
};

/** Creates a lead as management for `to` (an AE id) or OOA, returning the lead. */
async function addLead(fields: Row, to: string | "OOA" = HILARY, who = TONJA): Promise<Lead> {
  const res = await api.create(who, { ...fields, ...(to === "OOA" ? { ooa: true } : { assigned_to: to }) });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return (await json<{ lead: Lead }>(res)).lead;
}
const leadRow = async (id: string) => (await db.sql(`SELECT * FROM swag_leads WHERE id = $1`, [id]))[0];
const events = async (id: string) =>
  db.sql(`SELECT * FROM swag_lead_events WHERE lead_id = $1 ORDER BY seq`, [id]);
const countLeads = async () => Number((await db.sql(`SELECT count(*)::int AS n FROM swag_leads`))[0].n);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-29T18:00:00.000Z"));
  await seed();
});
afterEach(() => {
  vi.useRealTimers();
  holder.client = db.client;
});

// The full spreadsheet row, every column with a distinctive value.
const SHEET = {
  name: "Dana Whitaker",
  contact_info: "dana@example.com · 801-555-0100",
  confirmed_realtor: true,
  transactions_last_12_months: 14,
  date_lead_received: "2026-09-01",
  date_first_contact: "2026-09-03",
  follow_up_attempts: 3,
  swag_delivered: true,
  met_in_person: true,
  orders_received: true,
  orders_count: 4,
  notes: "Met at the Compass open house; wants the quarterly mailer.",
};

// ===========================================================================
// 1) Creating leads + exact spreadsheet fields
// ===========================================================================

describe("creating a swag lead", () => {
  it("stores every spreadsheet column exactly, with the meaning the spreadsheet gives it", async () => {
    const lead = await addLead(SHEET);
    const row = await leadRow(lead.id);
    expect(row).toMatchObject({
      name: "Dana Whitaker",
      contact_info: "dana@example.com · 801-555-0100",
      confirmed_realtor: true,
      transactions_last_12_months: 14, // the lead's PRODUCTION
      date_lead_received: "2026-09-01",
      date_first_contact: "2026-09-03",
      follow_up_attempts: 3,
      swag_delivered: true, // plain yes/no outcome — not an order workflow
      met_in_person: true,
      orders_received: true, // the AGENT has sent us business
      orders_count: 4, // orders the agent sent us — NOT a swag quantity
      notes: "Met at the Compass open house; wants the quarterly mailer.",
      assigned_to: HILARY,
      is_ooa: false,
      is_test_data: false,
      revision: 0,
      created_by: TONJA,
    });
  });

  it("a name alone is enough; everything else takes the spreadsheet-blank default", async () => {
    const lead = await addLead({ name: "Just A Name" });
    expect(await leadRow(lead.id)).toMatchObject({
      contact_info: null, confirmed_realtor: false, transactions_last_12_months: null,
      date_lead_received: "2026-09-29", // today, Denver
      date_first_contact: null, follow_up_attempts: 0,
      swag_delivered: false, met_in_person: false, orders_received: false, orders_count: null, notes: null,
    });
    expect(lead.attention).toBe("needs_first_contact");
  });

  it("records a 'created' history event naming who created it and who it was assigned to", async () => {
    const lead = await addLead(SHEET, KENNEDY);
    const ev = await events(lead.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      event_type: "created", actor_id: TONJA, actor_name: "Tonja",
      to_assigned_to: KENNEDY, to_label: "Kennedy", from_assigned_to: null, from_label: null,
    });
  });

  it("management can add a lead straight to OOA; an OOA lead has no AE", async () => {
    const lead = await addLead({ name: "Out of state" }, "OOA");
    expect(await leadRow(lead.id)).toMatchObject({ assigned_to: null, is_ooa: true });
    expect((await events(lead.id))[0]).toMatchObject({ to_label: "OOA", to_assigned_to: null });
  });

  it("an AE adds leads to their OWN list only", async () => {
    const res = await api.create(HILARY, { name: "Mine" });
    expect(res.status).toBe(201);
    const lead = (await json<{ lead: Lead }>(res)).lead;
    expect(lead.assigned_to).toBe(HILARY);
    expect((await events(lead.id))[0]).toMatchObject({ actor_id: HILARY });

    expect((await api.create(HILARY, { name: "Not mine", assigned_to: KENNEDY })).status).toBe(403);
    expect((await api.create(HILARY, { name: "OOA", ooa: true })).status).toBe(403);
    expect(await countLeads()).toBe(1);
    // Explicitly naming themselves is fine.
    expect((await api.create(HILARY, { name: "Mine too", assigned_to: HILARY })).status).toBe(201);
  });

  it("management must choose exactly one of an AE or OOA, and only a real, active AE", async () => {
    expect((await api.create(TONJA, { name: "x" })).status).toBe(400);
    expect((await api.create(TONJA, { name: "x", ooa: true, assigned_to: HILARY })).status).toBe(400);
    expect((await api.create(TONJA, { name: "x", assigned_to: COREY })).status).toBe(400); // an admin is not an AE
    expect((await api.create(TONJA, { name: "x", assigned_to: LEAH })).status).toBe(400); // not an AE
    expect((await api.create(TONJA, { name: "x", assigned_to: CHANEL })).status).toBe(400); // deactivated
    expect((await api.create(TONJA, { name: "x", assigned_to: "99999999-0000-4000-8000-000000000000" })).status).toBe(404); // unknown = not found
    expect(await countLeads()).toBe(0);
  });

  it("a double-tapped Save does not create the lead twice (idempotency key)", async () => {
    const request_id = "abababab-abab-4bab-8bab-abababababab";
    const a = await json<{ lead: Lead }>(api.create(HILARY, { name: "Once", request_id }));
    const b = await json<{ lead: Lead }>(api.create(HILARY, { name: "Once", request_id }));
    expect(b.lead.id).toBe(a.lead.id);
    expect(await countLeads()).toBe(1);
    expect(await events(a.lead.id)).toHaveLength(1);
    // Someone else can't hijack that key.
    expect((await api.create(KENNEDY, { name: "Other", request_id })).status).toBe(409);
  });

  it("rejects invalid data: negatives, impossible/future dates, orders without 'received', unknown fields", async () => {
    const bad = async (body: Row) => (await api.create(TONJA, { name: "x", assigned_to: HILARY, ...body })).status;
    expect(await bad({ orders_count: -1 })).toBe(400);
    expect(await bad({ follow_up_attempts: -2 })).toBe(400);
    expect(await bad({ transactions_last_12_months: -1 })).toBe(400);
    expect(await bad({ orders_count: 1.5 })).toBe(400);
    expect(await bad({ orders_count: 3, orders_received: false })).toBe(400);
    expect(await bad({ date_lead_received: "2026-02-30" })).toBe(400);
    expect(await bad({ date_lead_received: "09/01/2026" })).toBe(400);
    expect(await bad({ date_lead_received: "2026-10-15" })).toBe(400); // in the future
    expect(await bad({ date_first_contact: "2026-10-15" })).toBe(400);
    expect(await bad({ date_lead_received: "2026-09-10", date_first_contact: "2026-09-09" })).toBe(400);
    expect(await bad({ name: "   " })).toBe(400);
    expect(await bad({ status: "shipped" })).toBe(400); // no order-workflow fields exist
    expect(await bad({ tracking_number: "1Z" })).toBe(400);
    expect(await bad({ assigned_to: "not-a-uuid" })).toBe(400);
    expect(await countLeads()).toBe(0);
  });

  it("the same guards hold in the DATABASE (a caller that skipped the route)", async () => {
    const call = (fields: Row) =>
      db.client.rpc("create_swag_lead", { p_actor: TONJA, p_fields: fields, p_assigned_to: HILARY, p_ooa: false });
    expect((await call({ name: "x", orders_count: -1 })).error?.code).toBe("23514");
    expect((await call({ name: "x", orders_count: 2, orders_received: false })).error?.code).toBe("23514");
    expect((await call({ name: "x", date_lead_received: "2026-09-10", date_first_contact: "2026-09-01" })).error?.code).toBe("23514");
    expect((await call({ name: "x", nope: 1 })).error?.code).toBe("22023");
    expect((await call({ name: " " })).error?.code).toBe("22023");
    expect(await countLeads()).toBe(0);
  });

  it("there is no swag-order workflow anywhere: no status/shipping/tracking/vendor columns or tables", async () => {
    const cols = (await db.sql(
      `SELECT column_name FROM information_schema.columns WHERE table_name IN ('swag_leads','swag_lead_events')`,
    )).map((r) => String(r.column_name));
    for (const banned of ["status", "approved", "rejected", "ordered", "shipped", "shipping", "tracking", "vendor", "expected_delivery", "delivered_at", "quantity"]) {
      expect(cols.filter((c) => c.includes(banned)), banned).toEqual([]);
    }
    const tables = (await db.sql(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename ILIKE '%swag%'`)).map((r) => r.tablename);
    expect(tables.sort()).toEqual(["swag_lead_events", "swag_leads"]);
    expect(Object.keys(await leadRow((await addLead({ name: "n" })).id)).sort()).toEqual([
      "assigned_to", "confirmed_realtor", "contact_info", "create_request_id", "created_at", "created_by", "date_first_contact",
      "date_lead_received", "follow_up_attempts", "id", "is_ooa", "is_test_data", "met_in_person", "name", "notes", "orders_count",
      "orders_received", "revision", "swag_delivered", "transactions_last_12_months", "updated_at",
    ]);
  });
});

// ===========================================================================
// 2) Authorization: who can reach the feature at all
// ===========================================================================

describe("who can use Swag Leads", () => {
  it("rejects signed-out callers and accounts with no Swag Leads role", async () => {
    expect((await api.list(null)).status).toBe(401);
    expect((await api.create(null, { name: "x", assigned_to: HILARY })).status).toBe(401);
    // A juice_box_only guest without the flag, and an assistant without it.
    for (const who of [LEAH, PAT]) {
      expect((await api.list(who)).status, nameOf[who]).toBe(403);
      expect((await api.create(who, { name: "x", assigned_to: HILARY })).status, nameOf[who]).toBe(403);
    }
    expect(await countLeads()).toBe(0);
  });

  it("management = admin OR the can_manage_swag_leads flag (Corey, Ryan, Tonja, Faith); revoking the flag revokes access", async () => {
    for (const who of [COREY, RYAN, TONJA, FAITH]) {
      const res = await api.list(who);
      expect(res.status, nameOf[who]).toBe(200);
      expect((await json<ListBody>(res)).scope.is_manager, nameOf[who]).toBe(true);
    }
    await db.sql(`UPDATE salespeople SET can_manage_swag_leads = FALSE WHERE id = $1`, [FAITH]);
    expect((await api.list(FAITH)).status).toBe(403); // the server re-reads the flag every request
  });

  it("an AE is not management", async () => {
    const res = await json<ListBody>(api.list(HILARY));
    expect(res.scope).toMatchObject({ kind: "mine", is_manager: false });
    expect((await api.list(HILARY, "scope=all")).status).toBe(403);
    expect((await api.list(HILARY, "scope=ooa")).status).toBe(403);
    expect((await api.list(HILARY, `scope=${KENNEDY}`)).status).toBe(403);
    expect((await api.list(HILARY, `scope=${HILARY}`)).status).toBe(200); // themselves is fine
  });

  it("a deactivated account loses access (the shared session guard)", async () => {
    await db.sql(`UPDATE salespeople SET deactivated_at = NOW() WHERE id = $1`, [HILARY]);
    expect((await api.list(HILARY)).status).toBe(401);
  });

  it("the database functions re-check the actor themselves (defence in depth)", async () => {
    const lead = await addLead(SHEET, HILARY);
    const asOf = (actor: string) => ({ p_actor: actor });
    // A guest with no role for this feature can't even create.
    expect((await db.client.rpc("create_swag_lead", { ...asOf(LEAH), p_fields: { name: "x" }, p_assigned_to: HILARY, p_ooa: false })).error?.code).toBe("42501");
    // An AE can't create for another AE, or OOA.
    expect((await db.client.rpc("create_swag_lead", { ...asOf(KENNEDY), p_fields: { name: "x" }, p_assigned_to: HILARY, p_ooa: false })).error?.code).toBe("42501");
    expect((await db.client.rpc("create_swag_lead", { ...asOf(KENNEDY), p_fields: { name: "x" }, p_assigned_to: null, p_ooa: true })).error?.code).toBe("42501");
    // Another AE can't edit or transfer Hilary's lead.
    expect((await db.client.rpc("update_swag_lead", { ...asOf(KENNEDY), p_id: lead.id, p_expected_revision: 0, p_patch: { notes: "hijack" } })).error?.code).toBe("42501");
    expect((await db.client.rpc("transfer_swag_lead", { ...asOf(KENNEDY), p_id: lead.id, p_to_assigned_to: KENNEDY, p_to_ooa: false })).error?.code).toBe("42501");
    // Unknown / deactivated / guest actors are refused outright.
    for (const actor of [CHANEL, LEAH, "99999999-0000-4000-8000-000000000000"]) {
      expect((await db.client.rpc("update_swag_lead", { ...asOf(actor), p_id: lead.id, p_expected_revision: 0, p_patch: { notes: "x" } })).error?.code, actor).toBe("42501");
    }
    expect(await leadRow(lead.id)).toMatchObject({ notes: SHEET.notes, assigned_to: HILARY, revision: 0 });
  });

  it("the public (anon) key can neither read the tables nor run the functions", async () => {
    const lead = await addLead(SHEET);
    for (const table of ["swag_leads", "swag_lead_events"]) {
      const res = await db.anon.from(table).select("*");
      expect(res.data ?? [], table).toEqual([]);
    }
    const w = await db.anon.from("swag_leads").update({ notes: "x" }).eq("id", lead.id).select("id");
    expect(w.data ?? []).toEqual([]);
    for (const [fn, args] of [
      ["create_swag_lead", { p_actor: TONJA, p_fields: { name: "x" }, p_assigned_to: HILARY, p_ooa: false }],
      ["update_swag_lead", { p_actor: TONJA, p_id: lead.id, p_expected_revision: 0, p_patch: { notes: "x" } }],
      ["transfer_swag_lead", { p_actor: TONJA, p_id: lead.id, p_to_assigned_to: null, p_to_ooa: true }],
    ] as const) {
      expect((await db.anon.rpc(fn, args as Row)).error?.code, fn).toBe("42501");
    }
    expect(await leadRow(lead.id)).toMatchObject({ notes: SHEET.notes, revision: 0 });
  });
});

// ===========================================================================
// 3) Visibility
// ===========================================================================

describe("visibility", () => {
  it("an AE sees only the leads they currently own; everyone else's are a 404", async () => {
    const mine = await addLead({ name: "Mine" }, HILARY);
    const theirs = await addLead({ name: "Theirs" }, KENNEDY);
    const ooa = await addLead({ name: "Out of area" }, "OOA");

    const list = await json<ListBody>(api.list(HILARY));
    expect(list.leads.map((l) => l.id)).toEqual([mine.id]);
    expect(list.metrics.total).toBe(1);

    expect((await api.get(HILARY, mine.id)).status).toBe(200);
    expect((await api.get(HILARY, theirs.id)).status).toBe(404);
    expect((await api.get(HILARY, ooa.id)).status).toBe(404); // OOA is not any AE's
    expect((await api.get(HILARY, "not-a-uuid")).status).toBe(404);
    expect((await api.get(HILARY, "99999999-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("management sees every lead, can filter by AE or OOA, and sees the full history", async () => {
    const a = await addLead({ name: "A" }, HILARY);
    const b = await addLead({ name: "B" }, KENNEDY);
    const c = await addLead({ name: "C" }, "OOA");

    const all = await json<ListBody>(api.list(TONJA));
    expect(all.scope.kind).toBe("all");
    expect(all.leads.map((l) => l.id).sort()).toEqual([a.id, b.id, c.id].sort());

    expect((await json<ListBody>(api.list(TONJA, `scope=${HILARY}`))).leads.map((l) => l.id)).toEqual([a.id]);
    expect((await json<ListBody>(api.list(FAITH, "scope=ooa"))).leads.map((l) => l.id)).toEqual([c.id]);
    const detail = await json<{ events: Row[]; permissions: Row }>(api.get(COREY, b.id));
    expect(detail.events).toHaveLength(1);
    expect(detail.permissions).toEqual({ can_edit: true, can_edit_identity: true, can_transfer: true });
  });

  it("scope validation: unknown AE id, a non-AE id, or garbage is refused", async () => {
    expect((await api.list(TONJA, "scope=not-a-scope")).status).toBe(400);
    expect((await api.list(TONJA, "scope=99999999-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await api.list(TONJA, `scope=${COREY}`)).status).toBe(404); // an admin is not an AE
    expect((await api.list(TONJA, "metric=shipped")).status).toBe(400);
  });

  it("the AE selector lists the real active AEs (from the roster) and never OOA, admins or guests", async () => {
    const res = await json<ListBody>(api.list(TONJA));
    expect(res.ae_options.map((o) => o.first_name)).toEqual(["Hilary", "Kennedy"]); // Chanel deactivated; no admins/guests
  });
});

// ===========================================================================
// 4) Editing prospecting fields
// ===========================================================================

describe("editing a lead", () => {
  it("the owning AE updates the prospecting fields; revision advances and history records before/after", async () => {
    const lead = await addLead({ name: "Pat Realty", date_lead_received: "2026-09-01" }, HILARY);
    const res = await api.patch(HILARY, lead.id, 0, {
      date_first_contact: "2026-09-05", follow_up_attempts: 2, swag_delivered: true, met_in_person: true,
      orders_received: true, orders_count: 3, confirmed_realtor: true, transactions_last_12_months: 9,
      contact_info: "pat@example.com", notes: "Loves the tumblers",
    });
    expect(res.status).toBe(200);
    expect(await leadRow(lead.id)).toMatchObject({
      date_first_contact: "2026-09-05", follow_up_attempts: 2, swag_delivered: true, met_in_person: true,
      orders_received: true, orders_count: 3, confirmed_realtor: true, transactions_last_12_months: 9,
      contact_info: "pat@example.com", notes: "Loves the tumblers", revision: 1,
    });
    const ev = (await events(lead.id)).at(-1)!;
    expect(ev).toMatchObject({ event_type: "updated", actor_id: HILARY, actor_name: "Hilary" });
    const changes = ev.changes as Record<string, Row>;
    expect(changes.date_first_contact).toEqual({ from: null, to: "2026-09-05" });
    expect(changes.follow_up_attempts).toEqual({ from: 0, to: 2 });
    expect(changes.orders_count).toEqual({ from: null, to: 3 });
    expect(changes.swag_delivered).toEqual({ from: false, to: true });
    // Notes are flagged as changed, not copied into the timeline.
    expect(changes.notes).toEqual({ changed: true });
    expect(JSON.stringify(ev.changes)).not.toContain("tumblers");
  });

  it("an AE cannot change name or date received (source-of-truth fields), but may re-send them unchanged", async () => {
    const lead = await addLead({ name: "Stable", date_lead_received: "2026-09-01" }, HILARY);
    expect((await api.patch(HILARY, lead.id, 0, { name: "Renamed" })).status).toBe(403);
    expect((await api.patch(HILARY, lead.id, 0, { date_lead_received: "2026-09-02" })).status).toBe(403);
    expect(await leadRow(lead.id)).toMatchObject({ name: "Stable", date_lead_received: "2026-09-01", revision: 0 });
    // A form that posts every field, with name/date untouched, still saves.
    const ok = await api.patch(HILARY, lead.id, 0, { name: "Stable", date_lead_received: "2026-09-01", notes: "hi" });
    expect(ok.status).toBe(200);
    expect(await leadRow(lead.id)).toMatchObject({ name: "Stable", notes: "hi", revision: 1 });
  });

  it("management can edit name and date received too", async () => {
    const lead = await addLead({ name: "Typo", date_lead_received: "2026-09-01" }, HILARY);
    expect((await api.patch(TONJA, lead.id, 0, { name: "Fixed", date_lead_received: "2026-09-02" })).status).toBe(200);
    expect(await leadRow(lead.id)).toMatchObject({ name: "Fixed", date_lead_received: "2026-09-02" });
  });

  it("an AE cannot edit another AE's lead; it is a 404, and a direct database call is refused", async () => {
    const theirs = await addLead(SHEET, KENNEDY);
    expect((await api.patch(HILARY, theirs.id, 0, { notes: "hijack" })).status).toBe(404);
    expect(await leadRow(theirs.id)).toMatchObject({ notes: SHEET.notes, revision: 0 });
  });

  it("a stale save is refused with the current lead (409); nothing is overwritten", async () => {
    const lead = await addLead({ name: "Race", notes: "original" }, HILARY);
    expect((await api.patch(TONJA, lead.id, 0, { notes: "Tonja's edit" })).status).toBe(200); // -> revision 1
    const res = await api.patch(HILARY, lead.id, 0, { notes: "Hilary's stale edit", follow_up_attempts: 5 });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.conflict).toMatchObject({ id: lead.id, notes: "Tonja's edit", revision: 1 });
    expect(await leadRow(lead.id)).toMatchObject({ notes: "Tonja's edit", follow_up_attempts: 0, revision: 1 });
  });

  it("a save that changes nothing is a no-op: no revision bump, no history row", async () => {
    const lead = await addLead({ name: "Same", notes: "n" }, HILARY);
    const before = (await events(lead.id)).length;
    const res = await api.patch(HILARY, lead.id, 0, { notes: "n", follow_up_attempts: 0 });
    expect(res.status).toBe(200);
    expect(await leadRow(lead.id)).toMatchObject({ revision: 0 });
    expect(await events(lead.id)).toHaveLength(before);
  });

  it("the merged row is validated too: orders can't be counted while 'received' is No", async () => {
    const lead = await addLead({ name: "x", orders_received: false }, HILARY);
    const res = await api.patch(HILARY, lead.id, 0, { orders_count: 2 }); // passes the route's own check
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Orders can't be counted/);
    // And a first contact before the lead was received.
    const l2 = await addLead({ name: "y", date_lead_received: "2026-09-10" }, HILARY);
    const res2 = await api.patch(HILARY, l2.id, 0, { date_first_contact: "2026-09-01" });
    expect(res2.status).toBe(400);
    expect((await res2.json()).error).toMatch(/First contact can't be before/);
    expect(await leadRow(lead.id)).toMatchObject({ orders_count: null, revision: 0 });
  });

  it("assignment is not editable through PATCH at all", async () => {
    const lead = await addLead({ name: "x" }, HILARY);
    for (const patch of [{ assigned_to: KENNEDY }, { is_ooa: true }, { revision: 99 }, { created_by: KENNEDY }]) {
      expect((await api.patch(HILARY, lead.id, 0, patch)).status).toBe(400);
      expect((await api.patch(TONJA, lead.id, 0, patch)).status).toBe(400);
    }
    expect(await leadRow(lead.id)).toMatchObject({ assigned_to: HILARY, is_ooa: false, revision: 0 });
  });
});

// ===========================================================================
// 5) Transfers
// ===========================================================================

describe("transferring a lead", () => {
  it("AE → AE: the SAME lead moves, history says previous → new, who, when, why; the old owner loses it", async () => {
    const lead = await addLead(SHEET, HILARY);
    const before = await leadRow(lead.id);
    const leadsBefore = await countLeads();

    const res = await api.transfer(HILARY, lead.id, { to_assigned_to: KENNEDY, reason: "Kennedy covers Davis" });
    expect(res.status).toBe(200);
    expect((await json<{ lead: Lead }>(res)).lead).toMatchObject({ id: lead.id, assigned_to: KENNEDY, assigned_label: "Kennedy" });

    // Not duplicated; the original data is intact; only ownership + revision moved.
    expect(await countLeads()).toBe(leadsBefore);
    const after = await leadRow(lead.id);
    const { assigned_to: a1, revision: r1, updated_at: u1, ...restBefore } = before;
    const { assigned_to: a2, revision: r2, updated_at: u2, ...restAfter } = after;
    void [a1, r1, u1, u2];
    expect(restAfter).toEqual(restBefore);
    expect([a2, r2]).toEqual([KENNEDY, 1]);

    const ev = (await events(lead.id)).at(-1)!;
    expect(ev).toMatchObject({
      event_type: "transferred", actor_id: HILARY, actor_name: "Hilary",
      from_assigned_to: HILARY, from_label: "Hilary", to_assigned_to: KENNEDY, to_label: "Kennedy",
      reason: "Kennedy covers Davis",
    });
    expect(ev.occurred_at).toBeTruthy();

    // The CURRENT owner controls the AE view.
    expect((await json<ListBody>(api.list(KENNEDY))).leads.map((l) => l.id)).toEqual([lead.id]);
    expect((await json<ListBody>(api.list(HILARY))).leads).toEqual([]);
    expect((await api.get(HILARY, lead.id)).status).toBe(404);
    expect((await api.get(KENNEDY, lead.id)).status).toBe(200);
  });

  it("AE → OOA: the lead leaves the AE's view and is not an AE anywhere", async () => {
    const lead = await addLead(SHEET, HILARY);
    const res = await api.transfer(HILARY, lead.id, { to_ooa: true, reason: "Out of state" });
    expect(res.status).toBe(200);
    expect(await leadRow(lead.id)).toMatchObject({ assigned_to: null, is_ooa: true });
    expect((await events(lead.id)).at(-1)).toMatchObject({ from_label: "Hilary", to_label: "OOA", to_assigned_to: null });
    expect((await json<ListBody>(api.list(HILARY))).leads).toEqual([]);
    expect((await api.patch(HILARY, lead.id, 1, { notes: "still mine?" })).status).toBe(404);
    expect((await json<ListBody>(api.list(TONJA, "scope=ooa"))).leads.map((l) => l.id)).toEqual([lead.id]);
  });

  it("OOA → AE: management moves it back to an AE, and that AE now sees it", async () => {
    const lead = await addLead({ name: "OOA lead" }, "OOA");
    const res = await api.transfer(FAITH, lead.id, { to_assigned_to: KENNEDY, reason: "Expanded territory" });
    expect(res.status).toBe(200);
    expect(await leadRow(lead.id)).toMatchObject({ assigned_to: KENNEDY, is_ooa: false });
    expect((await events(lead.id)).at(-1)).toMatchObject({ from_label: "OOA", from_assigned_to: null, to_label: "Kennedy", actor_name: "Faith" });
    expect((await json<ListBody>(api.list(KENNEDY))).leads.map((l) => l.id)).toEqual([lead.id]);
  });

  it("every management user (Corey, Ryan, Tonja, Faith) can transfer any lead", async () => {
    for (const who of [COREY, RYAN, TONJA, FAITH]) {
      const lead = await addLead({ name: `for ${nameOf[who]}` }, HILARY);
      expect((await api.transfer(who, lead.id, { to_assigned_to: KENNEDY })).status, nameOf[who]).toBe(200);
      expect((await events(lead.id)).at(-1)).toMatchObject({ actor_id: who });
    }
  });

  it("an AE cannot transfer a lead they don't own, an OOA lead, or one that already left them", async () => {
    const theirs = await addLead({ name: "K's" }, KENNEDY);
    const ooa = await addLead({ name: "OOA" }, "OOA");
    expect((await api.transfer(HILARY, theirs.id, { to_assigned_to: HILARY })).status).toBe(404);
    expect((await api.transfer(HILARY, ooa.id, { to_assigned_to: HILARY })).status).toBe(404);
    expect(await leadRow(theirs.id)).toMatchObject({ assigned_to: KENNEDY, revision: 0 });
    expect(await leadRow(ooa.id)).toMatchObject({ is_ooa: true });

    const mine = await addLead({ name: "mine" }, HILARY);
    expect((await api.transfer(HILARY, mine.id, { to_assigned_to: KENNEDY })).status).toBe(200);
    // Hilary tries again / tries to take it back: she no longer owns it.
    expect((await api.transfer(HILARY, mine.id, { to_assigned_to: HILARY })).status).toBe(404);
    expect(await leadRow(mine.id)).toMatchObject({ assigned_to: KENNEDY });
    // …and the same refusals hold in the database itself.
    expect((await db.client.rpc("transfer_swag_lead", { p_actor: HILARY, p_id: mine.id, p_to_assigned_to: HILARY, p_to_ooa: false })).error?.code).toBe("42501");
  });

  it("a guest (no Swag Leads role) cannot transfer anything", async () => {
    const lead = await addLead({ name: "x" }, HILARY);
    expect((await api.transfer(LEAH, lead.id, { to_assigned_to: KENNEDY })).status).toBe(403);
    expect((await api.transfer(PAT, lead.id, { to_assigned_to: KENNEDY })).status).toBe(403);
    expect(await leadRow(lead.id)).toMatchObject({ assigned_to: HILARY });
  });

  it("refuses a transfer to the current owner, to a non-AE, a deactivated AE, or to nobody/both", async () => {
    const lead = await addLead({ name: "x" }, HILARY);
    expect((await api.transfer(TONJA, lead.id, { to_assigned_to: HILARY })).status).toBe(409); // already there
    expect((await api.transfer(TONJA, lead.id, { to_assigned_to: COREY })).status).toBe(400); // admin is not an AE
    expect((await api.transfer(TONJA, lead.id, { to_assigned_to: LEAH })).status).toBe(400);
    expect((await api.transfer(TONJA, lead.id, { to_assigned_to: CHANEL })).status).toBe(400); // deactivated
    expect((await api.transfer(TONJA, lead.id, { to_assigned_to: "99999999-0000-4000-8000-000000000000" })).status).toBe(404);
    expect((await api.transfer(TONJA, lead.id, {})).status).toBe(400);
    expect((await api.transfer(TONJA, lead.id, { to_ooa: true, to_assigned_to: KENNEDY })).status).toBe(400);
    const ooa = await addLead({ name: "o" }, "OOA");
    expect((await api.transfer(TONJA, ooa.id, { to_ooa: true })).status).toBe(409); // OOA -> OOA
    expect(await leadRow(lead.id)).toMatchObject({ assigned_to: HILARY, revision: 0 });
    expect((await events(lead.id)).map((e) => e.event_type)).toEqual(["created"]);
  });

  it("a stale transfer (expected_revision) is refused with the current lead", async () => {
    const lead = await addLead({ name: "x", notes: "a" }, HILARY);
    await api.patch(HILARY, lead.id, 0, { notes: "b" }); // -> revision 1
    const res = await api.transfer(HILARY, lead.id, { to_assigned_to: KENNEDY, expected_revision: 0 });
    expect(res.status).toBe(409);
    expect((await res.json()).conflict).toMatchObject({ assigned_to: HILARY, revision: 1 });
    expect(await leadRow(lead.id)).toMatchObject({ assigned_to: HILARY });
  });

  it("a chain of transfers keeps ONE lead and a complete, ordered trail", async () => {
    const lead = await addLead(SHEET, HILARY);
    await api.transfer(HILARY, lead.id, { to_assigned_to: KENNEDY });
    await api.transfer(KENNEDY, lead.id, { to_ooa: true });
    await api.transfer(TONJA, lead.id, { to_assigned_to: HILARY, reason: "Back in area" });
    expect(await countLeads()).toBe(1);
    const trail = (await events(lead.id)).map((e) => `${e.event_type}:${e.from_label ?? "-"}>${e.to_label ?? "-"}`);
    expect(trail).toEqual(["created:->Hilary", "transferred:Hilary>Kennedy", "transferred:Kennedy>OOA", "transferred:OOA>Hilary"]);
    expect(await leadRow(lead.id)).toMatchObject({ assigned_to: HILARY, revision: 3, orders_count: 4, name: "Dana Whitaker" });
  });

  it("the history the owner reads shows previous → new, who and when", async () => {
    const lead = await addLead({ name: "x" }, HILARY);
    await api.transfer(HILARY, lead.id, { to_assigned_to: KENNEDY, reason: "Territory" });
    const detail = await json<{ events: Row[] }>(api.get(KENNEDY, lead.id));
    expect(detail.events[0]).toMatchObject({
      event_type: "transferred", from_label: "Hilary", to_label: "Kennedy", actor_name: "Hilary", reason: "Territory",
    });
  });
});

// ===========================================================================
// 6) Immutable history + ownership can't move sideways
// ===========================================================================

describe("immutability", () => {
  it("history rows can never be edited or deleted — not even by the service role", async () => {
    const lead = await addLead({ name: "x" }, HILARY);
    await api.transfer(HILARY, lead.id, { to_assigned_to: KENNEDY });
    await expect(db.sql(`UPDATE swag_lead_events SET to_label = 'Forged' WHERE lead_id = $1`, [lead.id])).rejects.toMatchObject({ code: "23514" });
    await expect(db.sql(`UPDATE swag_lead_events SET actor_name = 'Forged' WHERE lead_id = $1`, [lead.id])).rejects.toMatchObject({ code: "23514" });
    await expect(db.sql(`DELETE FROM swag_lead_events WHERE lead_id = $1`, [lead.id])).rejects.toMatchObject({ code: "23514" });
    expect((await events(lead.id)).map((e) => e.to_label)).toEqual(["Hilary", "Kennedy"]);
  });

  it("ordinary edits never touch assignment history", async () => {
    const lead = await addLead({ name: "x" }, HILARY);
    await api.transfer(HILARY, lead.id, { to_assigned_to: KENNEDY });
    const before = await events(lead.id);
    await api.patch(KENNEDY, lead.id, 1, { notes: "edit", follow_up_attempts: 2 });
    await api.patch(TONJA, lead.id, 2, { name: "renamed" });
    const after = await events(lead.id);
    expect(after.slice(0, before.length)).toEqual(before); // the earlier rows are byte-identical
    expect(after.filter((e) => e.event_type === "transferred")).toHaveLength(1);
  });

  it("ownership cannot change except through transfer_swag_lead (which writes the history)", async () => {
    const lead = await addLead({ name: "x" }, HILARY);
    await expect(db.sql(`UPDATE swag_leads SET assigned_to = $2 WHERE id = $1`, [lead.id, KENNEDY])).rejects.toMatchObject({ code: "23514" });
    await expect(db.sql(`UPDATE swag_leads SET assigned_to = NULL, is_ooa = TRUE WHERE id = $1`, [lead.id])).rejects.toMatchObject({ code: "23514" });
    expect(await leadRow(lead.id)).toMatchObject({ assigned_to: HILARY, is_ooa: false });
    expect((await events(lead.id)).map((e) => e.event_type)).toEqual(["created"]);
  });

  it("permanent fields can't change, leads can't be deleted, and every lead has exactly one owner", async () => {
    const lead = await addLead({ name: "x" }, HILARY);
    await expect(db.sql(`UPDATE swag_leads SET created_by = $2 WHERE id = $1`, [lead.id, KENNEDY])).rejects.toMatchObject({ code: "23514" });
    await expect(db.sql(`UPDATE swag_leads SET is_test_data = TRUE WHERE id = $1`, [lead.id])).rejects.toMatchObject({ code: "23514" });
    await expect(db.sql(`UPDATE swag_leads SET created_at = created_at - interval '1 day' WHERE id = $1`, [lead.id])).rejects.toMatchObject({ code: "23514" });
    await expect(db.sql(`DELETE FROM swag_leads WHERE id = $1`, [lead.id])).rejects.toMatchObject({ code: "23514" });
    // Neither an owner AND OOA, nor neither.
    await expect(db.sql(`INSERT INTO swag_leads (name, assigned_to, is_ooa) VALUES ('x', $1, TRUE)`, [HILARY])).rejects.toMatchObject({ code: "23514" });
    await expect(db.sql(`INSERT INTO swag_leads (name, assigned_to, is_ooa) VALUES ('x', NULL, FALSE)`)).rejects.toMatchObject({ code: "23514" });
    // The owner must be a real salesperson.
    await expect(db.sql(`INSERT INTO swag_leads (name, assigned_to) VALUES ('x', '99999999-0000-4000-8000-000000000000')`)).rejects.toMatchObject({ code: "23503" });
  });
});

// ===========================================================================
// 7) Dashboard metrics: team, individual AE, OOA, click-through
// ===========================================================================

/** A known dataset: Hilary 4 leads, Kennedy 3, OOA 2. */
async function dataset() {
  const d = "2026-09-";
  const H = (fields: Row) => addLead({ date_lead_received: `${d}01`, ...fields }, HILARY);
  const K = (fields: Row) => addLead({ date_lead_received: `${d}01`, ...fields }, KENNEDY);
  await H({ name: "H1 never contacted" });
  await H({ name: "H2 contacted, no follow-up", date_first_contact: `${d}05` });
  await H({ name: "H3 worked", date_first_contact: `${d}05`, follow_up_attempts: 3, swag_delivered: true, met_in_person: true, confirmed_realtor: true });
  await H({ name: "H4 sent business", date_first_contact: `${d}05`, follow_up_attempts: 2, swag_delivered: true, met_in_person: true, orders_received: true, orders_count: 5, transactions_last_12_months: 20 });
  await K({ name: "K1 never contacted" });
  await K({ name: "K2 met, swag", date_first_contact: `${d}06`, follow_up_attempts: 1, swag_delivered: true, met_in_person: true });
  await K({ name: "K3 sent business", date_first_contact: `${d}06`, follow_up_attempts: 4, orders_received: true, orders_count: 2 });
  await addLead({ name: "O1 ooa never contacted", date_lead_received: `${d}02` }, "OOA");
  await addLead({ name: "O2 ooa met", date_lead_received: `${d}02`, date_first_contact: `${d}07`, follow_up_attempts: 1, met_in_person: true }, "OOA");
}

describe("dashboard metrics", () => {
  it("TEAM view: totals across every AE plus OOA, with OOA as its own bucket", async () => {
    await dataset();
    const t = await json<ListBody>(api.list(TONJA));
    expect(t.scope.kind).toBe("all");
    expect(t.metrics).toEqual({
      total: 9, needs_first_contact: 3, contacted: 6, followed_up: 5, no_follow_up: 1,
      follow_up_attempts: 11, met_in_person: 4, swag_delivered: 3,
      agents_with_orders: 2, total_orders: 7, ooa: 2,
    });
    // OOA is separate and excluded from the AE rows / AE subtotal.
    expect(t.ooa_metrics).toMatchObject({ total: 2, needs_first_contact: 1, met_in_person: 1, ooa: 2 });
    expect(t.ae_total).toMatchObject({ total: 7, ooa: 0, total_orders: 7, agents_with_orders: 2 });
    expect(t.by_ae!.map((r) => [r.name, r.metrics.total])).toEqual([["Hilary", 4], ["Kennedy", 3]]);
    expect(t.by_ae!.every((r) => r.metrics.ooa === 0)).toBe(true);
    // AE rows + OOA bucket = team, each lead counted once.
    expect(t.by_ae!.reduce((n, r) => n + r.metrics.total, 0) + t.ooa_metrics!.total).toBe(t.metrics.total);
    expect(t.by_ae!.reduce((n, r) => n + r.metrics.total_orders, 0)).toBe(t.metrics.total_orders);
  });

  it("INDIVIDUAL AE view: the metrics are recomputed for that AE (not the team's) and so is the list", async () => {
    await dataset();
    const team = await json<ListBody>(api.list(TONJA));
    const h = await json<ListBody>(api.list(TONJA, `scope=${HILARY}`));
    expect(h.scope).toMatchObject({ kind: "ae", ae_id: HILARY, ae_name: "Hilary" });
    expect(h.metrics).toEqual({
      total: 4, needs_first_contact: 1, contacted: 3, followed_up: 2, no_follow_up: 1,
      follow_up_attempts: 5, met_in_person: 2, swag_delivered: 2,
      agents_with_orders: 1, total_orders: 5, ooa: 0,
    });
    expect(h.metrics).not.toEqual(team.metrics);
    expect(h.leads).toHaveLength(4);
    expect(h.leads.every((l) => l.assigned_to === HILARY)).toBe(true);
    expect(h.by_ae).toBeNull(); // no team breakdown in a single-AE view

    const k = await json<ListBody>(api.list(TONJA, `scope=${KENNEDY}`));
    expect(k.metrics).toMatchObject({ total: 3, agents_with_orders: 1, total_orders: 2 });
    // The same numbers the AE sees for themselves.
    expect((await json<ListBody>(api.list(HILARY))).metrics).toEqual(h.metrics);
  });

  it("OOA view shows only OOA leads", async () => {
    await dataset();
    const o = await json<ListBody>(api.list(FAITH, "scope=ooa"));
    expect(o.scope.kind).toBe("ooa");
    expect(o.metrics).toMatchObject({ total: 2, ooa: 2, met_in_person: 1 });
    expect(o.leads.every((l) => l.is_ooa && l.assigned_to === null)).toBe(true);
  });

  it("CLICKABLE metrics: for every metric the list IS exactly the set the count describes", async () => {
    await dataset();
    const scopes = ["", `scope=${HILARY}`, `scope=${KENNEDY}`, "scope=ooa"];
    for (const scope of scopes) {
      const base = await json<ListBody>(api.list(TONJA, scope));
      for (const key of SWAG_METRIC_KEYS) {
        const res = await json<ListBody>(api.list(TONJA, [scope, `metric=${key}`].filter(Boolean).join("&")));
        expect(res.active_metric).toBe(key);
        expect(res.matched, `${scope || "all"}:${key}`).toBe(res.leads.length);
        // The list equals the scope filtered by the metric's own predicate…
        const expected = base.leads.filter((l) => matchesMetric(l as never, key)).map((l) => l.id).sort();
        expect(res.leads.map((l) => l.id).sort(), `${scope || "all"}:${key}`).toEqual(expected);
        // …and the headline count agrees with the list.
        const headline: Record<string, number> = {
          total: base.metrics.total, needs_first_contact: base.metrics.needs_first_contact, contacted: base.metrics.contacted,
          followed_up: base.metrics.followed_up, no_follow_up: base.metrics.no_follow_up, met_in_person: base.metrics.met_in_person,
          swag_delivered: base.metrics.swag_delivered, with_orders: base.metrics.agents_with_orders, ooa: base.metrics.ooa,
        };
        expect(res.leads.length, `${scope || "all"}:${key}`).toBe(headline[key]);
        // Metrics stay whole-scope even while the list is narrowed.
        expect(res.metrics).toEqual(base.metrics);
      }
    }
  });

  it("the specific click-throughs return the right leads (needs first contact, met in person, agents with orders, OOA)", async () => {
    await dataset();
    const names = async (qs: string) => (await json<ListBody>(api.list(TONJA, qs))).leads.map((l) => String(l.name).split(" ")[0]).sort();
    expect(await names("metric=needs_first_contact")).toEqual(["H1", "K1", "O1"]);
    expect(await names("metric=met_in_person")).toEqual(["H3", "H4", "K2", "O2"]);
    expect(await names("metric=with_orders")).toEqual(["H4", "K3"]);
    expect(await names("metric=ooa")).toEqual(["O1", "O2"]);
    expect(await names("metric=no_follow_up")).toEqual(["H2"]); // contacted, nothing logged since
    expect(await names("metric=swag_delivered")).toEqual(["H3", "H4", "K2"]);
  });

  it("orders count the AGENT's business ('How many?'), never swag: totals sum orders_count only", async () => {
    await addLead({ name: "a", orders_received: true, orders_count: 3, swag_delivered: true }, HILARY);
    await addLead({ name: "b", orders_received: true }, HILARY); // yes, count unknown
    await addLead({ name: "c", swag_delivered: true }, HILARY); // swag delivered, no business
    const m = (await json<ListBody>(api.list(HILARY))).metrics;
    expect(m.total_orders).toBe(3);
    expect(m.agents_with_orders).toBe(2); // "Any orders received?" = yes
    expect(m.swag_delivered).toBe(2); // swag delivered is a separate outcome
  });

  it("needs-first-contact logic comes from the date alone; follow-up counts add up", async () => {
    const a = await addLead({ name: "a" }, HILARY);
    const b = await addLead({ name: "b", date_first_contact: "2026-09-10", date_lead_received: "2026-09-09" }, HILARY);
    const c = await addLead({ name: "c", date_first_contact: "2026-09-10", date_lead_received: "2026-09-09", follow_up_attempts: 2 }, HILARY);
    expect([a.attention, b.attention, c.attention]).toEqual(["needs_first_contact", "needs_follow_up", null]);
    const m = (await json<ListBody>(api.list(HILARY))).metrics;
    expect(m).toMatchObject({ needs_first_contact: 1, contacted: 2, followed_up: 1, no_follow_up: 1, follow_up_attempts: 2 });
    expect(m.needs_first_contact + m.contacted).toBe(m.total); // partition
    // Logging first contact moves it out of "needs first contact".
    await api.patch(HILARY, a.id, 0, { date_first_contact: "2026-09-29" });
    expect((await json<ListBody>(api.list(HILARY))).metrics).toMatchObject({ needs_first_contact: 0, contacted: 3, no_follow_up: 2 });
  });

  it("attention-needing leads sort first, oldest waiting first", async () => {
    await addLead({ name: "worked", date_lead_received: "2026-09-01", date_first_contact: "2026-09-02", follow_up_attempts: 1 }, HILARY);
    await addLead({ name: "new", date_lead_received: "2026-09-20" }, HILARY);
    await addLead({ name: "old", date_lead_received: "2026-09-03" }, HILARY);
    await addLead({ name: "no-follow-up", date_lead_received: "2026-09-04", date_first_contact: "2026-09-05" }, HILARY);
    expect((await json<ListBody>(api.list(HILARY))).leads.map((l) => l.name)).toEqual(["old", "new", "no-follow-up", "worked"]);
  });
});

// ===========================================================================
// 8) Reporting: transfers, OOA, current owner, other reports
// ===========================================================================

describe("reporting", () => {
  it("a transfer never double-counts: the team total is unchanged; one AE loses it, the other gains it", async () => {
    await dataset();
    const before = await json<ListBody>(api.list(TONJA));
    const hilaryLead = before.leads.find((l) => String(l.name).startsWith("H3"))!;
    await api.transfer(HILARY, hilaryLead.id, { to_assigned_to: KENNEDY });

    const after = await json<ListBody>(api.list(TONJA));
    expect(after.metrics.total).toBe(before.metrics.total);
    expect(after.metrics.total_orders).toBe(before.metrics.total_orders);
    const row = (t: ListBody, id: string) => t.by_ae!.find((r) => r.ae_id === id)!.metrics.total;
    expect([row(after, HILARY), row(after, KENNEDY)]).toEqual([row(before, HILARY) - 1, row(before, KENNEDY) + 1]);
    expect(after.by_ae!.reduce((n, r) => n + r.metrics.total, 0) + after.ooa_metrics!.total).toBe(after.metrics.total);
  });

  it("current-owner reporting: a lead counts for its CURRENT AE only; history does not inflate anyone", async () => {
    const lead = await addLead({ name: "x", orders_received: true, orders_count: 6 }, HILARY);
    await api.transfer(HILARY, lead.id, { to_assigned_to: KENNEDY });
    await api.transfer(KENNEDY, lead.id, { to_assigned_to: HILARY });
    await api.transfer(HILARY, lead.id, { to_assigned_to: KENNEDY });
    const t = await json<ListBody>(api.list(TONJA));
    expect(t.by_ae!.find((r) => r.ae_id === HILARY)!.metrics).toMatchObject({ total: 0, total_orders: 0 });
    expect(t.by_ae!.find((r) => r.ae_id === KENNEDY)!.metrics).toMatchObject({ total: 1, total_orders: 6, agents_with_orders: 1 });
    expect(t.metrics).toMatchObject({ total: 1, total_orders: 6 });
  });

  it("OOA is excluded from AE performance and shown as a separate bucket; moving a lead to OOA moves it between buckets", async () => {
    const lead = await addLead({ name: "x", orders_received: true, orders_count: 2 }, HILARY);
    let t = await json<ListBody>(api.list(TONJA));
    expect(t.ae_total).toMatchObject({ total: 1, total_orders: 2 });
    expect(t.ooa_metrics).toMatchObject({ total: 0 });
    await api.transfer(HILARY, lead.id, { to_ooa: true });
    t = await json<ListBody>(api.list(TONJA));
    expect(t.ae_total).toMatchObject({ total: 0, total_orders: 0 });
    expect(t.ooa_metrics).toMatchObject({ total: 1, total_orders: 2 });
    expect(t.metrics).toMatchObject({ total: 1, ooa: 1 }); // the team includes it
    expect(t.by_ae!.every((r) => r.metrics.total === 0)).toBe(true);
  });

  it("every active AE appears in the team breakdown (zero leads is informative); Chanel appears only if she still owns leads", async () => {
    let t = await json<ListBody>(api.list(TONJA));
    expect(t.by_ae!.map((r) => r.name)).toEqual(["Hilary", "Kennedy"]);
    await db.sql(`UPDATE salespeople SET deactivated_at = NULL WHERE id = $1`, [CHANEL]);
    await db.sql(`UPDATE salespeople SET deactivated_at = NOW() WHERE id = $1`, [HILARY]);
    await db.sql(`INSERT INTO swag_leads (name, assigned_to, created_by) VALUES ('old', $1, $2)`, [HILARY, COREY]);
    t = await json<ListBody>(api.list(TONJA));
    expect(t.by_ae!.map((r) => [r.name, r.metrics.total])).toEqual([["Chanel", 0], ["Hilary", 1], ["Kennedy", 0]]);
  });

  it("territory is DERIVED from the current owner (existing Cogent mappings) and follows a transfer", async () => {
    const lead = await addLead({ name: "x" }, HILARY);
    let t = await json<ListBody>(api.list(TONJA));
    expect(t.leads[0].territories).toEqual(["Utah County", "Wasatch Front"]); // active mappings only
    expect(t.territories).toEqual(["Utah County", "Wasatch Front"]);
    expect((await json<ListBody>(api.list(TONJA, "territory=Wasatch%20Front"))).leads).toHaveLength(1);
    expect((await json<ListBody>(api.list(TONJA, "territory=Davis"))).leads).toHaveLength(0);
    await api.transfer(TONJA, lead.id, { to_assigned_to: KENNEDY });
    t = await json<ListBody>(api.list(TONJA));
    expect(t.leads[0].territories).toEqual(["Davis"]); // "Old Territory" is inactive
    expect((await json<ListBody>(api.list(TONJA, "territory=Davis"))).leads).toHaveLength(1);
    expect((await json<ListBody>(api.list(TONJA, "territory=Wasatch%20Front"))).leads).toHaveLength(0);
    await api.transfer(TONJA, lead.id, { to_ooa: true });
    expect((await json<ListBody>(api.list(TONJA, "scope=ooa"))).leads[0].territories).toEqual([]);
  });

  it("search and filters narrow the LIST but never the metrics", async () => {
    await dataset();
    const base = await json<ListBody>(api.list(TONJA));
    const q = async (qs: string) => json<ListBody>(api.list(TONJA, qs));
    expect((await q("q=H3")).leads.map((l) => l.name)).toEqual(["H3 worked"]);
    expect((await q("q=h3")).matched).toBe(1); // case-insensitive
    expect((await q("confirmed_realtor=yes")).leads.map((l) => l.name)).toEqual(["H3 worked"]);
    expect((await q("contacted=no")).matched).toBe(3);
    expect((await q("contacted=yes&met_in_person=yes")).matched).toBe(4 - 0);
    expect((await q("swag_delivered=no&orders_received=yes")).leads.map((l) => l.name)).toEqual(["K3 sent business"]);
    expect((await q("from=2026-09-02&to=2026-09-02")).matched).toBe(2); // the OOA pair
    expect((await q("from=2026-09-03")).matched).toBe(0);
    expect((await q("q=zzz")).matched).toBe(0);
    expect((await q("q=H3")).metrics).toEqual(base.metrics);
    // Contact info is searchable too.
    await addLead({ name: "Phone Person", contact_info: "801-555-0199" }, HILARY);
    expect((await q("q=555-0199")).leads.map((l) => l.name)).toEqual(["Phone Person"]);
  });

  it("swag leads change NOTHING in the existing reporting (leaderboard standings are identical)", async () => {
    await db.sql(
      `INSERT INTO activity_entries (salesperson_id, entry_date, office_visits) VALUES ($1, '2026-09-28', 5), ($2, '2026-09-28', 9)`,
      [HILARY, KENNEDY],
    );
    const standings = async () =>
      (await computeStandings(db.client as never, "2026-09-28", "2026-09-29", "2026-09-28", "2026-09-29")).standings;
    const before = await standings();
    expect(before.length).toBeGreaterThan(0);
    await dataset();
    const lead = (await json<ListBody>(api.list(TONJA))).leads[0];
    await api.transfer(TONJA, lead.id, { to_ooa: true });
    expect(await standings()).toEqual(before);
    // And Gold List is untouched (separate tables, no shared rows).
    expect(Number((await db.sql(`SELECT count(*)::int AS n FROM gold_list_agents`))[0].n)).toBe(0);
  });
});

// ===========================================================================
// 9) Test-account isolation
// ===========================================================================

describe("the private Test AE sandbox", () => {
  it("test leads never appear in any aggregate or another admin's view, only the test account's owner's", async () => {
    await addLead({ name: "real" }, HILARY);
    const test = await addLead({ name: "sandbox", orders_received: true, orders_count: 9 }, TEST_AE, COREY);
    expect(await leadRow(test.id)).toMatchObject({ is_test_data: true });

    // Not in the team numbers or the AE breakdown, for anyone — owner included.
    for (const who of [COREY, RYAN, TONJA]) {
      const t = await json<ListBody>(api.list(who));
      expect(t.metrics, nameOf[who]).toMatchObject({ total: 1, total_orders: 0 });
      expect(t.leads.map((l) => l.name), nameOf[who]).toEqual(["real"]);
      expect(t.by_ae!.map((r) => r.name), nameOf[who]).toEqual(["Hilary", "Kennedy"]);
    }
    // The owner reaches it by selecting the test AE; others get "not found".
    expect((await json<ListBody>(api.list(COREY, `scope=${TEST_AE}`))).leads.map((l) => l.name)).toEqual(["sandbox"]);
    expect((await api.list(RYAN, `scope=${TEST_AE}`)).status).toBe(404);
    expect((await api.list(TONJA, `scope=${TEST_AE}`)).status).toBe(404);
    expect((await api.get(COREY, test.id)).status).toBe(200);
    expect((await api.get(RYAN, test.id)).status).toBe(404);
    expect((await api.get(TONJA, test.id)).status).toBe(404);
    expect((await api.patch(RYAN, test.id, 0, { notes: "x" })).status).toBe(404);
    expect((await api.transfer(RYAN, test.id, { to_ooa: true })).status).toBe(404);
    // Only Corey's own roster shows the test AE as an option.
    expect((await json<ListBody>(api.list(COREY))).ae_options.map((o) => o.first_name)).toEqual(["Hilary", "Kennedy", "Test AE"]);
    expect((await json<ListBody>(api.list(RYAN))).ae_options.map((o) => o.first_name)).toEqual(["Hilary", "Kennedy"]);
  });

  it("the Test AE can use its own leads end to end", async () => {
    const res = await api.create(TEST_AE, { name: "mine" });
    expect(res.status).toBe(201);
    const lead = (await json<{ lead: Lead }>(res)).lead;
    expect(await leadRow(lead.id)).toMatchObject({ is_test_data: true, assigned_to: TEST_AE });
    expect((await api.patch(TEST_AE, lead.id, 0, { follow_up_attempts: 1 })).status).toBe(200);
    expect((await json<ListBody>(api.list(TEST_AE))).leads).toHaveLength(1);
    expect((await json<ListBody>(api.list(TONJA))).leads).toHaveLength(0);
  });

  it("test and real leads can't be mixed by any transfer or create", async () => {
    const real = await addLead({ name: "real" }, HILARY);
    const test = await addLead({ name: "test" }, TEST_AE, COREY);
    expect((await api.transfer(COREY, real.id, { to_assigned_to: TEST_AE })).status).toBe(400);
    expect((await api.transfer(COREY, test.id, { to_assigned_to: HILARY })).status).toBe(400);
    expect((await api.create(TEST_AE, { name: "x", assigned_to: HILARY })).status).toBe(403);
    // A test lead may still go to OOA and back to a test AE.
    expect((await api.transfer(COREY, test.id, { to_ooa: true })).status).toBe(200);
    expect(await leadRow(test.id)).toMatchObject({ is_ooa: true, is_test_data: true });
    // …where it stays out of the real OOA bucket.
    expect((await json<ListBody>(api.list(RYAN, "scope=ooa"))).leads).toEqual([]);
    expect((await json<ListBody>(api.list(COREY, "scope=ooa"))).leads.map((l) => l.id)).toEqual([test.id]);
    expect((await json<ListBody>(api.list(TONJA))).ooa_metrics).toMatchObject({ total: 0 });
  });
});

// ===========================================================================
// 10) Concurrency (staged on one connection; real locking: realpg test)
// ===========================================================================

describe("races", () => {
  it("an edit that loses a race to a transfer is refused (the editor no longer owns the lead)", async () => {
    const lead = await addLead({ name: "x", notes: "orig" }, HILARY);
    // After the route's ownership check but before its database call, management moves the lead.
    db.beforeWrite("update_swag_lead", "rpc", async () => {
      expect((await api.transfer(TONJA, lead.id, { to_assigned_to: KENNEDY })).status).toBe(200);
    });
    const res = await api.patch(HILARY, lead.id, 0, { notes: "Hilary's late edit" });
    expect(res.status).toBe(403);
    expect(await leadRow(lead.id)).toMatchObject({ assigned_to: KENNEDY, notes: "orig" });
    expect((await events(lead.id)).map((e) => e.event_type)).toEqual(["created", "transferred"]);
  });

  it("two edits at the same revision: one wins, the other gets a conflict, nothing is lost", async () => {
    const lead = await addLead({ name: "x" }, HILARY);
    db.beforeWrite("update_swag_lead", "rpc", async () => {
      expect((await api.patch(TONJA, lead.id, 0, { follow_up_attempts: 7 })).status).toBe(200);
    });
    const res = await api.patch(HILARY, lead.id, 0, { swag_delivered: true });
    expect(res.status).toBe(409);
    expect(await leadRow(lead.id)).toMatchObject({ follow_up_attempts: 7, swag_delivered: false, revision: 1 });
  });

  it("two transfers of the same lead: the second finds a different owner and is refused; one trail, no duplicate", async () => {
    const lead = await addLead({ name: "x" }, HILARY);
    db.beforeWrite("transfer_swag_lead", "rpc", async () => {
      // Management sends it to OOA first…
      expect((await api.transfer(TONJA, lead.id, { to_ooa: true })).status).toBe(200);
    });
    // …then Hilary's in-flight transfer reaches the database: she no longer owns it.
    const res = await api.transfer(HILARY, lead.id, { to_assigned_to: KENNEDY });
    expect(res.status).toBe(403);
    expect(await leadRow(lead.id)).toMatchObject({ is_ooa: true, assigned_to: null });
    expect(await countLeads()).toBe(1);
    expect((await events(lead.id)).map((e) => e.to_label)).toEqual(["Hilary", "OOA"]);
  });

  it("a transfer with a stale revision after a concurrent edit is a clean conflict", async () => {
    const lead = await addLead({ name: "x" }, HILARY);
    db.beforeWrite("transfer_swag_lead", "rpc", async () => {
      await api.patch(HILARY, lead.id, 0, { notes: "edited meanwhile" });
    });
    const res = await api.transfer(HILARY, lead.id, { to_assigned_to: KENNEDY, expected_revision: 0 });
    expect(res.status).toBe(409);
    expect(await leadRow(lead.id)).toMatchObject({ assigned_to: HILARY, notes: "edited meanwhile" });
  });
});

// ===========================================================================
// 11) The permission surface the UI reads (chrome only)
// ===========================================================================

describe("GET /api/me/permissions exposes the Swag Leads capability", () => {
  it("true for admins and flagged accounts (Tonja, Faith); false for AEs and unflagged guests/assistants", async () => {
    const permissionsRoute = await import("@/app/api/me/permissions/route");
    const flag = async (who: string) =>
      (await json<{ can_manage_swag_leads: boolean }>(permissionsRoute.GET(req(who, "/api/me/permissions")))).can_manage_swag_leads;
    expect(await flag(COREY)).toBe(true);
    expect(await flag(RYAN)).toBe(true);
    expect(await flag(TONJA)).toBe(true);
    expect(await flag(FAITH)).toBe(true);
    expect(await flag(HILARY)).toBe(false);
    expect(await flag(LEAH)).toBe(false);
    expect(await flag(PAT)).toBe(false);
  });

  it("fails CLOSED when the capability can't be read (e.g. the migration isn't applied yet)", async () => {
    const real = db.client;
    holder.client = {
      from: (table: string) => {
        const q = real.from(table);
        if (table !== "salespeople") return q;
        const select = q.select.bind(q);
        q.select = (cols?: string) =>
          cols === "can_manage_swag_leads"
            ? ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: "42703", message: "column does not exist" } }) }) } as never)
            : select(cols);
        return q;
      },
      rpc: real.rpc.bind(real),
    };
    const permissionsRoute = await import("@/app/api/me/permissions/route");
    const res = await json<{ role: string; can_manage_swag_leads: boolean }>(permissionsRoute.GET(req(TONJA, "/api/me/permissions")));
    expect(res.can_manage_swag_leads).toBe(false); // not management, not an error
    expect((await api.list(TONJA)).status).toBe(403); // the feature itself also refuses
  });
});

// ===========================================================================
// 12) The one-time spreadsheet load script (supabase/swag_leads_load.template.sql)
// ===========================================================================

describe("one-time spreadsheet load template", () => {
  const template = readFileSync(join(process.cwd(), "supabase", "swag_leads_load.template.sql"), "utf8");
  const PLACEHOLDER = /\(NULL::text(?:,\s*NULL::text)+\)/;

  /** Runs the REAL template with `rows` substituted for its placeholder row. */
  const load = async (rows: string) => {
    expect(template).toMatch(PLACEHOLDER);
    await db.asOwner(template.replace(PLACEHOLDER, rows));
  };

  const ROWS = `
    ('Dana Whitaker', 'dana@example.com 801-555-0100', 'yes', '14', '2026-09-01', '2026-09-03', '3', 'yes', 'Y', 'x', '4', 'Met at the open house', 'Hilary'),
    ('Blank Bob', NULL, NULL, NULL, '2026-09-10', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'OOA'),
    ('No Orders Nina', NULL, 'no', NULL, '2026-09-05', '2026-09-06', '1', 'no', 'no', 'yes', NULL, NULL, 'Kennedy'),
    ('Bad Dates Dave', NULL, 'yes', NULL, '2026-09-10', '2026-09-01', '0', 'no', 'no', 'no', NULL, NULL, 'Hilary'),
    ('Ghost Gail', NULL, 'yes', NULL, '2026-09-10', NULL, '0', 'no', 'no', 'no', NULL, NULL, 'Nobody'),
    ('Counted But No Dora', NULL, 'yes', NULL, '2026-09-10', NULL, '0', 'no', 'no', 'no', '3', NULL, 'Hilary'),
    ('Not An AE Andy', NULL, 'yes', NULL, '2026-09-10', NULL, '0', 'no', 'no', 'no', NULL, NULL, 'Tonja')`;

  it("loads the good rows exactly as the spreadsheet says, and skips (never 'fixes') the bad ones", async () => {
    await load(ROWS);
    const rows = await db.sql(
      `SELECT l.*, s.first_name::text AS owner FROM swag_leads l LEFT JOIN salespeople s ON s.id = l.assigned_to ORDER BY l.name`,
    );
    expect(rows.map((r) => r.name)).toEqual(["Blank Bob", "Dana Whitaker", "No Orders Nina"]);

    const dana = rows.find((r) => r.name === "Dana Whitaker")!;
    expect(dana).toMatchObject({
      owner: "Hilary", contact_info: "dana@example.com 801-555-0100", confirmed_realtor: true,
      transactions_last_12_months: 14, date_lead_received: "2026-09-01", date_first_contact: "2026-09-03",
      follow_up_attempts: 3, swag_delivered: true, met_in_person: true, orders_received: true, orders_count: 4,
      notes: "Met at the open house", is_ooa: false, revision: 0,
    });
    // A row of blanks keeps the spreadsheet's "blank": not contacted, No answers, nothing recorded.
    expect(rows.find((r) => r.name === "Blank Bob")).toMatchObject({
      owner: null, is_ooa: true, assigned_to: null, contact_info: null, confirmed_realtor: false,
      transactions_last_12_months: null, date_first_contact: null, follow_up_attempts: 0,
      swag_delivered: false, met_in_person: false, orders_received: false, orders_count: null, notes: null,
      date_lead_received: "2026-09-10",
    });
    // "Yes" with no count: the answer is known, the number isn't.
    expect(rows.find((r) => r.name === "No Orders Nina")).toMatchObject({ orders_received: true, orders_count: null, owner: "Kennedy" });
  });

  it("every loaded lead has a 'created' history row crediting the admin; re-running loads nothing twice", async () => {
    await load(ROWS);
    const first = await db.sql(`SELECT count(*)::int AS n FROM swag_leads`);
    expect(first[0].n).toBe(3);
    const ev = await db.sql(`SELECT event_type, actor_name, to_label FROM swag_lead_events ORDER BY seq`);
    expect(ev).toHaveLength(3);
    expect(ev.every((e) => e.event_type === "created" && e.actor_name === "Corey")).toBe(true);
    expect(ev.map((e) => e.to_label).sort()).toEqual(["Hilary", "Kennedy", "OOA"]);

    await load(ROWS); // again
    expect((await db.sql(`SELECT count(*)::int AS n FROM swag_leads`))[0].n).toBe(3);
    expect((await db.sql(`SELECT count(*)::int AS n FROM swag_lead_events`))[0].n).toBe(3);
  });

  it("the loaded leads behave like any other: they count in the dashboard under their owners", async () => {
    await load(ROWS);
    const t = await json<ListBody>(api.list(TONJA));
    expect(t.metrics).toMatchObject({ total: 3, ooa: 1, agents_with_orders: 2, total_orders: 4, needs_first_contact: 1 });
    expect(t.by_ae!.map((r) => [r.name, r.metrics.total])).toEqual([["Hilary", 1], ["Kennedy", 1]]);
    expect(t.ooa_metrics).toMatchObject({ total: 1 });
  });

  it("with its placeholder row untouched it loads nothing", async () => {
    await db.asOwner(template);
    expect(await countLeads()).toBe(0);
  });
});

// ===========================================================================
// 13) A create REPLAY must respect CURRENT ownership (security regression)
//
// Codex finding: a matching request_id + created_by returned the existing lead
// without re-checking who owns it NOW — so an AE who created a lead, then had
// it transferred away, could replay the original request and read the new
// owner's lead (contact info, notes). Creating a lead does not entitle you to it
// forever.
// ===========================================================================

describe("create replay and current-owner visibility", () => {
  const RID = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
  const SECRET = {
    name: "Replay Target",
    contact_info: "secret-contact@example.com 801-555-0142",
    notes: "SECRET-NOTE-FOR-THE-CURRENT-OWNER",
    transactions_last_12_months: 31,
    orders_received: true,
    orders_count: 7,
  };
  const leaks = (body: unknown) => {
    const text = JSON.stringify(body);
    return ["Replay Target", "secret-contact", "801-555-0142", "SECRET-NOTE", "Hilary", "Kennedy"].filter((t) => text.includes(t));
  };

  it("the former owner gets a 404 with NO lead data; the new owner and management still reach the lead", async () => {
    // 1) Hilary creates a lead.
    const created = await api.create(HILARY, { ...SECRET, request_id: RID });
    expect(created.status).toBe(201);
    const lead = (await json<{ lead: Lead }>(created)).lead;

    // 2) While she still owns it, replaying the same request returns the existing lead (idempotent).
    const replay = await api.create(HILARY, { ...SECRET, request_id: RID });
    expect(replay.status).toBe(201);
    expect((await json<{ lead: Lead }>(replay)).lead.id).toBe(lead.id);
    expect(await countLeads()).toBe(1);

    // 3) The lead is transferred to Kennedy.
    expect((await api.transfer(TONJA, lead.id, { to_assigned_to: KENNEDY })).status).toBe(200);

    // 4) Hilary replays the ORIGINAL request id: not found, and not a byte of lead data.
    const stolen = await api.create(HILARY, { ...SECRET, request_id: RID });
    expect(stolen.status).toBe(404);
    const body = await stolen.json();
    expect(body).toEqual({ error: "Swag lead not found." }); // nothing but the error
    expect(leaks(body)).toEqual([]);
    expect(Object.keys(body)).toEqual(["error"]);

    // 5) Nothing changed: still Kennedy's, still one lead, no extra history.
    expect(await leadRow(lead.id)).toMatchObject({ assigned_to: KENNEDY, revision: 1 });
    expect(await countLeads()).toBe(1);
    expect((await events(lead.id)).map((e) => e.event_type)).toEqual(["created", "transferred"]);

    // 6) The new owner can still retrieve it; so can management.
    const kennedy = await json<{ lead: Lead }>(api.get(KENNEDY, lead.id));
    expect(kennedy.lead).toMatchObject({ id: lead.id, contact_info: SECRET.contact_info, notes: SECRET.notes });
    expect((await api.get(TONJA, lead.id)).status).toBe(200);
    expect((await api.get(COREY, lead.id)).status).toBe(200);
    // …and Hilary cannot read it any other way either.
    expect((await api.get(HILARY, lead.id)).status).toBe(404);
  });

  it("the same holds when the lead was moved to OOA (nobody's AE view)", async () => {
    const lead = (await json<{ lead: Lead }>(api.create(HILARY, { ...SECRET, request_id: RID }))).lead;
    expect((await api.transfer(HILARY, lead.id, { to_ooa: true })).status).toBe(200);
    const res = await api.create(HILARY, { ...SECRET, request_id: RID });
    expect(res.status).toBe(404);
    expect(leaks(await res.json())).toEqual([]);
    expect(await leadRow(lead.id)).toMatchObject({ is_ooa: true, assigned_to: null });
  });

  it("a former owner who transferred it back to herself can replay again (visibility is simply 'owns it now')", async () => {
    const lead = (await json<{ lead: Lead }>(api.create(HILARY, { ...SECRET, request_id: RID }))).lead;
    await api.transfer(HILARY, lead.id, { to_assigned_to: KENNEDY });
    expect((await api.create(HILARY, { ...SECRET, request_id: RID })).status).toBe(404);
    await api.transfer(TONJA, lead.id, { to_assigned_to: HILARY });
    const again = await api.create(HILARY, { ...SECRET, request_id: RID });
    expect(again.status).toBe(201);
    expect((await json<{ lead: Lead }>(again)).lead.id).toBe(lead.id);
  });

  it("management keeps normal replay behaviour after the lead moves (management can see every lead)", async () => {
    const created = await json<{ lead: Lead }>(api.create(TONJA, { ...SECRET, assigned_to: HILARY, request_id: RID }));
    await api.transfer(TONJA, created.lead.id, { to_assigned_to: KENNEDY });
    const replay = await api.create(TONJA, { ...SECRET, assigned_to: HILARY, request_id: RID });
    expect(replay.status).toBe(201);
    expect((await json<{ lead: Lead }>(replay)).lead).toMatchObject({ id: created.lead.id, assigned_to: KENNEDY });
    expect(await countLeads()).toBe(1);
  });

  it("an ordinary retry / double tap while the creator still owns it is unchanged: one lead, one history row", async () => {
    const a = await json<{ lead: Lead }>(api.create(KENNEDY, { name: "Tap", request_id: RID }));
    const b = await json<{ lead: Lead }>(api.create(KENNEDY, { name: "Tap", request_id: RID }));
    const c = await json<{ lead: Lead }>(api.create(KENNEDY, { name: "Tap", request_id: RID }));
    expect([b.lead.id, c.lead.id]).toEqual([a.lead.id, a.lead.id]);
    expect(await countLeads()).toBe(1);
    expect(await events(a.lead.id)).toHaveLength(1);
  });

  it("the database refuses it on its own (calling the function directly cannot bypass the route)", async () => {
    const call = (actor: string) =>
      db.client.rpc("create_swag_lead", {
        p_actor: actor, p_fields: { name: SECRET.name, notes: SECRET.notes }, p_assigned_to: actor, p_ooa: false, p_request_id: RID,
      });
    const first = await call(HILARY);
    expect(first.error).toBeNull();
    const leadId = (first.data as Lead).id;
    // Still the owner: replay returns the same lead.
    expect(((await call(HILARY)).data as Lead).id).toBe(leadId);
    await api.transfer(TONJA, leadId, { to_assigned_to: KENNEDY });
    // Former owner: not found, no data.
    const denied = await call(HILARY);
    expect(denied.data).toBeNull();
    expect(denied.error?.code).toBe("P0002");
    expect(JSON.stringify(denied)).not.toContain("SECRET-NOTE");
    // Management replaying the same key on its own behalf is a different creator: refused as before.
    expect((await db.client.rpc("create_swag_lead", {
      p_actor: TONJA, p_fields: { name: "x" }, p_assigned_to: HILARY, p_ooa: false, p_request_id: RID,
    })).error?.code).toBe("23505");
    expect(await leadRow(leadId)).toMatchObject({ assigned_to: KENNEDY, notes: SECRET.notes, revision: 1 });
    expect(await countLeads()).toBe(1);
  });

  it("someone else's request id still can't be used to reach the lead (existing behaviour kept)", async () => {
    await api.create(HILARY, { ...SECRET, request_id: RID });
    const res = await api.create(KENNEDY, { name: "Other", request_id: RID });
    expect(res.status).toBe(409);
    expect(leaks(await res.json())).toEqual([]);
  });

  it("a response to the person who just handed a lead off carries a receipt, not the lead's contact info or notes", async () => {
    const lead = (await json<{ lead: Lead }>(api.create(HILARY, { ...SECRET }))).lead;
    const res = await api.transfer(HILARY, lead.id, { to_assigned_to: KENNEDY, reason: "Territory" });
    expect(res.status).toBe(200);
    const body = await json<{ lead: Row }>(res);
    expect(body.lead).toMatchObject({ id: lead.id, assigned_to: KENNEDY, assigned_label: "Kennedy", is_ooa: false });
    const text = JSON.stringify(body);
    for (const secret of ["secret-contact", "801-555-0142", "SECRET-NOTE", "transactions", "orders_count"]) {
      expect(text, secret).not.toContain(secret);
    }
    // Management transferring still gets the whole lead back.
    const other = (await json<{ lead: Lead }>(api.create(TONJA, { ...SECRET, assigned_to: HILARY }))).lead;
    const mgr = await json<{ lead: Row }>(api.transfer(TONJA, other.id, { to_assigned_to: KENNEDY }));
    expect(mgr.lead).toMatchObject({ contact_info: SECRET.contact_info, notes: SECRET.notes, orders_count: 7 });
  });

  it("the other write paths already answer a former owner with 404/403 and no lead data", async () => {
    const lead = (await json<{ lead: Lead }>(api.create(HILARY, { ...SECRET }))).lead;
    await api.transfer(TONJA, lead.id, { to_assigned_to: KENNEDY });
    for (const res of [
      await api.get(HILARY, lead.id),
      await api.patch(HILARY, lead.id, 0, { notes: "late" }),
      await api.patch(HILARY, lead.id, 1, { notes: "late" }),
      await api.transfer(HILARY, lead.id, { to_assigned_to: HILARY }),
      await api.transfer(HILARY, lead.id, { to_assigned_to: HILARY, expected_revision: 0 }), // stale -> conflict path
    ]) {
      expect(res.status).toBe(404);
      expect(leaks(await res.json())).toEqual([]);
    }
    expect(await leadRow(lead.id)).toMatchObject({ notes: SECRET.notes, assigned_to: KENNEDY });
  });
});


// ===========================================================================
// 14) Migration safety: the initial grant is ONE-TIME; a re-run never undoes a revocation
// ===========================================================================

describe("the management grant in swag_leads.sql is one-time", () => {
  const sql = () => readFileSync(join(process.cwd(), "supabase", "swag_leads.sql"), "utf8");
  const flags = async () =>
    Object.fromEntries(
      (await db.sql(`SELECT first_name::text AS n, can_manage_swag_leads AS f FROM salespeople ORDER BY first_name`)).map(
        (r) => [r.n, r.f],
      ),
    );

  /** A database where the roster exists but this migration has never been applied. */
  async function preMigration() {
    await seed();
    await db.asOwner(`ALTER TABLE salespeople DROP COLUMN can_manage_swag_leads`);
  }

  it("apply -> Tonja and Faith get the grant; revoke one -> re-run -> it stays revoked", async () => {
    await preMigration();

    // 1) Apply the migration for the first time.
    await db.asOwner(sql());
    // 2) The intended users — and only them — are granted management.
    expect(await flags()).toEqual({
      Chanel: false, Corey: false, Faith: true, Hilary: false, Kennedy: false,
      Leah: false, Pat: false, Ryan: false, "Test AE": false, Tonja: true,
    });

    // 3) An administrator revokes Faith's access.
    await db.sql(`UPDATE salespeople SET can_manage_swag_leads = FALSE WHERE first_name = 'Faith'`);
    expect((await api.list(FAITH)).status).toBe(403);

    // 4) The migration is re-run (it is documented as safe to re-run) — twice.
    await db.asOwner(sql());
    await db.asOwner(sql());

    // 5) The revocation stands; nobody else's access moved either.
    expect((await flags()).Faith).toBe(false);
    expect((await flags()).Tonja).toBe(true);
    expect((await api.list(FAITH)).status).toBe(403);
    expect((await api.list(TONJA)).status).toBe(200);
  });

  it("revoking BOTH and re-running leaves both revoked; a later deliberate grant is kept across re-runs", async () => {
    await preMigration();
    await db.asOwner(sql());
    await db.sql(`UPDATE salespeople SET can_manage_swag_leads = FALSE WHERE first_name IN ('Tonja', 'Faith')`);
    await db.asOwner(sql());
    expect(await flags()).toMatchObject({ Tonja: false, Faith: false });

    // An administrator deliberately grants someone else (Pat) — a re-run leaves that alone too.
    await db.sql(`UPDATE salespeople SET can_manage_swag_leads = TRUE WHERE first_name = 'Pat'`);
    await db.asOwner(sql());
    expect(await flags()).toMatchObject({ Pat: true, Tonja: false, Faith: false });
  });

  it("a plain re-run on an untouched database changes nothing at all", async () => {
    await preMigration();
    await db.asOwner(sql());
    const before = await flags();
    await db.asOwner(sql());
    expect(await flags()).toEqual(before);
  });

  it("the rest of the migration still re-applies cleanly over live data (leads, history, functions)", async () => {
    await preMigration();
    await db.asOwner(sql());
    const lead = await addLead(SHEET, HILARY);
    await api.transfer(HILARY, lead.id, { to_assigned_to: KENNEDY });
    const before = { row: await leadRow(lead.id), ev: await events(lead.id) };
    await db.asOwner(sql());
    expect(await leadRow(lead.id)).toEqual(before.row);
    expect(await events(lead.id)).toEqual(before.ev);
    expect((await api.transfer(TONJA, lead.id, { to_assigned_to: HILARY })).status).toBe(200); // functions still work
  });

  it("structurally: the grant UPDATE exists only inside the 'column does not exist yet' branch", () => {
    // Code only: comments (which quote an example grant) are not statements.
    const text = sql().split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    const updates = [...text.matchAll(/UPDATE\s+salespeople\s+SET\s+can_manage_swag_leads/gi)];
    expect(updates).toHaveLength(1);
    const guarded = text.slice(
      text.indexOf("IF NOT EXISTS ("),
      text.indexOf("END IF;", text.indexOf("IF NOT EXISTS (")),
    );
    expect(guarded).toContain("information_schema.columns");
    expect(guarded).toContain("column_name = 'can_manage_swag_leads'");
    expect(guarded).toMatch(/ADD COLUMN can_manage_swag_leads/);
    expect(guarded).toMatch(/UPDATE salespeople\s+SET can_manage_swag_leads = TRUE/);
    // …and there is no top-level "set it back to TRUE if it is FALSE" statement.
    expect(text).not.toMatch(/AND\s+can_manage_swag_leads\s*=\s*FALSE/i);
  });
});
