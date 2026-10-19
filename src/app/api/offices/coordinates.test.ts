/**
 * Coordinate validation on the AE-facing Add Office (POST /api/offices) and
 * Edit Office (PATCH /api/offices/[id]) routes — real Postgres, real auth.
 * A pair is complete + valid WGS84 or absent; a half pair never reaches the DB.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDb, type TestDb } from "@/test/pglite-supabase";

process.env.SESSION_SECRET = "test-session-secret";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ getServerSupabase: () => holder.client }));

const { signSessionToken } = await import("@/lib/server/auth");
const listRoute = await import("./route");
const detailRoute = await import("./[id]/route");

const AE = "d31df880-da70-4e56-aa5e-8de94f1eba91";
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  holder.client = db.client;
}, 60_000);
beforeEach(async () => {
  await db.reset();
  await db.sql(`INSERT INTO salespeople (id, first_name, role, is_test) VALUES ($1,'Shannon','ae',false)`, [AE]);
});

const headers = () => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${signSessionToken({ sub: AE, role: "ae" as never, name: "Shannon" })}`,
});
const create = (body: unknown) =>
  listRoute.POST(new Request("http://localhost/api/offices", { method: "POST", headers: headers(), body: JSON.stringify(body) }));
const patch = (id: string, body: unknown) =>
  detailRoute.PATCH(new Request("http://localhost/x", { method: "PATCH", headers: headers(), body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });

const BASE = { name: "New Office", street: "1 Main St", city: "San Antonio", state: "TX", zip: "78201" };

describe("POST /api/offices — Add Office", () => {
  it("accepts a valid pair and accepts no coordinates at all", async () => {
    expect((await create({ ...BASE, latitude: 29.42, longitude: -98.49 })).status).toBe(201);
    expect((await create({ ...BASE, name: "No Coords", street: "2 Main St" })).status).toBe(201);
    expect((await create({ ...BASE, name: "Null Coords", street: "3 Main St", latitude: null, longitude: null })).status).toBe(201);
  });

  it.each([
    ["latitude only", { latitude: 29.42 }],
    ["longitude only", { longitude: -98.49 }],
    ["latitude out of range", { latitude: 91, longitude: -98.49 }],
    ["longitude out of range", { latitude: 29.42, longitude: 181 }],
    ["0,0", { latitude: 0, longitude: 0 }],
  ])("rejects %s and stores nothing", async (_l, coords) => {
    const res = await create({ ...BASE, ...coords });
    expect(res.status).toBe(400);
    expect(await db.sql(`SELECT 1 FROM offices`)).toHaveLength(0);
  });
});

describe("PATCH /api/offices/[id] — Edit Office", () => {
  async function seeded() {
    const res = await create({ ...BASE, latitude: 29.42, longitude: -98.49 });
    return ((await res.json()) as { office: { id: string } }).office.id;
  }

  it("moves a pin with a complete valid pair, and clears it with two nulls", async () => {
    const id = await seeded();
    expect((await patch(id, { latitude: 29.5, longitude: -98.5 })).status).toBe(200);
    expect((await db.sql(`SELECT latitude FROM offices WHERE id=$1`, [id]))[0].latitude).toBe(29.5);
    expect((await patch(id, { latitude: null, longitude: null })).status).toBe(200);
    expect((await db.sql(`SELECT latitude, longitude FROM offices WHERE id=$1`, [id]))[0]).toEqual({ latitude: null, longitude: null });
  });

  it.each([
    ["latitude only", { latitude: 30 }],
    ["longitude only", { longitude: -99 }],
    ["latitude with a null longitude", { latitude: 30, longitude: null }],
    ["out of range", { latitude: -91, longitude: -99 }],
    ["0,0", { latitude: 0, longitude: 0 }],
  ])("rejects %s and leaves the stored pin alone", async (_l, coords) => {
    const id = await seeded();
    expect((await patch(id, coords)).status).toBe(400);
    expect((await db.sql(`SELECT latitude, longitude FROM offices WHERE id=$1`, [id]))[0]).toEqual({ latitude: 29.42, longitude: -98.49 });
  });

  it("still allows edits that don't mention coordinates", async () => {
    const id = await seeded();
    expect((await patch(id, { office_notes: "hello" })).status).toBe(200);
  });
});
