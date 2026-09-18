/**
 * Route-level authorization + workflow tests for the Gold List endpoints:
 *   GET    /api/gold-list/agents
 *   POST   /api/gold-list/agents
 *   PATCH  /api/gold-list/agents/:id
 *   DELETE /api/gold-list/agents/:id
 *   GET    /api/gold-list/agents/:id/activities
 *   POST   /api/gold-list/agents/:id/activities
 *   PATCH  /api/gold-list/agents/:id/activities/:aid
 *
 * WHY THIS FILE EXISTS
 *   The Gold List is per-AE data behind service-role routes: the tables have
 *   RLS enabled with no policy, so the ONLY thing standing between one rep's
 *   follow-up list and another's is the ownership logic in
 *   src/lib/server/gold-list.ts. The rules these tests pin down are:
 *     * an AE reads and writes only their own agents;
 *     * an admin READS any AE's list (and filters by AE) but never writes to
 *       one they don't own;
 *     * `juice_box_only` has no Gold List surface at all;
 *     * the owner of a new agent is the authenticated caller, no matter what
 *       the request body says;
 *     * completing an activity preserves it as history and frees the agent for
 *       the next one, with at most one open activity at a time.
 *
 * WHAT MAKES THESE TESTS MEANINGFUL
 *   The auth module is NOT mocked. Requests carry real HMAC-signed session
 *   tokens and `requireSalesperson` re-reads the caller's row from the fake
 *   Supabase, so the real guard chain runs (signature, role gate,
 *   `deactivated_at`). Only the Supabase client is faked — including its two
 *   unique indexes, so the 409 paths are exercised rather than assumed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// The real auth module signs and verifies with this; set before any call.
process.env.SESSION_SECRET = "test-session-secret";
// Harmless placeholders — nothing in this chain makes a real request.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

// ---------------------------------------------------------------------------
// Fake Supabase (service-role client), shared by the routes AND by
// requireSalesperson's identity re-read.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

type FakeState = {
  people: Record<string, Row>;
  agents: Row[];
  activities: Row[];
};

let state: FakeState;
let idSeq = 0;
let largestActivityBatch = 0;

function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${String(idSeq).padStart(4, "0")}`;
}

/** Mirrors idx_gold_list_activities_one_open. */
function openActivityExists(agentId: unknown, ignoreId?: string): boolean {
  return state.activities.some(
    (a) =>
      a.id !== ignoreId && a.agent_id === agentId && a.status === "scheduled",
  );
}

const UNIQUE_VIOLATION = { code: "23505", message: "duplicate key value" };

function tableRows(table: string): Row[] {
  if (table === "salespeople") return Object.values(state.people);
  if (table === "gold_list_agents") return state.agents;
  return state.activities;
}

function makeBuilder(table: string) {
  const filters: Record<string, unknown> = {};
  let slice: [number, number] = [0, 499];
  const orders: Array<[string, boolean]> = [];
  let pending: { op: "insert" | "update"; payload: Row } | null = null;

  const matches = (row: Row): boolean => {
    for (const [key, value] of Object.entries(filters)) {
      const [op, col] = key.split(":");
      if (!col) continue;
      if (op === "eq" && row[col] !== value) return false;
      if (op === "neq" && row[col] === value) return false;
      if (op === "is" && row[col] !== value) return false;
      if (op === "in" && !(value as unknown[]).includes(row[col])) return false;
    }
    return true;
  };

  const resolve = (single: boolean) => {
    // --- INSERT ---------------------------------------------------------
    if (pending?.op === "insert") {
      const payload = pending.payload;
      if (table === "gold_list_agents") {
        if (state.agents.some((a) => a.id === payload.id))
          return Promise.resolve({ data: null, error: UNIQUE_VIOLATION });
        const row: Row = {
          id: nextId("agent"),
          brokerage: null,
          phone: null,
          email: null,
          notes: null,
          archived_at: null,
          created_at: "2026-09-18T12:00:00.000Z",
          updated_at: "2026-09-18T12:00:00.000Z",
          ...payload,
        };
        state.agents.push(row);
        return Promise.resolve({ data: row, error: null });
      }
      if (openActivityExists(payload.agent_id)) {
        return Promise.resolve({ data: null, error: UNIQUE_VIOLATION });
      }
      const row: Row = {
        id: nextId("activity"),
        activity_note: null,
        outcome_note: null,
        completed_at: null,
        created_at: "2026-09-18T12:00:00.000Z",
        updated_at: "2026-09-18T12:00:00.000Z",
        ...payload,
      };
      state.activities.push(row);
      return Promise.resolve({ data: row, error: null });
    }

    // --- UPDATE ---------------------------------------------------------
    if (pending?.op === "update") {
      const patch = pending.payload;
      const hits = tableRows(table).filter(matches);
      for (const row of hits) {
        const candidate = { ...row, ...patch };
        if (
          table === "gold_list_activities" &&
          candidate.status === "scheduled" &&
          openActivityExists(candidate.agent_id, row.id as string)
        ) {
          return Promise.resolve({ data: null, error: UNIQUE_VIOLATION });
        }
        Object.assign(row, patch);
      }
      return Promise.resolve({
        data: single ? (hits[0] ?? null) : hits,
        error: null,
      });
    }

    // --- SELECT ---------------------------------------------------------
    const rows = tableRows(table)
      .filter(matches)
      .sort((a, b) => {
        for (const [col, ascending] of orders) {
          if (a[col] === b[col]) continue;
          if (a[col] == null) return 1;
          if (b[col] == null) return -1;
          return (
            String(a[col]).localeCompare(String(b[col])) * (ascending ? 1 : -1)
          );
        }
        return 0;
      })
      .slice(slice[0], slice[1] + 1);
    return Promise.resolve({
      data: single ? (rows[0] ?? null) : rows,
      error: null,
    });
  };

  const self: Record<string, unknown> = {
    select: () => self,
    range: (from: number, to: number) => {
      slice = [from, to];
      return self;
    },
    order: (col: string, options?: { ascending?: boolean }) => {
      orders.push([col, options?.ascending !== false]);
      return self;
    },
    insert: (payload: Row) => {
      pending = { op: "insert", payload };
      return self;
    },
    update: (payload: Row) => {
      pending = { op: "update", payload };
      return self;
    },
    maybeSingle: () => resolve(true),
    single: () => resolve(true),
    // PostgREST builders are thenable — awaiting the chain runs the query.
    then: (onFulfilled: unknown, onRejected: unknown) =>
      resolve(false).then(onFulfilled as never, onRejected as never),
  };
  for (const method of ["eq", "neq", "is", "in", "gte", "lte", "limit"]) {
    self[method] = (col?: string, value?: unknown) => {
      if (col !== undefined && ["eq", "neq", "is", "in"].includes(method)) {
        if (method === "in" && col === "agent_id")
          largestActivityBatch = Math.max(
            largestActivityBatch,
            (value as unknown[]).length,
          );
        filters[`${method}:${col}`] = value;
      }
      return self;
    };
  }
  return self;
}

vi.mock("@/lib/supabase/server", () => ({
  getServerSupabase: () => ({ from: (table: string) => makeBuilder(table) }),
}));

// ---------------------------------------------------------------------------
// Imports (after the mock so hoisting applies)
// ---------------------------------------------------------------------------

const { signSessionToken } = await import("@/lib/server/auth");

const { GET: listAgents, POST: createAgent } = await import("./agents/route");
const { PATCH: patchAgent, DELETE: archiveAgent } =
  await import("./agents/[id]/route");
const { GET: listActivities, POST: createActivity } =
  await import("./agents/[id]/activities/route");
const { PATCH: patchActivity } =
  await import("./agents/[id]/activities/[aid]/route");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_AE_ID = "22222222-2222-4222-8222-222222222222";
const LEAH_ID = "33333333-3333-4333-8333-333333333333"; // juice_box_only
const ADMIN_ID = "55555555-5555-4555-8555-555555555555";

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

function seed() {
  idSeq = 0;
  largestActivityBatch = 0;
  state = { people: {}, agents: [], activities: [] };
  state.people[AE_ID] = person({ id: AE_ID, first_name: "Carli" });
  state.people[OTHER_AE_ID] = person({
    id: OTHER_AE_ID,
    first_name: "Kennedy",
  });
  state.people[LEAH_ID] = person({
    id: LEAH_ID,
    first_name: "Leah",
    role: "juice_box_only",
  });
  state.people[ADMIN_ID] = person({
    id: ADMIN_ID,
    first_name: "Corey",
    role: "admin",
  });
}

function seedAgent(over: Row = {}): Row {
  const row: Row = {
    id: nextId("agent"),
    salesperson_id: AE_ID,
    agent_name: "Dana Reed",
    brokerage: "Summit Realty",
    phone: null,
    email: null,
    notes: null,
    archived_at: null,
    created_at: "2026-09-01T12:00:00.000Z",
    updated_at: "2026-09-01T12:00:00.000Z",
    ...over,
  };
  state.agents.push(row);
  return row;
}

function seedActivity(over: Row = {}): Row {
  const row: Row = {
    id: nextId("activity"),
    agent_id: state.agents[0]?.id,
    salesperson_id: AE_ID,
    activity_type: "call",
    description: "Phone call",
    activity_note: null,
    scheduled_for: "2026-09-20",
    status: "scheduled",
    outcome_note: null,
    completed_at: null,
    created_at: "2026-09-01T12:00:00.000Z",
    updated_at: "2026-09-01T12:00:00.000Z",
    ...over,
  };
  state.activities.push(row);
  return row;
}

function tokenFor(id: string): string {
  const row = state.people[id] as { role: string; first_name: string };
  return signSessionToken({
    sub: id,
    role: row.role as never,
    name: row.first_name,
  });
}

function req(id: string | null, path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(id ? { Authorization: `Bearer ${tokenFor(id)}` } : {}),
    },
  });
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

beforeEach(() => {
  seed();
});

// ---------------------------------------------------------------------------
// Reading the board
// ---------------------------------------------------------------------------

describe("GET /api/gold-list/agents", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await listAgents(req(null, "/api/gold-list/agents"));
    expect(res.status).toBe(401);
  });

  it("rejects a juice_box_only account — no AE surface at all", async () => {
    const res = await listAgents(req(LEAH_ID, "/api/gold-list/agents"));
    expect(res.status).toBe(403);
  });

  it("returns only the caller's own agents, and counts active ones", async () => {
    seedAgent({ agent_name: "Dana Reed" });
    seedAgent({
      agent_name: "Archived Al",
      archived_at: "2026-09-05T00:00:00Z",
    });
    seedAgent({ agent_name: "Kennedy's Agent", salesperson_id: OTHER_AE_ID });

    const res = await listAgents(req(AE_ID, "/api/gold-list/agents"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.agents.map((a: Row) => a.agent_name)).toEqual(["Dana Reed"]);
    expect(body.active_count).toBe(1);
    expect(body.scope).toMatchObject({
      ae_id: AE_ID,
      view_all: false,
      can_view_all: false,
    });
    // The AE filter belongs to admins; an AE is never handed the roster.
    expect(body.ae_options).toBeUndefined();
  });

  it("refuses an AE asking for someone else's list", async () => {
    const res = await listAgents(
      req(AE_ID, `/api/gold-list/agents?ae_id=${OTHER_AE_ID}`),
    );
    expect(res.status).toBe(403);
  });

  it("gives an admin every AE's list, with edit rights only on their own", async () => {
    seedAgent({ agent_name: "Dana Reed" });
    seedAgent({ agent_name: "Kennedy's Agent", salesperson_id: OTHER_AE_ID });
    seedAgent({ agent_name: "Corey's Agent", salesperson_id: ADMIN_ID });

    const res = await listAgents(req(ADMIN_ID, "/api/gold-list/agents"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.agents).toHaveLength(3);
    expect(body.scope).toMatchObject({ ae_id: null, view_all: true });
    expect(body.ae_options.map((o: Row) => o.first_name)).toContain("Kennedy");

    const editable = body.agents.filter((a: Row) => a.can_edit);
    expect(editable.map((a: Row) => a.agent_name)).toEqual(["Corey's Agent"]);
    // Owner labels make the all-AEs view legible.
    expect(
      body.agents.find((a: Row) => a.agent_name === "Dana Reed").owner_name,
    ).toBe("Carli");
  });

  it("lets an admin filter by AE, read-only", async () => {
    seedAgent({ agent_name: "Dana Reed" });
    seedAgent({ agent_name: "Kennedy's Agent", salesperson_id: OTHER_AE_ID });

    const res = await listAgents(
      req(ADMIN_ID, `/api/gold-list/agents?ae_id=${AE_ID}`),
    );
    const body = await res.json();

    expect(body.agents.map((a: Row) => a.agent_name)).toEqual(["Dana Reed"]);
    expect(body.agents.every((a: Row) => a.can_edit === false)).toBe(true);
  });

  it("summarizes each agent's open activity and preserved history", async () => {
    const agent = seedAgent();
    seedActivity({ agent_id: agent.id, scheduled_for: "2026-09-25" });
    seedActivity({
      agent_id: agent.id,
      status: "completed",
      scheduled_for: "2026-09-10",
      completed_at: "2026-09-10T18:00:00Z",
    });
    seedActivity({
      agent_id: agent.id,
      status: "completed",
      scheduled_for: "2026-08-28",
      completed_at: "2026-08-28T18:00:00Z",
    });

    const res = await listAgents(req(AE_ID, "/api/gold-list/agents"));
    const body = await res.json();
    const card = body.agents[0];

    expect(card.next_activity.scheduled_for).toBe("2026-09-25");
    expect(card.completed_count).toBe(2);
    expect(card.last_completed_on).toBe("2026-09-10");
  });
});

// ---------------------------------------------------------------------------
// Creating + editing agents
// ---------------------------------------------------------------------------

describe("POST /api/gold-list/agents", () => {
  it("assigns the owner from the session, ignoring a body-supplied id", async () => {
    const res = await createAgent(
      req(AE_ID, "/api/gold-list/agents", {
        method: "POST",
        body: jsonBody({
          agent_name: "Dana Reed",
          // A hand-crafted request trying to plant a row on someone else.
          salesperson_id: OTHER_AE_ID,
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.agent.salesperson_id).toBe(AE_ID);
    expect(state.agents[0].salesperson_id).toBe(AE_ID);
  });

  it("warns about a matching name without creating or hard-blocking", async () => {
    seedAgent({ agent_name: "Dana Reed", brokerage: "Summit Realty" });
    const res = await createAgent(
      req(AE_ID, "/api/gold-list/agents", {
        method: "POST",
        body: jsonBody({
          agent_name: "  dana reed ",
          brokerage: "Summit Realty",
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).duplicates).toHaveLength(1);
    expect(state.agents).toHaveLength(1);
  });

  it("requires a name", async () => {
    const res = await createAgent(
      req(AE_ID, "/api/gold-list/agents", {
        method: "POST",
        body: jsonBody({ agent_name: "   " }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("PATCH / DELETE /api/gold-list/agents/:id", () => {
  it("404s when an AE edits someone else's agent", async () => {
    const agent = seedAgent({ salesperson_id: OTHER_AE_ID });
    const res = await patchAgent(
      req(AE_ID, `/api/gold-list/agents/${agent.id}`, {
        method: "PATCH",
        body: jsonBody({ agent_name: "Hijacked" }),
      }),
      { params: Promise.resolve({ id: agent.id as string }) },
    );
    expect(res.status).toBe(404);
    expect(state.agents[0].agent_name).toBe("Dana Reed");
  });

  it("404s when an ADMIN edits an agent they don't own — read access is not write access", async () => {
    const agent = seedAgent({ salesperson_id: AE_ID });
    const res = await patchAgent(
      req(ADMIN_ID, `/api/gold-list/agents/${agent.id}`, {
        method: "PATCH",
        body: jsonBody({ agent_name: "Manager edit" }),
      }),
      { params: Promise.resolve({ id: agent.id as string }) },
    );
    expect(res.status).toBe(404);
    expect(state.agents[0].agent_name).toBe("Dana Reed");
  });

  it("archives rather than deletes, keeping the row and its history", async () => {
    const agent = seedAgent();
    seedActivity({
      agent_id: agent.id,
      status: "completed",
      completed_at: "2026-09-10T18:00:00Z",
    });

    const res = await archiveAgent(
      req(AE_ID, `/api/gold-list/agents/${agent.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: agent.id as string }) },
    );
    expect(res.status).toBe(200);
    expect(state.agents).toHaveLength(1);
    expect(state.agents[0].archived_at).not.toBeNull();
    expect(state.activities).toHaveLength(1);

    // …and it drops out of the active count.
    const list = await listAgents(req(AE_ID, "/api/gold-list/agents"));
    const body = await list.json();
    expect(body.active_count).toBe(0);
  });

  it("restores an archived agent", async () => {
    const agent = seedAgent({ archived_at: "2026-09-05T00:00:00Z" });
    const res = await patchAgent(
      req(AE_ID, `/api/gold-list/agents/${agent.id}`, {
        method: "PATCH",
        body: jsonBody({ archived: false }),
      }),
      { params: Promise.resolve({ id: agent.id as string }) },
    );
    expect(res.status).toBe(200);
    expect(state.agents[0].archived_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The follow-up loop
// ---------------------------------------------------------------------------

describe("activities", () => {
  it("schedules an activity on an owned agent", async () => {
    const agent = seedAgent();
    const res = await createActivity(
      req(AE_ID, `/api/gold-list/agents/${agent.id}/activities`, {
        method: "POST",
        body: jsonBody({
          description: "Follow up about the meeting",
          activity_type: "lunch",
          scheduled_for: "2026-09-22",
        }),
      }),
      { params: Promise.resolve({ id: agent.id as string }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.activity).toMatchObject({
      activity_type: "lunch",
      status: "scheduled",
      // Denormalized owner comes from the agent row, never the request.
      salesperson_id: AE_ID,
    });
  });

  it("allows only one open activity per agent", async () => {
    const agent = seedAgent();
    seedActivity({ agent_id: agent.id });
    const res = await createActivity(
      req(AE_ID, `/api/gold-list/agents/${agent.id}/activities`, {
        method: "POST",
        body: jsonBody({
          description: "Follow up about the meeting",
          activity_type: "call",
          scheduled_for: "2026-09-30",
        }),
      }),
      { params: Promise.resolve({ id: agent.id as string }) },
    );
    expect(res.status).toBe(409);
  });

  it("refuses to schedule on an agent the caller doesn't own", async () => {
    const agent = seedAgent({ salesperson_id: OTHER_AE_ID });
    const res = await createActivity(
      req(ADMIN_ID, `/api/gold-list/agents/${agent.id}/activities`, {
        method: "POST",
        body: jsonBody({
          description: "Follow up about the meeting",
          activity_type: "call",
          scheduled_for: "2026-09-30",
        }),
      }),
      { params: Promise.resolve({ id: agent.id as string }) },
    );
    expect(res.status).toBe(404);
    expect(state.activities).toHaveLength(0);
  });

  it("rejects an unknown activity type", async () => {
    const agent = seedAgent();
    const res = await createActivity(
      req(AE_ID, `/api/gold-list/agents/${agent.id}/activities`, {
        method: "POST",
        body: jsonBody({
          description: "Follow up about the meeting",
          activity_type: "carrier-pigeon",
          scheduled_for: "2026-09-30",
        }),
      }),
      { params: Promise.resolve({ id: agent.id as string }) },
    );
    expect(res.status).toBe(400);
  });

  it("completes with an outcome note, preserves the row, and frees the agent for the next one", async () => {
    const agent = seedAgent();
    const activity = seedActivity({ agent_id: agent.id });

    const completed = await patchActivity(
      req(
        AE_ID,
        `/api/gold-list/agents/${agent.id}/activities/${activity.id}`,
        {
          method: "PATCH",
          body: jsonBody({
            status: "completed",
            outcome_note: "Met at the office — wants the Q4 deck.",
          }),
        },
      ),
      {
        params: Promise.resolve({
          id: agent.id as string,
          aid: activity.id as string,
        }),
      },
    );
    expect(completed.status).toBe(200);
    const body = await completed.json();
    expect(body.activity.status).toBe("completed");
    expect(body.activity.completed_at).not.toBeNull();
    expect(body.activity.outcome_note).toBe(
      "Met at the office — wants the Q4 deck.",
    );
    // The completed activity is still there — history, not a mutation target.
    expect(state.activities).toHaveLength(1);

    // …and the next one can now be scheduled.
    const next = await createActivity(
      req(AE_ID, `/api/gold-list/agents/${agent.id}/activities`, {
        method: "POST",
        body: jsonBody({
          description: "Follow up about the meeting",
          activity_type: "text",
          scheduled_for: "2026-10-02",
        }),
      }),
      { params: Promise.resolve({ id: agent.id as string }) },
    );
    expect(next.status).toBe(201);
    expect(state.activities).toHaveLength(2);
  });

  it("404s when the URL's agent segment doesn't own the activity", async () => {
    const agent = seedAgent();
    const otherAgent = seedAgent({ agent_name: "Someone Else" });
    const activity = seedActivity({ agent_id: agent.id });

    const res = await patchActivity(
      req(
        AE_ID,
        `/api/gold-list/agents/${otherAgent.id}/activities/${activity.id}`,
        { method: "PATCH", body: jsonBody({ status: "completed" }) },
      ),
      {
        params: Promise.resolve({
          id: otherAgent.id as string,
          aid: activity.id as string,
        }),
      },
    );
    expect(res.status).toBe(404);
    expect(state.activities[0].status).toBe("scheduled");
  });

  it("lets an admin READ another AE's history but not an unrelated AE", async () => {
    const agent = seedAgent({ salesperson_id: AE_ID });
    seedActivity({
      agent_id: agent.id,
      status: "completed",
      completed_at: "2026-09-10T18:00:00Z",
      outcome_note: "Coffee — introduced the service team.",
    });

    const adminRes = await listActivities(
      req(ADMIN_ID, `/api/gold-list/agents/${agent.id}/activities`),
      { params: Promise.resolve({ id: agent.id as string }) },
    );
    expect(adminRes.status).toBe(200);
    expect((await adminRes.json()).activities).toHaveLength(1);

    const peerRes = await listActivities(
      req(OTHER_AE_ID, `/api/gold-list/agents/${agent.id}/activities`),
      { params: Promise.resolve({ id: agent.id as string }) },
    );
    expect(peerRes.status).toBe(404);
  });
});

describe("review regressions", () => {
  it.each(["assistant", "juice_box_only"])(
    "rejects %s at every feature entry point",
    async (role) => {
      state.people[AE_ID].role = role;
      const agent = seedAgent();
      const activity = seedActivity();
      const ctx = {
        params: Promise.resolve({
          id: String(agent.id),
          aid: String(activity.id),
        }),
      };
      const requests = [
        listAgents(req(AE_ID, "/api/gold-list/agents")),
        createAgent(
          req(AE_ID, "/api/gold-list/agents", {
            method: "POST",
            body: jsonBody({ agent_name: "New" }),
          }),
        ),
        patchAgent(
          req(AE_ID, "/api/gold-list/agents/x", {
            method: "PATCH",
            body: jsonBody({ archived: false }),
          }),
          ctx,
        ),
        archiveAgent(
          req(AE_ID, "/api/gold-list/agents/x", { method: "DELETE" }),
          ctx,
        ),
        listActivities(req(AE_ID, "/api/gold-list/agents/x/activities"), ctx),
        createActivity(
          req(AE_ID, "/api/gold-list/agents/x/activities", {
            method: "POST",
            body: jsonBody({
              description: "Call",
              scheduled_for: "2026-09-20",
            }),
          }),
          ctx,
        ),
        patchActivity(
          req(AE_ID, "/api/gold-list/agents/x/activities/y", {
            method: "PATCH",
            body: jsonBody({ status: "completed" }),
          }),
          ctx,
        ),
      ];
      expect((await Promise.all(requests)).map((r) => r.status)).toEqual(
        Array(7).fill(403),
      );
    },
  );

  it("warns on normalized email/phone in archived rows, scoped to the owner, with override", async () => {
    seedAgent({
      agent_name: "Archived",
      archived_at: "2026-09-01",
      email: "DANA@example.com",
      phone: "+1 (303) 555-1234",
    });
    seedAgent({
      salesperson_id: OTHER_AE_ID,
      agent_name: "Secret",
      email: "dana@example.com",
    });
    for (const contact of [
      { email: "dana@example.com" },
      { phone: "3035551234" },
    ]) {
      const response = await createAgent(
        req(AE_ID, "/api/gold-list/agents", {
          method: "POST",
          body: jsonBody({ agent_name: "Different", ...contact }),
        }),
      );
      const body = await response.json();
      expect(body.duplicates).toHaveLength(1);
      expect(body.duplicates[0].agent_name).toBe("Archived");
    }
    const response = await createAgent(
      req(AE_ID, "/api/gold-list/agents", {
        method: "POST",
        body: jsonBody({ agent_name: "Archived", confirm_duplicate: true }),
      }),
    );
    expect(response.status).toBe(201);
  });

  it("never leaks another owner's duplicate candidates", async () => {
    seedAgent({ salesperson_id: OTHER_AE_ID });
    const res = await createAgent(
      req(AE_ID, "/api/gold-list/agents", {
        method: "POST",
        body: jsonBody({ agent_name: "Dana Reed" }),
      }),
    );
    expect(res.status).toBe(201);
  });

  it.each([
    { status: "scheduled" },
    { status: "completed" },
    { outcome_note: "rewrite" },
    { description: "rewrite" },
    { scheduled_for: "2026-10-01" },
  ])("preserves completed history against %j", async (patch) => {
    const agent = seedAgent();
    const activity = seedActivity({
      status: "completed",
      completed_at: "2026-09-10T18:00:00Z",
    });
    const before = { ...activity };
    const res = await patchActivity(
      req(AE_ID, "/api/gold-list/agents/x/activities/y", {
        method: "PATCH",
        body: jsonBody(patch),
      }),
      {
        params: Promise.resolve({
          id: String(agent.id),
          aid: String(activity.id),
        }),
      },
    );
    expect(res.status).toBe(409);
    expect(activity).toEqual(before);
  });

  it("concurrent completions only succeed once", async () => {
    const agent = seedAgent();
    const activity = seedActivity();
    const complete = () =>
      patchActivity(
        req(AE_ID, "/api/gold-list/agents/x/activities/y", {
          method: "PATCH",
          body: jsonBody({ status: "completed" }),
        }),
        {
          params: Promise.resolve({
            id: String(agent.id),
            aid: String(activity.id),
          }),
        },
      );
    expect(
      (await Promise.all([complete(), complete()])).map((r) => r.status).sort(),
    ).toEqual([200, 409]);
  });

  it.each(["2026-02-30", "2025-02-29", "2026-13-01"])(
    "rejects impossible date %s",
    async (date) => {
      const agent = seedAgent();
      const res = await createActivity(
        req(AE_ID, "/api/gold-list/agents/x/activities", {
          method: "POST",
          body: jsonBody({ description: "Call", scheduled_for: date }),
        }),
        { params: Promise.resolve({ id: String(agent.id) }) },
      );
      expect(res.status).toBe(400);
    },
  );

  it("pages through agents and history beyond the provider cap", async () => {
    for (let i = 0; i < 1005; i++) seedAgent({ agent_name: `Agent ${i}` });
    const agent = state.agents[0];
    for (let i = 0; i < 1005; i++)
      seedActivity({
        agent_id: agent.id,
        status: "completed",
        completed_at: "2026-09-10T18:00:00Z",
      });
    seedActivity({ agent_id: agent.id });
    const list = await (
      await listAgents(req(AE_ID, "/api/gold-list/agents"))
    ).json();
    expect(list.active_count).toBe(1005);
    expect(largestActivityBatch).toBeLessThanOrEqual(100);
    const decorated = list.agents.find((a: Row) => a.id === agent.id);
    expect(decorated.completed_count).toBe(1005);
    expect(decorated.next_activity).not.toBeNull();
    const history = await (
      await listActivities(req(AE_ID, "/api/gold-list/agents/x/activities"), {
        params: Promise.resolve({ id: String(agent.id) }),
      })
    ).json();
    expect(history.activities).toHaveLength(1006);
  });

  it("same agent request id can be retried without duplication", async () => {
    const create = () =>
      createAgent(
        req(AE_ID, "/api/gold-list/agents", {
          method: "POST",
          body: jsonBody({
            request_id: "77777777-7777-4777-8777-777777777777",
            agent_name: "New",
          }),
        }),
      );
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(200);
    expect(state.agents).toHaveLength(1);
  });

  it("cross-AE archive, restore, completion all fail without mutation", async () => {
    const agent = seedAgent({ salesperson_id: OTHER_AE_ID });
    const activity = seedActivity({ salesperson_id: OTHER_AE_ID });
    const ctx = {
      params: Promise.resolve({
        id: String(agent.id),
        aid: String(activity.id),
      }),
    };
    expect(
      (
        await archiveAgent(
          req(AE_ID, "/api/gold-list/agents/x", { method: "DELETE" }),
          ctx,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await patchAgent(
          req(AE_ID, "/api/gold-list/agents/x", {
            method: "PATCH",
            body: jsonBody({ archived: false }),
          }),
          ctx,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await patchActivity(
          req(AE_ID, "/api/gold-list/agents/x/activities/y", {
            method: "PATCH",
            body: jsonBody({ status: "completed" }),
          }),
          ctx,
        )
      ).status,
    ).toBe(404);
    expect(agent.archived_at).toBeNull();
    expect(activity.status).toBe("scheduled");
  });
});

describe("activity retry and input integrity", () => {
  it("replays an activity request even after completion without adding a new activity", async () => {
    const agent = seedAgent();
    const requestId = "88888888-8888-4888-8888-888888888888";
    const create = () =>
      createActivity(
        req(AE_ID, "/api/gold-list/agents/x/activities", {
          method: "POST",
          body: jsonBody({
            request_id: requestId,
            description: "Call Dana",
            scheduled_for: "2026-09-20",
          }),
        }),
        { params: Promise.resolve({ id: String(agent.id) }) },
      );
    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(200);
    expect(state.activities).toHaveLength(1);
    const completed = await patchActivity(
      req(AE_ID, "/api/gold-list/agents/x/activities/y", {
        method: "PATCH",
        body: jsonBody({ status: "completed" }),
      }),
      { params: Promise.resolve({ id: String(agent.id), aid: requestId }) },
    );
    expect(completed.status).toBe(200);
    const replay = await create();
    expect(replay.status).toBe(200);
    expect((await replay.json()).activity.status).toBe("completed");
    expect(state.activities).toHaveLength(1);
  });

  it.each([undefined, "", "   "])(
    "rejects missing/empty description %s",
    async (description) => {
      const agent = seedAgent();
      const response = await createActivity(
        req(AE_ID, "/api/gold-list/agents/x/activities", {
          method: "POST",
          body: jsonBody({ description, scheduled_for: "2026-09-20" }),
        }),
        { params: Promise.resolve({ id: String(agent.id) }) },
      );
      expect(response.status).toBe(400);
      expect(state.activities).toHaveLength(0);
    },
  );

  it("validates contact details at the API, independent of browser inputs", async () => {
    for (const contact of [
      { email: "not-an-email" },
      { phone: "javascript:invalid" },
    ]) {
      const response = await createAgent(
        req(AE_ID, "/api/gold-list/agents", {
          method: "POST",
          body: jsonBody({ agent_name: "Name", ...contact }),
        }),
      );
      expect(response.status).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
// The scheduled activity note
// ---------------------------------------------------------------------------
//
// Three notes exist in this feature and the tests below exist to keep them
// from collapsing into each other:
//
//   agent.notes    — the standing relationship note on the person
//   activity_note  — the plan for ONE scheduled activity
//   outcome_note   — what happened, written when that activity is completed
//
// They are separate columns, they travel separately through the API, and a
// completed activity freezes both of its notes as history.

describe("scheduled activity note", () => {
  it("creates an activity with a note, keeping it apart from the agent's own notes", async () => {
    const agent = seedAgent({ notes: "Met at the spring mixer." });
    const res = await createActivity(
      req(AE_ID, `/api/gold-list/agents/${agent.id}/activities`, {
        method: "POST",
        body: jsonBody({
          description: "Phone call",
          activity_note: "Get him on the phone to discuss his upcoming listing",
          scheduled_for: "2026-09-22",
        }),
      }),
      { params: Promise.resolve({ id: agent.id as string }) },
    );
    expect(res.status).toBe(201);
    const { activity } = await res.json();

    expect(activity.description).toBe("Phone call");
    expect(activity.activity_note).toBe(
      "Get him on the phone to discuss his upcoming listing",
    );
    // The completion note is untouched by scheduling…
    expect(activity.outcome_note).toBeNull();
    // …and the agent's own relationship note is a different record entirely.
    expect(state.agents[0].notes).toBe("Met at the spring mixer.");
    expect(state.activities[0].activity_note).toBe(
      "Get him on the phone to discuss his upcoming listing",
    );
  });

  it("creates an activity without a note — the field is optional", async () => {
    const agent = seedAgent();
    const res = await createActivity(
      req(AE_ID, `/api/gold-list/agents/${agent.id}/activities`, {
        method: "POST",
        body: jsonBody({
          description: "Office visit",
          scheduled_for: "2026-09-22",
        }),
      }),
      { params: Promise.resolve({ id: agent.id as string }) },
    );
    expect(res.status).toBe(201);
    expect((await res.json()).activity.activity_note).toBeNull();
  });

  it("stores an empty note as null rather than an empty string", async () => {
    const agent = seedAgent();
    const res = await createActivity(
      req(AE_ID, `/api/gold-list/agents/${agent.id}/activities`, {
        method: "POST",
        body: jsonBody({
          description: "Lunch",
          activity_note: "   ",
          scheduled_for: "2026-09-22",
        }),
      }),
      { params: Promise.resolve({ id: agent.id as string }) },
    );
    expect(res.status).toBe(201);
    expect((await res.json()).activity.activity_note).toBeNull();
  });

  it("edits the note on an open activity, and can clear it", async () => {
    const agent = seedAgent();
    const activity = seedActivity({
      agent_id: agent.id,
      activity_note: "Original plan",
    });
    const params = {
      params: Promise.resolve({
        id: agent.id as string,
        aid: activity.id as string,
      }),
    };

    const edited = await patchActivity(
      req(
        AE_ID,
        `/api/gold-list/agents/${agent.id}/activities/${activity.id}`,
        {
          method: "PATCH",
          body: jsonBody({
            description: "Phone call",
            activity_note: "Ask about the Tuesday listing",
            scheduled_for: "2026-09-24",
          }),
        },
      ),
      params,
    );
    expect(edited.status).toBe(200);
    const body = await edited.json();
    expect(body.activity.activity_note).toBe("Ask about the Tuesday listing");
    expect(body.activity.scheduled_for).toBe("2026-09-24");

    const cleared = await patchActivity(
      req(
        AE_ID,
        `/api/gold-list/agents/${agent.id}/activities/${activity.id}`,
        { method: "PATCH", body: jsonBody({ activity_note: null }) },
      ),
      params,
    );
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).activity.activity_note).toBeNull();
  });

  it("rejects a note longer than the column allows", async () => {
    const agent = seedAgent();
    const res = await createActivity(
      req(AE_ID, `/api/gold-list/agents/${agent.id}/activities`, {
        method: "POST",
        body: jsonBody({
          description: "Phone call",
          activity_note: "x".repeat(2001),
          scheduled_for: "2026-09-22",
        }),
      }),
      { params: Promise.resolve({ id: agent.id as string }) },
    );
    expect(res.status).toBe(400);
    expect(state.activities).toHaveLength(0);
  });

  it("preserves the scheduled note through completion, alongside a separate outcome note", async () => {
    const agent = seedAgent();
    const activity = seedActivity({
      agent_id: agent.id,
      description: "Phone call",
      activity_note: "Get him on the phone about his upcoming listing",
      scheduled_for: "2026-09-22",
    });

    const completed = await patchActivity(
      req(
        AE_ID,
        `/api/gold-list/agents/${agent.id}/activities/${activity.id}`,
        {
          method: "PATCH",
          body: jsonBody({
            status: "completed",
            outcome_note: "Spoke with him; listing goes live next Friday",
          }),
        },
      ),
      {
        params: Promise.resolve({
          id: agent.id as string,
          aid: activity.id as string,
        }),
      },
    );
    expect(completed.status).toBe(200);
    const saved = (await completed.json()).activity;

    // Both notes survive, in their own fields. Neither overwrote the other.
    expect(saved.activity_note).toBe(
      "Get him on the phone about his upcoming listing",
    );
    expect(saved.outcome_note).toBe(
      "Spoke with him; listing goes live next Friday",
    );
    expect(saved.description).toBe("Phone call");
    expect(saved.status).toBe("completed");
    expect(saved.completed_at).not.toBeNull();
  });

  it("refuses to rewrite the note on a completed activity", async () => {
    const agent = seedAgent();
    const activity = seedActivity({
      agent_id: agent.id,
      status: "completed",
      completed_at: "2026-09-22T18:00:00.000Z",
      activity_note: "The original plan",
      outcome_note: "The original outcome",
    });

    const res = await patchActivity(
      req(
        AE_ID,
        `/api/gold-list/agents/${agent.id}/activities/${activity.id}`,
        {
          method: "PATCH",
          body: jsonBody({
            activity_note: "Rewriting history",
            outcome_note: "Rewriting history",
          }),
        },
      ),
      {
        params: Promise.resolve({
          id: agent.id as string,
          aid: activity.id as string,
        }),
      },
    );
    expect(res.status).toBe(409);
    // Untouched in the database. (The API refuses first; the
    // protect_gold_list_activity_history trigger refuses again underneath.)
    expect(state.activities[0].activity_note).toBe("The original plan");
    expect(state.activities[0].outcome_note).toBe("The original outcome");
  });

  it("schedules the NEXT activity with its own note after a completion", async () => {
    const agent = seedAgent();
    const first = seedActivity({
      agent_id: agent.id,
      activity_note: "First plan",
    });
    await patchActivity(
      req(AE_ID, `/api/gold-list/agents/${agent.id}/activities/${first.id}`, {
        method: "PATCH",
        body: jsonBody({ status: "completed", outcome_note: "Went well" }),
      }),
      {
        params: Promise.resolve({
          id: agent.id as string,
          aid: first.id as string,
        }),
      },
    );

    const next = await createActivity(
      req(AE_ID, `/api/gold-list/agents/${agent.id}/activities`, {
        method: "POST",
        body: jsonBody({
          description: "Follow-up text",
          activity_note: "Check whether the listing went live",
          scheduled_for: "2026-10-02",
        }),
      }),
      { params: Promise.resolve({ id: agent.id as string }) },
    );
    expect(next.status).toBe(201);
    expect((await next.json()).activity.activity_note).toBe(
      "Check whether the listing went live",
    );
    // Two rows: the completed one still carries its own plan note.
    expect(state.activities).toHaveLength(2);
    expect(state.activities[0].activity_note).toBe("First plan");
  });

  it("returns both notes separately in the agent's history", async () => {
    const agent = seedAgent();
    seedActivity({
      agent_id: agent.id,
      description: "Phone call",
      activity_note: "Discuss the upcoming listing",
      status: "completed",
      completed_at: "2026-09-22T18:00:00.000Z",
      outcome_note: "Listing goes live Friday",
    });

    const res = await listActivities(
      req(AE_ID, `/api/gold-list/agents/${agent.id}/activities`),
      { params: Promise.resolve({ id: agent.id as string }) },
    );
    expect(res.status).toBe(200);
    const [entry] = (await res.json()).activities;
    expect(entry).toMatchObject({
      description: "Phone call",
      activity_note: "Discuss the upcoming listing",
      outcome_note: "Listing goes live Friday",
      scheduled_for: "2026-09-20",
      completed_at: "2026-09-22T18:00:00.000Z",
    });
  });

  it("carries the open activity's note into the board summary", async () => {
    const agent = seedAgent();
    seedActivity({
      agent_id: agent.id,
      description: "Office visit",
      activity_note: "Drop off the Q4 packet",
    });

    const res = await listAgents(req(AE_ID, "/api/gold-list/agents"));
    const body = await res.json();
    expect(body.agents[0].next_activity).toMatchObject({
      description: "Office visit",
      activity_note: "Drop off the Q4 packet",
    });
  });

  it("still refuses a note written by a non-owner", async () => {
    const agent = seedAgent({ salesperson_id: OTHER_AE_ID });
    const activity = seedActivity({
      agent_id: agent.id,
      salesperson_id: OTHER_AE_ID,
      activity_note: "Kennedy's plan",
    });
    const res = await patchActivity(
      req(
        ADMIN_ID,
        `/api/gold-list/agents/${agent.id}/activities/${activity.id}`,
        { method: "PATCH", body: jsonBody({ activity_note: "Admin edit" }) },
      ),
      {
        params: Promise.resolve({
          id: agent.id as string,
          aid: activity.id as string,
        }),
      },
    );
    expect(res.status).toBe(404);
    expect(state.activities[0].activity_note).toBe("Kennedy's plan");
  });
});

describe("search and scheduled-note isolation", () => {
  it("combines client search/filter/sort with authorized complete API results beyond 1000 rows", async () => {
    const { visibleAgents } = await import("@/lib/gold-list");
    for (let i = 0; i < 1010; i++) seedAgent({ agent_name: `Person ${i}` });
    const target = state.agents[1009];
    Object.assign(target, {
      agent_name: "Needle",
      email: "needle@example.com",
    });
    seedActivity({
      agent_id: target.id,
      scheduled_for: "2026-09-18",
      activity_note: "Private plan",
    });
    seedAgent({ agent_name: "Needle other AE", salesperson_id: OTHER_AE_ID });
    for (const viewer of [AE_ID, ADMIN_ID]) {
      const response = await listAgents(
        req(
          viewer,
          `/api/gold-list/agents?ae_id=${AE_ID}&search=Needle&salesperson_id=${OTHER_AE_ID}`,
        ),
      );
      const data = await response.json();
      const matches = visibleAgents(data.agents, {
        query: "NEEDLE@EXAMPLE.COM",
        status: "today",
        sort: "agent_name",
        todayIso: "2026-09-18",
      });
      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({
        id: target.id,
        salesperson_id: AE_ID,
      });
      expect(data.agents.every((a: Row) => a.salesperson_id === AE_ID)).toBe(
        true,
      );
      expect(data.active_count).toBe(1010);
    }
    expect(
      (
        await listAgents(
          req(
            AE_ID,
            `/api/gold-list/agents?ae_id=${OTHER_AE_ID}&search=Needle`,
          ),
        )
      ).status,
    ).toBe(403);
  });

  it("ignores note-payload ownership/parent tampering and normalizes blank updates", async () => {
    const agent = seedAgent({ notes: "General note" });
    const other = seedAgent({ salesperson_id: OTHER_AE_ID });
    const activity = seedActivity({ activity_note: "Scheduled plan" });
    const response = await patchActivity(
      req(AE_ID, "/api/gold-list/agents/x/activities/y", {
        method: "PATCH",
        body: jsonBody({
          activity_note: "   ",
          salesperson_id: OTHER_AE_ID,
          agent_id: other.id,
        }),
      }),
      {
        params: Promise.resolve({
          id: String(agent.id),
          aid: String(activity.id),
        }),
      },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).activity).toMatchObject({
      salesperson_id: AE_ID,
      agent_id: agent.id,
      activity_note: null,
    });
    expect(agent.notes).toBe("General note");
  });
});
