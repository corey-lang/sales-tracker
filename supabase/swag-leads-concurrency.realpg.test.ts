/**
 * REAL multi-connection PostgreSQL tests for Swag Leads (supabase/swag_leads.sql).
 *
 * The PGlite route tests run ONE connection, so two transactions can never block
 * each other there. Here every actor is its own backend connection to a real
 * server, running as the non-superuser `service_role` against the real
 * migrations, and the tests assert actual lock waits (pg_blocking_pids), the
 * losers' refusals, and the server's own deadlock counter.
 *
 * OPT-IN (skipped by the normal `npm test`):
 *   REAL_PG=1 REAL_PG_MODULES=/dir/with/node_modules npx vitest run \
 *     supabase/swag-leads-concurrency.realpg.test.ts
 * (see src/test/real-pg.ts for how to get `embedded-postgres` + `pg`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { REAL_PG_ENABLED, isPending, startRealPg, type Row, type Session } from "@/test/real-pg";

const HILARY = "11111111-1111-4111-8111-111111111111";
const KENNEDY = "22222222-2222-4222-8222-222222222222";
const COREY = "55555555-5555-4555-8555-555555555555";
const TONJA = "77777777-7777-4777-8777-777777777777";

type Pg = Awaited<ReturnType<typeof startRealPg>>;

const CREATE = `SELECT id, revision FROM create_swag_lead($1, $2::jsonb, $3, $4, $5)`;
const UPDATE = `SELECT id, revision FROM update_swag_lead($1, $2, $3, $4::jsonb)`;
const TRANSFER = `SELECT id, revision FROM transfer_swag_lead($1, $2, $3, $4, $5, $6)`;

describe.skipIf(!REAL_PG_ENABLED)("REAL PostgreSQL: Swag Leads concurrency", () => {
  let pg: Pg;

  beforeAll(async () => {
    pg = await startRealPg();
  }, 180_000);
  afterAll(async () => {
    await pg?.stop();
  }, 60_000);

  async function seedLead(owner: string | "OOA" = HILARY, fields: Row = { name: "Lead" }): Promise<string> {
    const s = await pg.session();
    const r = await s.attempt(CREATE, [
      TONJA, JSON.stringify(fields), owner === "OOA" ? null : owner, owner === "OOA", null,
    ]);
    if (!r.ok) throw new Error(r.message);
    return r.rows[0].id as string;
  }
  const leadRow = async (id: string) => (await pg.admin.q(`SELECT * FROM swag_leads WHERE id = $1`, [id]))[0];
  const trail = async (id: string) =>
    (await pg.admin.q(`SELECT event_type, from_label, to_label, actor_name FROM swag_lead_events WHERE lead_id = $1 ORDER BY seq`, [id]));

  beforeEach(async () => {
    await pg.closeSessions();
    await pg.reset();
    await pg.admin.q(
      `INSERT INTO salespeople (id, first_name, role) VALUES ($1,'Hilary','ae'), ($2,'Kennedy','ae'), ($3,'Corey','admin'), ($4,'Tonja','assistant')`,
      [HILARY, KENNEDY, COREY, TONJA],
    );
    await pg.admin.q(`UPDATE salespeople SET can_manage_swag_leads = TRUE WHERE id = $1`, [TONJA]);
  });

  it("runs on a real PostgreSQL server with the real migrations", async () => {
    expect(pg.version).toMatch(/^PostgreSQL \d+/);
    console.log(`[real-pg] ${pg.version.split(",")[0]}`);
    const [{ n }] = await pg.admin.q(`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('create_swag_lead','update_swag_lead','transfer_swag_lead')`);
    expect(n).toBe(3);
  });

  it("1. TRANSFER vs TRANSFER: the owner's transfer really waits behind management's, then is refused — she no longer owns it", async () => {
    const id = await seedLead(HILARY);
    const mgr = await pg.session();
    const ae = await pg.session();

    await mgr.q(`BEGIN`);
    expect((await mgr.attempt(TRANSFER, [TONJA, id, KENNEDY, false, "coverage", null])).ok).toBe(true); // holds the row, uncommitted

    const hilary = ae.attempt(TRANSFER, [HILARY, id, null, true, "out of area", null]); // Hilary -> OOA, in flight
    await pg.waitBlockedBy(ae.pid, mgr.pid); // REAL lock wait on the lead row
    expect(await isPending(hilary)).toBe(true);

    await mgr.q(`COMMIT`);
    expect(await hilary).toMatchObject({ ok: false, code: "42501" }); // she isn't the owner any more

    expect(await leadRow(id)).toMatchObject({ assigned_to: KENNEDY, is_ooa: false, revision: 1 });
    expect(await trail(id)).toEqual([
      { event_type: "created", from_label: null, to_label: "Hilary", actor_name: "Tonja" },
      { event_type: "transferred", from_label: "Hilary", to_label: "Kennedy", actor_name: "Tonja" },
    ]);
    expect((await pg.admin.q(`SELECT count(*)::int AS n FROM swag_leads`))[0].n).toBe(1); // no duplicate
  });

  it("2. EDIT vs TRANSFER: the transfer waits for the edit, then lands on top of it; with a stale revision it is refused instead", async () => {
    const id = await seedLead(HILARY);
    const ae = await pg.session();
    const mgr = await pg.session();

    // (a) transfer without an expected revision queues behind the edit and applies after it.
    await ae.q(`BEGIN`);
    expect((await ae.attempt(UPDATE, [HILARY, id, 0, JSON.stringify({ notes: "edited" })])).ok).toBe(true);
    const moved = mgr.attempt(TRANSFER, [TONJA, id, KENNEDY, false, null, null]);
    await pg.waitBlockedBy(mgr.pid, ae.pid);
    expect(await isPending(moved)).toBe(true);
    await ae.q(`COMMIT`);
    expect((await moved).ok).toBe(true);
    expect(await leadRow(id)).toMatchObject({ assigned_to: KENNEDY, notes: "edited", revision: 2 });
    expect((await trail(id)).map((e) => e.event_type)).toEqual(["created", "updated", "transferred"]);

    // (b) the same race with expected_revision: the edit won, so the stale transfer is refused.
    const id2 = await seedLead(HILARY);
    await ae.q(`BEGIN`);
    await ae.attempt(UPDATE, [HILARY, id2, 0, JSON.stringify({ follow_up_attempts: 1 })]);
    const stale = mgr.attempt(TRANSFER, [TONJA, id2, KENNEDY, false, null, 0]);
    await pg.waitBlockedBy(mgr.pid, ae.pid);
    await ae.q(`COMMIT`);
    expect(await stale).toMatchObject({ ok: false, code: "40001" });
    expect(await leadRow(id2)).toMatchObject({ assigned_to: HILARY, follow_up_attempts: 1, revision: 1 });
  });

  it("3. TRANSFER vs EDIT by the old owner: the edit waits, then is refused (no longer hers); nothing is overwritten", async () => {
    const id = await seedLead(HILARY, { name: "Lead", notes: "orig" });
    const mgr = await pg.session();
    const ae = await pg.session();
    await mgr.q(`BEGIN`);
    await mgr.attempt(TRANSFER, [COREY, id, null, true, null, null]); // -> OOA, uncommitted
    const edit = ae.attempt(UPDATE, [HILARY, id, 0, JSON.stringify({ notes: "Hilary's late edit" })]);
    await pg.waitBlockedBy(ae.pid, mgr.pid);
    await mgr.q(`COMMIT`);
    expect(await edit).toMatchObject({ ok: false, code: "42501" });
    expect(await leadRow(id)).toMatchObject({ is_ooa: true, assigned_to: null, notes: "orig" });
  });

  it("4. TWO EDITS at the same revision: exactly one wins, the other is told it's stale", async () => {
    const id = await seedLead(HILARY);
    const a = await pg.session();
    const b = await pg.session();
    await a.q(`BEGIN`);
    expect((await a.attempt(UPDATE, [HILARY, id, 0, JSON.stringify({ follow_up_attempts: 1 })])).ok).toBe(true);
    const second = b.attempt(UPDATE, [TONJA, id, 0, JSON.stringify({ follow_up_attempts: 9 })]);
    await pg.waitBlockedBy(b.pid, a.pid);
    await a.q(`COMMIT`);
    expect(await second).toMatchObject({ ok: false, code: "40001" });
    expect(await leadRow(id)).toMatchObject({ follow_up_attempts: 1, revision: 1 });
  });

  it("5. DOUBLE-TAPPED create (same request id, two connections at once): one lead, one history row, both callers get it", async () => {
    const a = await pg.session();
    const b = await pg.session();
    const rid = "abababab-abab-4bab-8bab-abababababab";
    await a.q(`BEGIN`);
    const first = await a.attempt(CREATE, [HILARY, JSON.stringify({ name: "Once" }), HILARY, false, rid]);
    expect(first.ok).toBe(true);
    const second = b.attempt(CREATE, [HILARY, JSON.stringify({ name: "Once" }), HILARY, false, rid]);
    await pg.waitBlockedBy(b.pid, a.pid); // blocked on the unique index
    await a.q(`COMMIT`);
    const r2 = await second;
    expect(r2.ok).toBe(true);
    expect(r2.ok && r2.rows[0].id).toBe(first.ok && first.rows[0].id);
    expect((await pg.admin.q(`SELECT count(*)::int AS n FROM swag_leads`))[0].n).toBe(1);
    expect((await pg.admin.q(`SELECT count(*)::int AS n FROM swag_lead_events`))[0].n).toBe(1);
  });

  it("5b. a double-tap that LOSES the insert race cannot read a lead that was transferred away meanwhile (P0002, no lead data)", async () => {
    const a = await pg.session();
    const b = await pg.session();
    const rid = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
    const fields = JSON.stringify({ name: "Racey", notes: "SECRET-NOTE-FOR-THE-NEW-OWNER" });
    await a.q(`BEGIN`);
    const first = await a.attempt(CREATE, [HILARY, fields, HILARY, false, rid]);
    expect(first.ok).toBe(true);
    const id = (first.ok && first.rows[0].id) as string;
    // Before it commits, the first tap's lead is handed to Kennedy (same transaction).
    expect((await a.attempt(TRANSFER, [TONJA, id, KENNEDY, false, null, null])).ok).toBe(true);

    const second = b.attempt(CREATE, [HILARY, fields, HILARY, false, rid]); // Hilary's second tap
    await pg.waitBlockedBy(b.pid, a.pid); // really waiting on the unique index
    await a.q(`COMMIT`);

    const r2 = await second;
    expect(r2).toMatchObject({ ok: false, code: "P0002" });
    expect(JSON.stringify(r2)).not.toContain("SECRET-NOTE");
    expect(await leadRow(id)).toMatchObject({ assigned_to: KENNEDY, revision: 1 });
    expect((await pg.admin.q(`SELECT count(*)::int AS n FROM swag_leads`))[0].n).toBe(1);

    // A manager's racing second tap for the same key is still served normally.
    const c = await pg.session();
    const d = await pg.session();
    const rid2 = "dededede-dede-4ede-8ede-dededededede";
    await c.q(`BEGIN`);
    const m1 = await c.attempt(CREATE, [TONJA, fields, HILARY, false, rid2]);
    await c.attempt(TRANSFER, [TONJA, (m1.ok && m1.rows[0].id) as string, KENNEDY, false, null, null]);
    const m2 = d.attempt(CREATE, [TONJA, fields, HILARY, false, rid2]);
    await pg.waitBlockedBy(d.pid, c.pid);
    await c.q(`COMMIT`);
    const rm = await m2;
    expect(rm.ok && rm.rows[0].id).toBe(m1.ok && m1.rows[0].id);
  });

  it("6. the protections hold on a real server: history is append-only, ownership only moves via transfer, no deletes", async () => {
    const id = await seedLead(HILARY);
    const s = await pg.session();
    expect(await s.attempt(`UPDATE swag_lead_events SET to_label = 'x' WHERE lead_id = $1`, [id])).toMatchObject({ ok: false, code: "23514" });
    expect(await s.attempt(`DELETE FROM swag_lead_events WHERE lead_id = $1`, [id])).toMatchObject({ ok: false, code: "23514" });
    expect(await s.attempt(`UPDATE swag_leads SET assigned_to = $2 WHERE id = $1`, [id, KENNEDY])).toMatchObject({ ok: false, code: "23514" });
    expect(await s.attempt(`DELETE FROM swag_leads WHERE id = $1`, [id])).toMatchObject({ ok: false, code: "23514" });
    // The anon/authenticated roles have no access at all.
    const anon = await pg.session();
    await anon.q(`RESET ROLE`);
    await anon.q(`SET ROLE anon`);
    expect(await anon.attempt(`SELECT * FROM swag_leads`)).toMatchObject({ ok: false, code: "42501" });
    expect(await anon.attempt(TRANSFER, [TONJA, id, null, true, null, null])).toMatchObject({ ok: false, code: "42501" });
  });

  it("7. DEADLOCK HUNT: managers and AEs transferring and editing the same leads at once — zero deadlocks, history is always a consistent chain", async () => {
    const ROUNDS = Number(process.env.REAL_PG_ROUNDS ?? 15);
    const [{ deadlocks: before }] = await pg.admin.q(`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`);
    const outcomes = new Map<string, number>();
    const tally = (k: string) => outcomes.set(k, (outcomes.get(k) ?? 0) + 1);
    const pause = () => new Promise<void>((r) => setTimeout(r, Math.floor(Math.random() * 5)));
    const ALLOWED = new Set(["ok", "42501", "40001", "23514"]);
    const destinations: Array<[string | null, boolean]> = [[HILARY, false], [KENNEDY, false], [null, true]];
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)];

    let totalLeads = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      await pg.closeSessions();
      await pg.reset();
      await pg.admin.q(
        `INSERT INTO salespeople (id, first_name, role) VALUES ($1,'Hilary','ae'), ($2,'Kennedy','ae'), ($3,'Corey','admin'), ($4,'Tonja','assistant')`,
        [HILARY, KENNEDY, COREY, TONJA],
      );
      await pg.admin.q(`UPDATE salespeople SET can_manage_swag_leads = TRUE WHERE id = $1`, [TONJA]);
      const ids = [await seedLead(HILARY, { name: "A" }), await seedLead(KENNEDY, { name: "B" }), await seedLead("OOA", { name: "C" })];
      totalLeads += ids.length;
      const actors = [TONJA, COREY, HILARY, KENNEDY];
      const sessions = await Promise.all(actors.flatMap(() => [pg.session(), pg.session()]));
      let ok = 0;

      await Promise.all(
        sessions.map((s, i) => async () => {
          const actor = actors[Math.floor(i / 2)];
          for (let k = 0; k < 12; k += 1) {
            await pause();
            const id = pick(ids);
            const [cur] = await s.q(`SELECT revision FROM swag_leads WHERE id = $1`, [id]);
            let r;
            if (Math.random() < 0.5) {
              const [to, ooa] = pick(destinations);
              r = await s.attempt(TRANSFER, [actor, id, to, ooa, null, Math.random() < 0.3 ? Number(cur.revision) : null]);
            } else {
              r = await s.attempt(UPDATE, [actor, id, Number(cur.revision), JSON.stringify({ follow_up_attempts: Math.floor(Math.random() * 50) })]);
            }
            const key = r.ok ? "ok" : r.code;
            tally(key);
            // A no-op edit (same value) legitimately succeeds with no revision bump
            // and no history row, so count only changes that advanced the revision.
            if (r.ok && Number(r.rows[0].revision) !== Number(cur.revision)) ok += 1;
          }
        }).map((w) => w()),
      );

      // ---- invariants ----
      const leads = await pg.admin.q(`SELECT * FROM swag_leads ORDER BY name`);
      expect(leads).toHaveLength(3); // never duplicated, never lost
      let mutating = 0;
      for (const lead of leads) {
        const ev = await pg.admin.q(`SELECT * FROM swag_lead_events WHERE lead_id = $1 ORDER BY seq`, [lead.id]);
        expect(ev[0].event_type).toBe("created");
        // The transfers form an unbroken chain ending at the current owner.
        let owner = ev[0].to_label as string;
        for (const e of ev.slice(1)) {
          if (e.event_type === "transferred") {
            expect(e.from_label, `round ${round}: chain break`).toBe(owner);
            owner = e.to_label as string;
          }
        }
        const live = lead.is_ooa ? "OOA" : (lead.assigned_to === HILARY ? "Hilary" : "Kennedy");
        expect(owner, `round ${round}: history vs live owner`).toBe(live);
        // Every revision bump has exactly one history row.
        expect(Number(lead.revision), `round ${round}: revision vs history`).toBe(ev.length - 1);
        mutating += ev.length - 1;
        // Exactly one owner, always.
        expect((lead.assigned_to !== null) !== (lead.is_ooa === true)).toBe(true);
      }
      expect(mutating).toBe(ok);
    }

    const unexpected = [...outcomes.keys()].filter((k) => !ALLOWED.has(k));
    console.log(`[real-pg] swag leads hunt, ${ROUNDS} rounds, ${totalLeads} leads, outcomes: ${JSON.stringify(Object.fromEntries([...outcomes].sort()))}`);
    expect(unexpected, "every statement ended in an accounted-for outcome (no 40P01)").toEqual([]);
    await new Promise((r) => setTimeout(r, 1500));
    const [{ deadlocks: after }] = await pg.admin.q(`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`);
    expect(Number(after) - Number(before)).toBe(0);
    expect(outcomes.get("ok") ?? 0).toBeGreaterThan(0);
  }, 300_000);
});

export type { Session };
