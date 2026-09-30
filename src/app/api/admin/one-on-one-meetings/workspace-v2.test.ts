/**
 * 1:1 workspace v2 — Gold List management inside a 1:1, the notes rework
 * (1:1 Notes + Private Manager Notes) and the AE follow-up email — against a
 * REAL Postgres (PGlite running the project's migrations) with real auth.
 *
 * The AI provider is the ONLY fake: the OpenAI HTTPS call (global `fetch` to
 * api.openai.com) is stubbed so the tests can assert on the exact request body
 * the app would send, and so failures can be staged. Nothing is ever sent by email — the app has no such capability.
 *
 * The app clock is pinned to Tue 2026-09-29 12:00 America/Denver.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDb, type TestDb } from "@/test/pglite-supabase";

process.env.SESSION_SECRET = "test-session-secret";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.OPENAI_API_KEY = "test-openai-key";
delete process.env.ANTHROPIC_API_KEY; // the follow-up email must not need it

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ getServerSupabase: () => holder.client }));

// The only fake: OpenAI. `create` receives the parsed JSON body of every
// POST to the chat-completions endpoint (and its headers); it returns the
// response JSON, or rejects (with `.status` => that HTTP status, else a
// network failure).
const ai = vi.hoisted(() => ({ create: vi.fn() }));
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const realFetch = globalThis.fetch;
function installFakeOpenAI() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== OPENAI_URL) throw new Error(`unexpected fetch in test: ${String(input)}`);
    try {
      const out = await ai.create(JSON.parse(String(init?.body)), { headers: init?.headers });
      return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status) return new Response(`upstream said: ${(err as Error).message}`, { status });
      throw err;
    }
  });
}

const { signSessionToken } = await import("@/lib/server/auth");
const { computeStandings } = await import("@/lib/server/leaderboard-standings");
const { loadFollowupContext, SHAREABLE_MEETING_COLUMNS, assertShareable } = await import(
  "@/lib/server/followup-context"
);
const { buildFollowupRequest, parseFollowupReply, FOLLOWUP_DEFAULT_MODEL } = await import(
  "@/lib/ai/followup-email"
);
const { formatEmailForCopy } = await import("@/lib/one-on-one-meetings");
const { FOLLOWUP_COMPLETED_WHILE_WRITING_MESSAGE } = await import("@/lib/server/one-on-one-meetings");

const workspaceRoute = await import("@/app/api/admin/coaching/[ae_id]/meetings/route");
const historyRoute = await import("@/app/api/admin/coaching/[ae_id]/meetings/history/route");
const goalsRoute = await import("@/app/api/admin/coaching/[ae_id]/goals/route");
const meetingRoute = await import("./[id]/route");
const completeRoute = await import("./[id]/complete/route");
const commitmentsRoute = await import("./[id]/commitments/route");
const followupRoute = await import("./[id]/followup/route");
const goldListRoute = await import("./[id]/gold-list/route");
const agentRoute = await import("./[id]/gold-list/[agentId]/route");
const legacyOldRoute = await import("@/app/api/admin/one-on-ones/[id]/commitments/[cid]/route");
const activitiesRoute = await import("./[id]/gold-list/[agentId]/activities/route");
const aeAgentsRoute = await import("@/app/api/gold-list/agents/route");
const aeAgentRoute = await import("@/app/api/gold-list/agents/[id]/route");

type Row = Record<string, unknown>;

const AE = "11111111-1111-4111-8111-111111111111"; // Hilary
const OTHER_AE = "22222222-2222-4222-8222-222222222222"; // Kennedy
const ADMIN = "55555555-5555-4555-8555-555555555555"; // Corey
const RYAN = "66666666-6666-4666-8666-666666666666"; // another admin
const TEST_AE = "99999999-9999-4999-8999-999999999999"; // Corey's private test AE
const SARAH = "aaaaaaaa-0000-4000-8000-000000000001"; // Hilary's agent
const NOT_HERS = "aaaaaaaa-0000-4000-8000-000000000002"; // Kennedy's agent

const PRIVATE = "PRIV-MARKER-7f3a9c the AE is on thin ice, do NOT tell them";
const PRIVATE_SNIPPET = "PRIV-MARKER-7f3a9c";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  holder.client = db.client;
}, 60_000);

const roleOf: Record<string, string> = {
  [AE]: "ae", [OTHER_AE]: "ae", [ADMIN]: "admin", [RYAN]: "admin", [TEST_AE]: "ae",
};
const nameOf: Record<string, string> = {
  [AE]: "Hilary", [OTHER_AE]: "Kennedy", [ADMIN]: "Corey", [RYAN]: "Ryan", [TEST_AE]: "Test AE",
};

async function seed() {
  await db.reset();
  await db.sql(
    `INSERT INTO salespeople (id, first_name, role, is_test) VALUES
       ($1,'Hilary','ae',false), ($2,'Kennedy','ae',false), ($3,'Corey','admin',false),
       ($4,'Ryan','admin',false), ($5,'Test AE','ae',true)`,
    [AE, OTHER_AE, ADMIN, RYAN, TEST_AE],
  );
  await db.sql(`UPDATE salespeople SET test_owner_id = $1 WHERE id = $2`, [ADMIN, TEST_AE]);
  await db.sql(
    `INSERT INTO weekly_goals (salesperson_id, effective_from, office_visits, impressions, presentations, created_at)
     VALUES (NULL, '2026-01-05', 40, 150, 1, '2026-01-01')`,
  );
  await db.sql(
    `INSERT INTO activity_entries (salesperson_id, entry_date, office_visits, impressions, presentations) VALUES
       ($1, '2026-09-22', 20, 80, 1), ($1, '2026-09-28', 5, 45, 1), ($2, '2026-09-28', 9, 60, 1)`,
    [AE, OTHER_AE],
  );
  await db.sql(
    `INSERT INTO gold_list_agents (id, salesperson_id, agent_name, brokerage, phone, email, notes) VALUES
       ($1, $2, 'Sarah Johnson', 'Compass', '801-555-0111', 'sarah@example.com', 'CRM-only note about Sarah'),
       ($3, $4, 'Not Hilary''s', NULL, NULL, NULL, NULL)`,
    [SARAH, AE, NOT_HERS, OTHER_AE],
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

const GOALS = {
  office_visits: 30, service_requests: 0, ones_scheduled: 0, ones_held: 0,
  presentations: 2, impressions: 120, team_meetings: 0, gold_list_touches: 0,
};

const api = {
  workspace: (who: string | null = ADMIN, ae = AE) => workspaceRoute.GET(req(who, "/x"), p({ ae_id: ae })),
  start: (who: string | null = ADMIN, ae = AE) =>
    workspaceRoute.POST(req(who, "/x", { method: "POST" }), p({ ae_id: ae })),
  history: (who: string | null = ADMIN) => historyRoute.GET(req(who, "/x"), p({ ae_id: AE })),
  record: (id: string, who: string | null = ADMIN) => meetingRoute.GET(req(who, "/x"), p({ id })),
  saveField: (id: string, field: string, value: string | null, expected: number, who: string | null = ADMIN) =>
    meetingRoute.PATCH(
      req(who, "/x", { method: "PATCH", body: { field, value, expected_revision: expected } }),
      p({ id }),
    ),
  /** Saves on top of the CURRENT revision (a well-behaved tab). */
  set: async (id: string, field: string, value: string | null, who: string | null = ADMIN) => {
    const [row] = await db.sql(`SELECT ${field}_rev AS rev FROM one_on_one_meetings WHERE id = $1`, [id]);
    return api.saveField(id, field, value, Number(row.rev), who);
  },
  complete: (id: string, who: string | null = ADMIN) =>
    completeRoute.POST(req(who, "/x", { method: "POST" }), p({ id })),
  addCommitment: (id: string, body: unknown, who: string | null = ADMIN) =>
    commitmentsRoute.POST(req(who, "/x", { method: "POST", body }), p({ id })),
  addAgent: (id: string, body: unknown, who: string | null = ADMIN) =>
    goldListRoute.POST(req(who, "/x", { method: "POST", body }), p({ id })),
  editAgent: (id: string, agentId: string, body: unknown, who: string | null = ADMIN) =>
    agentRoute.PATCH(req(who, "/x", { method: "PATCH", body }), p({ id, agentId })),
  note: async (id: string, agentId: string, note: string | null) => {
    const [row] = await db
      .sql(`SELECT revision FROM one_on_one_gold_list_notes WHERE meeting_id = $1 AND agent_id = $2`, [id, agentId])
      .catch(() => []);
    return agentRoute.PUT(
      req(ADMIN, "/x", { method: "PUT", body: { note, expected_revision: Number(row?.revision ?? 0) } }),
      p({ id, agentId }),
    );
  },
  schedule: (id: string, agentId: string, body: unknown) =>
    activitiesRoute.POST(req(ADMIN, "/x", { method: "POST", body }), p({ id, agentId })),
  goals: (body: unknown, who: string | null = ADMIN, ae = AE) =>
    goalsRoute.PUT(req(who, "/x", { method: "PUT", body }), p({ ae_id: ae })),
  followupStatus: (id: string, who: string | null = ADMIN) =>
    followupRoute.GET(req(who, "/x"), p({ id })),
  /** Generate on top of the email's CURRENT revisions unless overridden. */
  generate: async (id: string, over: { subject?: number; body?: number } = {}, who: string | null = ADMIN) => {
    const [row] = await db.sql(
      `SELECT followup_subject_rev AS s, followup_body_rev AS b FROM one_on_one_meetings WHERE id = $1`,
      [id],
    );
    return followupRoute.POST(
      req(who, "/x", {
        method: "POST",
        body: {
          expected_subject_revision: over.subject ?? Number(row.s),
          expected_body_revision: over.body ?? Number(row.b),
        },
      }),
      p({ id }),
    );
  },
  aeAgents: (who: string | null = AE) => aeAgentsRoute.GET(req(who, "/api/gold-list/agents")),
  aeRenameAgent: (agentId: string, name: string) =>
    aeAgentRoute.PATCH(req(AE, "/x", { method: "PATCH", body: { agent_name: name } }), p({ id: agentId })),
  aeAddAgent: (body: unknown) =>
    aeAgentsRoute.POST(req(AE, "/api/gold-list/agents", { method: "POST", body })),
};

async function startMeeting(ae = AE): Promise<string> {
  return (await json<{ meeting: Row }>(api.start(ADMIN, ae))).meeting.id as string;
}
async function meetingRow(id: string) {
  return (await db.sql(`SELECT * FROM one_on_one_meetings WHERE id = $1`, [id]))[0];
}
const agentRow = async (id: string) =>
  (await db.sql(`SELECT * FROM gold_list_agents WHERE id = $1`, [id]))[0];

const REPLY = {
  subject: "Great 1:1 today, Hilary!",
  body: "Hi Hilary,\n\nLoved our conversation today — great job closing Compass.\n\n- Corey",
};
/** An OpenAI chat-completions response whose message content is `text`. */
const aiText = (text: string) => ({
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }],
});
const aiReply = (r: { subject: string; body: string } = REPLY) => aiText(JSON.stringify(r));

/** The exact JSON body POSTed to OpenAI on its Nth call (as `system` + user `messages`). */
const aiWire = (n = 0) => ai.create.mock.calls[n][0] as {
  model: string; response_format: unknown; max_completion_tokens: number;
  messages: Array<{ role: string; content: string }>;
};
const aiRequest = (n = 0) => {
  const w = aiWire(n);
  return { ...w, system: w.messages[0].content, messages: w.messages.slice(1) };
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-29T18:00:00.000Z"));
  ai.create.mockReset();
  ai.create.mockResolvedValue(aiReply());
  process.env.OPENAI_API_KEY = "test-openai-key";
  delete process.env.ANTHROPIC_API_KEY;
  installFakeOpenAI();
  await seed();
});
afterEach(() => {
  vi.useRealTimers();
  vi.stubGlobal("fetch", realFetch);
});

// ===========================================================================
// 1) Gold List management inside an active 1:1
// ===========================================================================

describe("Gold List: add an agent from the 1:1", () => {
  it("adds to the AE's REAL Gold List, owned by the AE and attributed to the manager and the meeting", async () => {
    const id = await startMeeting();
    const res = await api.addAgent(id, {
      agent_name: "Dana Whitaker",
      brokerage: "Coldwell",
      phone: "801-555-0100",
      email: "dana@example.com",
      notes: "Met at the open house",
      // Anything about ownership in the body is ignored: the owner is the 1:1's AE.
      salesperson_id: OTHER_AE,
    });
    expect(res.status).toBe(201);
    const { agent } = await json<{ agent: Row }>(res);
    expect(agent).toMatchObject({ agent_name: "Dana Whitaker", salesperson_id: AE, can_edit: true });

    expect(await agentRow(agent.id as string)).toMatchObject({
      salesperson_id: AE,
      created_by: ADMIN,
      created_in_meeting_id: id,
      edited_in_meeting_id: null,
    });

    // It is on the AE's own live Gold List — and the AE payload doesn't leak the meeting.
    const aeView = await json<{ agents: Row[] }>(api.aeAgents(AE));
    const mine = aeView.agents.find((a) => a.id === agent.id)!;
    expect(mine).toMatchObject({ agent_name: "Dana Whitaker", can_edit: true, owner_name: "Hilary" });
    expect(JSON.stringify(aeView)).not.toContain(id);

    // And in the manager's workspace, flagged as added during this 1:1.
    const ws = await json<{
      gold_list: Row[]; gold_list_added_agent_ids: string[]; gold_list_action_agent_ids: string[];
    }>(api.workspace());
    expect(ws.gold_list.some((a) => a.id === agent.id)).toBe(true);
    expect(ws.gold_list_added_agent_ids).toEqual([agent.id]);
    expect(ws.gold_list_action_agent_ids).toContain(agent.id);
  });

  it("is idempotent on request_id, and warns about a likely duplicate before adding", async () => {
    const id = await startMeeting();
    const rid = "cccccccc-0000-4000-8000-0000000000c1";
    const first = await api.addAgent(id, { agent_name: "Dana Whitaker", request_id: rid });
    const replay = await api.addAgent(id, { agent_name: "Dana Whitaker", request_id: rid });
    expect([first.status, replay.status]).toEqual([201, 200]);
    expect(await db.sql(`SELECT count(*)::int AS n FROM gold_list_agents WHERE agent_name = 'Dana Whitaker'`)).toEqual([{ n: 1 }]);

    const dup = await json<{ duplicates?: Row[]; agent?: Row }>(api.addAgent(id, { agent_name: "Sarah Johnson" }));
    expect(dup.agent).toBeUndefined();
    expect(dup.duplicates?.map((d) => d.id)).toEqual([SARAH]);
    expect((await api.addAgent(id, { agent_name: "Sarah Johnson", confirm_duplicate: true })).status).toBe(201);
  });

  it("only an admin, only in an in-progress 1:1", async () => {
    const id = await startMeeting();
    expect((await api.addAgent(id, { agent_name: "X" }, AE)).status).toBe(403);
    expect((await api.addAgent(id, { agent_name: "X" }, null)).status).toBe(401);
    await api.complete(id);
    expect((await api.addAgent(id, { agent_name: "After" })).status).toBe(409);
    expect(await db.sql(`SELECT 1 FROM gold_list_agents WHERE agent_name IN ('X', 'After')`)).toEqual([]);
  });

  it("the AE's own add during an open draft is NOT attributed to the 1:1", async () => {
    const id = await startMeeting();
    const res = await api.aeAddAgent({ agent_name: "Own Add" });
    const { agent } = await json<{ agent: Row }>(res);
    expect(await agentRow(agent.id as string)).toMatchObject({ created_by: null, created_in_meeting_id: null });
    const ws = await json<{ gold_list_added_agent_ids: string[] }>(api.workspace());
    expect(ws.gold_list_added_agent_ids).toEqual([]);
    void id;
  });
});

describe("Gold List: edit an agent from the 1:1", () => {
  it("updates the live agent, stamps the meeting, and the AE sees the change", async () => {
    const id = await startMeeting();
    const res = await api.editAgent(id, SARAH, { brokerage: "Berkshire Hathaway", phone: "801-555-0999" });
    expect(res.status).toBe(200);
    expect(await agentRow(SARAH)).toMatchObject({
      brokerage: "Berkshire Hathaway",
      phone: "801-555-0999",
      agent_name: "Sarah Johnson", // omitted fields untouched
      edited_by: ADMIN,
      edited_in_meeting_id: id,
      created_in_meeting_id: null,
    });
    const ae = await json<{ agents: Row[] }>(api.aeAgents(AE));
    expect(ae.agents.find((a) => a.id === SARAH)).toMatchObject({ brokerage: "Berkshire Hathaway" });
    const ws = await json<{ gold_list_edited_agent_ids: string[] }>(api.workspace());
    expect(ws.gold_list_edited_agent_ids).toEqual([SARAH]);
  });

  it("can't archive from a 1:1, can't touch another AE's agent, needs at least one field", async () => {
    const id = await startMeeting();
    expect((await api.editAgent(id, SARAH, { archived: true })).status).toBe(400);
    expect((await agentRow(SARAH)).archived_at).toBeNull();
    expect((await api.editAgent(id, NOT_HERS, { agent_name: "Hijack" })).status).toBe(404);
    expect((await agentRow(NOT_HERS)).agent_name).toBe("Not Hilary's");
    expect((await api.editAgent(id, SARAH, { agent_name: "" })).status).toBe(400);
    expect((await api.editAgent(id, SARAH, { brokerage: "X" }, AE)).status).toBe(403);
  });

  it("activities still work from the 1:1 (schedule) and are attributed", async () => {
    const id = await startMeeting();
    const res = await api.schedule(id, SARAH, { description: "Lunch", scheduled_for: "2026-10-02" });
    expect(res.status).toBe(201);
    expect(await db.sql(`SELECT created_in_meeting_id FROM gold_list_activities WHERE agent_id = $1`, [SARAH])).toEqual([
      { created_in_meeting_id: id },
    ]);
  });
});

describe("Gold List: the completed record keeps what happened", () => {
  it("snapshots 'added' / 'edited' / actions, and later live changes don't rewrite it", async () => {
    const id = await startMeeting();
    const { agent } = await json<{ agent: Row }>(api.addAgent(id, { agent_name: "New Agent", brokerage: "Coldwell" }));
    await api.schedule(id, agent.id as string, { description: "Intro visit", scheduled_for: "2026-10-02" });
    await api.editAgent(id, SARAH, { brokerage: "Berkshire" });
    expect((await api.complete(id)).status).toBe(200);

    const record = await json<{ gold_list_notes: Row[] }>(api.record(id));
    const byName = (n: string) => record.gold_list_notes.find((x) => x.agent_name === n)!;
    expect(byName("New Agent")).toMatchObject({
      agent_added: true, agent_edited: false, action_taken: true, next_activity_on: "2026-10-02",
      activity_changes: [{ kind: "scheduled", description: "Intro visit", date: "2026-10-02" }],
    });
    expect(byName("Sarah Johnson")).toMatchObject({
      agent_added: false, agent_edited: true, action_taken: true, brokerage: "Berkshire",
    });

    // The live list keeps changing after completion…
    await api.aeRenameAgent(agent.id as string, "Renamed Later");
    await db.sql(`UPDATE gold_list_agents SET brokerage = 'Changed' WHERE id = $1`, [SARAH]);
    // …the record doesn't.
    const again = await json<{ gold_list_notes: Row[] }>(api.record(id));
    expect(again.gold_list_notes.find((x) => x.agent_added === true)).toMatchObject({ agent_name: "New Agent" });
    expect(again.gold_list_notes.find((x) => x.agent_edited === true)).toMatchObject({ brokerage: "Berkshire" });

    // A LATER 1:1 doesn't claim the earlier meeting's additions.
    const m2 = await startMeeting();
    const ws = await json<{ gold_list_added_agent_ids: string[]; gold_list_edited_agent_ids: string[] }>(api.workspace());
    expect(ws.gold_list_added_agent_ids).toEqual([]);
    expect(ws.gold_list_edited_agent_ids).toEqual([]);
    await api.complete(m2);
    expect((await json<{ gold_list_notes: Row[] }>(api.record(m2))).gold_list_notes).toEqual([]);
  });
});

describe("Gold List: writes can't race the frozen snapshot", () => {
  it("an agent add that arrives as completion runs is refused, and nothing is created", async () => {
    const id = await startMeeting();
    db.beforeWrite("gold_list_agents", "insert", async () => {
      expect((await api.complete(id)).status).toBe(200);
    });
    const res = await api.addAgent(id, { agent_name: "Late Agent" });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: "This 1:1 is completed and read-only." });
    expect(await db.sql(`SELECT 1 FROM gold_list_agents WHERE agent_name = 'Late Agent'`)).toEqual([]);
  });

  it("an agent edit that arrives as completion runs is refused, and the agent is unchanged", async () => {
    const id = await startMeeting();
    db.beforeWrite("gold_list_agents", "update", async () => {
      await api.complete(id);
    });
    expect((await api.editAgent(id, SARAH, { brokerage: "Too late" })).status).toBe(409);
    expect(await agentRow(SARAH)).toMatchObject({ brokerage: "Compass", edited_in_meeting_id: null });
  });

  it("the database itself refuses attribution to a completed meeting — even a repeat edit stamp", async () => {
    const id = await startMeeting();
    expect((await api.editAgent(id, SARAH, { brokerage: "First" })).status).toBe(200);
    await api.complete(id);
    // Same edited_in_meeting_id as before, fresh edited_at (a later time — the test
    // clock is frozen, so NOW() alone would equal the route's stamp): the trigger
    // re-checks the lock.
    await expect(
      db.sql(
        `UPDATE gold_list_agents SET brokerage = 'Sneaky', edited_in_meeting_id = $1, edited_at = NOW() + interval '1 minute' WHERE id = $2`,
        [id, SARAH],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // Nor can a new agent be born inside a completed meeting.
    await expect(
      db.sql(
        `INSERT INTO gold_list_agents (salesperson_id, agent_name, created_in_meeting_id) VALUES ($1, 'Ghost', $2)`,
        [AE, id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await agentRow(SARAH)).toMatchObject({ brokerage: "First" });
  });
});

// ===========================================================================
// 2) Test AE privacy still holds for every new route
// ===========================================================================

describe("Test AE privacy", () => {
  it("another admin can't reach any new route for the owner's private test AE 1:1", async () => {
    const id = await startMeeting(TEST_AE);
    await db.sql(
      `INSERT INTO gold_list_agents (id, salesperson_id, agent_name) VALUES ('aaaaaaaa-0000-4000-8000-0000000000a9', $1, 'Sandbox Agent')`,
      [TEST_AE],
    );
    const sandbox = "aaaaaaaa-0000-4000-8000-0000000000a9";

    // The owner can do all of it…
    expect((await api.addAgent(id, { agent_name: "Owner Added" })).status).toBe(201);
    expect((await api.editAgent(id, sandbox, { brokerage: "Sandbox Realty" })).status).toBe(200);
    expect((await api.set(id, "private_notes", "owner only")).status).toBe(200);
    expect((await api.generate(id)).status).toBe(200);

    // …another admin gets a 404 on every one of them, as if it doesn't exist.
    expect((await api.addAgent(id, { agent_name: "Intruder" }, RYAN)).status).toBe(404);
    expect((await api.editAgent(id, sandbox, { brokerage: "Hacked" }, RYAN)).status).toBe(404);
    expect((await api.saveField(id, "private_notes", "x", 1, RYAN)).status).toBe(404);
    expect((await api.saveField(id, "followup_body", "x", 1, RYAN)).status).toBe(404);
    expect((await api.generate(id, {}, RYAN)).status).toBe(404);
    expect((await api.followupStatus(id, RYAN)).status).toBe(404);
    expect((await api.record(id, RYAN)).status).toBe(404);
    expect((await api.workspace(RYAN, TEST_AE)).status).toBe(404);
    expect((await api.goals({ start: "next_week", values: GOALS, meeting_id: id }, RYAN, TEST_AE)).status).toBe(404);
    expect(await db.sql(`SELECT 1 FROM gold_list_agents WHERE agent_name = 'Intruder'`)).toEqual([]);
    expect((await agentRow(sandbox)).brokerage).toBe("Sandbox Realty");
    // Only Corey's own generation reached the AI.
    expect(ai.create).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 3) Notes: 1:1 Notes + Private Manager Notes
// ===========================================================================

describe("1:1 Notes and Private Manager Notes autosave", () => {
  it("each saves on its own revision; a stale save gets 409 with the newer text and nothing is overwritten", async () => {
    const id = await startMeeting();
    expect(await json(api.saveField(id, "coaching_notes", "Notes v1", 0))).toMatchObject({ revision: 1 });
    expect(await json(api.saveField(id, "private_notes", "Private v1", 0))).toMatchObject({ revision: 1 });

    const staleNotes = await api.saveField(id, "coaching_notes", "from an old tab", 0);
    expect(staleNotes.status).toBe(409);
    expect(await staleNotes.json()).toMatchObject({ conflict: { value: "Notes v1", revision: 1 } });
    const stalePrivate = await api.saveField(id, "private_notes", "from an old tab", 0);
    expect(stalePrivate.status).toBe(409);
    expect(await stalePrivate.json()).toMatchObject({ conflict: { value: "Private v1", revision: 1 } });

    // Saving one never conflicts with the other.
    expect((await api.saveField(id, "coaching_notes", "Notes v2", 1)).status).toBe(200);
    expect(await meetingRow(id)).toMatchObject({
      coaching_notes: "Notes v2", coaching_notes_rev: 2, private_notes: "Private v1", private_notes_rev: 1,
    });
  });

  it("enforces the length limits", async () => {
    const id = await startMeeting();
    expect((await api.saveField(id, "private_notes", "x".repeat(5001), 0)).status).toBe(400);
    expect((await api.saveField(id, "followup_subject", "x".repeat(301), 0)).status).toBe(400);
    expect((await api.saveField(id, "followup_body", "x".repeat(10001), 0)).status).toBe(400);
  });

  it("completion freezes both notes and the email; a late save is refused and the DB agrees", async () => {
    const id = await startMeeting();
    await api.set(id, "coaching_notes", "Final notes");
    await api.set(id, "private_notes", "Final private");
    await api.set(id, "followup_subject", "Final subject");
    await api.set(id, "followup_body", "Final body");
    expect((await api.complete(id)).status).toBe(200);

    for (const field of ["coaching_notes", "private_notes", "followup_subject", "followup_body"]) {
      const res = await api.saveField(id, field, "too late", 1);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "This 1:1 is completed and read-only." });
    }
    await expect(
      db.sql(`UPDATE one_on_one_meetings SET private_notes = 'tampered' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await meetingRow(id)).toMatchObject({
      coaching_notes: "Final notes", private_notes: "Final private",
      followup_subject: "Final subject", followup_body: "Final body",
    });
  });

  it("a field autosave that arrives as completion runs is refused (notes, private notes and email)", async () => {
    for (const field of ["coaching_notes", "private_notes", "followup_body"]) {
      await seed();
      const id = await startMeeting();
      db.beforeWrite("one_on_one_meetings", "update", async () => {
        await api.complete(id);
      });
      expect((await api.saveField(id, field, "raced", 0)).status).toBe(409);
      expect((await meetingRow(id))[field]).toBeNull();
    }
  });
});

describe("'From last 1:1' and history use shareable notes only", () => {
  it("the previous-meeting summary carries the normal notes and date, never the private notes", async () => {
    const m1 = await startMeeting();
    await api.set(m1, "coaching_notes", "Worked on renewals.\nSecond line.");
    await api.set(m1, "coaching_focus", "Legacy focus");
    await api.set(m1, "private_notes", PRIVATE);
    await api.complete(m1);

    const m2 = await startMeeting();
    await api.set(m2, "private_notes", "second meeting private");
    const ws = await json<Row & { last_completed: { meeting: Row } }>(api.workspace());
    expect(ws.last_completed.meeting).toEqual({
      id: m1,
      meeting_date: "2026-09-29",
      completed_at: expect.any(String),
      coaching_focus: "Legacy focus",
      coaching_notes: "Worked on renewals.\nSecond line.",
    });
    // The whole workspace payload: the PREVIOUS meeting's private notes are nowhere in it…
    const blob = JSON.stringify(ws);
    expect(blob).not.toContain(PRIVATE_SNIPPET);
    // …while the in-progress meeting's own private notes are (they are the editor's content).
    expect((ws.meeting as unknown as Row).private_notes).toBe("second meeting private");

    const hist = await json<{ items: Row[] }>(api.history());
    expect(hist.items[0]).toMatchObject({ id: m1, notes_preview: "Worked on renewals." });
    expect(JSON.stringify(hist)).not.toContain(PRIVATE_SNIPPET);
  });

  it("the authorized admin can still open the historical record with its private notes; nobody else can", async () => {
    const m1 = await startMeeting();
    await api.set(m1, "private_notes", PRIVATE);
    await api.complete(m1);
    expect((await json<{ meeting: Row }>(api.record(m1))).meeting.private_notes).toBe(PRIVATE);
    // An AE (or anonymous caller) can't read any 1:1 route.
    for (const who of [AE, OTHER_AE, null]) {
      const res = await api.record(m1, who);
      expect([401, 403]).toContain(res.status);
      expect(await res.text()).not.toContain(PRIVATE_SNIPPET);
    }
    // The AE-facing Gold List endpoints never carry any of it.
    expect(JSON.stringify(await json(api.aeAgents(AE)))).not.toContain(PRIVATE_SNIPPET);
  });

  it("every new 1:1 route rejects an AE and an anonymous caller", async () => {
    const id = await startMeeting();
    for (const who of [AE, null]) {
      const expected = who ? 403 : 401;
      expect((await api.addAgent(id, { agent_name: "X" }, who)).status).toBe(expected);
      expect((await api.editAgent(id, SARAH, { brokerage: "X" }, who)).status).toBe(expected);
      expect((await api.followupStatus(id, who)).status).toBe(expected);
      expect((await api.generate(id, {}, who)).status).toBe(expected);
      expect((await api.saveField(id, "private_notes", "x", 0, who)).status).toBe(expected);
    }
    expect(ai.create).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 4) AI follow-up email
// ===========================================================================

async function richMeeting() {
  const id = await startMeeting();
  await api.set(id, "wins", "Closed the Compass account");
  await api.set(id, "activity_notes", "Visits are up week over week");
  await api.set(id, "coaching_notes", "Talked through objection handling on renewals");
  await api.set(id, "private_notes", PRIVATE);
  await api.addCommitment(id, { description: "Send Sarah the renewal deck", owner: "ae", due_date: "2026-10-03" });
  await api.note(id, SARAH, "Sarah wants a lunch meeting");
  await api.schedule(id, SARAH, { description: "Lunch at Tradesman", scheduled_for: "2026-10-02" });
  await api.addAgent(id, {
    agent_name: "Dana Whitaker", brokerage: "Coldwell",
    phone: "801-555-0100", email: "dana-secret@example.com", notes: "CRM-ONLY-NOTE-XYZ",
  });
  await api.editAgent(id, SARAH, { brokerage: "Compass Realty" });
  await api.goals({ start: "next_week", values: GOALS, meeting_id: id });
  return id;
}

describe("AE follow-up email: what the AI receives", () => {
  it("is built from shareable meeting content — and the private notes are provably absent", async () => {
    const id = await richMeeting();
    const res = await api.generate(id);
    expect(res.status).toBe(200);
    expect(ai.create).toHaveBeenCalledTimes(1);

    const request = aiRequest();
    // EVERYTHING handed to the SDK — system prompt, messages, every option.
    const wire = JSON.stringify(request);
    expect(wire).not.toContain(PRIVATE_SNIPPET);
    expect(wire).not.toContain("thin ice");
    expect(wire.toLowerCase()).not.toContain("private_notes");
    expect(wire).not.toMatch(/private manager/i);

    // Shareable content IS there.
    const content = request.messages[0].content;
    for (const expected of [
      "Closed the Compass account",
      "Visits are up week over week",
      "Talked through objection handling on renewals",
      "Send Sarah the renewal deck",
      "Sarah wants a lunch meeting",
      "Lunch at Tradesman",
      "Dana Whitaker",
      "Hilary",
      "Corey",
      "Office visits",
    ]) {
      expect(content, expected).toContain(expected);
    }
    // The agents' CRM details are not.
    expect(wire).not.toContain("801-555-0100");
    expect(wire).not.toContain("dana-secret@example.com");
    expect(wire).not.toContain("CRM-ONLY-NOTE-XYZ");
    expect(wire).not.toContain("CRM-only note about Sarah");
    expect(wire).not.toContain("801-555-0111");
    // A goal change made during the 1:1 is included.
    expect(content).toContain('"office_visits": 30');
    expect(request.messages).toHaveLength(1);
    expect(request.model).toBe(FOLLOWUP_DEFAULT_MODEL);
  });

  it("the context loader reads the meeting through an explicit column list only", async () => {
    const id = await richMeeting();
    const seen: Array<{ table: string; columns: string }> = [];
    const recording = {
      ...db.client,
      rpc: db.client.rpc,
      from: (table: string) => {
        const q = db.client.from(table);
        const select = q.select.bind(q);
        q.select = (cols?: string) => {
          seen.push({ table, columns: cols ?? "*" });
          return select(cols);
        };
        return q;
      },
    };
    const { context } = await loadFollowupContext(recording as never, id);

    const meetingReads = seen.filter((s) => s.table === "one_on_one_meetings");
    expect(meetingReads).toEqual([{ table: "one_on_one_meetings", columns: SHAREABLE_MEETING_COLUMNS }]);
    expect(SHAREABLE_MEETING_COLUMNS).not.toMatch(/private|followup/);
    // No agent contact fields are even selected.
    const agentReads = seen.filter((s) => s.table === "gold_list_agents").map((s) => s.columns);
    for (const cols of agentReads) expect(cols).not.toMatch(/phone|email|notes|\*/);
    expect(JSON.stringify(context)).not.toContain(PRIVATE_SNIPPET);
    expect(() => assertShareable(context)).not.toThrow();
  });

  it("the tripwire refuses a payload that grows a private-looking key", () => {
    expect(() => assertShareable({ wins: "x", nested: [{ private_notes: "leak" }] })).toThrow(/forbidden key/);
    expect(() => assertShareable({ manager_privateNotes: "leak" })).toThrow(/forbidden key/);
    expect(() => assertShareable({ wins: "x", gold_list: [{ agent: "A" }] })).not.toThrow();
  });

  it("the request builder is pure: same context, same request; model is overridable", () => {
    const ctx = { hello: "world" } as never;
    expect(buildFollowupRequest(ctx)).toEqual(buildFollowupRequest(ctx));
    process.env.OPENAI_FOLLOWUP_EMAIL_MODEL = "some-other-model";
    expect(buildFollowupRequest(ctx).model).toBe("some-other-model");
    delete process.env.OPENAI_FOLLOWUP_EMAIL_MODEL;
    expect(buildFollowupRequest(ctx).model).toBe("gpt-4o-mini");
  });
});

describe("AE follow-up email: persistence, edits, staleness", () => {
  it("saves the generated subject and body with the meeting; the response is copy-ready", async () => {
    const id = await startMeeting();
    await api.set(id, "wins", "Big week");
    const res = await api.generate(id);
    expect(await res.json()).toMatchObject({
      subject: REPLY.subject, body: REPLY.body, subject_revision: 1, body_revision: 1,
    });
    expect(await meetingRow(id)).toMatchObject({
      followup_subject: REPLY.subject,
      followup_body: REPLY.body,
      followup_subject_rev: 1,
      followup_body_rev: 1,
      followup_model: FOLLOWUP_DEFAULT_MODEL,
    });
    expect((await meetingRow(id)).followup_generated_at).not.toBeNull();
    expect((await meetingRow(id)).followup_context_hash).toMatch(/^[0-9a-f]{64}$/);
    // What the "Copy Email" button puts on the clipboard.
    expect(formatEmailForCopy(REPLY.subject, REPLY.body)).toBe(
      `Subject: ${REPLY.subject}\n\n${REPLY.body}`,
    );
    expect(formatEmailForCopy("", "  just the body ")).toBe("just the body");
  });

  it("a manual edit survives everything that isn't an explicit Regenerate", async () => {
    const id = await startMeeting();
    await api.generate(id);
    expect((await api.saveField(id, "followup_body", "Corey's own words.", 1)).status).toBe(200);
    expect((await api.saveField(id, "followup_subject", "My subject", 1)).status).toBe(200);

    // Meeting content changes, the workspace reloads, staleness is polled…
    await api.set(id, "coaching_notes", "New notes after the email");
    await api.addCommitment(id, { description: "Something new" });
    await api.workspace();
    await api.followupStatus(id);
    await api.workspace();

    expect(ai.create).toHaveBeenCalledTimes(1); // nothing regenerated on its own
    expect(await meetingRow(id)).toMatchObject({
      followup_subject: "My subject", followup_body: "Corey's own words.",
    });
  });

  it("flags the email as stale when shareable meeting content changes — but not for private notes", async () => {
    const id = await startMeeting();
    await api.set(id, "wins", "Wins v1");
    await api.generate(id);
    const stale = async () => (await json<{ stale: boolean }>(api.followupStatus(id))).stale;
    const wsStale = async () => (await json<{ followup_stale: boolean }>(api.workspace())).followup_stale;

    expect(await stale()).toBe(false);
    expect(await wsStale()).toBe(false);

    // Private notes are not part of the email, so they can't make it stale.
    await api.set(id, "private_notes", "some private thought");
    expect(await stale()).toBe(false);

    for (const change of [
      () => api.set(id, "wins", "Wins v2"),
      () => api.set(id, "coaching_notes", "New notes"),
      () => api.addCommitment(id, { description: "A new commitment" }),
      () => api.note(id, SARAH, "Discussed Sarah"),
      () => api.addAgent(id, { agent_name: "Brand New" }),
      () => api.goals({ start: "next_week", values: GOALS, meeting_id: id }),
    ]) {
      await api.generate(id); // fresh baseline (explicit regenerate)
      expect(await stale()).toBe(false);
      expect((await change()).status).toBeLessThan(300);
      expect(await stale()).toBe(true);
      expect(await wsStale()).toBe(true);
    }
  });

  it("regenerates only on an explicit request, replacing the draft and clearing the flag", async () => {
    const id = await startMeeting();
    await api.generate(id);
    await api.saveField(id, "followup_body", "edited", 1);
    await api.set(id, "wins", "new wins");
    expect((await json<{ stale: boolean }>(api.followupStatus(id))).stale).toBe(true);
    expect(ai.create).toHaveBeenCalledTimes(1);

    ai.create.mockResolvedValueOnce(aiReply({ subject: "Fresh subject", body: "Fresh body" }));
    const res = await api.generate(id); // the click
    expect(await res.json()).toMatchObject({ subject: "Fresh subject", body: "Fresh body", body_revision: 3 });
    expect(ai.create).toHaveBeenCalledTimes(2);
    expect((await json<{ stale: boolean }>(api.followupStatus(id))).stale).toBe(false);
  });

  it("a regeneration built on stale revisions can't overwrite an edit from another tab", async () => {
    const id = await startMeeting();
    await api.generate(id); // revisions 1 / 1
    await api.saveField(id, "followup_body", "typed in tab B", 1); // body rev 2

    const res = await api.generate(id, { subject: 1, body: 1 }); // tab A is behind
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      followup_conflict: {
        subject: { value: REPLY.subject, revision: 1 },
        body: { value: "typed in tab B", revision: 2 },
      },
    });
    expect(ai.create).toHaveBeenCalledTimes(1); // refused BEFORE spending a generation
    expect((await meetingRow(id)).followup_body).toBe("typed in tab B");
  });
});

describe("AE follow-up email: the save itself is compare-and-set", () => {
  it("an edit from another tab that lands while the AI is thinking is not overwritten", async () => {
    const id = await startMeeting();
    await api.generate(id); // revisions 1 / 1
    ai.create.mockImplementationOnce(async () => {
      // Tab B edits the body after the route's early revision check passed…
      expect((await api.saveField(id, "followup_body", "typed in tab B", 1)).status).toBe(200);
      return aiReply({ subject: "Fresh", body: "Fresh body" });
    });
    const res = await api.generate(id);
    // …so the atomic save refuses, reports both current values, and keeps tab B's text.
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      followup_conflict: { body: { value: "typed in tab B", revision: 2 } },
    });
    expect(await meetingRow(id)).toMatchObject({
      followup_body: "typed in tab B", followup_subject: REPLY.subject,
    });
  });
});

describe("AE follow-up email: AI failure never damages or blocks the meeting", () => {
  it("a provider error is a retryable 502 with a safe message; the meeting is untouched and still completes", async () => {
    const id = await startMeeting();
    await api.set(id, "wins", "Wins survive");
    await api.set(id, "private_notes", "still here");
    const before = await meetingRow(id);
    ai.create.mockRejectedValueOnce(Object.assign(new Error("upstream said: secret-key sk-123 overloaded"), { status: 529 }));

    const res = await api.generate(id);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ retryable: true });
    expect(JSON.stringify(body)).not.toMatch(/sk-123|upstream said/);

    const after = await meetingRow(id);
    for (const k of ["wins", "private_notes", "followup_subject", "followup_body", "followup_subject_rev", "followup_body_rev", "followup_context_hash"]) {
      expect(after[k], k).toEqual(before[k]);
    }
    // Retry works…
    expect((await api.generate(id)).status).toBe(200);
    // …and even without it the 1:1 completes.
    const other = await startMeeting(OTHER_AE);
    ai.create.mockRejectedValue(new Error("down"));
    expect((await api.generate(other)).status).toBe(502);
    expect((await api.complete(other)).status).toBe(200);
  });

  it("an unusable reply is treated as a failure (nothing saved)", async () => {
    const id = await startMeeting();
    for (const text of ["not json at all", JSON.stringify({ subject: "only subject" }), JSON.stringify({ subject: "", body: "x" })]) {
      ai.create.mockResolvedValueOnce(aiText(text));
      expect((await api.generate(id)).status).toBe(502);
    }
    expect((await meetingRow(id)).followup_body).toBeNull();
    expect(parseFollowupReply('```json\n{"subject":"S","body":"B\\r\\nC"}\n```')).toEqual({ subject: "S", body: "B\nC" });
    expect(parseFollowupReply(JSON.stringify({ subject: "S", body: "x".repeat(10001) }))).toBeNull();
  });

  it("a server without the AI key says so (503, not retryable) and the meeting is fine", async () => {
    const id = await startMeeting();
    delete process.env.OPENAI_API_KEY;
    const res = await api.generate(id);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ retryable: false });
    expect(ai.create).not.toHaveBeenCalled();
    expect((await api.complete(id)).status).toBe(200);
  });
});

describe("AE follow-up email: completion", () => {
  it("the FINAL edited email is what history shows; the autosave PATCH stays in-progress-only and everything else is frozen", async () => {
    const id = await startMeeting();
    await api.generate(id);
    await api.saveField(id, "followup_subject", "Edited subject", 1);
    await api.saveField(id, "followup_body", "Edited body — final.", 1);
    expect((await api.complete(id)).status).toBe(200);

    const record = await json<{ meeting: Row }>(api.record(id));
    expect(record.meeting).toMatchObject({
      status: "completed", followup_subject: "Edited subject", followup_body: "Edited body — final.",
    });
    // The draft-autosave route is for the IN-PROGRESS draft only; editing a
    // completed 1:1's email goes through the dedicated /followup route
    // (see "follow-up email after completion" below).
    expect((await api.saveField(id, "followup_body", "again", 2)).status).toBe(409);
    // …and the rest of the record is frozen by the database, whoever asks.
    await expect(
      db.sql(`UPDATE one_on_one_meetings SET wins = 'tampered' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("a generation built from LIVE data that finishes after the meeting completed is refused and saves nothing", async () => {
    const id = await startMeeting();
    ai.create.mockImplementationOnce(async () => {
      expect((await api.complete(id)).status).toBe(200); // completes while the AI is "thinking"
      return aiReply();
    });
    const res = await api.generate(id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: FOLLOWUP_COMPLETED_WHILE_WRITING_MESSAGE });
    expect(await meetingRow(id)).toMatchObject({ status: "completed", followup_subject: null, followup_body: null });
    // Generating again now builds from the FROZEN record and lands.
    expect((await api.generate(id)).status).toBe(200);
  });

  it("a generation racing the write itself (completion between check and save) cannot land either", async () => {
    const id = await startMeeting();
    db.beforeWrite("one_on_one_meetings", "update", async () => {
      await api.complete(id);
    });
    expect((await api.generate(id)).status).toBe(409);
    expect((await meetingRow(id)).followup_body).toBeNull();
  });
});

// ===========================================================================
// 5) Goal changes recorded on the meeting
// ===========================================================================

describe("goal changes made from a 1:1", () => {
  it("are recorded on the meeting and shown in its completed record", async () => {
    const id = await startMeeting();
    const res = await api.goals({ start: "next_week", values: GOALS, meeting_id: id });
    expect(await res.json()).toMatchObject({ recorded_in_meeting: true });
    await api.goals({ start: "this_week", values: { ...GOALS, office_visits: 35 }, meeting_id: id });
    await api.complete(id);
    const record = await json<{ meeting: { goal_changes: Row[] } }>(api.record(id));
    expect(record.meeting.goal_changes).toHaveLength(2);
    expect(record.meeting.goal_changes[0]).toMatchObject({ start: "next_week", values: { office_visits: 30 } });
    expect(record.meeting.goal_changes[1]).toMatchObject({ start: "this_week", values: { office_visits: 35 } });
  });

  it("without a meeting the route is unchanged; with a wrong/completed meeting nothing is written", async () => {
    const before = async () => Number((await db.sql(`SELECT count(*)::int AS n FROM weekly_goals`))[0].n);
    const start = await before();
    const plain = await json(api.goals({ start: "next_week", values: GOALS }));
    expect(plain).toMatchObject({ recorded_in_meeting: false });
    expect(await before()).toBe(start + 1);

    const other = await startMeeting(OTHER_AE);
    expect((await api.goals({ start: "this_week", values: GOALS, meeting_id: other })).status).toBe(404); // another AE's 1:1
    const mine = await startMeeting();
    await api.complete(mine);
    expect((await api.goals({ start: "this_week", values: GOALS, meeting_id: mine })).status).toBe(409);
    expect(await before()).toBe(start + 1);
  });
});

// ===========================================================================
// 5b) Goal changes are ATOMIC with the meeting and SERIALIZED with completion
//
// Regression for the race where the live goal committed but the completed 1:1
// omitted it (goal write, then a separate history write that completion could
// slip between), and for completion computing its activity snapshot before it
// held the meeting lock.
//
// LIMITATION — PGlite is a single connection, so two transactions cannot block
// each other here: a "completion wins" race is staged by injecting the
// competing statement between the route's check and its write (beforeWrite).
// Actual lock waiting / NOWAIT failure / deadlock freedom is proven against a
// real multi-connection Postgres in supabase/one-on-one-goal-concurrency.realpg.test.ts.
// ===========================================================================

const THIS_MONDAY = "2026-09-28"; // pinned clock: Tue 2026-09-29, Denver
const NEXT_MONDAY = "2026-10-05";
const liveGoals = (ae = AE) =>
  db.sql(`SELECT effective_from::text AS effective_from, office_visits, presentations, impressions
            FROM weekly_goals WHERE salesperson_id = $1 ORDER BY effective_from, created_at`, [ae]);
const goalsWith = (office_visits: number, extra: Record<string, number> = {}) => ({
  ...GOALS, office_visits, ...extra,
});
type Snapshot = {
  this_week: { cells: Record<string, { original_goal: number; goal: number }> };
  last_week: { cells: Record<string, { original_goal: number; goal: number }> };
};
const snapshotOf = async (id: string) =>
  (await meetingRow(id)).activity_snapshot as Snapshot;
const historyOf = async (id: string) =>
  (await meetingRow(id)).goal_changes as Array<{ start: string; effective_from: string; values: Record<string, number> }>;
/** Counts rpc() calls by function name, passing everything through. */
function spyRpc() {
  const calls: string[] = [];
  const real = db.client;
  holder.client = {
    from: real.from.bind(real),
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.push(fn);
      return real.rpc(fn, args);
    },
  };
  return { calls, restore: () => { holder.client = real; } };
}

describe("goal change vs completion: atomicity and ordering", () => {
  // --- A. Goal change wins ------------------------------------------------
  it("A. goal change first: live goal + history commit together, then completion freezes a consistent record", async () => {
    const id = await startMeeting();
    const res = await api.goals({ start: "this_week", values: goalsWith(35), meeting_id: id });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ recorded_in_meeting: true });
    // Both halves are visible right after the one call.
    expect(await liveGoals()).toMatchObject([{ effective_from: THIS_MONDAY, office_visits: 35 }]);
    expect(await historyOf(id)).toMatchObject([
      { start: "this_week", effective_from: THIS_MONDAY, values: { office_visits: 35, presentations: 2, impressions: 120 } },
    ]);

    expect((await api.complete(id)).status).toBe(200);
    const snap = await snapshotOf(id);
    expect(snap.this_week.cells.office_visits.original_goal).toBe(35);
    expect(snap.this_week.cells.impressions.original_goal).toBe(120);
    expect(snap.last_week.cells.office_visits.original_goal).toBe(40); // last week keeps its own goal
    expect(await historyOf(id)).toHaveLength(1);
  });

  it("A2. a repeat save at the same Monday updates that row in place (still one row, two history entries)", async () => {
    const id = await startMeeting();
    await api.goals({ start: "this_week", values: goalsWith(35), meeting_id: id });
    await api.goals({ start: "this_week", values: goalsWith(36), meeting_id: id });
    await api.goals({ start: "next_week", values: goalsWith(50), meeting_id: id });
    expect(await liveGoals()).toMatchObject([
      { effective_from: THIS_MONDAY, office_visits: 36 },
      { effective_from: NEXT_MONDAY, office_visits: 50 },
    ]);
    expect((await historyOf(id)).map((h) => [h.start, h.values.office_visits])).toEqual([
      ["this_week", 35], ["this_week", 36], ["next_week", 50],
    ]);
  });

  // --- B. Completion wins -------------------------------------------------
  it("B. completion commits between the route's check and the goal write: rejected, live goal unchanged, record doesn't claim it", async () => {
    const id = await startMeeting();
    await api.goals({ start: "this_week", values: goalsWith(33), meeting_id: id }); // earlier, accepted change
    db.beforeWrite("update_weekly_goal_in_one_on_one", "rpc", async () => {
      expect((await api.complete(id)).status).toBe(200);
    });
    const res = await api.goals({ start: "this_week", values: goalsWith(99), meeting_id: id });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "This 1:1 is completed and read-only." });
    // Live goal is still the earlier accepted one; the rejected 99 is nowhere.
    expect(await liveGoals()).toMatchObject([{ effective_from: THIS_MONDAY, office_visits: 33 }]);
    expect((await historyOf(id)).map((h) => h.values.office_visits)).toEqual([33]);
    expect((await snapshotOf(id)).this_week.cells.office_visits.original_goal).toBe(33);
    expect(JSON.stringify((await meetingRow(id)).goal_changes)).not.toContain('"office_visits":99');
  });

  it("B2. with no earlier change: a rejected goal inserts nothing at all", async () => {
    const id = await startMeeting();
    db.beforeWrite("update_weekly_goal_in_one_on_one", "rpc", async () => {
      await api.complete(id);
    });
    expect((await api.goals({ start: "next_week", values: goalsWith(99), meeting_id: id })).status).toBe(409);
    expect(await liveGoals()).toEqual([]);
    expect(await historyOf(id)).toEqual([]);
  });

  it("B3. a goal change arriving after completion is refused at the route and at the database", async () => {
    const id = await startMeeting();
    await api.complete(id);
    expect((await api.goals({ start: "this_week", values: goalsWith(99), meeting_id: id })).status).toBe(409);
    // Straight at the RPC (no route pre-check): the database refuses too.
    const direct = await db.client.rpc("update_weekly_goal_in_one_on_one", {
      p_meeting_id: id, p_ae_id: AE, p_start: "this_week", p_effective_from: THIS_MONDAY,
      p_values: GOALS, p_created_by: ADMIN,
    });
    expect(direct.error?.code).toBe("23514");
    expect(await liveGoals()).toEqual([]);
    expect(await historyOf(id)).toEqual([]);
  });

  it("B4. completion holding the meeting lock (55P03 from NOWAIT) is a clean 409 — never a 200 with recorded_in_meeting:false", async () => {
    // Mapping check only: PGlite can't hold a competing lock (see header);
    // the real 55P03 is exercised against real Postgres.
    const id = await startMeeting();
    const real = db.client;
    holder.client = {
      from: real.from.bind(real),
      rpc: (fn: string, args: Record<string, unknown>) =>
        fn === "update_weekly_goal_in_one_on_one"
          ? Promise.resolve({ data: null, error: { code: "55P03", message: "could not obtain lock on row" } })
          : real.rpc(fn, args),
    };
    try {
      const res = await api.goals({ start: "this_week", values: goalsWith(99), meeting_id: id });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toMatchObject({ error: "This 1:1 is being completed right now." });
      expect(body).not.toHaveProperty("recorded_in_meeting");
    } finally {
      holder.client = real;
    }
    expect(await liveGoals()).toEqual([]);
  });

  it("B5. wrong-AE and unknown meetings are refused by the database too (nothing written)", async () => {
    const other = await startMeeting(OTHER_AE);
    const wrongAe = await db.client.rpc("update_weekly_goal_in_one_on_one", {
      p_meeting_id: other, p_ae_id: AE, p_start: "this_week", p_effective_from: THIS_MONDAY,
      p_values: GOALS, p_created_by: ADMIN,
    });
    expect(wrongAe.error?.code).toBe("23514");
    const unknown = await db.client.rpc("update_weekly_goal_in_one_on_one", {
      p_meeting_id: "deadbeef-dead-4bee-8fed-deadbeefdead", p_ae_id: AE, p_start: "this_week",
      p_effective_from: THIS_MONDAY, p_values: GOALS, p_created_by: ADMIN,
    });
    expect(unknown.error?.code).toBe("23503");
    expect(await liveGoals()).toEqual([]);
    expect(await liveGoals(OTHER_AE)).toEqual([]);
  });

  it("B6. the function validates its own inputs (a malformed call writes nothing)", async () => {
    const id = await startMeeting();
    const call = (over: Record<string, unknown>) =>
      db.client.rpc("update_weekly_goal_in_one_on_one", {
        p_meeting_id: id, p_ae_id: AE, p_start: "this_week", p_effective_from: THIS_MONDAY,
        p_values: GOALS, p_created_by: ADMIN, ...over,
      });
    expect((await call({ p_start: "whenever" })).error?.code).toBe("22023");
    expect((await call({ p_values: { ...GOALS, office_visits: -1 } })).error?.code).toBe("22023");
    expect((await call({ p_values: { ...GOALS, office_visits: 1.5 } })).error?.code).toBe("22023");
    expect((await call({ p_values: { ...GOALS, office_visits: "9" } })).error?.code).toBe("22023");
    const { impressions: _omit, ...missing } = GOALS;
    void _omit;
    expect((await call({ p_values: missing })).error?.code).toBe("22023");
    expect(await liveGoals()).toEqual([]);
    expect(await historyOf(id)).toEqual([]);
  });

  // --- C. Atomic failure --------------------------------------------------
  describe("C. atomic failure: a failing history write rolls the live goal back", () => {
    const FAIL_TRIGGER = `
      CREATE OR REPLACE FUNCTION test_fail_goal_history() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.goal_changes IS DISTINCT FROM OLD.goal_changes THEN
          RAISE EXCEPTION 'forced goal-history failure' USING ERRCODE = 'XX001';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_fail_goal_history BEFORE UPDATE ON one_on_one_meetings
        FOR EACH ROW EXECUTE FUNCTION test_fail_goal_history();`;
    const arm = () => db.asOwner(FAIL_TRIGGER);
    const disarm = () =>
      db.asOwner(`DROP TRIGGER IF EXISTS test_fail_goal_history ON one_on_one_meetings;
                  DROP FUNCTION IF EXISTS test_fail_goal_history();`);
    afterEach(disarm);

    it("a NEW goal row is not left behind", async () => {
      const id = await startMeeting();
      await arm();
      const res = await api.goals({ start: "this_week", values: goalsWith(35), meeting_id: id });
      expect(res.status).toBe(500);
      expect(await liveGoals()).toEqual([]);
      expect(await historyOf(id)).toEqual([]);
    });

    it("an EXISTING goal row keeps its previous values", async () => {
      const id = await startMeeting();
      await api.goals({ start: "this_week", values: goalsWith(35, { impressions: 111 }), meeting_id: id });
      await arm();
      const res = await api.goals({ start: "this_week", values: goalsWith(77, { impressions: 222 }), meeting_id: id });
      expect(res.status).toBe(500);
      expect(await liveGoals()).toMatchObject([{ office_visits: 35, impressions: 111 }]);
      expect(await historyOf(id)).toHaveLength(1);
    });

    it("the route never reports success (no 200, no recorded flag)", async () => {
      const id = await startMeeting();
      await arm();
      const res = await api.goals({ start: "next_week", values: goalsWith(35), meeting_id: id });
      expect(res.ok).toBe(false);
      expect(await res.json()).not.toHaveProperty("recorded_in_meeting");
    });
  });

  // --- D. Snapshot consistency -------------------------------------------
  it("D. a goal change that lands after completion read the meeting is folded in: snapshot and history use the SAME goal", async () => {
    const id = await startMeeting();
    const spy = spyRpc();
    try {
      // Fires right before completion's FIRST attempt reaches the database —
      // i.e. after the snapshot was computed with the old goal (40).
      db.beforeWrite("complete_one_on_one_meeting", "rpc", async () => {
        expect((await api.goals({ start: "this_week", values: goalsWith(35), meeting_id: id })).status).toBe(200);
      });
      const res = await api.complete(id);
      expect(res.status).toBe(200);
      // First attempt refused (40001) and recomputed; the second committed.
      expect(spy.calls.filter((c) => c === "complete_one_on_one_meeting")).toHaveLength(2);
    } finally {
      spy.restore();
    }
    const history = await historyOf(id);
    expect(history).toHaveLength(1);
    const snap = await snapshotOf(id);
    // The SAME goal version in both places: 35, not the stale 40.
    expect(history[0].values.office_visits).toBe(35);
    expect(snap.this_week.cells.office_visits.original_goal).toBe(35);
    expect((await meetingRow(id)).status).toBe("completed");
  });

  it("D2. invariant over several interleavings: the frozen goal always equals the last recorded goal", async () => {
    for (const changes of [[35], [35, 36], [36, 37, 38]]) {
      await seed();
      const id = await startMeeting();
      await api.goals({ start: "this_week", values: goalsWith(30), meeting_id: id });
      for (const v of changes) {
        db.beforeWrite("complete_one_on_one_meeting", "rpc", async () => {
          await api.goals({ start: "this_week", values: goalsWith(v), meeting_id: id });
        });
      }
      const res = await api.complete(id);
      if (changes.length <= 3) expect(res.status).toBe(200);
      const history = await historyOf(id);
      const snap = await snapshotOf(id);
      expect(history.at(-1)!.values.office_visits).toBe(changes.at(-1));
      expect(snap.this_week.cells.office_visits.original_goal).toBe(history.at(-1)!.values.office_visits);
      expect((await liveGoals())[0].office_visits).toBe(history.at(-1)!.values.office_visits);
    }
  });

  it("D3. goal changes that keep landing exhaust the retries with a 409 — the meeting stays a retryable draft", async () => {
    const id = await startMeeting();
    for (const v of [31, 32, 33, 34]) {
      db.beforeWrite("complete_one_on_one_meeting", "rpc", async () => {
        await api.goals({ start: "this_week", values: goalsWith(v), meeting_id: id });
      });
    }
    const res = await api.complete(id);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("Goals were changed") });
    const row = await meetingRow(id);
    expect(row.status).toBe("in_progress");
    expect(row.activity_snapshot).toBeNull();
    // Quiet now: completing again succeeds and is consistent.
    expect((await api.complete(id)).status).toBe(200);
    expect((await snapshotOf(id)).this_week.cells.office_visits.original_goal).toBe(34);
  });

  it("D4. a stale snapshot is refused by the DATABASE itself (40001) and changes nothing", async () => {
    const id = await startMeeting();
    await api.goals({ start: "this_week", values: goalsWith(35), meeting_id: id });
    const stale = await db.client.rpc("complete_one_on_one_meeting", {
      p_meeting_id: id, p_completed_by: ADMIN, p_activity_snapshot: { version: 1 }, p_goal_changes_seen: 0,
    });
    expect(stale.error?.code).toBe("40001");
    expect((await meetingRow(id)).status).toBe("in_progress");
    const fresh = await db.client.rpc("complete_one_on_one_meeting", {
      p_meeting_id: id, p_completed_by: ADMIN, p_activity_snapshot: { version: 1 }, p_goal_changes_seen: 1,
    });
    expect(fresh.error).toBeNull();
    // Idempotent on an already-completed meeting, whatever count it is handed.
    const again = await db.client.rpc("complete_one_on_one_meeting", {
      p_meeting_id: id, p_completed_by: ADMIN, p_activity_snapshot: { version: 1 }, p_goal_changes_seen: 0,
    });
    expect(again.error).toBeNull();
    expect(again.data).toMatchObject({ status: "completed" });
  });

  describe("D5. the retained 3-argument completion is a compatibility wrapper, NOT a way around the goal-change check", () => {
    const threeArg = (id: string) =>
      db.client.rpc("complete_one_on_one_meeting", {
        p_meeting_id: id, p_completed_by: ADMIN, p_activity_snapshot: { version: 1, stale: true },
      });

    it("A. zero V2 goal history: completes normally (backward compatible with the deployed app)", async () => {
      const id = await startMeeting();
      const res = await threeArg(id);
      expect(res.error).toBeNull();
      expect(res.data).toMatchObject({ status: "completed", completed_by: ADMIN });
    });

    it("B. existing V2 goal history: refused (40001), and NOTHING about the meeting changes", async () => {
      const id = await startMeeting();
      await api.set(id, "wins", "Big win");
      await api.goals({ start: "this_week", values: goalsWith(35), meeting_id: id });
      const before = await meetingRow(id);
      const notesBefore = await db.sql(`SELECT count(*)::int AS n FROM one_on_one_gold_list_notes WHERE meeting_id = $1`, [id]);
      const reviewsBefore = await db.sql(`SELECT count(*)::int AS n FROM one_on_one_commitment_reviews WHERE meeting_id = $1`, [id]);

      const res = await threeArg(id);
      expect(res.error?.code).toBe("40001");

      const after = await meetingRow(id);
      expect(after).toEqual(before); // byte-for-byte: status, snapshot, completed_*, every text field, history, updated_at
      expect(after).toMatchObject({ status: "in_progress", completed_at: null, completed_by: null, activity_snapshot: null });
      expect(await db.sql(`SELECT count(*)::int AS n FROM one_on_one_gold_list_notes WHERE meeting_id = $1`, [id])).toEqual(notesBefore);
      expect(await db.sql(`SELECT count(*)::int AS n FROM one_on_one_commitment_reviews WHERE meeting_id = $1`, [id])).toEqual(reviewsBefore);
      expect(await liveGoals()).toMatchObject([{ effective_from: THIS_MONDAY, office_visits: 35 }]);

      // The V2 application path then completes it correctly.
      expect((await api.complete(id)).status).toBe(200);
      expect((await snapshotOf(id)).this_week.cells.office_visits.original_goal).toBe(35);
    });

    it("the checked 4-argument function has no opt-out: NULL is rejected (22004) and changes nothing", async () => {
      const id = await startMeeting();
      const res = await db.client.rpc("complete_one_on_one_meeting", {
        p_meeting_id: id, p_completed_by: ADMIN, p_activity_snapshot: { version: 1 }, p_goal_changes_seen: null,
      });
      expect(res.error?.code).toBe("22004");
      expect((await meetingRow(id)).status).toBe("in_progress");
    });
  });

  // --- E. UI / API contract ----------------------------------------------
  it("E. during an active meeting every 2xx carries recorded_in_meeting:true; every non-2xx carries no goals at all", async () => {
    const id = await startMeeting();
    const ok = await api.goals({ start: "next_week", values: goalsWith(41), meeting_id: id });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ recorded_in_meeting: true });

    await api.complete(id);
    const refused = await api.goals({ start: "next_week", values: goalsWith(42), meeting_id: id });
    expect(refused.status).toBe(409);
    const body = await refused.json();
    expect(body).not.toHaveProperty("recorded_in_meeting");
    expect(body).not.toHaveProperty("weekly_goal_current");
  });

  // --- F. Existing behavior ----------------------------------------------
  it("F. goal editing outside a 1:1 is unchanged — even while a 1:1 is in progress (no meeting_id => not recorded, not blocked)", async () => {
    // No meeting at all.
    const plain = await api.goals({ start: "this_week", values: goalsWith(35) });
    expect(plain.status).toBe(200);
    expect(await plain.json()).toMatchObject({ recorded_in_meeting: false });
    expect(await liveGoals()).toMatchObject([{ office_visits: 35 }]);
    // Edit in place at the same Monday.
    expect((await api.goals({ start: "this_week", values: goalsWith(36) })).status).toBe(200);
    expect(await liveGoals()).toMatchObject([{ office_visits: 36 }]);

    // A 1:1 in progress that the change is NOT made from.
    const id = await startMeeting();
    const beside = await api.goals({ start: "next_week", values: goalsWith(45) });
    expect(beside.status).toBe(200);
    expect(await beside.json()).toMatchObject({ recorded_in_meeting: false });
    expect(await historyOf(id)).toEqual([]);
    // …and completion is not blocked or affected by it.
    expect((await api.complete(id)).status).toBe(200);
    // After completion, plain goal editing still works.
    expect((await api.goals({ start: "next_week", values: goalsWith(46) })).status).toBe(200);
    expect(await liveGoals()).toMatchObject([{ office_visits: 36 }, { effective_from: NEXT_MONDAY, office_visits: 46 }]);
  });

  it("F2. legacy Weekly Focus writes, Gold List, commitments and autosaves interleave with goal changes and completion", async () => {
    const WEEK = "cccccccc-0000-4000-8000-000000000001";
    const LEGACY = "dddddddd-0000-4000-8000-000000000001";
    await db.sql(
      `INSERT INTO one_on_ones (id, ae_id, week_start, meeting_date, notes_focus) VALUES ($1, $2, '2026-09-14', '2026-09-15', 'Old')`,
      [WEEK, AE],
    );
    await db.sql(
      `INSERT INTO one_on_one_commitments (id, one_on_one_id, ae_id, content, status) VALUES ($1, $2, $3, 'Legacy follow-up', 'open')`,
      [LEGACY, WEEK, AE],
    );
    const id = await startMeeting();
    expect((await api.set(id, "wins", "Closed a big one")).status).toBe(200);
    expect((await api.goals({ start: "this_week", values: goalsWith(35), meeting_id: id })).status).toBe(200);
    expect((await api.addCommitment(id, { description: "Send the listing deck" })).status).toBe(201);
    expect((await api.schedule(id, SARAH, { description: "Coffee", scheduled_for: "2026-10-01" })).status).toBe(201);
    // The ORIGINAL Weekly Focus route (old client), untouched contract.
    const old = await legacyOldRoute.PATCH(
      req(ADMIN, "/x", { method: "PATCH", body: { status: "completed" } }),
      p({ id: WEEK, cid: LEGACY }),
    );
    expect(old.status).toBe(200);
    expect((await api.goals({ start: "next_week", values: goalsWith(50), meeting_id: id })).status).toBe(200);
    expect((await api.complete(id)).status).toBe(200);

    const row = await meetingRow(id);
    expect(row).toMatchObject({ status: "completed", wins: "Closed a big one" });
    expect(await historyOf(id)).toHaveLength(2);
    expect((await snapshotOf(id)).this_week.cells.office_visits.original_goal).toBe(35);
    const reviews = await db.sql(`SELECT description, origin, status FROM one_on_one_commitment_reviews WHERE meeting_id = $1 ORDER BY sort_order`, [id]);
    expect(reviews).toEqual(expect.arrayContaining([
      expect.objectContaining({ description: "Send the listing deck", origin: "new" }),
      expect.objectContaining({ description: "Legacy follow-up", origin: "carryover", status: "completed" }),
    ]));
  });
});

// ===========================================================================
// 5c) V2.1 — OpenAI, and the follow-up email AFTER a 1:1 is completed
// ===========================================================================

const EMAIL_COLUMNS = [
  "followup_subject", "followup_subject_rev", "followup_body", "followup_body_rev",
  "followup_generated_at", "followup_context_hash", "followup_model", "updated_at",
];
/** The whole meeting row minus the email columns: everything that must stay frozen. */
const frozenPart = async (id: string) => {
  const row = { ...(await meetingRow(id)) };
  for (const c of EMAIL_COLUMNS) delete row[c];
  return row;
};
const putEmail = (
  id: string,
  body: { subject: string | null; body: string | null; expected_subject_revision: number; expected_body_revision: number },
  who: string | null = ADMIN,
) => followupRoute.PUT(req(who, "/x", { method: "PUT", body }), p({ id }));
/** Saves on top of the email's CURRENT revisions (a well-behaved tab). */
const putEmailNow = async (id: string, subject: string | null, body: string | null, who: string | null = ADMIN) => {
  const row = await meetingRow(id);
  return putEmail(id, {
    subject, body,
    expected_subject_revision: Number(row.followup_subject_rev),
    expected_body_revision: Number(row.followup_body_rev),
  }, who);
};
const completedRich = async () => {
  const id = await richMeeting();
  expect((await api.complete(id)).status).toBe(200);
  return id;
};

describe("follow-up email uses OpenAI", () => {
  it("POSTs to the OpenAI chat-completions endpoint with OPENAI_API_KEY, a JSON-mode body and subject/body back", async () => {
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined(); // not needed
    const id = await startMeeting();
    const res = await api.generate(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ subject: REPLY.subject, body: REPLY.body });

    expect(ai.create).toHaveBeenCalledTimes(1);
    const [body, meta] = ai.create.mock.calls[0] as [ReturnType<typeof aiWire>, { headers: Record<string, string> }];
    expect(meta.headers.Authorization).toBe("Bearer test-openai-key");
    expect(body).toMatchObject({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      max_completion_tokens: 1024,
    });
    expect(body.messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(body.messages[0].content).toMatch(/warm, conversational, upbeat and encouraging/i);
    expect(await meetingRow(id)).toMatchObject({ followup_model: "gpt-4o-mini" });
  });

  it("a missing OPENAI_API_KEY is the only configuration it needs (503, nothing saved, meeting intact)", async () => {
    const id = await startMeeting();
    delete process.env.OPENAI_API_KEY;
    process.env.ANTHROPIC_API_KEY = "set-but-irrelevant";
    try {
      const res = await api.generate(id);
      expect(res.status).toBe(503);
      expect(ai.create).not.toHaveBeenCalled(); // an Anthropic key does NOT make it work
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("an OpenAI HTTP error / network failure is a safe 502 with no provider text; a 401 is 'not set up'", async () => {
    const id = await startMeeting();
    ai.create.mockRejectedValueOnce(Object.assign(new Error("Incorrect API key sk-live-abc"), { status: 401 }));
    const unauth = await api.generate(id);
    expect(unauth.status).toBe(503);
    expect(JSON.stringify(await unauth.json())).not.toMatch(/sk-live|Incorrect/);
    ai.create.mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }));
    expect((await api.generate(id)).status).toBe(502);
    ai.create.mockRejectedValueOnce(new Error("socket hang up"));
    expect((await api.generate(id)).status).toBe(502);
    ai.create.mockResolvedValueOnce({ choices: [{ finish_reason: "length", message: { content: '{"subject":"a","body":"b"' } }] });
    expect((await api.generate(id)).status).toBe(502);
    ai.create.mockResolvedValueOnce({ choices: [] });
    expect((await api.generate(id)).status).toBe(502);
    expect((await meetingRow(id)).followup_body).toBeNull();
    expect((await api.complete(id)).status).toBe(200); // still completes, email optional
  });
});

describe("follow-up email after completion", () => {
  it("a completed meeting with NO email can generate one — and nothing else about it moves", async () => {
    const id = await completedRich();
    const frozen = await frozenPart(id);
    const before = await meetingRow(id);
    expect(before.followup_body).toBeNull();

    const res = await api.generate(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ subject: REPLY.subject, body: REPLY.body, subject_revision: 1, body_revision: 1 });

    const after = await meetingRow(id);
    expect(after).toMatchObject({
      status: "completed", followup_subject: REPLY.subject, followup_body: REPLY.body, followup_model: "gpt-4o-mini",
    });
    expect(after.followup_generated_at).not.toBeNull();
    // Completion stamps, snapshot, notes (incl. private), goals history… untouched.
    expect(await frozenPart(id)).toEqual(frozen);
    expect(after.completed_at).toEqual(before.completed_at);
    expect(after.activity_snapshot).toEqual(before.activity_snapshot);
    expect(after.private_notes).toBe(PRIVATE);
  });

  it("a completed meeting can be written by hand (no AI involved)", async () => {
    const id = await completedRich();
    const frozen = await frozenPart(id);
    const res = await putEmailNow(id, "Hand-written subject", "Hi Hilary,\n\nTyped by hand.\n\n- Corey");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      subject: "Hand-written subject", body: "Hi Hilary,\n\nTyped by hand.\n\n- Corey", subject_revision: 1, body_revision: 1,
    });
    expect(ai.create).not.toHaveBeenCalled();
    expect(await meetingRow(id)).toMatchObject({ followup_generated_at: null, followup_model: null });
    expect(await frozenPart(id)).toEqual(frozen);
  });

  it("edit, regenerate, display and copy: only the FINAL saved email is kept, and it persists", async () => {
    const id = await completedRich();
    await api.generate(id);
    expect((await putEmailNow(id, "Edit 1", "Body edit 1")).status).toBe(200);
    expect((await putEmailNow(id, "Edit 2", "Body edit 2 — final")).status).toBe(200);

    let record = await json<{ meeting: Row }>(api.record(id));
    expect(record.meeting).toMatchObject({
      followup_subject: "Edit 2", followup_body: "Body edit 2 — final",
      followup_subject_rev: 3, followup_body_rev: 3,
    });
    expect(formatEmailForCopy(String(record.meeting.followup_subject), String(record.meeting.followup_body))).toBe(
      "Subject: Edit 2\n\nBody edit 2 — final",
    );

    // Regenerate replaces it (an explicit action on the current revisions).
    ai.create.mockResolvedValueOnce(aiReply({ subject: "Fresh", body: "Fresh body" }));
    const regen = await api.generate(id);
    expect(regen.status).toBe(200);
    record = await json<{ meeting: Row }>(api.record(id));
    expect(record.meeting).toMatchObject({ followup_subject: "Fresh", followup_body: "Fresh body" });
    // No revision history is kept: the record holds the current text only.
    const cols = await db.sql(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'one_on_one_meetings' AND column_name ILIKE '%followup%'`,
    );
    expect(cols.map((c) => c.column_name).sort()).toEqual([
      "followup_body", "followup_body_rev", "followup_context_hash", "followup_generated_at",
      "followup_model", "followup_subject", "followup_subject_rev",
    ]);
    // Clearing both fields is allowed too (and reads as "no email").
    expect((await putEmailNow(id, "", "")).status).toBe(200);
    expect(await meetingRow(id)).toMatchObject({ followup_subject: null, followup_body: null });
  });

  it("the email of a meeting completed BEFORE this feature is editable (its saved text carries over)", async () => {
    const id = await startMeeting();
    await api.generate(id);
    await api.complete(id);
    expect((await putEmailNow(id, "Polished", "Polished body")).status).toBe(200);
    expect(await meetingRow(id)).toMatchObject({ followup_subject: "Polished", status: "completed" });
  });

  it("every OTHER field of a completed meeting stays immutable — at the database and at every route", async () => {
    const id = await completedRich();
    await api.generate(id);
    const frozen = await frozenPart(id);
    const emailBefore = { ...(await meetingRow(id)) };

    const tamper: Array<[string, string]> = [
      ["wins", `wins = 'x'`], ["activity_notes", `activity_notes = 'x'`], ["coaching_notes", `coaching_notes = 'x'`],
      ["coaching_focus", `coaching_focus = 'x'`], ["private_notes", `private_notes = 'x'`],
      ["activity_snapshot", `activity_snapshot = '{}'::jsonb`], ["goal_changes", `goal_changes = '[]'::jsonb`],
      ["status", `status = 'in_progress', completed_at = NULL, activity_snapshot = NULL`],
      ["completed_at", `completed_at = completed_at + interval '1 day'`], ["completed_by", `completed_by = NULL`],
      ["manager_name", `manager_name = 'x'`], ["ae_id", `ae_id = '${OTHER_AE}'`],
      ["wins_rev", `wins_rev = wins_rev + 1`], ["private_notes_rev", `private_notes_rev = 99`],
      // email + a frozen column in ONE statement: the whole statement is refused.
      ["email AND wins", `followup_body = 'sneaky', wins = 'x'`],
    ];
    for (const [name, set] of tamper) {
      const attempt = await db.sql(`UPDATE one_on_one_meetings SET ${set} WHERE id = $1 RETURNING id`, [id]).then(
        () => "ACCEPTED", (e: { code?: string }) => e.code);
      expect(`${name}: ${attempt}`).toBe(`${name}: 23514`);
    }
    await expect(db.sql(`DELETE FROM one_on_one_meetings WHERE id = $1`, [id])).rejects.toMatchObject({ code: "23514" });
    expect(await frozenPart(id)).toEqual(frozen);
    expect(await meetingRow(id)).toEqual(emailBefore);

    // Routes: the PATCH autosave, commitments, goals, Gold List — all still 409.
    for (const field of ["wins", "activity_notes", "coaching_notes", "coaching_focus", "private_notes"]) {
      expect((await api.saveField(id, field, "x", 0)).status, field).toBe(409);
    }
    expect((await api.addCommitment(id, { description: "late" })).status).toBe(409);
    expect((await api.goals({ start: "this_week", values: GOALS, meeting_id: id })).status).toBe(409);
    expect((await api.addAgent(id, { agent_name: "Late Agent" })).status).toBe(409);
    expect((await api.note(id, SARAH, "late note")).status).toBe(409);
    expect(await frozenPart(id)).toEqual(frozen);
    // The email columns alone ARE writable at the database (that is the whole change).
    await db.sql(`UPDATE one_on_one_meetings SET followup_body = 'db-level edit' WHERE id = $1`, [id]);
  });

  it("an email write never touches completion data, the snapshot, notes, commitments, goals or Gold List history", async () => {
    const id = await completedRich();
    const tables = async () => ({
      notes: await db.sql(`SELECT * FROM one_on_one_gold_list_notes WHERE meeting_id = $1 ORDER BY id`, [id]),
      reviews: await db.sql(`SELECT * FROM one_on_one_commitment_reviews WHERE meeting_id = $1 ORDER BY id`, [id]),
      commitments: await db.sql(`SELECT * FROM one_on_one_meeting_commitments ORDER BY id`),
      agents: await db.sql(`SELECT * FROM gold_list_agents ORDER BY id`),
      activities: await db.sql(`SELECT * FROM gold_list_activities ORDER BY id`),
      goals: await db.sql(`SELECT * FROM weekly_goals ORDER BY id`),
    });
    const before = await tables();
    const frozen = await frozenPart(id);
    await api.generate(id);
    await putEmailNow(id, "Subject", "Body");
    await api.generate(id);
    expect(await tables()).toEqual(before);
    expect(await frozenPart(id)).toEqual(frozen);
  });

  it("cross-tab: a save based on a stale view is rejected with the newer text, nothing is overwritten", async () => {
    const id = await completedRich();
    await api.generate(id); // revs 1/1
    // Tab A and Tab B both open at revs 1/1.
    const stale = { expected_subject_revision: 1, expected_body_revision: 1 };
    expect((await putEmail(id, { subject: "Tab A", body: "Tab A body", ...stale })).status).toBe(200); // revs 2/2
    const res = await putEmail(id, { subject: "Tab B", body: "Tab B body", ...stale });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      followup_conflict: { subject: { value: "Tab A", revision: 2 }, body: { value: "Tab A body", revision: 2 } },
    });
    expect(await meetingRow(id)).toMatchObject({ followup_subject: "Tab A", followup_body: "Tab A body" });
    // Tab B resolves by re-saving on top of the current revisions.
    expect((await putEmail(id, { subject: "Tab B", body: "Tab B body", expected_subject_revision: 2, expected_body_revision: 2 })).status).toBe(200);
  });

  it("a late AI generation cannot overwrite a newer manual edit (completed meeting)", async () => {
    const id = await completedRich();
    await api.generate(id); // revs 1/1
    ai.create.mockImplementationOnce(async () => {
      // While the AI is "thinking", another tab saves a manual edit.
      expect((await putEmailNow(id, "Manual edit", "Manual body")).status).toBe(200);
      return aiReply({ subject: "Late AI", body: "Late AI body" });
    });
    const res = await api.generate(id, { subject: 1, body: 1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ followup_conflict: { body: { value: "Manual body", revision: 2 } } });
    expect(await meetingRow(id)).toMatchObject({ followup_subject: "Manual edit", followup_body: "Manual body" });
  });

  it("a regenerate request built on stale revisions is refused BEFORE spending a generation", async () => {
    const id = await completedRich();
    await api.generate(id);
    await putEmailNow(id, "Newer", "Newer body");
    ai.create.mockClear();
    const res = await api.generate(id, { subject: 1, body: 1 });
    expect(res.status).toBe(409);
    expect(ai.create).not.toHaveBeenCalled();
  });

  it("Test AE privacy: another admin can't read, generate or edit Corey's private Test AE meeting email", async () => {
    const id = await startMeeting(TEST_AE);
    expect((await api.complete(id)).status).toBe(200);
    expect((await api.generate(id)).status).toBe(200); // the owner
    ai.create.mockClear();
    expect((await api.generate(id, { subject: 1, body: 1 }, RYAN)).status).toBe(404);
    expect((await putEmailNow(id, "Hijack", "Hijack body", RYAN)).status).toBe(404);
    expect((await api.followupStatus(id, RYAN)).status).toBe(404);
    expect((await api.record(id, RYAN)).status).toBe(404);
    expect(ai.create).not.toHaveBeenCalled();
    expect(await meetingRow(id)).toMatchObject({ followup_subject: REPLY.subject });
    expect((await putEmailNow(id, "Owner edit", "Owner body")).status).toBe(200);
  });

  it("only admins: an AE token or no token can't generate or edit", async () => {
    const id = await completedRich();
    const before = await meetingRow(id);
    for (const who of [AE, OTHER_AE, null]) {
      const gen = await api.generate(id, { subject: 0, body: 0 }, who);
      expect([401, 403], String(who)).toContain(gen.status);
      const put = await putEmailNow(id, "x", "y", who);
      expect([401, 403], String(who)).toContain(put.status);
    }
    expect(ai.create).not.toHaveBeenCalled();
    expect(await meetingRow(id)).toEqual(before);
    // The anon (public) key still can't touch the table at all.
    const anon = await db.anon.from("one_on_one_meetings").update({ followup_body: "x" }).eq("id", id).select("id");
    expect(anon.data ?? []).toEqual([]);
    expect((await meetingRow(id)).followup_body).toBeNull();
  });

  it("the v2.1 migration is idempotent: re-running it (and v2 before it) changes nothing", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const id = await completedRich();
    await api.generate(id);
    const before = await meetingRow(id);
    await db.asOwner(readFileSync(join(process.cwd(), "supabase", "one_on_one_followup_v2_1.sql"), "utf8"));
    await db.asOwner(readFileSync(join(process.cwd(), "supabase", "one_on_one_followup_v2_1.sql"), "utf8"));
    expect(await meetingRow(id)).toEqual(before);
    expect((await putEmailNow(id, "After re-run", "Still editable")).status).toBe(200);
    await expect(db.sql(`UPDATE one_on_one_meetings SET wins = 'x' WHERE id = $1`, [id])).rejects.toMatchObject({ code: "23514" });
  });

  it("the PUT validates its input (lengths, revisions)", async () => {
    const id = await completedRich();
    const ok = { expected_subject_revision: 0, expected_body_revision: 0 };
    expect((await putEmail(id, { subject: "x".repeat(301), body: "b", ...ok })).status).toBe(400);
    expect((await putEmail(id, { subject: "s", body: "b".repeat(10001), ...ok })).status).toBe(400);
    expect((await putEmail(id, { subject: "s", body: "b", expected_subject_revision: -1, expected_body_revision: 0 })).status).toBe(400);
  });
});

describe("follow-up email for a COMPLETED meeting is generated from its FROZEN record", () => {
  /** Changes EVERYTHING live that a naive generator would read. */
  async function changeTheWorld() {
    await db.sql(`UPDATE gold_list_agents SET brokerage = 'LIVE-BROKERAGE-MARKER', agent_name = 'LIVE-RENAMED-MARKER' WHERE id = $1`, [SARAH]);
    await db.sql(
      `INSERT INTO gold_list_agents (salesperson_id, agent_name, brokerage) VALUES ($1, 'LIVE-NEW-AGENT-MARKER', 'Nowhere')`, [AE]);
    await db.sql(
      `UPDATE gold_list_activities SET description = 'LIVE-ACTIVITY-MARKER', scheduled_for = '2027-01-01' WHERE agent_id = $1 AND status = 'scheduled'`, [SARAH]);
    expect((await api.goals({ start: "this_week", values: { ...GOALS, office_visits: 888 } })).status).toBe(200);
    await db.sql(`UPDATE activity_entries SET office_visits = 4321 WHERE salesperson_id = $1 AND entry_date = '2026-09-28'`, [AE]);
    // A NEW 1:1 for the same AE with a live commitment and a live note.
    const next = await startMeeting();
    await api.addCommitment(next, { description: "LIVE-COMMITMENT-MARKER" });
    await api.set(next, "wins", "LIVE-WINS-MARKER");
    await api.set(next, "private_notes", "LIVE-PRIVATE-MARKER");
  }

  it("later live Gold List, goal, activity and commitment changes do not alter the historical context at all", async () => {
    const id = await completedRich();
    const before = await loadFollowupContext(db.client as never, id);
    await changeTheWorld();
    const after = await loadFollowupContext(db.client as never, id);
    expect(after.context).toEqual(before.context);
    expect(after.contentHash).toBe(before.contentHash);

    // And what actually goes to OpenAI for that completed meeting.
    expect((await api.generate(id)).status).toBe(200);
    const wire = JSON.stringify(aiWire());
    for (const marker of [
      "LIVE-BROKERAGE", "LIVE-RENAMED", "LIVE-NEW-AGENT", "LIVE-ACTIVITY", "LIVE-COMMITMENT", "LIVE-WINS",
      "LIVE-PRIVATE", "888", "4321", "2027-01-01",
    ]) {
      expect(wire, marker).not.toContain(marker);
    }
    // The frozen facts ARE there.
    const user = aiWire().messages[1].content;
    for (const frozen of [
      "Closed the Compass account", "Visits are up week over week", "Talked through objection handling on renewals",
      "Sarah wants a lunch meeting", "Lunch at Tradesman", "Dana Whitaker", "Compass Realty",
      "Send Sarah the renewal deck", "Sarah Johnson", "2026-09-28",
    ]) {
      expect(user, frozen).toContain(frozen);
    }
    // Frozen Activity & Results: this week's actual visits were 5 at completion.
    const ctx = after.context;
    expect(ctx.activity_results?.this_week.activities.find((a) => a.activity === "Office visits")?.actual).toBe(5);
    expect(ctx.activity_results?.this_week.activities.find((a) => a.activity === "Office visits")?.goal).toBe(40);
  });

  it("reads ONLY the meeting's frozen tables — never a live Gold List, goal, activity or commitment table", async () => {
    const id = await completedRich();
    const seen: Array<{ table: string; columns: string }> = [];
    const recording = {
      ...db.client,
      rpc: db.client.rpc,
      from: (table: string) => {
        const q = db.client.from(table);
        const select = q.select.bind(q);
        q.select = (cols?: string) => {
          seen.push({ table, columns: cols ?? "*" });
          return select(cols);
        };
        return q;
      },
    };
    await loadFollowupContext(recording as never, id);
    expect([...new Set(seen.map((s) => s.table))].sort()).toEqual([
      "one_on_one_commitment_reviews", "one_on_one_gold_list_notes", "one_on_one_meetings",
    ]);
    // Explicit columns everywhere (no `*`), and no contact / private column named.
    for (const s of seen) {
      expect(s.columns, s.table).not.toMatch(/\*|phone|email|private|followup/);
    }
    expect(seen.find((s) => s.table === "one_on_one_meetings")!.columns).toBe(SHAREABLE_MEETING_COLUMNS);
  });

  it("Private Manager Notes never enter the historical context or the OpenAI request", async () => {
    const id = await completedRich();
    expect((await meetingRow(id)).private_notes).toBe(PRIVATE);
    const { context } = await loadFollowupContext(db.client as never, id);
    expect(JSON.stringify(context)).not.toContain(PRIVATE_SNIPPET);
    expect((await api.generate(id)).status).toBe(200);
    const wire = JSON.stringify(ai.create.mock.calls[0]);
    expect(wire).not.toContain(PRIVATE_SNIPPET);
    expect(wire).not.toContain("thin ice");
    expect(wire.toLowerCase()).not.toContain("private_notes");
    // No agent contact PII either.
    for (const pii of ["801-555-0100", "dana-secret@example.com", "CRM-ONLY-NOTE-XYZ", "801-555-0111", "sarah@example.com", "CRM-only note about Sarah"]) {
      expect(wire, pii).not.toContain(pii);
    }
    // The AE-facing surfaces never see them: the GET status route and the PUT/POST bodies.
    const status = JSON.stringify(await json(api.followupStatus(id)));
    expect(status).not.toContain(PRIVATE_SNIPPET);
    const put = JSON.stringify(await json(putEmailNow(id, "s", "b")));
    expect(put).not.toContain(PRIVATE_SNIPPET);
  });

  it("a meeting completed before v2 (no snapshot flags, no goal history) still generates from what it did freeze", async () => {
    const id = await startMeeting();
    await api.set(id, "wins", "Old win");
    await api.complete(id);
    // Simulate the pre-v2 record: flags that didn't exist are at their defaults.
    const { context } = await loadFollowupContext(db.client as never, id);
    expect(context).toMatchObject({ wins: "Old win", gold_list: [], goal_changes: [], commitments: { made_in_this_1_1: [] } });
    expect(context.activity_results).not.toBeNull(); // the frozen comparison exists
    expect((await api.generate(id)).status).toBe(200);
  });

  it("an in-progress meeting still builds from LIVE data (unchanged behavior)", async () => {
    const id = await richMeeting();
    const before = await loadFollowupContext(db.client as never, id);
    expect(before.status).toBe("in_progress");
    await db.sql(`UPDATE activity_entries SET office_visits = 4321 WHERE salesperson_id = $1 AND entry_date = '2026-09-28'`, [AE]);
    const after = await loadFollowupContext(db.client as never, id);
    expect(after.context.activity_results?.this_week.activities.find((a) => a.activity === "Office visits")?.actual).toBe(4321);
    expect(after.contentHash).toBe(before.contentHash); // live numbers don't make the email "stale"
  });

  it("completion, goal atomicity, Gold List attribution and the legacy route are unaffected by the email changes", async () => {
    const id = await richMeeting();
    await api.generate(id);
    expect((await api.goals({ start: "this_week", values: { ...GOALS, office_visits: 35 }, meeting_id: id })).status).toBe(200);
    expect((await api.complete(id)).status).toBe(200);
    expect((await snapshotOf(id)).this_week.cells.office_visits.original_goal).toBe(35);
    expect((await historyOf(id))).toHaveLength(2);
    const notes = await db.sql(`SELECT agent_name, agent_added, agent_edited, action_taken FROM one_on_one_gold_list_notes WHERE meeting_id = $1 ORDER BY agent_name`, [id]);
    expect(notes).toEqual([
      { agent_name: "Dana Whitaker", agent_added: true, agent_edited: false, action_taken: true },
      { agent_name: "Sarah Johnson", agent_added: false, agent_edited: true, action_taken: true },
    ]);
    // Editing the email afterwards changes none of that.
    await putEmailNow(id, "s", "b");
    expect((await snapshotOf(id)).this_week.cells.office_visits.original_goal).toBe(35);
    expect(await historyOf(id)).toHaveLength(2);
  });
});

// ===========================================================================
// 6) Isolation: reporting, legacy, anon
// ===========================================================================

describe("nothing else moves", () => {
  it("the whole v2 workflow leaves real team reporting exactly as it was", async () => {
    const standings = async () =>
      (await computeStandings(db.client as never, "2026-09-28", "2026-09-29", "2026-09-28", "2026-09-29")).standings;
    const before = await standings();
    expect(before.length).toBeGreaterThan(0);

    const id = await richMeeting();
    await api.generate(id);
    await api.complete(id);

    // (The goal change is a real per-AE goal, so compare the OTHER AE and the roster.)
    const after = await standings();
    expect(after.find((s) => s.id === OTHER_AE)).toEqual(before.find((s) => s.id === OTHER_AE));
    expect(after.map((s) => s.id).sort()).toEqual(before.map((s) => s.id).sort());
    expect(JSON.stringify(after)).not.toContain(TEST_AE);
  });

  it("the legacy Weekly Focus tables are untouched", async () => {
    await db.sql(
      `INSERT INTO one_on_ones (ae_id, week_start, meeting_date, notes_focus) VALUES ($1, '2026-09-14', '2026-09-15', 'Old focus')`,
      [AE],
    );
    const snap = async () => db.sql(`SELECT * FROM one_on_ones ORDER BY id`);
    const before = await snap();
    const id = await richMeeting();
    await api.generate(id);
    await api.complete(id);
    expect(await snap()).toEqual(before);
  });

  it("the anon (public) key can read or run none of it", async () => {
    const id = await richMeeting();
    await api.generate(id);
    for (const table of ["one_on_one_meetings", "one_on_one_gold_list_notes", "gold_list_agents"]) {
      const res = await db.anon.from(table).select("*");
      expect(res.data ?? [], table).toEqual([]);
    }
    const priv = await db.anon.from("one_on_one_meetings").select("private_notes, followup_body");
    expect(priv.data ?? []).toEqual([]);
    const write = await db.anon.from("one_on_one_meetings").update({ private_notes: "x" }).eq("id", id).select("id");
    expect(write.data ?? []).toEqual([]);
    expect((await meetingRow(id)).private_notes).toBe(PRIVATE);
    // Every function the goal/completion path calls is service-role only…
    const goalsBefore = await liveGoals();
    const goalArgs = {
      p_meeting_id: id, p_ae_id: AE, p_start: "this_week", p_effective_from: "2026-09-28",
      p_values: GOALS, p_created_by: ADMIN,
    };
    expect((await db.anon.rpc("update_weekly_goal_in_one_on_one", goalArgs)).error?.code).toBe("42501");
    expect(
      (await db.anon.rpc("complete_one_on_one_meeting", {
        p_meeting_id: id, p_completed_by: ADMIN, p_activity_snapshot: {}, p_goal_changes_seen: 0,
      })).error?.code,
    ).toBe("42501");
    expect(
      (await db.anon.rpc("complete_one_on_one_meeting", {
        p_meeting_id: id, p_completed_by: ADMIN, p_activity_snapshot: {},
      })).error?.code,
    ).toBe("42501");
    expect(await liveGoals()).toEqual(goalsBefore);
    // …and the history-only function (the non-atomic path) no longer exists.
    expect(
      (await db.sql(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'record_one_on_one_goal_change'`))[0].n,
    ).toBe(0);
  });
});
