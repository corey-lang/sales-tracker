/**
 * Office importer — matching, re-import safety, coordinate validation and
 * multi-request batches, against a REAL Postgres (PGlite running the project's
 * migrations) with real signed sessions and the real auth chain.
 *
 * The properties pinned here are the ones that protect an AE's data:
 *   * a re-import never ERASES information (blank/missing CSV fields, notes,
 *     next actions, coordinates, contact info, the office id and its visits);
 *   * an existing office is matched by a stable id first, then by identity —
 *     and merely-similar offices (same name / same address) stay separate;
 *   * ambiguity is reported for review, never guessed at;
 *   * invalid coordinates never reach the database, and never wipe good ones;
 *   * a large file split across requests shares one batch and cannot duplicate.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDb, type TestDb } from "@/test/pglite-supabase";

process.env.SESSION_SECRET = "test-session-secret";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ getServerSupabase: () => holder.client }));

const { signSessionToken } = await import("@/lib/server/auth");
const importRoute = await import("./route");

const COREY = "55555555-5555-4555-8555-555555555555"; // admin
const SHANNON = "d31df880-da70-4e56-aa5e-8de94f1eba91";
const JAMES = "5f156683-b660-4684-b673-1afd5709fa27";

type Row = Record<string, unknown>;
type Body = {
  batch_id: string;
  created: number;
  updated: number;
  unchanged: number;
  total_rows: number;
  skipped: Array<{ row: number; reason: string }>;
  flagged: Array<{ row: number; reason: string }>;
  conflicts: Array<{ row: number; field: string; existing: string | null; incoming: string | null; office_id: string }>;
  conflicts_total: number;
  errors: Array<{ row: number; reason: string }>;
};

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  holder.client = db.client;
}, 60_000);

beforeEach(async () => {
  await db.reset();
  await db.sql(
    `INSERT INTO salespeople (id, first_name, role, is_test) VALUES
       ($1,'Corey','admin',false), ($2,'Shannon','ae',false), ($3,'James','ae',false)`,
    [COREY, SHANNON, JAMES],
  );
});

function post(body: unknown, who = COREY) {
  return importRoute.POST(
    new Request("http://localhost/api/admin/offices/import", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${signSessionToken({ sub: who, role: "admin" as never, name: "Corey" })}`,
      },
      body: JSON.stringify(body),
    }),
  );
}
async function run(rows: Row[], extra: Row = {}): Promise<Body> {
  const res = await post({ source: "test", default_salesperson_id: SHANNON, rows, ...extra });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  const body = (await res.json()) as Body;
  // Every sent row lands in exactly one bucket — nothing goes unreported.
  expect(body.created + body.updated + body.unchanged + body.skipped.length + body.errors.length).toBe(body.total_rows);
  return body;
}
const offices = (ae = SHANNON) =>
  db.sql<Row>(`SELECT * FROM offices WHERE salesperson_id = $1 ORDER BY name, street`, [ae]);

const FULL = {
  name: "Acme Realty",
  street: "100 Main St",
  city: "San Antonio",
  state: "TX",
  zip: "78201",
  latitude: 29.45,
  longitude: -98.5,
  office_phone: "210-555-0100",
  office_email: "front@acme.test",
  external_badger_id: "badger-1",
};

describe("re-imports never erase information", () => {
  it("keeps stored values when the new file leaves optional fields blank or omits them", async () => {
    await run([FULL]);
    // The same office again — but this file has no phone/email/id/coords/city/zip.
    const r = await run([{ name: "Acme Realty", street: "100 Main St", zip: "78201" }]);
    expect(r.created).toBe(0);
    expect(r.unchanged).toBe(1);

    const [o] = await offices();
    expect(o.office_phone).toBe("210-555-0100");
    expect(o.office_email).toBe("front@acme.test");
    expect(o.external_badger_id).toBe("badger-1");
    expect(o.city).toBe("San Antonio");
    expect(o.state).toBe("TX");
    expect(o.latitude).toBe(29.45);
    expect(o.longitude).toBe(-98.5);
  });

  it("keeps explicitly blank strings from clearing stored values", async () => {
    await run([FULL]);
    await run([{ ...FULL, office_phone: "", office_email: "   ", city: "", latitude: null, longitude: null }]);
    const [o] = await offices();
    expect(o.office_phone).toBe("210-555-0100");
    expect(o.office_email).toBe("front@acme.test");
    expect(o.city).toBe("San Antonio");
    expect(o.latitude).toBe(29.45);
  });

  it("never touches notes, next actions, the office id or its visits", async () => {
    await run([{ ...FULL, office_notes: "seeded note", next_action: "seeded action" }]);
    const [before] = await offices();
    await db.sql(`UPDATE offices SET office_notes='AE wrote this', next_action='Call Tuesday' WHERE id=$1`, [before.id]);
    await db.sql(`INSERT INTO office_visits (office_id, salesperson_id, note) VALUES ($1,$2,'dropped off donuts')`, [before.id, SHANNON]);

    await run([{ ...FULL, office_notes: "CSV note", next_action: "CSV action", office_phone: "999" }]);

    const [after] = await offices();
    expect(after.id).toBe(before.id);
    expect(after.office_notes).toBe("AE wrote this");
    expect(after.next_action).toBe("Call Tuesday");
    expect(await db.sql(`SELECT note FROM office_visits WHERE office_id=$1`, [before.id])).toEqual([{ note: "dropped off donuts" }]);
  });

  it("fills blanks, but reports (and keeps) a stored value the file disagrees with", async () => {
    await run([{ name: "Acme Realty", street: "100 Main St", zip: "78201", office_phone: "210-555-0100" }]);
    const r = await run([{ ...FULL, office_phone: "210-555-9999" }]);
    expect(r.updated).toBe(1);

    const [o] = await offices();
    expect(o.office_phone).toBe("210-555-0100"); // kept
    expect(o.office_email).toBe("front@acme.test"); // filled
    expect(o.latitude).toBe(29.45); // filled
    const phone = r.conflicts.find((c) => c.field === "office_phone");
    expect(phone).toMatchObject({ existing: "210-555-0100", incoming: "210-555-9999" });
  });

  it("is idempotent: importing the same file twice changes nothing the second time", async () => {
    await run([FULL, { name: "Beta Realty", street: "5 Oak Ln", zip: "78202" }]);
    const first = await offices();
    const r = await run([FULL, { name: "Beta Realty", street: "5 Oak Ln", zip: "78202" }]);
    expect(r.created).toBe(0);
    expect(r.updated).toBe(0);
    expect(r.unchanged).toBe(2);
    expect(await offices()).toEqual(first);
  });
});

describe("duplicate prevention", () => {
  it("matches by external id even when the office was renamed and moved — no duplicate", async () => {
    await run([FULL]);
    const r = await run([{ ...FULL, name: "Acme Realty Group", street: "200 Other Blvd", zip: "78209" }]);
    expect(r.created).toBe(0);
    expect(await offices()).toHaveLength(1);
    const [o] = await offices();
    expect(o.name).toBe("Acme Realty"); // stored identity kept
    expect(o.street).toBe("100 Main St");
    expect(r.conflicts.map((c) => c.field).sort()).toEqual(["name", "street", "zip"]);
  });

  it("matches an office stored before zips were known (the original Badger shape) and fills the zip", async () => {
    await db.sql(
      `INSERT INTO offices (salesperson_id, name, street, city, state, dedupe_key, environment, office_notes)
       VALUES ($1,'Legacy Realty','9 Elm St','San Antonio','TX','legacy realty|9 elm st|','production','keep me')`,
      [SHANNON],
    );
    const r = await run([{ name: "Legacy Realty", street: "9 Elm St", zip: "78212", latitude: 29.46, longitude: -98.49 }]);
    expect(r.created).toBe(0);
    expect(r.updated).toBe(1);
    const [o] = await offices();
    expect(o.zip).toBe("78212");
    expect(o.latitude).toBe(29.46);
    expect(o.office_notes).toBe("keep me");
    expect(o.dedupe_key).toBe("legacy realty|9 elm st|78212");

    // …and a second import of the same file now matches by key — still one row.
    const again = await run([{ name: "Legacy Realty", street: "9 Elm St", zip: "78212" }]);
    expect(again.created).toBe(0);
    expect(await offices()).toHaveLength(1);
  });

  it("keeps genuinely different offices separate: same name at different addresses", async () => {
    const r = await run([
      { name: "Keller Williams", street: "1 A St", zip: "78201" },
      { name: "Keller Williams", street: "2 B St", zip: "78201" },
      { name: "Keller Williams", street: "1 A St", zip: "78209" }, // same street text, other zip
    ]);
    expect(r.created).toBe(3);
    expect(await offices()).toHaveLength(3);
    const again = await run([{ name: "Keller Williams", street: "2 B St", zip: "78201" }]);
    expect(again.created).toBe(0);
    expect(await offices()).toHaveLength(3);
  });

  it("keeps genuinely different offices separate: different names at the same address", async () => {
    const r = await run([
      { name: "Chris Reeves", street: "40 NE Loop 410", zip: "78216" },
      { name: "Signet Mortgage", street: "40 NE Loop 410", zip: "78216" },
    ]);
    expect(r.created).toBe(2);
    expect(await offices()).toHaveLength(2);
  });

  it("does not bridge two different zips when matching by name + street", async () => {
    await run([{ name: "Same Name", street: "1 A St", zip: "78201" }]);
    const r = await run([{ name: "Same Name", street: "1 A St", zip: "78209" }]);
    expect(r.created).toBe(1);
    expect(await offices()).toHaveLength(2);
  });

  it("reports an ambiguous match for review instead of guessing", async () => {
    await db.sql(
      `INSERT INTO offices (salesperson_id, name, street, dedupe_key, environment) VALUES
         ($1,'Twin Realty','3 Pine St','twin realty|3 pine st|a','production'),
         ($1,'Twin Realty','3 Pine St','twin realty|3 pine st|b','production')`,
      [SHANNON],
    );
    const r = await run([{ name: "Twin Realty", street: "3 Pine St", zip: "78201", latitude: 29.4, longitude: -98.4 }]);
    expect(r.created).toBe(0);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toMatch(/more than one existing office/);
    expect((await offices()).every((o) => o.latitude === null)).toBe(true);
  });

  it("refuses to fill a zip that would make an office identical to another", async () => {
    await db.sql(
      `INSERT INTO offices (salesperson_id, name, street, zip, dedupe_key, environment) VALUES
         ($1,'Dup Realty','4 Oak St','78201','dup realty|4 oak st|78201','production'),
         ($1,'Dup Realty','4 Oak St',NULL,'dup realty|4 oak st|','production')`,
      [SHANNON],
    );
    // Name+street now matches two offices (one with a zip) → ambiguous, nothing changes.
    const r = await run([{ name: "Dup Realty", street: "4 Oak St", zip: "78201" }]);
    expect(r.created).toBe(0);
    expect((await offices()).map((o) => o.zip).sort()).toEqual(["78201", null]);
  });

  it("treats a repeated external id inside one file as a duplicate, keeping the later row", async () => {
    const r = await run([
      { name: "First Name", street: "1 A St", zip: "78201", external_badger_id: "x1" },
      { name: "Second Name", street: "2 B St", zip: "78202", external_badger_id: "x1" },
    ]);
    expect(r.created).toBe(1);
    expect(r.skipped).toEqual([{ row: 1, reason: "Duplicate of row 2 in this file — kept the later one." }]);
    expect((await offices())[0].name).toBe("Second Name");
  });

  it("never matches across AEs", async () => {
    await run([FULL]);
    const r = await run([FULL], { default_salesperson_id: JAMES });
    expect(r.created).toBe(1);
    expect(await offices(SHANNON)).toHaveLength(1);
    expect(await offices(JAMES)).toHaveLength(1);
  });
});

describe("coordinate validation", () => {
  const bad: Array<[string, Row]> = [
    ["latitude without longitude", { latitude: 29.4 }],
    ["longitude without latitude", { longitude: -98.4 }],
    ["latitude out of range", { latitude: 129.4, longitude: -98.4 }],
    ["longitude out of range", { latitude: 29.4, longitude: -198.4 }],
    ["the 0,0 placeholder", { latitude: 0, longitude: 0 }],
  ];
  it.each(bad)("imports the office WITHOUT coordinates and flags it: %s", async (_label, coords) => {
    const r = await run([{ name: "Bad Coords Realty", street: "1 A St", zip: "78201", ...coords }]);
    expect(r.created).toBe(1);
    expect(r.flagged).toHaveLength(1);
    const [o] = await offices();
    expect(o.latitude).toBeNull();
    expect(o.longitude).toBeNull();
  });

  it("an invalid pair in a re-import never wipes or replaces stored good coordinates", async () => {
    await run([FULL]);
    const r = await run([{ ...FULL, latitude: 999, longitude: 999 }]);
    expect(r.flagged).toHaveLength(1);
    const [o] = await offices();
    expect(o.latitude).toBe(29.45);
    expect(o.longitude).toBe(-98.5);
  });

  it("flags a differing location instead of silently moving the pin", async () => {
    await run([FULL]);
    const r = await run([{ ...FULL, latitude: 30.5, longitude: -97.5 }]);
    expect(r.conflicts.some((c) => c.field === "coordinates")).toBe(true);
    expect((await offices())[0].latitude).toBe(29.45);
  });

  it("treats geocoder jitter (a few metres) as the same place, not a conflict", async () => {
    await run([FULL]);
    const r = await run([{ ...FULL, latitude: 29.45001, longitude: -98.50001 }]);
    expect(r.conflicts).toHaveLength(0);
  });

  it("keeps offices with no coordinates (they stay in List + search)", async () => {
    const r = await run([{ name: "PO Box Realty", street: "PO Box 12", zip: "78270" }]);
    expect(r.created).toBe(1);
    expect((await offices())[0].latitude).toBeNull();
  });
});

describe("large files sent as several requests", () => {
  it("shares one provenance batch, and an overlapping row across requests does not duplicate", async () => {
    const mk = (n: number): Row => ({ name: `Office ${n}`, street: `${n} Main St`, zip: "78201" });
    const first = await run([mk(1), mk(2), mk(3)]);
    const second = await run([mk(3), mk(4), mk(5)], { batch_id: first.batch_id });
    expect(second.batch_id).toBe(first.batch_id);
    expect(second.created).toBe(2);
    expect(second.unchanged).toBe(1);
    expect(await offices()).toHaveLength(5);

    const batches = await db.sql<Row>(`SELECT * FROM office_import_batches`);
    expect(batches).toHaveLength(1);
    expect(batches[0].row_count).toBe(5);
  });

  it("is resumable: re-sending an already-completed request changes nothing", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ name: `Office ${i}`, street: `${i} Main St`, zip: "78201" }));
    const a = await run(rows);
    const again = await run(rows, { batch_id: a.batch_id });
    expect(again.created).toBe(0);
    expect(again.unchanged).toBe(40);
    expect(await offices()).toHaveLength(40);
  });

  it("rejects a batch id that does not exist or belongs to someone else", async () => {
    const res = await post({
      source: "t",
      default_salesperson_id: SHANNON,
      batch_id: "00000000-0000-4000-8000-000000000000",
      rows: [{ name: "X", street: "1 A St" }],
    });
    expect(res.status).toBe(400);
  });

  it("handles more rows than PostgREST's 1,000-row response cap", async () => {
    const rows = Array.from({ length: 1_500 }, (_, i) => ({
      name: `Office ${String(i).padStart(5, "0")}`,
      street: `${i} Main St`,
      zip: "78201",
    }));
    const a = await run(rows);
    expect(a.created).toBe(1_500);
    // The second pass must SEE all 1,500 existing offices (paged read) or it would re-create some.
    const b = await run(rows, { batch_id: a.batch_id });
    expect(b.created).toBe(0);
    expect(b.unchanged).toBe(1_500);
    expect(await offices()).toHaveLength(1_500);
  }, 60_000);
});
