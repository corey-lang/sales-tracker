/**
 * Route-level tests for POST /api/offices/[id]/visits — map visit logging.
 *
 * These tests cover the write path that feeds the Check-ins refresh: the route
 * must return a well-formed { visit } payload so the calling UI can confirm
 * the write succeeded and bump `checkinsRefreshKey` to trigger a re-fetch.
 *
 * WHY THIS FILE EXISTS
 *   Bug: AEs logged map visits but the Check-ins tab did not update.
 *   Root cause: `checkinsRefreshKey` was never incremented after a successful
 *   POST, so `CheckinsViewSection`'s useEffect deps never changed and the
 *   component never re-fetched.
 *   Fix (src/app/offices/page.tsx): `handleLogVisit` and `handleNoteModalLogged`
 *   now call `setCheckinsRefreshKey((n) => n + 1)` on a 2xx response whose
 *   body includes `data.visit`. These tests verify the route produces that shape.
 *
 * WHAT IS NOT COVERED HERE
 *   The React state transition (incrementing `checkinsRefreshKey` and passing it
 *   to `CheckinsViewSection`) cannot be exercised with Vitest alone — this
 *   project has no @testing-library/react or jsdom environment configured.
 *
 * MANUAL VERIFICATION (required before merge)
 *   1. Run `npm run dev` and open the app as any AE (e.g. Carli Anderson).
 *   2. Switch to the Map tab and find any owned office.
 *   3. Click the quick-log "Log visit" button on a map pin.
 *      → The "Visit logged." notice appears.
 *      → Switch to the Check-ins tab IMMEDIATELY (no page reload).
 *      → The new visit entry appears at the top of the list.
 *   4. Return to the Map tab. Open the note modal for any owned office.
 *      Fill in a note and submit.
 *      → Switch to Check-ins.
 *      → The new visit appears with the note.
 *   5. Confirm the Check-ins feed does NOT spontaneously refresh while the
 *      map tab is idle (only `refreshKey` increments trigger a re-fetch;
 *      there is no background polling timer).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// vi.hoisted — values available inside vi.mock factories before module eval
// ---------------------------------------------------------------------------

const { mockMaybeSingle, mockSingle } = vi.hoisted(() => ({
  mockMaybeSingle: vi.fn(),
  mockSingle: vi.fn(),
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
    parseBody: vi.fn(async (req: Request) => req.json()),
    handleApiError: vi.fn((err: unknown) => {
      const status = (err as { status?: number }).status ?? 500;
      return Response.json({ error: String(err) }, { status });
    }),
    badRequest: vi.fn((msg: string) => new ApiError(400, msg)),
    notFound: vi.fn((msg: string) => new ApiError(404, msg)),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  getServerSupabase: vi.fn(() => ({
    from: (table: string) => {
      if (table === "offices") {
        // Every chained call returns `self` except the terminal `maybeSingle`.
        const self: Record<string, unknown> = {};
        ["select", "eq", "is"].forEach((m) => {
          self[m] = () => self;
        });
        self["maybeSingle"] = mockMaybeSingle;
        return self;
      }
      // office_visits insert chain terminates in `single`.
      const self: Record<string, unknown> = {};
      ["insert", "select"].forEach((m) => {
        self[m] = () => self;
      });
      self["single"] = mockSingle;
      return self;
    },
  })),
}));

vi.mock("@/lib/offices", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/offices")>();
  return { ...real, officeEnvironmentFor: vi.fn(() => "production") };
});

// ---------------------------------------------------------------------------
// Static imports (after mocks so hoisting applies correctly)
// ---------------------------------------------------------------------------

import { POST } from "./route";
import { requireAeToolAccess } from "@/lib/server/auth";

const mockRequireAeToolAccess = vi.mocked(requireAeToolAccess);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OFFICE_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const VISIT_ID = "cccccccc-cccc-4ccc-cccc-cccccccccccc";

const MOCK_ME = {
  id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
  first_name: "Carli",
  is_test: false,
  role: "ae" as const,
  state_code: null as string | null,
  can_import_offices: false,
};

const MOCK_VISIT = {
  id: VISIT_ID,
  office_id: OFFICE_ID,
  salesperson_id: MOCK_ME.id,
  note: null as string | null,
  visited_at: "2026-06-30T18:00:00.000Z",
  environment: "production",
  created_at: "2026-06-30T18:00:00.000Z",
};

function makeRequest(body: Record<string, unknown> = {}, id = OFFICE_ID) {
  return new Request(`http://localhost/api/offices/${id}/visits`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ctx(id = OFFICE_ID) {
  return { params: Promise.resolve({ id }) };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAeToolAccess.mockResolvedValue(MOCK_ME);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/offices/[id]/visits", () => {
  it("returns 201 with a well-formed { visit } on success (quick-log, no note)", async () => {
    // handleLogVisit in page.tsx does: if (!res.ok || !data?.visit) { ... return }
    // then calls setCheckinsRefreshKey((n) => n + 1).
    // If `visit` is missing from this response, the key is never incremented
    // and the Check-ins tab never refreshes — that was the original bug.
    mockMaybeSingle.mockResolvedValue({ data: { id: OFFICE_ID }, error: null });
    mockSingle.mockResolvedValue({ data: MOCK_VISIT, error: null });

    const res = await POST(makeRequest(), ctx());

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty("visit");
    expect(body.visit).toMatchObject({
      id: VISIT_ID,
      office_id: OFFICE_ID,
      salesperson_id: MOCK_ME.id,
      note: null,
      environment: "production",
    });
    expect(typeof body.visit.visited_at).toBe("string");
  });

  it("returns 201 and includes the note in the visit payload", async () => {
    const visitWithNote = { ...MOCK_VISIT, note: "Dropped off donuts" };
    mockMaybeSingle.mockResolvedValue({ data: { id: OFFICE_ID }, error: null });
    mockSingle.mockResolvedValue({ data: visitWithNote, error: null });

    const res = await POST(
      makeRequest({ visit_note: "Dropped off donuts" }),
      ctx(),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.visit.note).toBe("Dropped off donuts");
  });

  it("returns 404 when the office does not belong to the calling AE", async () => {
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });

    const res = await POST(makeRequest(), ctx());

    expect(res.status).toBe(404);
  });

  it("returns 400 for a non-UUID office id", async () => {
    const res = await POST(makeRequest({}, "not-a-uuid"), ctx("not-a-uuid"));
    expect(res.status).toBe(400);
  });

  it("rejects visited_at more than 1 hour in the future", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { id: OFFICE_ID }, error: null });
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    const res = await POST(makeRequest({ visited_at: future }), ctx());

    expect(res.status).toBe(400);
  });
});
