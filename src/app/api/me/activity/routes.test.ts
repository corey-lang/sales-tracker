/**
 * Route-level authorization tests for the AE activity endpoints:
 *   GET  /api/me/activity/week
 *   PUT  /api/me/activity/week
 *   POST /api/me/activity/increment
 *
 * WHY THIS FILE EXISTS
 *   These reads/writes used to run in the BROWSER against `activity_entries`
 *   with the anon key, scoped by a `salespersonId` prop that came from
 *   localStorage. `activity_entries` has no RLS, so the AE boundary was
 *   advisory: a `juice_box_only` guest could edit their stored role, load the
 *   dashboard, and read or overwrite ANY salesperson's activity by changing one
 *   id. The fix moved every one of those operations behind these routes.
 *
 * WHAT MAKES THESE TESTS MEANINGFUL
 *   The auth module is NOT mocked. Requests carry real HMAC-signed session
 *   tokens (`signSessionToken`) and `requireSalesperson` re-reads the caller's
 *   row from a fake Supabase, so the assertions exercise the actual guard
 *   chain — role gate, `deactivated_at` gate, signature verification — rather
 *   than a stub of it. Only the Supabase client is faked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// The real auth module signs and verifies with this; set before any call.
process.env.SESSION_SECRET = "test-session-secret";
// @/lib/goals pulls in the browser Supabase client, which throws at module load
// without these. Harmless placeholders — no request is ever made with them.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

// ---------------------------------------------------------------------------
// Fake Supabase (service-role client) — shared by the routes AND by
// requireSalesperson's identity re-read.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

type FakeState = {
  /** salespeople rows by id — what requireSalesperson re-reads. */
  people: Record<string, Row>;
  /** activity_entries rows across ALL salespeople (the fake filters them). */
  entries: Array<Row & { salesperson_id: string; entry_date: string }>;
  /** weekly_goals rows. */
  goals: Row[];
  /** Recorded writes, for ownership assertions. */
  upserts: Array<{ payload: Row }>;
  rpcCalls: Array<{ name: string; params: Row }>;
  /** Recorded `activity_entries` read filters, for scoping assertions. */
  entryReads: Array<Record<string, unknown>>;
};

let state: FakeState;

function freshState(): FakeState {
  return {
    people: {},
    entries: [],
    goals: [],
    upserts: [],
    rpcCalls: [],
    entryReads: [],
  };
}

function makeBuilder(table: string) {
  const filters: Record<string, unknown> = {};

  const resolve = (single: boolean) => {
    if (table === "salespeople") {
      const id = filters["eq:id"] as string | undefined;
      const row = id ? state.people[id] : undefined;
      return Promise.resolve({ data: row ?? null, error: null });
    }
    if (table === "weekly_goals") {
      return Promise.resolve({ data: state.goals, error: null });
    }
    if (table === "activity_entries") {
      state.entryReads.push({ ...filters });
      const owner = filters["eq:salesperson_id"] as string | undefined;
      const day = filters["eq:entry_date"] as string | undefined;
      const from = filters["gte:entry_date"] as string | undefined;
      const to = filters["lte:entry_date"] as string | undefined;
      const rows = state.entries.filter((r) => {
        if (owner !== undefined && r.salesperson_id !== owner) return false;
        if (day !== undefined && r.entry_date !== day) return false;
        if (from !== undefined && r.entry_date < from) return false;
        if (to !== undefined && r.entry_date > to) return false;
        return true;
      });
      return Promise.resolve({
        data: single ? (rows[0] ?? null) : rows,
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: null });
  };

  const self: Record<string, unknown> = {
    select: (cols?: string) => {
      filters.select = cols;
      return self;
    },
    upsert: (payload: Row) => {
      state.upserts.push({ payload });
      return Promise.resolve({ data: null, error: null });
    },
    maybeSingle: () => resolve(true),
    single: () => resolve(true),
    // PostgREST builders are thenable — awaiting the chain runs the query.
    then: (onFulfilled: unknown, onRejected: unknown) =>
      resolve(false).then(
        onFulfilled as never,
        onRejected as never,
      ),
  };
  for (const method of ["eq", "gte", "lte", "is", "in", "order", "limit"]) {
    self[method] = (col?: string, value?: unknown) => {
      if (col !== undefined) filters[`${method}:${col}`] = value;
      return self;
    };
  }
  return self;
}

vi.mock("@/lib/supabase/server", () => ({
  getServerSupabase: () => ({
    from: (table: string) => makeBuilder(table),
    rpc: (name: string, params: Row) => {
      state.rpcCalls.push({ name, params });
      return Promise.resolve({ data: null, error: null });
    },
  }),
}));

// ---------------------------------------------------------------------------
// Dynamic imports so the env placeholders above are set first
// ---------------------------------------------------------------------------
// The route chain reaches @/lib/goals, which imports the BROWSER Supabase
// client; that module throws at load time without these two vars. Same pattern
// as src/lib/goals.test.ts. (The browser client is never used by the routes —
// they take the service-role client, which is mocked above.)

import { format } from "date-fns";

const { signSessionToken } = await import("@/lib/server/auth");
const { activityWeekToDateRange } = await import("@/lib/goals");
const { todayInAppTimezone } = await import("@/lib/dates");
const { ZERO_ACTIVITY } = await import("@/lib/activities");

const { GET: getWeek, PUT: putWeek } = await import("./week/route");
const { POST: postIncrement } = await import("./increment/route");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_AE_ID = "22222222-2222-4222-8222-222222222222";
const LEAH_ID = "33333333-3333-4333-8333-333333333333"; // juice_box_only
const CHANEL_ID = "44444444-4444-4444-8444-444444444444"; // deactivated
const ADMIN_ID = "55555555-5555-4555-8555-555555555555";

const CURRENT_WEEK_START = activityWeekToDateRange().since;
const TODAY = format(todayInAppTimezone(), "yyyy-MM-dd");

function person(over: Row): Row {
  return {
    role: "ae",
    is_test: false,
    can_import_offices: false,
    state_code: null,
    deactivated_at: null,
    ...over,
  };
}

function seedPeople() {
  state.people[AE_ID] = person({
    id: AE_ID,
    first_name: "Carli",
  });
  state.people[OTHER_AE_ID] = person({
    id: OTHER_AE_ID,
    first_name: "Kennedy",
  });
  state.people[LEAH_ID] = person({
    id: LEAH_ID,
    first_name: "Leah",
    role: "juice_box_only",
  });
  state.people[CHANEL_ID] = person({
    id: CHANEL_ID,
    first_name: "Chanel",
    deactivated_at: "2026-08-24T17:00:00.000Z",
  });
  state.people[ADMIN_ID] = person({
    id: ADMIN_ID,
    first_name: "Corey",
    role: "admin",
  });
}

/** A real signed token for one of the fixture people. */
function tokenFor(id: string): string {
  const row = state.people[id] as { role: string; first_name: string };
  return signSessionToken({
    sub: id,
    role: row.role as never,
    name: row.first_name,
  });
}

function getReq(id: string | null, qs = ""): Request {
  return new Request(`http://localhost/api/me/activity/week${qs}`, {
    headers: id ? { Authorization: `Bearer ${tokenFor(id)}` } : {},
  });
}

function putReq(id: string | null, body: unknown): Request {
  return new Request("http://localhost/api/me/activity/week", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(id ? { Authorization: `Bearer ${tokenFor(id)}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function incrementReq(id: string | null, body: unknown): Request {
  return new Request("http://localhost/api/me/activity/increment", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(id ? { Authorization: `Bearer ${tokenFor(id)}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const FULL_WEEK = { ...ZERO_ACTIVITY, office_visits: 12, impressions: 40 };

beforeEach(() => {
  state = freshState();
  seedPeople();
});

// ---------------------------------------------------------------------------

describe("juice_box_only is a server-side authorization boundary", () => {
  it("403s Leah on GET /api/me/activity/week", async () => {
    const res = await getWeek(getReq(LEAH_ID));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not available for your account/i);
  });

  it("403s Leah on PUT /api/me/activity/week and writes nothing", async () => {
    const res = await putWeek(
      putReq(LEAH_ID, { week_start: CURRENT_WEEK_START, values: FULL_WEEK }),
    );
    expect(res.status).toBe(403);
    expect(state.rpcCalls).toHaveLength(0);
    expect(state.upserts).toHaveLength(0);
  });

  it("403s Leah on POST /api/me/activity/increment and writes nothing", async () => {
    const res = await postIncrement(
      incrementReq(LEAH_ID, { key: "office_visits", delta: 1 }),
    );
    expect(res.status).toBe(403);
    expect(state.upserts).toHaveLength(0);
  });

  it("403s a juice_box_only caller even when the token claims role 'ae'", async () => {
    // The token is validly signed but claims a role the DB row contradicts —
    // exactly the shape of a tampered client session. requireSalesperson
    // re-reads the row, so the DB's `juice_box_only` wins over the claim.
    const forgedClaim = signSessionToken({
      sub: LEAH_ID,
      role: "ae",
      name: "Leah",
    });
    const res = await getWeek(
      new Request("http://localhost/api/me/activity/week", {
        headers: { Authorization: `Bearer ${forgedClaim}` },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("401s when the stored token body is edited to claim another identity", async () => {
    // Editing localStorage's token payload breaks the HMAC — the signature
    // check fails before any DB read, so a hand-crafted session is useless.
    const real = tokenFor(LEAH_ID);
    const [, sig] = real.split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({
        sub: AE_ID,
        role: "ae",
        name: "Carli",
        iat: Date.now(),
      }),
    ).toString("base64url");
    const res = await getWeek(
      new Request("http://localhost/api/me/activity/week", {
        headers: { Authorization: `Bearer ${forgedBody}.${sig}` },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("401s with no token at all", async () => {
    const res = await getWeek(getReq(null));
    expect(res.status).toBe(401);
  });
});

describe("deactivated accounts (Chanel) lose access with a valid token", () => {
  it("401s her GET even though the token is correctly signed", async () => {
    const res = await getWeek(getReq(CHANEL_ID));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/no longer active/i);
  });

  it("401s her write attempts and leaves the DB untouched", async () => {
    const put = await putWeek(
      putReq(CHANEL_ID, { week_start: CURRENT_WEEK_START, values: FULL_WEEK }),
    );
    const inc = await postIncrement(
      incrementReq(CHANEL_ID, { key: "office_visits", delta: 3 }),
    );
    expect(put.status).toBe(401);
    expect(inc.status).toBe(401);
    expect(state.rpcCalls).toHaveLength(0);
    expect(state.upserts).toHaveLength(0);
  });

  it("keeps her historical activity rows in place", async () => {
    // Her own past entries are still in the table — deactivation is an access
    // change, never a data deletion.
    state.entries.push({
      salesperson_id: CHANEL_ID,
      entry_date: "2026-07-06",
      ...ZERO_ACTIVITY,
      office_visits: 9,
    });
    await getWeek(getReq(CHANEL_ID));
    expect(
      state.entries.filter((r) => r.salesperson_id === CHANEL_ID),
    ).toHaveLength(1);
  });
});

describe("an AE only ever reads and writes their OWN activity", () => {
  beforeEach(() => {
    state.entries.push(
      {
        salesperson_id: AE_ID,
        entry_date: CURRENT_WEEK_START,
        ...ZERO_ACTIVITY,
        office_visits: 4,
      },
      {
        salesperson_id: OTHER_AE_ID,
        entry_date: CURRENT_WEEK_START,
        ...ZERO_ACTIVITY,
        office_visits: 100,
      },
    );
  });

  it("scopes the week read to the session's salesperson", async () => {
    const res = await getWeek(getReq(AE_ID));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: Record<string, number>;
      entry_count: number;
    };
    // 4 (own row) — never 104, which would mean the other AE's row leaked in.
    expect(body.totals.office_visits).toBe(4);
    expect(body.entry_count).toBe(1);
    for (const read of state.entryReads) {
      expect(read["eq:salesperson_id"]).toBe(AE_ID);
    }
  });

  it("has no salesperson parameter to point at another AE (GET)", async () => {
    // A tampered client can only add query params; none of them are read.
    const res = await getWeek(
      getReq(AE_ID, `?salesperson_id=${OTHER_AE_ID}&week_start=${CURRENT_WEEK_START}`),
    );
    expect(res.status).toBe(200);
    for (const read of state.entryReads) {
      expect(read["eq:salesperson_id"]).toBe(AE_ID);
    }
  });

  it("replaces only the caller's week — the RPC gets the session id", async () => {
    const res = await putWeek(
      putReq(AE_ID, { week_start: CURRENT_WEEK_START, values: FULL_WEEK }),
    );
    expect(res.status).toBe(200);
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0].name).toBe("replace_activity_week");
    expect(state.rpcCalls[0].params.p_salesperson_id).toBe(AE_ID);
    // Bounds are derived server-side, not taken from the request.
    expect(state.rpcCalls[0].params.p_week_start).toBe(CURRENT_WEEK_START);
  });

  it("rejects a body that tries to name another salesperson (PUT)", async () => {
    const res = await putWeek(
      putReq(AE_ID, {
        week_start: CURRENT_WEEK_START,
        values: FULL_WEEK,
        salesperson_id: OTHER_AE_ID,
      }),
    );
    expect(res.status).toBe(400);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("rejects a body that tries to name another salesperson (increment)", async () => {
    const res = await postIncrement(
      incrementReq(AE_ID, {
        key: "office_visits",
        delta: 1,
        salesperson_id: OTHER_AE_ID,
      }),
    );
    expect(res.status).toBe(400);
    expect(state.upserts).toHaveLength(0);
  });

  it("rejects an attempt to choose the entry_date (increment)", async () => {
    const res = await postIncrement(
      incrementReq(AE_ID, {
        key: "office_visits",
        delta: 1,
        entry_date: "2020-01-01",
      }),
    );
    expect(res.status).toBe(400);
    expect(state.upserts).toHaveLength(0);
  });

  it("increments today's own row, adding to the existing value", async () => {
    state.entries.push({
      salesperson_id: AE_ID,
      entry_date: TODAY,
      ...ZERO_ACTIVITY,
      service_requests: 2,
    });
    const res = await postIncrement(
      incrementReq(AE_ID, { key: "service_requests", delta: 3 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { value: number; entry_date: string };
    expect(body.value).toBe(5);
    expect(body.entry_date).toBe(TODAY);
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0].payload).toMatchObject({
      salesperson_id: AE_ID,
      entry_date: TODAY,
      service_requests: 5,
    });
  });

  it("only returns the caller's own goal, resolved server-side", async () => {
    state.goals.push(
      {
        id: "g-global",
        salesperson_id: null,
        effective_from: "2026-01-01",
        ...ZERO_ACTIVITY,
        office_visits: 5,
      },
      {
        id: "g-other",
        salesperson_id: OTHER_AE_ID,
        effective_from: "2026-01-01",
        ...ZERO_ACTIVITY,
        office_visits: 99,
      },
    );
    const res = await getWeek(getReq(AE_ID));
    const body = (await res.json()) as { goal: { id: string } | null };
    // Falls back to the global default — never the other AE's override.
    expect(body.goal?.id).toBe("g-global");
  });
});

describe("payload validation", () => {
  it("rejects an unknown activity key", async () => {
    const res = await postIncrement(
      incrementReq(AE_ID, { key: "not_an_activity", delta: 1 }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a non-positive or fractional delta", async () => {
    for (const delta of [0, -5, 1.5, 10_001]) {
      const res = await postIncrement(
        incrementReq(AE_ID, { key: "office_visits", delta }),
      );
      expect(res.status).toBe(400);
    }
    expect(state.upserts).toHaveLength(0);
  });

  it("rejects negative or absurd week values", async () => {
    const negative = await putWeek(
      putReq(AE_ID, {
        week_start: CURRENT_WEEK_START,
        values: { ...FULL_WEEK, office_visits: -1 },
      }),
    );
    const absurd = await putWeek(
      putReq(AE_ID, {
        week_start: CURRENT_WEEK_START,
        values: { ...FULL_WEEK, impressions: 999_999 },
      }),
    );
    expect(negative.status).toBe(400);
    expect(absurd.status).toBe(400);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("rejects a week_start that isn't a Sunday", async () => {
    const monday = new Date(`${CURRENT_WEEK_START}T00:00:00`);
    monday.setDate(monday.getDate() + 1);
    const res = await getWeek(
      getReq(AE_ID, `?week_start=${format(monday, "yyyy-MM-dd")}`),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a future week", async () => {
    const nextSunday = new Date(`${CURRENT_WEEK_START}T00:00:00`);
    nextSunday.setDate(nextSunday.getDate() + 7);
    const res = await getWeek(
      getReq(AE_ID, `?week_start=${format(nextSunday, "yyyy-MM-dd")}`),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a malformed week_start", async () => {
    const res = await getWeek(getReq(AE_ID, "?week_start=last-week"));
    expect(res.status).toBe(400);
  });
});

describe("other roles", () => {
  it("lets an admin use the route for their OWN week (unchanged behaviour)", async () => {
    state.entries.push({
      salesperson_id: ADMIN_ID,
      entry_date: CURRENT_WEEK_START,
      ...ZERO_ACTIVITY,
      team_meetings: 2,
    });
    const res = await getWeek(getReq(ADMIN_ID));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: Record<string, number> };
    expect(body.totals.team_meetings).toBe(2);
    for (const read of state.entryReads) {
      expect(read["eq:salesperson_id"]).toBe(ADMIN_ID);
    }
  });

  it("401s a token whose salesperson row no longer exists", async () => {
    const token = tokenFor(AE_ID);
    delete state.people[AE_ID];
    const res = await getWeek(
      new Request("http://localhost/api/me/activity/week", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(401);
  });
});
