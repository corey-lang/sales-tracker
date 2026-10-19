/**
 * Large-territory behavior of the office Map / List / visit flow, against a
 * REAL Postgres (PGlite running the project's actual migrations) with real
 * signed sessions and the real auth chain. Nothing about offices is faked.
 *
 * WHY THIS FILE EXISTS
 *   PostgREST silently clamps every response to 1,000 rows. The Map route
 *   used to read offices with one `.limit()`, so any AE with more than 1,000
 *   mapped offices silently lost the rest (alphabetically), and the List
 *   route's "visited first" sort only saw the same first 1,000. The harness
 *   enforces the same cap (POSTGREST_MAX_ROWS), so these tests fail against
 *   the old routes. They model a ~2,500-office territory — the same shape as
 *   a large imported territory such as San Antonio.
 *
 * COVERS
 *   * Map returns every mappable office (not just the first 1,000), and
 *     still excludes archived offices and offices without coordinates.
 *   * An office at the END of the alphabet can be visited through the real
 *     visits route, and then shows up with the right last-visit info on the
 *     Map, at the top of the List, in search, and in its own detail history.
 *   * Territories are strictly per-AE (another AE never sees these offices).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createTestDb, type TestDb } from "@/test/pglite-supabase";

process.env.SESSION_SECRET = "test-session-secret";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ getServerSupabase: () => holder.client }));

const { signSessionToken } = await import("@/lib/server/auth");
const listRoute = await import("./route");
const mapRoute = await import("./map/route");
const detailRoute = await import("./[id]/route");
const visitsRoute = await import("./[id]/visits/route");

const SHANNON = "d31df880-da70-4e56-aa5e-8de94f1eba91";
const OTHER_AE = "5f156683-b660-4684-b673-1afd5709fa27";

const TOTAL_MAPPABLE = 2_400; // > 2 pages of PostgREST's 1,000-row cap
const NO_COORDS = 30;
const ARCHIVED = 10;

type Row = Record<string, unknown>;

let db: TestDb;
let lastOfficeId: string;

function req(who: string, path: string, init: { method?: string; body?: unknown } = {}) {
  return new Request(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${signSessionToken({
        sub: who,
        role: "ae" as never,
        name: who === SHANNON ? "Shannon" : "James",
      })}`,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });

beforeAll(async () => {
  db = await createTestDb();
  holder.client = db.client;
  await db.sql(
    `INSERT INTO salespeople (id, first_name, role, is_test) VALUES ($1,'Shannon','ae',false), ($2,'James','ae',false)`,
    [SHANNON, OTHER_AE],
  );
  // Mappable offices, all around San Antonio. Every 7th shares the previous
  // office's exact coordinates (several MLS offices at one address).
  await db.sql(
    `INSERT INTO offices (salesperson_id, name, street, city, state, zip, latitude, longitude, dedupe_key, environment)
     SELECT $1, 'Office ' || lpad(g::text, 5, '0'), g || ' Main St', 'San Antonio', 'TX', '78201',
            29.40 + ((g - (g % 7 = 0)::int) % 100) * 0.002, -98.60 + ((g - (g % 7 = 0)::int) / 100) * 0.002,
            'k' || g, 'production'
       FROM generate_series(1, $2::int) g`,
    [SHANNON, TOTAL_MAPPABLE - 1],
  );
  // The office at the very END of the alphabet — far outside any 1,000-row window.
  await db.sql(
    `INSERT INTO offices (salesperson_id, name, street, city, state, zip, latitude, longitude, dedupe_key, environment)
     VALUES ($1, 'Zzz Last Realty', '9 End St', 'San Antonio', 'TX', '78201', 29.5, -98.5, 'k-last', 'production')`,
    [SHANNON],
  );
  // Listed but NOT mappable: no coordinates (PO boxes etc.) …
  await db.sql(
    `INSERT INTO offices (salesperson_id, name, street, city, state, zip, dedupe_key, environment)
     SELECT $1, 'NoCoords ' || g, 'PO Box ' || g, 'San Antonio', 'TX', '78201', 'nc' || g, 'production'
       FROM generate_series(1, $2::int) g`,
    [SHANNON, NO_COORDS],
  );
  // … and archived.
  await db.sql(
    `INSERT INTO offices (salesperson_id, name, street, city, state, zip, latitude, longitude, dedupe_key, environment, archived_at)
     SELECT $1, 'Archived ' || g, g || ' Gone St', 'San Antonio', 'TX', '78201', 29.45, -98.45, 'ar' || g, 'production', now()
       FROM generate_series(1, $2::int) g`,
    [SHANNON, ARCHIVED],
  );
  // One office belonging to a different AE.
  await db.sql(
    `INSERT INTO offices (salesperson_id, name, street, city, state, zip, latitude, longitude, dedupe_key, environment)
     VALUES ($1, 'James Only Realty', '1 Elsewhere', 'Provo', 'UT', '84601', 40.2, -111.6, 'j1', 'production')`,
    [OTHER_AE],
  );
  lastOfficeId = (
    await db.sql<{ id: string }>(`SELECT id FROM offices WHERE name = 'Zzz Last Realty'`)
  )[0].id;
}, 120_000);

afterAll(async () => {
  await db.reset();
});

type MapBody = {
  offices: Array<{ id: string; name: string; last_visit_at: string | null; latitude: number; longitude: number }>;
  total: number;
  truncated: boolean;
};
type ListBody = {
  offices: Array<{ id: string; name: string; last_visit_at: string | null; visit_count: number }>;
  total_matched: number;
  truncated: boolean;
};

describe("a territory larger than PostgREST's 1,000-row cap", () => {
  it("Map returns EVERY mappable office — including those past the first 1,000 — and nothing else", async () => {
    const res = await mapRoute.GET(req(SHANNON, "/api/offices/map"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as MapBody;

    expect(body.total).toBe(TOTAL_MAPPABLE);
    expect(body.offices).toHaveLength(TOTAL_MAPPABLE);
    expect(body.truncated).toBe(false);
    // Offices from the END of the alphabet are present (the old route cut them).
    expect(body.offices.some((o) => o.name === "Zzz Last Realty")).toBe(true);
    // No duplicates across page boundaries.
    expect(new Set(body.offices.map((o) => o.id)).size).toBe(TOTAL_MAPPABLE);
    // Excludes archived offices and offices without coordinates.
    expect(body.offices.some((o) => o.name.startsWith("Archived"))).toBe(false);
    expect(body.offices.some((o) => o.name.startsWith("NoCoords"))).toBe(false);
    // Every pin has real coordinates.
    expect(body.offices.every((o) => Number.isFinite(o.latitude) && Number.isFinite(o.longitude))).toBe(true);
    // Never another AE's office.
    expect(body.offices.some((o) => o.name === "James Only Realty")).toBe(false);
  });

  it("lets Shannon open an office at the end of the alphabet and record a visit with a note", async () => {
    const detail = await detailRoute.GET(req(SHANNON, "/x"), p({ id: lastOfficeId }));
    expect(detail.status).toBe(200);
    const { detail: before } = (await detail.json()) as {
      detail: { office: Row; visits: Row[]; last_visit_at: string | null };
    };
    expect(before.office.name).toBe("Zzz Last Realty");
    expect(before.visits).toHaveLength(0);
    expect(before.last_visit_at).toBeNull();

    const log = await visitsRoute.POST(
      req(SHANNON, "/x", { method: "POST", body: { visit_note: "Dropped off cookies, met the broker" } }),
      p({ id: lastOfficeId }),
    );
    expect(log.status, JSON.stringify(await log.clone().json())).toBe(201);
  });

  it("then shows that visit in the office's history and last-visit info", async () => {
    const detail = await detailRoute.GET(req(SHANNON, "/x"), p({ id: lastOfficeId }));
    const { detail: body } = (await detail.json()) as {
      detail: {
        visits: Array<{ note: string | null; office_id: string }>;
        last_visit_at: string | null;
        visit_count: number;
      };
    };
    expect(body.visit_count).toBe(1);
    expect(body.visits[0].note).toBe("Dropped off cookies, met the broker");
    expect(body.visits[0].office_id).toBe(lastOfficeId);
    expect(body.last_visit_at).not.toBeNull();
  });

  it("Map reports that visit as the office's last visit (so visit-age filters work past row 1,000)", async () => {
    const body = (await (await mapRoute.GET(req(SHANNON, "/api/offices/map"))).json()) as MapBody;
    const visited = body.offices.filter((o) => o.last_visit_at !== null);
    expect(visited.map((o) => o.name)).toEqual(["Zzz Last Realty"]);
  });

  it("List promotes the visited office to the top even though it is outside the alphabetical window", async () => {
    const res = await listRoute.GET(req(SHANNON, "/api/offices"));
    const body = (await res.json()) as ListBody;
    expect(body.offices[0].name).toBe("Zzz Last Realty");
    expect(body.offices[0].visit_count).toBe(1);
    expect(body.offices[0].last_visit_at).not.toBeNull();
    expect(body.offices.length).toBeLessThanOrEqual(200);
    // The alphabetical window was full, so the UI is told to refine.
    expect(body.truncated).toBe(true);
  });

  it("search finds a visited office outside the window, and ignores it when it does not match", async () => {
    const hit = (await (await listRoute.GET(req(SHANNON, "/api/offices?q=Zzz"))).json()) as ListBody;
    expect(hit.offices.map((o) => o.name)).toEqual(["Zzz Last Realty"]);

    const miss = (await (await listRoute.GET(req(SHANNON, "/api/offices?q=Office%2000042"))).json()) as ListBody;
    expect(miss.offices.map((o) => o.name)).toEqual(["Office 00042"]);
    expect(miss.offices.some((o) => o.name === "Zzz Last Realty")).toBe(false);
  });

  it("keeps territories strictly per-AE", async () => {
    const jamesMap = (await (await mapRoute.GET(req(OTHER_AE, "/api/offices/map"))).json()) as MapBody;
    expect(jamesMap.offices.map((o) => o.name)).toEqual(["James Only Realty"]);

    // Shannon cannot open or log a visit against James's office.
    const jamesId = (await db.sql<{ id: string }>(`SELECT id FROM offices WHERE name = 'James Only Realty'`))[0].id;
    const log = await visitsRoute.POST(req(SHANNON, "/x", { method: "POST", body: {} }), p({ id: jamesId }));
    expect(log.status).toBe(404);
  });
});
