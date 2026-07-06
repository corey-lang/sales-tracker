/**
 * Route-level tests for GET /api/offices/map — the data source for the Map
 * tab's default "All My Offices" scope (src/app/offices/page.tsx).
 *
 * WHY THIS ROUTE EXISTS
 *   The Map tab used to default to a 5/10/25-mile radius search
 *   (/api/offices/nearby), which required a location fix AND silently
 *   excluded any assigned office outside the selected radius. AEs cover
 *   large territories, so "nearby" was the wrong default — they need every
 *   office assigned to them, unbounded by distance, with radius as an
 *   OPTIONAL filter layered on top. This route serves that default; the
 *   existing /api/offices/nearby route is untouched and still serves the
 *   optional radius filter.
 *
 * WHAT THESE TESTS COVER
 *   * AE-only scoping (salesperson_id hard-pinned to the caller — never
 *     accepted from the client).
 *   * Environment scoping (officeEnvironmentFor(me) — never accepted from
 *     the client).
 *   * Archived-office / coordinate-null exclusion (query shape).
 *   * last_visit_at annotation (feeds the 30/60/90/Never/Custom filters).
 *   * distance_miles is optional (null without a center; computed, but
 *     never used to filter, with one).
 *   * The truncation backstop (MAP_ALL_RESULT_LIMIT).
 *   * Fail-closed behavior when the visit-history lookup errors.
 *
 * WHAT IS NOT COVERED HERE
 *   The page-level scope toggle and map centering/zoom logic
 *   (src/app/offices/page.tsx, src/components/nearby-offices-map.tsx) are
 *   React state/rendering concerns this project has no jsdom/RTL setup to
 *   exercise. See MANUAL VERIFICATION below.
 *
 * MANUAL VERIFICATION (required before merge)
 *   1. Run `npm run dev` and open the app as any AE (e.g. Carli Anderson).
 *   2. Deny (or never grant) location permission. Open the Map tab.
 *      → "All" is selected by default; every assigned office pin loads.
 *      → The map centers somewhere sensible (the centroid of your
 *        offices), not blank/broken, and does NOT try to fit every pin
 *        into view — it's fine if you need to zoom/pan.
 *   3. Reload with location permission granted.
 *      → Pins still load immediately (don't wait on the location fix).
 *      → Once the fix resolves, a blue "you are here" dot appears at your
 *        actual location.
 *   4. Tap a radius pill (5 / 10 / 25 mi).
 *      → If no location fix yet, "Locating…" shows, then results narrow to
 *        that radius once a fix lands. Tap "All" to go back to everything.
 *   5. In "All" mode, tap "Log visit" on a pin (Quick Log Visit).
 *      → "Visit logged." notice appears on that pin.
 *   6. In "All" mode, use "Log + note" on a pin, fill in a note, submit.
 *      → Notice appears; Next Action shown on the pin (if set) is
 *        unaffected.
 *   7. After either log action, switch to the Check-ins tab immediately.
 *      → The new visit appears at the top without a page reload.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted — values available inside vi.mock factories before module eval
// ---------------------------------------------------------------------------

const { mockOfficesLimit, mockVisitsIn, officeEqCalls, officeFilterCalls } =
  vi.hoisted(() => ({
    mockOfficesLimit: vi.fn(),
    mockVisitsIn: vi.fn(),
    officeEqCalls: [] as Array<[string, unknown]>,
    officeFilterCalls: [] as Array<[string, string, unknown]>,
  }));

// ---------------------------------------------------------------------------
// Module mocks (hoisted before all imports by vitest)
// ---------------------------------------------------------------------------

vi.mock("@/lib/server/auth", () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = "ApiError";
    }
  }
  return {
    ApiError,
    requireAeToolAccess: vi.fn(),
    handleApiError: vi.fn((err: unknown) => {
      const status = (err as { status?: number }).status ?? 500;
      return Response.json({ error: String(err) }, { status });
    }),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  getServerSupabase: vi.fn(() => ({
    from: (table: string) => {
      if (table === "offices") {
        const self: Record<string, unknown> = {};
        self["select"] = () => self;
        self["eq"] = (col: string, val: unknown) => {
          officeEqCalls.push([col, val]);
          return self;
        };
        // `.is` / `.not` share a call log so tests can assert the archived
        // + coordinate-null filters were applied, distinct from `.eq`.
        self["is"] = (col: string, val: unknown) => {
          officeFilterCalls.push(["is", col, val]);
          return self;
        };
        self["not"] = (col: string, op: string, val: unknown) => {
          officeFilterCalls.push(["not", col, val]);
          return self;
        };
        self["order"] = () => self;
        self["limit"] = mockOfficesLimit;
        return self;
      }
      // office_visits chain terminates in `in`.
      const self: Record<string, unknown> = {};
      self["select"] = () => self;
      self["eq"] = () => self;
      self["in"] = mockVisitsIn;
      return self;
    },
  })),
}));

// ---------------------------------------------------------------------------
// Static imports (after mocks so hoisting applies correctly)
// ---------------------------------------------------------------------------

import { GET } from "./route";
import { requireAeToolAccess } from "@/lib/server/auth";
import { MAP_ALL_RESULT_LIMIT } from "@/lib/offices";

const mockRequireAeToolAccess = vi.mocked(requireAeToolAccess);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_ME = {
  id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
  first_name: "Carli",
  is_test: false,
  role: "ae" as const,
  state_code: null as string | null,
  can_import_offices: false,
};

function officeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    name: "Downtown Office",
    street: "123 Main St",
    city: "Salt Lake City",
    state: "UT",
    zip: "84101",
    latitude: 40.7608,
    longitude: -111.891,
    next_action: null,
    next_action_due_date: null,
    ...overrides,
  };
}

function makeRequest(query = ""): Request {
  return new Request(`http://localhost/api/offices/map${query}`);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  officeEqCalls.length = 0;
  officeFilterCalls.length = 0;
  mockRequireAeToolAccess.mockResolvedValue(MOCK_ME);
  // Default: no visits logged for anything, unless a test overrides it.
  mockVisitsIn.mockResolvedValue({ data: [], error: null });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/offices/map", () => {
  it("scopes the offices query to the caller's own salesperson_id and environment", async () => {
    mockOfficesLimit.mockResolvedValue({ data: [officeRow()], error: null });

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(officeEqCalls).toContainEqual(["salesperson_id", MOCK_ME.id]);
    expect(officeEqCalls).toContainEqual(["environment", "production"]);
  });

  it("ignores a client-supplied salesperson_id / environment — identity is server-derived only", async () => {
    mockOfficesLimit.mockResolvedValue({ data: [officeRow()], error: null });

    const res = await GET(
      makeRequest("?salesperson_id=evil-id&environment=test"),
    );

    expect(res.status).toBe(200);
    // The route never reads these query params at all — the eq() calls are
    // still pinned to the authenticated caller's own identity.
    expect(officeEqCalls).toContainEqual(["salesperson_id", MOCK_ME.id]);
    expect(officeEqCalls).toContainEqual(["environment", "production"]);
    expect(
      officeEqCalls.some(([, val]) => val === "evil-id" || val === "test"),
    ).toBe(false);
  });

  it("uses the test environment slice for the seeded test account", async () => {
    mockRequireAeToolAccess.mockResolvedValue({ ...MOCK_ME, is_test: true });
    mockOfficesLimit.mockResolvedValue({ data: [], error: null });

    await GET(makeRequest());

    expect(officeEqCalls).toContainEqual(["environment", "test"]);
  });

  it("filters out archived offices and offices without coordinates", async () => {
    mockOfficesLimit.mockResolvedValue({ data: [officeRow()], error: null });

    await GET(makeRequest());

    expect(officeFilterCalls).toContainEqual(["is", "archived_at", null]);
    expect(
      officeFilterCalls.some(([, col]) => col === "latitude"),
    ).toBe(true);
    expect(
      officeFilterCalls.some(([, col]) => col === "longitude"),
    ).toBe(true);
  });

  it("returns distance_miles: null for every office when no center is supplied", async () => {
    mockOfficesLimit.mockResolvedValue({
      data: [officeRow({ id: "office-1" })],
      error: null,
    });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.offices).toHaveLength(1);
    expect(body.offices[0].distance_miles).toBeNull();
  });

  it("computes distance_miles when lat/lng are supplied, without filtering by it", async () => {
    // Deliberately far from the supplied center — must still be returned,
    // proving this route never drops offices based on distance.
    mockOfficesLimit.mockResolvedValue({
      data: [
        officeRow({ id: "near", latitude: 40.76, longitude: -111.89 }),
        officeRow({ id: "far", latitude: 47.6, longitude: -122.33 }), // Seattle
      ],
      error: null,
    });

    const res = await GET(makeRequest("?lat=40.76&lng=-111.89"));
    const body = await res.json();

    expect(body.offices).toHaveLength(2);
    const byId = Object.fromEntries(
      body.offices.map((o: { id: string; distance_miles: number | null }) => [
        o.id,
        o.distance_miles,
      ]),
    );
    expect(byId.near).not.toBeNull();
    expect(byId.near).toBeLessThan(1);
    expect(byId.far).not.toBeNull();
    expect(byId.far).toBeGreaterThan(500); // SLC → Seattle is ~700+ mi
  });

  it("ignores an incomplete or invalid center instead of erroring", async () => {
    mockOfficesLimit.mockResolvedValue({
      data: [officeRow({ id: "office-1" })],
      error: null,
    });

    const res = await GET(makeRequest("?lat=999&lng=-111.89")); // lat out of range

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.offices[0].distance_miles).toBeNull();
  });

  it("annotates last_visit_at with the most recent visit by the calling AE", async () => {
    mockOfficesLimit.mockResolvedValue({
      data: [officeRow({ id: "office-1" }), officeRow({ id: "office-2" })],
      error: null,
    });
    mockVisitsIn.mockResolvedValue({
      data: [
        { office_id: "office-1", visited_at: "2026-06-01T12:00:00.000Z" },
        { office_id: "office-1", visited_at: "2026-06-15T12:00:00.000Z" },
      ],
      error: null,
    });

    const res = await GET(makeRequest());
    const body = await res.json();

    const byId = Object.fromEntries(
      body.offices.map((o: { id: string; last_visit_at: string | null }) => [
        o.id,
        o.last_visit_at,
      ]),
    );
    expect(byId["office-1"]).toBe("2026-06-15T12:00:00.000Z");
    expect(byId["office-2"]).toBeNull();
  });

  it("fails closed (502) when the visit-history lookup errors, rather than shipping wrong last_visit_at", async () => {
    mockOfficesLimit.mockResolvedValue({
      data: [officeRow({ id: "office-1" })],
      error: null,
    });
    mockVisitsIn.mockResolvedValue({
      data: null,
      error: { code: "500", message: "boom" },
    });

    const res = await GET(makeRequest());

    expect(res.status).toBe(502);
  });

  it("returns a sanitized 500 when the offices query itself fails", async () => {
    mockOfficesLimit.mockResolvedValue({
      data: null,
      error: { code: "500", message: "raw db detail should not leak" },
    });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("raw db detail");
  });

  it("caps results at MAP_ALL_RESULT_LIMIT and flags truncation instead of silently dropping offices", async () => {
    const rows = Array.from({ length: MAP_ALL_RESULT_LIMIT + 1 }, (_, i) =>
      officeRow({ id: `office-${i}`, name: `Office ${i}` }),
    );
    mockOfficesLimit.mockResolvedValue({ data: rows, error: null });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.offices).toHaveLength(MAP_ALL_RESULT_LIMIT);
    expect(body.total).toBe(MAP_ALL_RESULT_LIMIT);
    expect(body.truncated).toBe(true);
  });

  it("reports truncated: false when the result set is under the cap", async () => {
    mockOfficesLimit.mockResolvedValue({
      data: [officeRow({ id: "office-1" })],
      error: null,
    });

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.truncated).toBe(false);
  });
});
