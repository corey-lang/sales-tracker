/**
 * Onboarding Kimberlee as the DFW West AE (replacing James) — runs the REAL
 * supabase/onboard_kimberlee_dfw_west.sql against a REAL Postgres (PGlite with
 * the project's migrations), then exercises the real login route, API guards,
 * Juice Box, rosters and report code. Nothing about identity is faked.
 *
 * The business rules pinned here:
 *   * Kimberlee is a SEPARATE account (new id, standard AE role); James keeps
 *     his row, id and name — never renamed, never reused.
 *   * James cannot sign in and a session he already holds is refused, and he
 *     leaves the current rosters — but nothing he produced is deleted or
 *     re-attributed (activity, goals, offices, visits, Juice Box authorship).
 *   * His results stay in the reports for periods he was on the team; Kimberlee
 *     stays out of periods before her start date and starts from zero.
 *   * DFW West rolls up to Kimberlee; other territories are untouched.
 *   * Re-running creates nothing twice; unsafe states fail loudly and change
 *     nothing; the start date is never guessed.
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
// Web Push would hit the network; Juice Box only needs it not to throw.
vi.mock("@/lib/server/push", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fanOutJuiceBoxPush: vi.fn(),
}));

const { signSessionToken } = await import("@/lib/server/auth");
const loginRoute = await import("./auth/login/route");
const mapRoute = await import("./offices/map/route");
const officesRoute = await import("./offices/route");
const messagesRoute = await import("./team-messages/route");
const rosterRoute = await import("./roster/visible/route");
const totalsRoute = await import("./admin/activity-totals/route");
const { buildActivityReport } = await import("@/lib/server/activity-report");
const { computeStandings } = await import("@/lib/server/leaderboard-standings");
const { loadActiveMappings } = await import("@/lib/server/cogent");

const JAMES = "5f156683-b660-4684-b673-1afd5709fa27";
const HILARY = "9dd4ed6d-3216-4b49-8549-2489406aeedb";
const COREY = "0eae4385-dffd-4df9-ba17-0538ae7811e9";

type Row = Record<string, unknown>;

// ---- dates relative to "now" so the test never goes stale ------------------
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
function mondayOf(d: Date) {
  const day = d.getUTCDay(); // 0 = Sun
  return addDays(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())), -((day + 6) % 7));
}
const NOW = new Date();
const W_CUR = mondayOf(NOW);
const W_PAST = addDays(W_CUR, -21); // James worked, Kimberlee had not started
const W_NEXT = addDays(W_CUR, 7); // Kimberlee's first week; James is gone
const START = iso(W_NEXT); // her first day — an explicit input, never defaulted

const ONBOARD_RAW = readFileSync(join(process.cwd(), "supabase", "onboard_kimberlee_dfw_west.sql"), "utf8");
const SHIPPED_START = "DATE '2026-10-26'";
/** The shipped script with a different first day substituted (for relative-date tests). */
const withStart = (date: string) => ONBOARD_RAW.replace(`v_start_date DATE := ${SHIPPED_START};`, `v_start_date DATE := DATE '${date}';`);
/** The shipped script with the start date unset. */
const UNSET = ONBOARD_RAW.replace(`v_start_date DATE := ${SHIPPED_START};`, "v_start_date DATE := NULL;");

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  holder.client = db.client;
}, 60_000);

const token = (id: string, role = "ae", name = "x") => signSessionToken({ sub: id, role: role as never, name });
const call = (fn: (r: Request) => Promise<Response>, path: string, who: string, init: { method?: string; body?: unknown; role?: string } = {}) =>
  fn(
    new Request(`http://localhost${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${token(who, init.role)}`,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    }),
  );
const login = (name: string) =>
  loginRoute.POST(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  );

/** Everything James produced or owns, as comparable JSON (order-stable). */
async function jamesFootprint() {
  const q = (sql: string) => db.sql<Row>(sql, [JAMES]);
  return {
    activity: await q(`SELECT * FROM activity_entries WHERE salesperson_id=$1 ORDER BY entry_date`),
    goals: await q(`SELECT * FROM weekly_goals WHERE salesperson_id=$1 ORDER BY id`),
    offices: await q(`SELECT * FROM offices WHERE salesperson_id=$1 ORDER BY id`),
    visits: await q(`SELECT * FROM office_visits WHERE salesperson_id=$1 ORDER BY id`),
    messages: await q(`SELECT * FROM team_messages WHERE salesperson_id=$1::text ORDER BY id`),
    // The person row, minus the one column onboarding is allowed to change.
    person: (await q(`SELECT id, first_name::text AS first_name, role, is_test, location, created_at FROM salespeople WHERE id=$1`))[0],
  };
}

async function seed() {
  await db.reset();
  await db.sql(
    `INSERT INTO salespeople (id, first_name, role, is_test, location) VALUES
       ($1,'James','ae',false,'HQ'), ($2,'Hilary','ae',false,'HQ'), ($3,'Corey','admin',false,'HQ')`,
    [JAMES, HILARY, COREY],
  );
  await db.sql(
    `INSERT INTO cogent_territory_mappings (sales_territory_name, salesperson_id) VALUES ('DFW West',$1), ('DFW East',$2)`,
    [JAMES, HILARY],
  );
  // James's history: logged activity in two past weeks, a personal goal, an
  // office with a visit and a follow-up, a device, and a Juice Box post (below).
  for (const [d, n] of [[addDays(W_PAST, 1), 4], [addDays(W_PAST, 8), 6]] as const) {
    await db.sql(`INSERT INTO activity_entries (salesperson_id, entry_date, office_visits) VALUES ($1,$2,$3)`, [JAMES, iso(d), n]);
  }
  await db.sql(
    `INSERT INTO weekly_goals (effective_from, office_visits, salesperson_id) VALUES ('2026-01-01', 10, $1)`,
    [JAMES],
  );
  await db.sql(
    `INSERT INTO offices (salesperson_id, name, street, dedupe_key, environment, next_action)
     VALUES ($1,'Dallas Realty','1 Elm St','dallas realty|1 elm st|','production','Call back Tuesday')`,
    [JAMES],
  );
  const office = (await db.sql<{ id: string }>(`SELECT id FROM offices WHERE salesperson_id=$1`, [JAMES]))[0].id;
  await db.sql(`INSERT INTO office_visits (office_id, salesperson_id, note) VALUES ($1,$2,'dropped off donuts')`, [office, JAMES]);
  await db.sql(`INSERT INTO push_subscriptions (salesperson_id, endpoint, p256dh, auth) VALUES ($1,'https://push.example/james','k','a')`, [JAMES]);
  const posted = await call(messagesRoute.POST, "/api/team-messages", JAMES, { method: "POST", body: { message: "Great week in Dallas!" } });
  expect(posted.status, JSON.stringify(await posted.clone().json())).toBeLessThan(300);
}

beforeEach(seed);

describe("the shipped script carries the confirmed start date", () => {
  it("is 2026-10-26, not a default or a guess", () => {
    expect(ONBOARD_RAW).toContain(`v_start_date DATE := ${SHIPPED_START};`);
  });
});

describe("the script will not run without an explicit start date", () => {
  it("refuses while v_start_date is unset, and changes nothing", async () => {
    const before = await jamesFootprint();
    await expect(db.asOwner(UNSET)).rejects.toThrow(/v_start_date/);
    expect(await db.sql(`SELECT 1 FROM salespeople WHERE first_name='Kimberlee'`)).toHaveLength(0);
    expect((await db.sql(`SELECT deactivated_at FROM salespeople WHERE id=$1`, [JAMES]))[0].deactivated_at).toBeNull();
    expect((await db.sql(`SELECT salesperson_id FROM cogent_territory_mappings WHERE sales_territory_name='DFW West'`))[0].salesperson_id).toBe(JAMES);
    expect(await jamesFootprint()).toEqual(before);
  });
});

describe("after onboarding", () => {
  let before: Awaited<ReturnType<typeof jamesFootprint>>;
  let kim: string;
  beforeEach(async () => {
    before = await jamesFootprint();
    await db.asOwner(withStart(START));
    kim = (await db.sql<{ id: string }>(`SELECT id FROM salespeople WHERE first_name='Kimberlee'`))[0].id;
  });

  it("creates Kimberlee as her own standard AE — new id, real account, her own start date", async () => {
    const [k] = await db.sql<Row>(`SELECT id, first_name::text AS first_name, role, is_test, is_admin, deactivated_at, started_on::text AS started_on FROM salespeople WHERE id=$1`, [kim]);
    expect(kim).not.toBe(JAMES);
    expect(k).toMatchObject({ first_name: "Kimberlee", role: "ae", is_test: false, is_admin: false, deactivated_at: null, started_on: START });
  });

  it("keeps James's row, id and name — nothing renamed or reused — and only deactivates him", async () => {
    const [j] = await db.sql<Row>(`SELECT id, first_name::text AS first_name, role, deactivated_at FROM salespeople WHERE id=$1`, [JAMES]);
    expect(j).toMatchObject({ id: JAMES, first_name: "James", role: "ae" });
    expect(j.deactivated_at).not.toBeNull();
    expect(await db.sql(`SELECT 1 FROM salespeople WHERE first_name='James'`)).toHaveLength(1);
  });

  it("leaves every record James produced or owns exactly as it was (authorship included)", async () => {
    expect(await jamesFootprint()).toEqual(before);
    const [msg] = await db.sql<Row>(`SELECT salesperson_id, salesperson_name, message FROM team_messages WHERE salesperson_id=$1::text`, [JAMES]);
    expect(msg).toMatchObject({ salesperson_id: JAMES, salesperson_name: "James", message: "Great week in Dallas!" });
    // Nothing of his was copied or moved to Kimberlee.
    for (const [t, c] of [["activity_entries", "salesperson_id"], ["offices", "salesperson_id"], ["office_visits", "salesperson_id"], ["weekly_goals", "salesperson_id"]]) {
      expect(await db.sql(`SELECT 1 FROM ${t} WHERE ${c}=$1`, [kim]), t).toHaveLength(0);
    }
    expect(await db.sql(`SELECT 1 FROM team_messages WHERE salesperson_id=$1::text`, [kim])).toHaveLength(0);
  });

  it("revokes only James's push devices", async () => {
    expect(await db.sql(`SELECT 1 FROM push_subscriptions WHERE salesperson_id=$1`, [JAMES])).toHaveLength(0);
  });

  it("points DFW West at Kimberlee on the SAME mapping row, and leaves other territories alone", async () => {
    const maps = await db.sql<Row>(`SELECT sales_territory_name, salesperson_id, active FROM cogent_territory_mappings ORDER BY 1`);
    expect(maps).toEqual([
      { sales_territory_name: "DFW East", salesperson_id: HILARY, active: true },
      { sales_territory_name: "DFW West", salesperson_id: kim, active: true },
    ]);
    // The real attribution loader (what the Orders tiles use) agrees.
    const live = await loadActiveMappings();
    expect(live.find((m) => m.sales_territory_name === "DFW West")?.salesperson_id).toBe(kim);
    expect(live.find((m) => m.sales_territory_name === "DFW East")?.salesperson_id).toBe(HILARY);
  });

  // ---------------- 1 & 2: who can use the app --------------------------------
  it("James can no longer sign in, and a session he already holds is refused everywhere", async () => {
    const res = await login("James");
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).toMatch(/no longer active/i);

    for (const [fn, path] of [[mapRoute.GET, "/api/offices/map"], [officesRoute.GET, "/api/offices"], [messagesRoute.GET, "/api/team-messages"]] as const) {
      expect((await call(fn, path, JAMES)).status, path).toBe(401);
    }
    const post = await call(messagesRoute.POST, "/api/team-messages", JAMES, { method: "POST", body: { message: "still here?" } });
    expect(post.status).toBe(401);
  });

  it("Kimberlee signs in by name like every AE and gets the standard AE tools and Juice Box", async () => {
    const res = await login("Kimberlee");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { salesperson: Row; token: string };
    expect(body.salesperson).toMatchObject({ id: kim, first_name: "Kimberlee", role: "ae", is_test: false });

    // AE tools: office map + list (empty — she starts with nothing) and Add Office.
    const map = (await (await call(mapRoute.GET, "/api/offices/map", kim)).json()) as { total: number };
    expect(map.total).toBe(0);
    const add = await call(officesRoute.POST, "/api/offices", kim, {
      method: "POST",
      body: { name: "Plano Realty", street: "9 Main St", city: "Plano", state: "TX", zip: "75024" },
    });
    expect(add.status).toBe(201);
    expect((await db.sql(`SELECT salesperson_id FROM offices WHERE name='Plano Realty'`))[0].salesperson_id).toBe(kim);

    // Juice Box: she can post, and sees James's earlier post still signed "James".
    const post = await call(messagesRoute.POST, "/api/team-messages", kim, { method: "POST", body: { message: "Excited to join the team!" } });
    expect(post.status, JSON.stringify(await post.clone().json())).toBeLessThan(300);
    const feed = (await (await call(messagesRoute.GET, "/api/team-messages", kim)).json()) as { messages: Array<{ salesperson_name: string; message: string }> };
    const names = Object.fromEntries(feed.messages.map((m) => [m.message, m.salesperson_name]));
    expect(names["Great week in Dallas!"]).toBe("James");
    expect(names["Excited to join the team!"]).toBe("Kimberlee");
  });

  // ---------------- 5: rosters -------------------------------------------------
  it("current rosters show Kimberlee and not James; DFW West is hers", async () => {
    const roster = (await (await call(rosterRoute.GET, "/api/roster/visible", kim)).json()) as { people: Array<{ first_name: string; deactivated_at: string | null }> };
    const activeAes = roster.people.filter((p) => p.deactivated_at === null).map((p) => p.first_name);
    expect(activeAes).toContain("Kimberlee");
    expect(activeAes).not.toContain("James");
    // The login screen's own query.
    const loginList = await db.sql<{ first_name: string }>(`SELECT first_name::text AS first_name FROM salespeople WHERE deactivated_at IS NULL ORDER BY 1`);
    expect(loginList.map((r) => r.first_name)).toEqual(["Corey", "Hilary", "Kimberlee"]);
    // Territory → current AE.
    const [t] = await db.sql<Row>(`SELECT s.first_name::text AS ae FROM cogent_territory_mappings m JOIN salespeople s ON s.id=m.salesperson_id WHERE m.sales_territory_name='DFW West'`);
    expect(t.ae).toBe("Kimberlee");
  });

  // ---------------- 4: historical reports --------------------------------------
  describe("reports", () => {
    const past = { since: iso(W_PAST), through: iso(addDays(W_PAST, 4)) };
    const next = { since: iso(W_NEXT), through: iso(addDays(W_NEXT, 4)) };
    const nameSet = (rows: Array<{ first_name: string }>) => rows.map((r) => r.first_name).sort();

    it("a past week still shows James's results, and does not list Kimberlee", async () => {
      const today = iso(NOW);
      const { rows, error } = await buildActivityReport(db.client as never, past.since, past.through, past.since, today);
      expect(error).toBeNull();
      expect(nameSet(rows)).toEqual(["Hilary", "James"]);
      const james = rows.find((r) => r.first_name === "James")!;
      expect(james.cells.office_visits.actual).toBe(4);

      const st = await computeStandings(db.client as never, past.since, past.through, past.since, today);
      expect(nameSet(st.standings)).toEqual(["Hilary", "James"]);
      expect(st.standings.find((s) => s.first_name === "James")!.totals.office_visits).toBe(4);
    });

    it("Kimberlee's first week lists her (from zero) and no longer lists James", async () => {
      const today = iso(addDays(W_NEXT, 2));
      const { rows } = await buildActivityReport(db.client as never, next.since, next.through, next.since, today);
      expect(nameSet(rows)).toEqual(["Hilary", "Kimberlee"]);
      const k = rows.find((r) => r.first_name === "Kimberlee")!;
      expect(k.cells.office_visits.actual).toBe(0);
      const st = await computeStandings(db.client as never, next.since, next.through, next.since, today);
      expect(nameSet(st.standings)).toEqual(["Hilary", "Kimberlee"]);
    });

    it("the admin totals range report keeps James in past ranges and Kimberlee out of them", async () => {
      const get = async (from: string, to: string) =>
        ((await (await call(totalsRoute.GET, `/api/admin/activity-totals?from=${from}&to=${to}`, COREY, { role: "admin" })).json()) as {
          rows: Array<{ first_name?: string; name?: string; salesperson?: { first_name: string } }>;
        }).rows.map((r) => r.first_name ?? r.name ?? r.salesperson?.first_name).sort();
      expect(await get(past.since, iso(addDays(W_PAST, 6)))).toEqual(["Hilary", "James"]);
      expect(await get(next.since, iso(addDays(W_NEXT, 6)))).toEqual(["Hilary", "Kimberlee"]);
      // A range spanning the changeover has both — each only for their own time.
      expect(await get(past.since, iso(addDays(W_NEXT, 6)))).toEqual(["Hilary", "James", "Kimberlee"]);
    });
  });

  // ---------------- 6: no duplicates --------------------------------------------
  it("is safe to re-run: no second account, no changed timestamps, no changed history", async () => {
    const snap = async () => ({
      people: await db.sql<Row>(`SELECT id, first_name::text AS first_name, role, started_on::text AS started_on, deactivated_at FROM salespeople ORDER BY first_name`),
      maps: await db.sql<Row>(`SELECT * FROM cogent_territory_mappings ORDER BY sales_territory_name`),
      james: await jamesFootprint(),
    });
    const first = await snap();
    await db.asOwner(withStart(START));
    await db.asOwner(withStart(START));
    expect(await snap()).toEqual(first); // identical, including James's ORIGINAL deactivation time and the mapping's updated_at
    expect(await db.sql(`SELECT 1 FROM salespeople WHERE first_name ILIKE 'kimberlee'`)).toHaveLength(1);
    expect(await db.sql(`SELECT 1 FROM salespeople`)).toHaveLength(4); // James, Hilary, Corey + Kimberlee
    expect(await db.sql(`SELECT 1 FROM cogent_territory_mappings`)).toHaveLength(2);
  });

  it("a re-run whose date matches the recorded one keeps it (and changes nothing)", async () => {
    const before = (await db.sql(`SELECT started_on::text AS s FROM salespeople WHERE id=$1`, [kim]))[0].s;
    await db.asOwner(withStart(START));
    expect((await db.sql(`SELECT started_on::text AS s FROM salespeople WHERE id=$1`, [kim]))[0].s).toBe(before);
  });
});

describe("unsafe states fail loudly and change nothing", () => {
  it("rejects an existing Kimberlee whose recorded start date DIFFERS from the approved one", async () => {
    await db.sql(`INSERT INTO salespeople (first_name, role, started_on) VALUES ('Kimberlee','ae','2026-11-02')`);
    const before = await jamesFootprint();
    await expect(db.asOwner(ONBOARD_RAW)).rejects.toThrow(/already exists with started_on = 2026-11-02, but this script onboards her as starting on 2026-10-26/);
    // Nothing happened: she keeps her date, James is untouched and still active, DFW West is still his.
    expect((await db.sql(`SELECT started_on::text AS s FROM salespeople WHERE first_name='Kimberlee'`))[0].s).toBe("2026-11-02");
    expect((await db.sql(`SELECT deactivated_at FROM salespeople WHERE id=$1`, [JAMES]))[0].deactivated_at).toBeNull();
    expect((await db.sql(`SELECT salesperson_id FROM cogent_territory_mappings WHERE sales_territory_name='DFW West'`))[0].salesperson_id).toBe(JAMES);
    expect(await jamesFootprint()).toEqual(before);
  });

  it("preserves an existing Kimberlee whose start date already matches (rerun) and fills a NULL one", async () => {
    await db.sql(`INSERT INTO salespeople (first_name, role, started_on) VALUES ('Kimberlee','ae','2026-10-26')`);
    await db.asOwner(ONBOARD_RAW);
    expect((await db.sql(`SELECT started_on::text AS s FROM salespeople WHERE first_name='Kimberlee'`))[0].s).toBe("2026-10-26");
    expect(await db.sql(`SELECT 1 FROM salespeople WHERE first_name ILIKE 'kimberlee'`)).toHaveLength(1);
  });

  it("refuses if someone else already holds DFW West", async () => {
    await db.sql(`UPDATE cogent_territory_mappings SET salesperson_id=$1 WHERE sales_territory_name='DFW West'`, [HILARY]);
    await expect(db.asOwner(withStart(START))).rejects.toThrow(/DFW West is currently mapped/);
    expect(await db.sql(`SELECT 1 FROM salespeople WHERE first_name='Kimberlee'`)).toHaveLength(0);
    expect((await db.sql(`SELECT deactivated_at FROM salespeople WHERE id=$1`, [JAMES]))[0].deactivated_at).toBeNull();
  });

  it("finds an existing Kimberlee case-insensitively (never a case-variant duplicate)", async () => {
    await db.sql(`INSERT INTO salespeople (first_name, role) VALUES ('KIMBERLEE','ae')`);
    await db.asOwner(withStart(START));
    expect(await db.sql(`SELECT 1 FROM salespeople WHERE first_name ILIKE 'kimberlee'`)).toHaveLength(1);
    expect((await db.sql(`SELECT started_on::text AS s FROM salespeople WHERE first_name='kimberlee'`))[0].s).toBe(START);
  });

  it("refuses to adopt an existing 'Kimberlee' that is not an active real AE", async () => {
    await db.sql(`INSERT INTO salespeople (first_name, role) VALUES ('kimberlee','juice_box_only')`);
    await expect(db.asOwner(withStart(START))).rejects.toThrow(/already exists but is not an active, real AE/);
    expect((await db.sql(`SELECT deactivated_at FROM salespeople WHERE id=$1`, [JAMES]))[0].deactivated_at).toBeNull();
  });

  it("refuses if James does not exist", async () => {
    // (Rows with history can't be deleted — the FKs forbid it — so point the script at a name that isn't there.)
    const sql = withStart(START).replace("v_old_name   CONSTANT TEXT := 'James';", "v_old_name   CONSTANT TEXT := 'Nobody';");
    await expect(db.asOwner(sql)).rejects.toThrow(/No salesperson named Nobody/);
    expect(await db.sql(`SELECT 1 FROM salespeople WHERE first_name='Kimberlee'`)).toHaveLength(0);
  });
});

describe("the script never touches history tables", () => {
  it("contains no statement that changes a history row", () => {
    const stmts = ONBOARD_RAW.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    for (const t of ["activity_entries", "weekly_goals", "offices", "office_visits", "team_messages", "team_message_reactions", "business_card_scans", "business_card_contacts", "one_on_ones", "ae_tasks", "gold_list_agents", "working_day_adjustments"]) {
      expect(stmts, t).not.toMatch(new RegExp(`(UPDATE|DELETE\\s+FROM|INSERT\\s+INTO)\\s+${t}\\b`, "i"));
    }
    expect(stmts).not.toMatch(/DELETE\s+FROM\s+salespeople/i);
    expect(stmts).not.toMatch(/SET\s+first_name\s*=/i); // never renames anyone
  });
});

// ---------------------------------------------------------------------------
// The actual changeover: Kimberlee's confirmed start (Mon 2026-10-26), James
// deactivated mid-week. Fixed dates, the shipped script (only the optional
// "James's final moment" knob is set so the result doesn't depend on the clock).
// ---------------------------------------------------------------------------
describe("transition week (week of Mon 2026-10-26) — both are reported where their dates overlap", () => {
  const JAMES_LEFT = "TIMESTAMPTZ '2026-10-29 10:00-06'"; // Thu Oct 29, Denver
  const shipped = ONBOARD_RAW.replace("v_james_deactivated_at TIMESTAMPTZ := NULL;", `v_james_deactivated_at TIMESTAMPTZ := ${JAMES_LEFT};`);
  const nameSet = (rows: Array<{ first_name: string }>) => rows.map((r) => r.first_name).sort();
  let kim: string;

  beforeEach(async () => {
    // Replace the relative-date fixture with fixed entries: James's last weeks,
    // and activity he logged on Mon Oct 26 (his last day or so); Kimberlee's first.
    await db.sql(`DELETE FROM activity_entries`);
    for (const [who, d, n] of [
      [JAMES, "2026-10-19", 4],
      [JAMES, "2026-10-20", 6],
      [JAMES, "2026-10-26", 3], // transition week — must be preserved
    ] as const) {
      await db.sql(`INSERT INTO activity_entries (salesperson_id, entry_date, office_visits) VALUES ($1,$2,$3)`, [who, d, n]);
    }
    await db.asOwner(shipped);
    kim = (await db.sql<{ id: string }>(`SELECT id FROM salespeople WHERE first_name='Kimberlee'`))[0].id;
    await db.sql(`INSERT INTO activity_entries (salesperson_id, entry_date, office_visits) VALUES ($1,'2026-10-27',5)`, [kim]);
  });

  it("is applied with exactly the confirmed dates", async () => {
    const [k] = await db.sql<Row>(`SELECT started_on::text AS s FROM salespeople WHERE id=$1`, [kim]);
    expect(k.s).toBe("2026-10-26");
    const [j] = await db.sql<Row>(`SELECT deactivated_at FROM salespeople WHERE id=$1`, [JAMES]);
    expect(new Date(j.deactivated_at as string).toISOString()).toBe("2026-10-29T16:00:00.000Z");
  });

  it("Activity Report, transition week: James AND Kimberlee, each with their own activity", async () => {
    const { rows, error } = await buildActivityReport(db.client as never, "2026-10-26", "2026-10-30", "2026-10-26", "2026-11-03");
    expect(error).toBeNull();
    expect(nameSet(rows)).toEqual(["Hilary", "James", "Kimberlee"]);
    expect(rows.find((r) => r.first_name === "James")!.cells.office_visits.actual).toBe(3); // preserved
    expect(rows.find((r) => r.first_name === "Kimberlee")!.cells.office_visits.actual).toBe(5);
  });

  it("Activity Report, the week before: James with his full results, no Kimberlee", async () => {
    const { rows } = await buildActivityReport(db.client as never, "2026-10-19", "2026-10-23", "2026-10-19", "2026-11-03");
    expect(nameSet(rows)).toEqual(["Hilary", "James"]);
    expect(rows.find((r) => r.first_name === "James")!.cells.office_visits.actual).toBe(10);
  });

  it("Activity Report, the week after: Kimberlee only — James has left", async () => {
    const { rows } = await buildActivityReport(db.client as never, "2026-11-02", "2026-11-06", "2026-11-02", "2026-11-09");
    expect(nameSet(rows)).toEqual(["Hilary", "Kimberlee"]);
  });

  it("past-week leaderboard standings (coaching / scorecards) for the transition week: both, totals intact", async () => {
    const st = await computeStandings(db.client as never, "2026-10-26", "2026-10-30", "2026-10-26", "2026-11-03");
    expect(nameSet(st.standings)).toEqual(["Hilary", "James", "Kimberlee"]);
    expect(st.standings.find((s) => s.first_name === "James")!.totals.office_visits).toBe(3);
    expect(st.standings.find((s) => s.first_name === "Kimberlee")!.totals.office_visits).toBe(5);
  });

  it("the live leaderboard during that week lists Kimberlee and no longer James (he has left; his entries are untouched)", async () => {
    const st = await computeStandings(db.client as never, "2026-10-26", "2026-10-30", "2026-10-26", "2026-10-30");
    expect(nameSet(st.standings)).toEqual(["Hilary", "Kimberlee"]);
    expect((await db.sql(`SELECT 1 FROM activity_entries WHERE salesperson_id=$1`, [JAMES]))).toHaveLength(3);
  });

  it("admin totals over the transition week include both; James's earlier results stay in earlier ranges", async () => {
    const get = async (from: string, to: string) => {
      const res = await call(totalsRoute.GET, `/api/admin/activity-totals?from=${from}&to=${to}`, COREY, { role: "admin" });
      return (await res.json()) as { rows: Array<Row> };
    };
    const names = (b: { rows: Array<Row> }) => b.rows.map((r) => (r.first_name ?? r.name ?? (r.salesperson as Row | undefined)?.first_name) as string).sort();
    expect(names(await get("2026-10-26", "2026-11-01"))).toEqual(["Hilary", "James", "Kimberlee"]);
    expect(names(await get("2026-10-12", "2026-10-25"))).toEqual(["Hilary", "James"]);
    expect(names(await get("2026-11-02", "2026-11-08"))).toEqual(["Hilary", "Kimberlee"]);
  });
});

describe("a session minted before deactivation cannot be reused", () => {
  const paths: Array<[(r: Request) => Promise<Response>, string, string]> = [
    [mapRoute.GET, "/api/offices/map", "GET"],
    [officesRoute.GET, "/api/offices", "GET"],
    [messagesRoute.GET, "/api/team-messages", "GET"],
    [rosterRoute.GET, "/api/roster/visible", "GET"],
  ];
  const withToken = (fn: (r: Request) => Promise<Response>, path: string, bearer: string, method = "GET", body?: unknown) =>
    fn(new Request(`http://localhost${path}`, { method, headers: { Authorization: `Bearer ${bearer}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }));

  it("the exact token James got from the real login route works before, and is refused everywhere after", async () => {
    // 1. James signs in through the real route and receives a real token.
    const login1 = await login("James");
    expect(login1.status).toBe(200);
    const { token: minted } = (await login1.json()) as { token: string };

    // 2. It works while he is active.
    for (const [fn, path] of paths) expect((await withToken(fn, path, minted)).status, `${path} before`).toBe(200);
    expect((await withToken(messagesRoute.POST, "/api/team-messages", minted, "POST", { message: "before the changeover" })).status).toBeLessThan(300);

    // 3. Onboarding deactivates him.
    await db.asOwner(withStart(START));

    // 4. The SAME token string is now refused on every route — reads and writes.
    for (const [fn, path] of paths) {
      const res = await withToken(fn, path, minted);
      expect(res.status, `${path} after`).toBe(401);
      expect(JSON.stringify(await res.json())).toMatch(/no longer active|sign in again/i);
    }
    expect((await withToken(messagesRoute.POST, "/api/team-messages", minted, "POST", { message: "after the changeover" })).status).toBe(401);
    expect((await withToken(officesRoute.POST, "/api/offices", minted, "POST", { name: "X", street: "1 St" })).status).toBe(401);
    // …and nothing he tried after deactivation was written.
    expect(await db.sql(`SELECT 1 FROM team_messages WHERE message='after the changeover'`)).toHaveLength(0);
    // A fresh sign-in is refused too.
    expect((await login("James")).status).toBe(401);
  });
});
