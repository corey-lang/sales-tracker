/**
 * Route-level tests for the manager 1:1 workspace, against a REAL Postgres.
 *
 *   GET/POST /api/admin/coaching/[ae_id]/meetings        (+ /history)
 *   GET/PATCH /api/admin/one-on-one-meetings/[id]
 *   POST     /api/admin/one-on-one-meetings/[id]/complete
 *   POST     /api/admin/one-on-one-meetings/[id]/commitments
 *   PATCH/DELETE .../commitments/[cid]
 *   PUT      .../gold-list/[agentId]
 *   POST     .../gold-list/[agentId]/activities
 *   PATCH    .../gold-list/[agentId]/activities/[aid]
 *   GET      /api/admin/coaching/[ae_id]/legacy          (read-only legacy)
 *   GET      /api/admin/coaching/[ae_id]  +  /api/admin/coaching
 *                                                         (original contracts)
 *   PUT      /api/admin/coaching/[ae_id]/goals            (unchanged)
 *
 * The auth module is NOT mocked (real HMAC tokens, real requireSalesperson),
 * and Supabase is src/test/pglite-supabase.ts: PGlite running the project's
 * actual migrations, so the unique indexes, freeze/lock triggers and the
 * transactional complete_one_on_one_meeting() are the real ones.
 *
 * RACES: PGlite is one connection, so a race is staged with
 * `db.beforeWrite(table, kind, fn)`: `fn` (e.g. completing the meeting) runs
 * after the route passed its in-progress check but right before its write —
 * exactly the window the review flagged.
 *
 * The app clock is pinned to Tue 2026-09-29 12:00 America/Denver. This week =
 * business Mon 09-28 (activity Sun 09-27..Sat 10-03); last week = Mon 09-21.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDb, type TestDb } from "@/test/pglite-supabase";

process.env.SESSION_SECRET = "test-session-secret";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ getServerSupabase: () => holder.client }));

const { signSessionToken } = await import("@/lib/server/auth");
const { computeStandings } = await import("@/lib/server/leaderboard-standings");
const { adjustedWeekScore, resolveActiveGoal } = await import("@/lib/goals");

const workspaceRoute = await import("@/app/api/admin/coaching/[ae_id]/meetings/route");
const historyRoute = await import("@/app/api/admin/coaching/[ae_id]/meetings/history/route");
const legacyReadRoute = await import("@/app/api/admin/coaching/[ae_id]/legacy/route");
const legacyDetailRoute = await import("@/app/api/admin/coaching/[ae_id]/route");
const coachingListRoute = await import("@/app/api/admin/coaching/route");
const goalsRoute = await import("@/app/api/admin/coaching/[ae_id]/goals/route");
const meetingRoute = await import("./[id]/route");
const completeRoute = await import("./[id]/complete/route");
const commitmentsRoute = await import("./[id]/commitments/route");
const commitmentRoute = await import("./[id]/commitments/[cid]/route");
const noteRoute = await import("./[id]/gold-list/[agentId]/route");
const activitiesRoute = await import("./[id]/gold-list/[agentId]/activities/route");
const activityRoute = await import("./[id]/gold-list/[agentId]/activities/[aid]/route");
const legacyScopedRoute = await import("./[id]/legacy-commitments/[cid]/route");
const legacyOldRoute = await import("@/app/api/admin/one-on-ones/[id]/commitments/[cid]/route");
const aeGoldListAgents = await import("@/app/api/gold-list/agents/route");
const aeGoldListActivities = await import("@/app/api/gold-list/agents/[id]/activities/route");
const aeGoldListActivity = await import("@/app/api/gold-list/agents/[id]/activities/[aid]/route");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const AE = "11111111-1111-4111-8111-111111111111";
const OTHER_AE = "22222222-2222-4222-8222-222222222222";
const ADMIN = "55555555-5555-4555-8555-555555555555";
const SARAH = "aaaaaaaa-0000-4000-8000-000000000001"; // Hilary's Gold List agent
const NOT_HERS = "aaaaaaaa-0000-4000-8000-000000000002"; // Kennedy's agent
const VISIT = "bbbbbbbb-0000-4000-8000-000000000001"; // Sarah's completed visit
const WEEK1 = "cccccccc-0000-4000-8000-000000000001"; // legacy Weekly Focus week
const LEGACY_C1 = "dddddddd-0000-4000-8000-000000000001";

const GOAL_COLUMNS =
  "office_visits, service_requests, ones_scheduled, ones_held, presentations, impressions, team_meetings, gold_list_touches";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  holder.client = db.client;
}, 60_000);

async function seed() {
  await db.reset();
  await db.sql(
    `INSERT INTO salespeople (id, first_name, role) VALUES ($1,'Hilary','ae'), ($2,'Kennedy','ae'), ($3,'Corey','admin')`,
    [AE, OTHER_AE, ADMIN],
  );
  // Team default since January; Hilary's personal goal changed THIS Monday.
  await db.sql(
    `INSERT INTO weekly_goals (salesperson_id, effective_from, office_visits, impressions, presentations, created_at)
     VALUES (NULL, '2026-01-05', 40, 150, 1, '2026-01-01'), ($1, '2026-09-28', 20, 100, 1, '2026-09-27')`,
    [AE],
  );
  await db.sql(
    `INSERT INTO activity_entries (salesperson_id, entry_date, office_visits, impressions, presentations) VALUES
       ($1, '2026-09-22', 20, 80, 1), ($1, '2026-09-24', 18, 67, 1), ($1, '2026-09-28', 5, 45, 1)`,
    [AE],
  );
  await db.sql(
    `INSERT INTO gold_list_agents (id, salesperson_id, agent_name, brokerage) VALUES
       ($1, $2, 'Sarah Johnson', 'Compass'), ($3, $4, 'Not Hilary''s', NULL)`,
    [SARAH, AE, NOT_HERS, OTHER_AE],
  );
  await db.sql(
    `INSERT INTO gold_list_activities (id, agent_id, salesperson_id, description, scheduled_for, created_at)
     VALUES ($1, $2, $3, 'Office visit', '2026-09-22', '2026-09-20T00:00:00Z')`,
    [VISIT, SARAH, AE],
  );
  await db.sql(
    `UPDATE gold_list_activities SET status = 'completed', completed_at = '2026-09-22T18:00:00Z' WHERE id = $1`,
    [VISIT],
  );
  // Legacy Weekly Focus: one past week with one open commitment.
  await db.sql(
    `INSERT INTO one_on_ones (id, ae_id, week_start, meeting_date, notes_focus) VALUES ($1, $2, '2026-09-14', '2026-09-15', 'Old focus')`,
    [WEEK1, AE],
  );
  await db.sql(
    `INSERT INTO one_on_one_commitments (id, one_on_one_id, ae_id, content, status) VALUES ($1, $2, $3, 'Legacy follow-up', 'open')`,
    [LEGACY_C1, WEEK1, AE],
  );
}

const roleOf: Record<string, string> = { [AE]: "ae", [OTHER_AE]: "ae", [ADMIN]: "admin" };
const nameOf: Record<string, string> = { [AE]: "Hilary", [OTHER_AE]: "Kennedy", [ADMIN]: "Corey" };

function req(who: string | null, path: string, init: { method?: string; body?: unknown } = {}) {
  return new Request(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(who
        ? {
            Authorization: `Bearer ${signSessionToken({ sub: who, role: roleOf[who] as never, name: nameOf[who] })}`,
          }
        : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });

const api = {
  workspace: (who: string | null = ADMIN, ae = AE) =>
    workspaceRoute.GET(req(who, `/x`), p({ ae_id: ae })),
  start: (who: string | null = ADMIN, ae = AE) =>
    workspaceRoute.POST(req(who, `/x`, { method: "POST" }), p({ ae_id: ae })),
  history: (before?: { completed_at: string; id: string } | string, who: string | null = ADMIN) =>
    historyRoute.GET(
      req(
        who,
        typeof before === "string"
          ? `/x?before=${encodeURIComponent(before)}`
          : before
            ? `/x?before=${encodeURIComponent(before.completed_at)}&before_id=${before.id}`
            : "/x",
      ),
      p({ ae_id: AE }),
    ),
  record: (id: string, who: string | null = ADMIN) => meetingRoute.GET(req(who, `/x`), p({ id })),
  /** One field save with an explicit base revision. */
  saveField: (id: string, field: string, value: string | null, expected: number, who: string | null = ADMIN) =>
    meetingRoute.PATCH(
      req(who, `/x`, { method: "PATCH", body: { field, value, expected_revision: expected } }),
      p({ id }),
    ),
  /** Saves each field on top of its CURRENT revision (a well-behaved tab). */
  patch: async (id: string, fields: Record<string, string | null>, who: string | null = ADMIN) => {
    let res: Response = new Response(null, { status: 400 });
    for (const [field, value] of Object.entries(fields)) {
      const [row] = await db.sql(`SELECT ${field}_rev AS rev FROM one_on_one_meetings WHERE id = $1`, [id]).catch(
        () => [{ rev: 0 }],
      );
      res = await api.saveField(id, field, value, Number(row?.rev ?? 0), who);
      if (!res.ok) return res;
    }
    return res;
  },
  complete: (id: string, who: string | null = ADMIN) =>
    completeRoute.POST(req(who, `/x`, { method: "POST" }), p({ id })),
  addCommitment: (id: string, body: unknown, who: string | null = ADMIN) =>
    commitmentsRoute.POST(req(who, `/x`, { method: "POST", body }), p({ id })),
  patchCommitment: (id: string, cid: string, body: unknown, who: string | null = ADMIN) =>
    commitmentRoute.PATCH(req(who, `/x`, { method: "PATCH", body }), p({ id, cid })),
  deleteCommitment: (id: string, cid: string, who: string | null = ADMIN) =>
    commitmentRoute.DELETE(req(who, `/x`, { method: "DELETE" }), p({ id, cid })),
  /** Note save with an explicit base revision. */
  saveNote: (id: string, agentId: string, note: string | null, expected: number, who: string | null = ADMIN) =>
    noteRoute.PUT(
      req(who, `/x`, { method: "PUT", body: { note, expected_revision: expected } }),
      p({ id, agentId }),
    ),
  /** Note save on top of the CURRENT revision. */
  note: async (id: string, agentId: string, note: string | null, who: string | null = ADMIN) => {
    const [row] = await db.sql(
      `SELECT revision FROM one_on_one_gold_list_notes WHERE meeting_id = $1 AND agent_id = $2`,
      [id, agentId],
    ).catch(() => []);
    return api.saveNote(id, agentId, note, Number(row?.revision ?? 0), who);
  },
  legacyScoped: (id: string, cid: string, body: unknown, who: string | null = ADMIN) =>
    legacyScopedRoute.PATCH(req(who, `/x`, { method: "PATCH", body }), p({ id, cid })),
  legacyScopedDrop: (id: string, cid: string, who: string | null = ADMIN) =>
    legacyScopedRoute.DELETE(req(who, `/x`, { method: "DELETE" }), p({ id, cid })),
  legacyOld: (cid: string, body: unknown, who: string | null = ADMIN) =>
    legacyOldRoute.PATCH(req(who, `/x`, { method: "PATCH", body }), p({ id: WEEK1, cid })),
  schedule: (id: string, agentId: string, body: unknown, who: string | null = ADMIN) =>
    activitiesRoute.POST(req(who, `/x`, { method: "POST", body }), p({ id, agentId })),
  patchActivity: (id: string, agentId: string, aid: string, body: unknown, who: string | null = ADMIN) =>
    activityRoute.PATCH(req(who, `/x`, { method: "PATCH", body }), p({ id, agentId, aid })),
  legacyRead: (who: string | null = ADMIN) => legacyReadRoute.GET(req(who, `/x`), p({ ae_id: AE })),
  legacyDetail: (who: string | null = ADMIN) => legacyDetailRoute.GET(req(who, `/x`), p({ ae_id: AE })),
  coachingList: (who: string | null = ADMIN) => coachingListRoute.GET(req(who, `/api/admin/coaching`)),
  goals: (body: unknown, who: string | null = ADMIN) =>
    goalsRoute.PUT(req(who, `/x`, { method: "PUT", body }), p({ ae_id: AE })),
};

async function json<T = Row>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}

async function startMeeting(ae = AE): Promise<string> {
  return ((await json<{ meeting: Row }>(api.start(ADMIN, ae))).meeting.id) as string;
}

async function meetingRow(id: string) {
  return (await db.sql(`SELECT * FROM one_on_one_meetings WHERE id = $1`, [id]))[0];
}

const setClock = (iso: string) => vi.setSystemTime(new Date(iso));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  setClock("2026-09-29T18:00:00.000Z"); // Tue 12:00 Denver
  await seed();
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

describe("manager-only access", () => {
  it("rejects an AE (403) and an anonymous caller (401) on every 1:1 route", async () => {
    const id = await startMeeting();
    const calls: Array<(who: string | null) => Promise<Response>> = [
      (w) => api.workspace(w),
      (w) => api.start(w),
      (w) => api.history(undefined, w),
      (w) => api.record(id, w),
      (w) => api.patch(id, { wins: "hi" }, w),
      (w) => api.complete(id, w),
      (w) => api.addCommitment(id, { description: "x" }, w),
      (w) => api.patchCommitment(id, LEGACY_C1, { status: "completed" }, w),
      (w) => api.deleteCommitment(id, LEGACY_C1, w),
      (w) => api.note(id, SARAH, "x", w),
      (w) => api.schedule(id, SARAH, { description: "Call", scheduled_for: "2026-10-01" }, w),
      (w) => api.patchActivity(id, SARAH, VISIT, { status: "cancelled" }, w),
      (w) => api.legacyScoped(id, LEGACY_C1, { status: "completed" }, w),
      (w) => api.legacyScopedDrop(id, LEGACY_C1, w),
      (w) => api.legacyRead(w),
      (w) => api.legacyDetail(w),
      (w) => api.coachingList(w),
    ];
    for (const call of calls) {
      expect((await call(AE)).status).toBe(403);
      expect((await call(null)).status).toBe(401);
    }
    expect(await meetingRow(id)).toMatchObject({ wins: null, status: "in_progress" });
    expect(await db.sql(`SELECT count(*)::int AS n FROM one_on_one_meeting_commitments`)).toEqual([{ n: 0 }]);
    expect(await db.sql(`SELECT count(*)::int AS n FROM one_on_one_gold_list_notes`)).toEqual([{ n: 0 }]);
  });

  it("never exposes 1:1 discussion notes through the AE's own Gold List endpoints", async () => {
    const id = await startMeeting();
    await api.note(id, SARAH, "PRIVATE: coach on follow-through");
    const list = await aeGoldListAgents.GET(req(AE, "/api/gold-list/agents"));
    const history = await aeGoldListActivities.GET(req(AE, "/x"), p({ id: SARAH }));
    expect(list.status).toBe(200);
    expect(history.status).toBe(200);
    expect(await list.text()).not.toContain("PRIVATE");
    expect(await history.text()).not.toContain("PRIVATE");
  });

  it("404s for a non-AE id (roles can't be probed)", async () => {
    expect((await api.workspace(ADMIN, ADMIN)).status).toBe(404);
    expect((await api.start(ADMIN, ADMIN)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("start / resume / complete", () => {
  it("GET never creates a meeting, and the read-only legacy view never creates a week", async () => {
    expect((await json(api.workspace())).meeting).toBeNull();
    expect((await api.legacyRead()).status).toBe(200);
    expect(await db.sql(`SELECT count(*)::int AS n FROM one_on_one_meetings`)).toEqual([{ n: 0 }]);
    expect(await db.sql(`SELECT count(*)::int AS n FROM one_on_ones`)).toEqual([{ n: 1 }]);
  });

  it("Start 1:1 creates once, then resumes the same draft (also under concurrent clicks)", async () => {
    const first = await api.start();
    const second = await api.start();
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const a = await json<{ meeting: Row; created: boolean }>(first);
    const b = await json<{ meeting: Row; created: boolean }>(second);
    expect(b.meeting.id).toBe(a.meeting.id);
    expect(a.meeting).toMatchObject({
      ae_id: AE,
      manager_id: ADMIN,
      ae_name: "Hilary",
      manager_name: "Corey",
      meeting_date: "2026-09-29",
      status: "in_progress",
    });

    const more = await Promise.all([api.start(), api.start(), api.start()]);
    const ids = new Set(await Promise.all(more.map(async (r) => ((await r.json()) as { meeting: Row }).meeting.id)));
    expect(ids).toEqual(new Set([a.meeting.id]));
    expect(await db.sql(`SELECT count(*)::int AS n FROM one_on_one_meetings WHERE status = 'in_progress'`)).toEqual([
      { n: 1 },
    ]);
  });

  it("autosaves draft fields, then freezes them; a repeat Complete is an idempotent 200", async () => {
    const id = await startMeeting();
    expect(
      (
        await api.patch(id, {
          wins: "Closed ABC Realty",
          activity_notes: "Impressions strong",
          coaching_focus: "Consistency with top producers",
          coaching_notes: "Talked through weekly plan",
        })
      ).status,
    ).toBe(200);

    const done = await api.complete(id);
    expect(done.status).toBe(200);
    const record = await json<{ meeting: Row }>(done);
    expect(record.meeting).toMatchObject({
      status: "completed",
      completed_by: ADMIN,
      wins: "Closed ABC Realty",
      coaching_focus: "Consistency with top producers",
    });

    const again = await api.complete(id);
    expect(again.status).toBe(200);
    expect((await json<{ meeting: Row }>(again)).meeting).toEqual(record.meeting);

    expect((await api.patch(id, { wins: "rewrite" })).status).toBe(409);
    expect((await api.addCommitment(id, { description: "late" })).status).toBe(409);
    expect((await api.note(id, SARAH, "late")).status).toBe(409);
    expect((await meetingRow(id)).wins).toBe("Closed ABC Realty");

    const next = await json<{ meeting: Row; created: boolean }>(api.start());
    expect(next.created).toBe(true);
    expect(next.meeting.id).not.toBe(id);
  });

  it("a failed completion leaves a normal, editable draft that completes on retry", async () => {
    const id = await startMeeting();
    await api.patch(id, { wins: "Before the blip" });
    const rpc = db.client.rpc;
    db.client.rpc = async () => ({ data: null, error: { code: "08006", message: "connection reset" } });
    try {
      expect((await api.complete(id)).status).toBe(500);
    } finally {
      db.client.rpc = rpc;
    }
    expect(await meetingRow(id)).toMatchObject({ status: "in_progress", completed_at: null });
    expect((await api.patch(id, { wins: "After the blip" })).status).toBe(200);
    expect((await api.complete(id)).status).toBe(200);
    expect(await meetingRow(id)).toMatchObject({ status: "completed", wins: "After the blip" });
  });

  it("finds the previous COMPLETED 1:1, pages history newest first", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) {
      setClock(new Date(Date.UTC(2026, 0, 5 + i * 7, 18)).toISOString());
      const id = await startMeeting();
      await api.patch(id, { coaching_focus: `Focus ${i}` });
      await api.complete(id);
      ids.push(id);
    }
    setClock("2026-09-29T18:00:00.000Z");
    await startMeeting(); // an in-progress draft is never "last 1:1"
    const ws = await json<{
      last_completed: { meeting: Row };
      history: Row[];
      history_has_more: boolean;
    }>(api.workspace());
    expect(ws.last_completed.meeting.id).toBe(ids[22]);
    expect(ws.last_completed.meeting.coaching_focus).toBe("Focus 22");
    expect(ws.history.map((h) => h.id)).toEqual(ids.slice(3).reverse());
    expect(ws.history_has_more).toBe(true);

    const last = ws.history.at(-1)!;
    const older = await json<{ items: Row[]; has_more: boolean }>(
      api.history({ completed_at: last.completed_at as string, id: last.id as string }),
    );
    expect(older.items.map((h) => h.id)).toEqual(ids.slice(0, 3).reverse());
    expect(older.has_more).toBe(false);
    expect((await api.history("2026-09-29T18:00:00Z")).status).toBe(400); // id missing
    expect((await api.history({ completed_at: "not-a-date", id: ids[0] })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Races: a write that passed the in-progress check vs. a completion
// ---------------------------------------------------------------------------

describe("meeting-scoped writes can't slip in after completion", () => {
  it("adding a commitment", async () => {
    const id = await startMeeting();
    db.beforeWrite("one_on_one_meeting_commitments", "insert", async () => {
      expect((await api.complete(id)).status).toBe(200);
    });
    const res = await api.addCommitment(id, { description: "Slipped in?" });
    expect(res.status).toBe(409);
    expect(await db.sql(`SELECT count(*)::int AS n FROM one_on_one_meeting_commitments`)).toEqual([{ n: 0 }]);
  });

  it("resolving a carryover commitment", async () => {
    const m1 = await startMeeting();
    const { commitment } = await json<{ commitment: Row }>(api.addCommitment(m1, { description: "Carry" }));
    await api.complete(m1);
    const m2 = await startMeeting();
    db.beforeWrite("one_on_one_meeting_commitments", "update", async () => {
      await api.complete(m2);
    });
    expect((await api.patchCommitment(m2, commitment.id as string, { status: "completed" })).status).toBe(409);
    expect(
      await db.sql(`SELECT status, resolved_in_meeting_id FROM one_on_one_meeting_commitments WHERE id = $1`, [
        commitment.id,
      ]),
    ).toEqual([{ status: "open", resolved_in_meeting_id: null }]);
    // m2's frozen record shows it still open — consistent with the live row.
    const r2 = await json<{ commitment_reviews: Row[] }>(api.record(m2));
    expect(r2.commitment_reviews.find((r) => r.commitment_id === commitment.id)).toMatchObject({ status: "open" });
  });

  it("a Gold List discussion note", async () => {
    const id = await startMeeting();
    db.beforeWrite("one_on_one_gold_list_notes", "insert", async () => {
      await api.complete(id);
    });
    expect((await api.note(id, SARAH, "late note")).status).toBe(409);
    expect(await db.sql(`SELECT count(*)::int AS n FROM one_on_one_gold_list_notes`)).toEqual([{ n: 0 }]);
  });

  it("editing an existing Gold List discussion note", async () => {
    const id = await startMeeting();
    expect((await api.note(id, SARAH, "first")).status).toBe(200);
    db.beforeWrite("one_on_one_gold_list_notes", "update", async () => {
      await api.complete(id);
    });
    expect((await api.saveNote(id, SARAH, "late edit", 1)).status).toBe(409);
    expect(await db.sql(`SELECT note FROM one_on_one_gold_list_notes WHERE meeting_id = $1`, [id])).toEqual([
      { note: "first" },
    ]);
  });

  it("a manager Gold List action — refused together with the live change", async () => {
    const id = await startMeeting();
    db.beforeWrite("gold_list_activities", "insert", async () => {
      await api.complete(id);
    });
    const res = await api.schedule(id, SARAH, { description: "Lunch", scheduled_for: "2026-10-02" });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: "This 1:1 is completed and read-only." });
    expect(await db.sql(`SELECT count(*)::int AS n FROM gold_list_activities`)).toEqual([{ n: 1 }]);
  });

  it("a draft field autosave", async () => {
    const id = await startMeeting();
    db.beforeWrite("one_on_one_meetings", "update", async () => {
      await db.client.rpc("complete_one_on_one_meeting", {
        p_meeting_id: id,
        p_completed_by: ADMIN,
        p_activity_snapshot: { version: 1 },
      });
    });
    expect((await api.saveField(id, "wins", "too late", 0)).status).toBe(409);
    expect((await meetingRow(id)).wins).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Activity & Results
// ---------------------------------------------------------------------------

type Snapshot = {
  last_week: { week_start: string; score: number | null; cells: Record<string, Row> };
  this_week: { week_start: string; score: number | null; cells: Record<string, Row> };
};

describe("Last Week vs This Week", () => {
  it("scores each week against the goals in effect THAT week", async () => {
    const { activity } = await json<{ activity: Snapshot }>(api.workspace());
    expect(activity.last_week.week_start).toBe("2026-09-21");
    expect(activity.this_week.week_start).toBe("2026-09-28");
    expect(activity.last_week.cells.office_visits).toMatchObject({ actual: 38, goal: 40, percent: 95 });
    expect(activity.last_week.cells.impressions).toMatchObject({ actual: 147, goal: 150, percent: 98 });
    expect(activity.last_week.cells.presentations).toMatchObject({ actual: 2, goal: 1, percent: 200 });
    expect(activity.this_week.cells.office_visits).toMatchObject({ actual: 5, goal: 20, percent: 25 });
    expect(activity.this_week.cells.impressions).toMatchObject({ actual: 45, goal: 100, percent: 45 });
  });

  it("uses the existing weekly score — identical to the leaderboard", async () => {
    const { activity } = await json<{ activity: Snapshot }>(api.workspace());
    expect(activity.last_week.score).toBe(104); // (95 + 98 + 120) / 3
    expect(activity.this_week.score).toBe(57); // (25 + 45 + 100) / 3

    const goals = await db.sql(`SELECT id, salesperson_id, effective_from::text, created_at, ${GOAL_COLUMNS} FROM weekly_goals`);
    const direct = adjustedWeekScore(
      { office_visits: 5, impressions: 45, presentations: 1 },
      resolveActiveGoal(AE, goals as never, "2026-09-28"),
      5,
    );
    expect(activity.this_week.score).toBe(direct.percent);
    for (const [monday, through, score] of [
      ["2026-09-28", "2026-09-29", activity.this_week.score],
      ["2026-09-21", "2026-09-25", activity.last_week.score],
    ] as const) {
      const board = await computeStandings(db.client as never, monday, through, monday, "2026-09-29");
      expect(board.standings.find((s) => s.id === AE)?.percent).toBe(score);
    }
  });

  it("Update Goals still works: Start Next Week leaves this week alone; Start This Week re-scores it", async () => {
    const values = {
      office_visits: 10,
      service_requests: 0,
      ones_scheduled: 0,
      ones_held: 0,
      presentations: 1,
      impressions: 100,
      team_meetings: 0,
      gold_list_touches: 0,
    };
    expect((await api.goals({ start: "next_week", values })).status).toBe(200);
    expect(
      await db.sql(
        `SELECT office_visits, created_by FROM weekly_goals WHERE salesperson_id = $1 AND effective_from = '2026-10-05'`,
        [AE],
      ),
    ).toEqual([{ office_visits: 10, created_by: ADMIN }]);
    let ws = await json<{ activity: Snapshot; weekly_goal_next_override: Row }>(api.workspace());
    expect(ws.activity.this_week.cells.office_visits.goal).toBe(20);
    expect(ws.weekly_goal_next_override).toMatchObject({ effective_from: "2026-10-05" });

    expect((await api.goals({ start: "this_week", values })).status).toBe(200);
    expect(
      await db.sql(
        `SELECT count(*)::int AS n FROM weekly_goals WHERE salesperson_id = $1 AND effective_from = '2026-09-28'`,
        [AE],
      ),
    ).toEqual([{ n: 1 }]);
    ws = await json(api.workspace());
    expect(ws.activity.this_week.cells.office_visits).toMatchObject({ goal: 10, percent: 50 });
    expect(ws.activity.last_week.cells.office_visits.goal).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// Commitments
// ---------------------------------------------------------------------------

describe("commitments", () => {
  it("carry over and record where they were resolved; history keeps each meeting's view", async () => {
    const m1 = await startMeeting();
    const { commitment } = await json<{ commitment: Row }>(
      api.addCommitment(m1, { description: "Follow up with Sarah", owner: "ae", due_date: "2026-10-02" }),
    );
    const cid = commitment.id as string;
    await api.addCommitment(m1, { description: "Send deck", owner: "manager" });
    await api.complete(m1);

    setClock("2026-10-13T18:00:00.000Z");
    const m2 = await startMeeting();
    let ws = await json<{ carryover: Row[]; last_completed: { commitments: Row[] } }>(api.workspace());
    expect(ws.carryover.map((c) => c.description)).toEqual(["Follow up with Sarah", "Send deck"]);
    expect(ws.carryover[0]).toMatchObject({ origin_meeting_id: m1, origin_meeting_date: "2026-09-29" });
    expect(ws.last_completed.commitments).toHaveLength(2);

    expect((await api.patchCommitment(m2, cid, { description: "reworded" })).status).toBe(409);
    expect((await api.deleteCommitment(m2, cid)).status).toBe(409);

    const done = await json<{ commitment: Row }>(api.patchCommitment(m2, cid, { status: "completed" }));
    expect(done.commitment).toMatchObject({ status: "completed", origin_meeting_id: m1, resolved_in_meeting_id: m2 });
    ws = await json(api.workspace());
    expect(ws.carryover.find((c) => c.id === cid)).toMatchObject({ status: "completed" });

    await api.complete(m2);
    const r1 = await json<{ commitment_reviews: Row[] }>(api.record(m1));
    const r2 = await json<{ commitment_reviews: Row[] }>(api.record(m2));
    expect(r1.commitment_reviews.find((r) => r.commitment_id === cid)).toMatchObject({ origin: "new", status: "open" });
    const reviewed = r2.commitment_reviews.map((r) => [r.description, r.origin, r.status]);
    // Both came from the same 1:1 (tie on time in PGlite's ms clock), so
    // compare those two as a set; legacy Weekly Focus items always sort last.
    expect(reviewed.slice(0, 2).sort()).toEqual([
      ["Follow up with Sarah", "carryover", "completed"],
      ["Send deck", "carryover", "open"],
    ]);
    expect(reviewed[2]).toEqual(["Legacy follow-up", "carryover", "open"]);
    expect(r2.commitment_reviews.find((r) => r.commitment_id === cid)).toMatchObject({
      origin_meeting_date: "2026-09-29",
    });

    setClock("2026-10-20T18:00:00.000Z");
    await startMeeting();
    ws = await json(api.workspace());
    expect(ws.carryover.map((c) => c.description)).toEqual(["Send deck"]);
  });

  it("reopening a carryover clears its resolution; this meeting's own items can be deleted", async () => {
    const m1 = await startMeeting();
    const { commitment } = await json<{ commitment: Row }>(api.addCommitment(m1, { description: "A" }));
    await api.complete(m1);
    const m2 = await startMeeting();
    await api.patchCommitment(m2, commitment.id as string, { status: "completed" });
    const reopened = await json<{ commitment: Row }>(api.patchCommitment(m2, commitment.id as string, { status: "open" }));
    expect(reopened.commitment).toMatchObject({ status: "open", resolved_in_meeting_id: null, completed_at: null });

    const own = await json<{ commitment: Row }>(api.addCommitment(m2, { description: "typo" }));
    expect((await api.deleteCommitment(m2, own.commitment.id as string)).status).toBe(200);
    expect(await db.sql(`SELECT description FROM one_on_one_meeting_commitments`)).toEqual([{ description: "A" }]);
  });

  it("can't touch another AE's commitment through this AE's meeting", async () => {
    const theirs = await startMeeting(OTHER_AE);
    const { commitment } = await json<{ commitment: Row }>(api.addCommitment(theirs, { description: "Kennedy's" }));
    const mine = await startMeeting();
    expect((await api.patchCommitment(mine, commitment.id as string, { status: "completed" })).status).toBe(404);
  });

  it("surfaces open legacy Weekly Focus commitments and freezes them into the record", async () => {
    const m1 = await startMeeting();
    const ws = await json<{ legacy_carryover: Row[] }>(api.workspace());
    expect(ws.legacy_carryover).toMatchObject([
      { id: LEGACY_C1, content: "Legacy follow-up", source_week_start: "2026-09-14" },
    ]);
    await api.complete(m1);
    const record = await json<{ commitment_reviews: Row[] }>(api.record(m1));
    expect(record.commitment_reviews).toContainEqual(
      expect.objectContaining({ legacy_commitment_id: LEGACY_C1, status: "open", origin: "carryover" }),
    );
    expect(await db.sql(`SELECT status FROM one_on_one_commitments WHERE id = $1`, [LEGACY_C1])).toEqual([
      { status: "open" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Gold List
// ---------------------------------------------------------------------------

describe("Gold List in the 1:1", () => {
  it("shows the AE's real Gold List with last/next activity", async () => {
    const ws = await json<{ gold_list: Row[] }>(api.workspace());
    expect(ws.gold_list.map((a) => a.agent_name)).toEqual(["Sarah Johnson"]);
    expect(ws.gold_list[0]).toMatchObject({
      can_edit: false,
      next_activity: null,
      last_completed: { description: "Office visit", completed_on: "2026-09-22" },
    });
  });

  it("updates the LIVE Gold List from an in-progress 1:1, attributed to the manager AND the meeting", async () => {
    const id = await startMeeting();
    const scheduled = await api.schedule(id, SARAH, { description: "Coffee", scheduled_for: "2026-10-01" });
    expect(scheduled.status).toBe(201);
    const s = await json<{ activity: Row; agent: Row }>(scheduled);
    expect(s.agent).toMatchObject({ can_edit: true, next_activity: { description: "Coffee" } });
    expect(
      (await api.schedule(id, SARAH, { description: "Dup", scheduled_for: "2026-10-02" })).status,
    ).toBe(409); // one open activity at a time — the Gold List's own rule

    const edited = await api.patchActivity(id, SARAH, s.activity.id as string, { scheduled_for: "2026-10-02" });
    expect(edited.status).toBe(200);
    const done = await api.patchActivity(id, SARAH, s.activity.id as string, {
      status: "completed",
      outcome_note: "Great chat",
    });
    expect(done.status).toBe(200);
    expect(
      await db.sql(
        `SELECT salesperson_id, created_by, completed_by, created_in_meeting_id, closed_in_meeting_id, rescheduled_in_meeting_id, status FROM gold_list_activities WHERE id = $1`,
        [s.activity.id],
      ),
    ).toEqual([
      {
        salesperson_id: AE,
        created_by: ADMIN,
        completed_by: ADMIN,
        created_in_meeting_id: id,
        closed_in_meeting_id: id,
        rescheduled_in_meeting_id: id,
        status: "completed",
      },
    ]);
    const ws = await json<{ gold_list_action_agent_ids: string[] }>(api.workspace());
    expect(ws.gold_list_action_agent_ids).toEqual([SARAH]);

    const record = await json<{ gold_list_notes: Row[] }>(api.complete(id));
    expect(record.gold_list_notes).toMatchObject([
      {
        agent_id: SARAH,
        note: null, // acted on, never noted — still recorded as discussed
        action_taken: true,
        activity_changes: [
          { kind: "scheduled", description: "Coffee", date: "2026-10-02" },
          { kind: "completed", description: "Coffee", date: "2026-09-29" },
        ],
      },
    ]);

    // The AE sees it on their own Gold List.
    const history = await json<{ activities: Row[] }>(aeGoldListActivities.GET(req(AE, "/x"), p({ id: SARAH })));
    expect(history.activities.map((a) => a.description)).toContain("Coffee");
  });

  it("does NOT attribute the AE's own Gold List activity during an open draft to the 1:1", async () => {
    const id = await startMeeting();
    await api.note(id, SARAH, "Talked about Q4");
    // While the draft is open the AE works their own list, via their routes.
    const own = await json<{ activity: Row }>(
      aeGoldListActivities.POST(
        req(AE, "/x", { method: "POST", body: { description: "AE's own call", scheduled_for: "2026-09-29" } }),
        p({ id: SARAH }),
      ),
    );
    const closed = await aeGoldListActivity.PATCH(
      req(AE, "/x", { method: "PATCH", body: { status: "completed" } }),
      p({ id: SARAH, aid: own.activity.id as string }),
    );
    expect(closed.status).toBe(200);
    expect((await json<{ gold_list_action_agent_ids: string[] }>(api.workspace())).gold_list_action_agent_ids).toEqual(
      [],
    );

    const record = await json<{ gold_list_notes: Row[] }>(api.complete(id));
    expect(record.gold_list_notes).toHaveLength(1);
    expect(record.gold_list_notes[0]).toMatchObject({
      note: "Talked about Q4",
      action_taken: false,
      activity_changes: [], // the AE's call is NOT claimed as 1:1 activity…
      last_activity_description: "AE's own call", // …though it's the live context
    });
  });

  it("keeps existing Gold List permissions", async () => {
    const id = await startMeeting();
    const viaAeRoute = await aeGoldListActivities.POST(
      req(ADMIN, "/x", { method: "POST", body: { description: "x", scheduled_for: "2026-10-01" } }),
      p({ id: SARAH }),
    );
    expect(viaAeRoute.status).toBe(404); // admins still can't write via the AE routes
    expect((await api.schedule(id, NOT_HERS, { description: "x", scheduled_for: "2026-10-01" })).status).toBe(404);
    expect((await api.note(id, NOT_HERS, "x")).status).toBe(404);
    await api.complete(id);
    expect((await api.schedule(id, SARAH, { description: "x", scheduled_for: "2026-10-01" })).status).toBe(409);
    expect(await db.sql(`SELECT count(*)::int AS n FROM gold_list_activities`)).toEqual([{ n: 1 }]);
  });

  it("keeps discussion notes meeting-specific and off the Gold List itself", async () => {
    const m1 = await startMeeting();
    await api.note(m1, SARAH, "Push for the Compass presentation");
    await api.complete(m1);
    const m2 = await startMeeting();
    expect((await json<{ gold_list_notes: Row[] }>(api.workspace())).gold_list_notes).toEqual([]);
    await api.note(m2, SARAH, "Presentation booked");
    const r1 = await json<{ gold_list_notes: Row[] }>(api.record(m1));
    expect(r1.gold_list_notes.map((n) => n.note)).toEqual(["Push for the Compass presentation"]);
    expect(await db.sql(`SELECT notes FROM gold_list_agents WHERE id = $1`, [SARAH])).toEqual([{ notes: null }]);
  });
});

// ---------------------------------------------------------------------------
// Historical accuracy
// ---------------------------------------------------------------------------

describe("completed record is historically accurate", () => {
  it("doesn't change when goals, activity, or the Gold List change later", async () => {
    const id = await startMeeting();
    await api.note(id, SARAH, "Talked about Q4");
    const done = await json<{ meeting: { activity_snapshot: Snapshot }; gold_list_notes: Row[] }>(api.complete(id));
    const frozenSnapshot = structuredClone(done.meeting.activity_snapshot);
    const frozenNote = structuredClone(done.gold_list_notes[0]);
    expect(frozenNote).toMatchObject({
      agent_name: "Sarah Johnson",
      last_activity_on: "2026-09-22",
      last_activity_description: "Office visit",
      next_activity_on: null,
    });

    await api.goals({
      start: "this_week",
      values: {
        office_visits: 5,
        service_requests: 0,
        ones_scheduled: 0,
        ones_held: 0,
        presentations: 1,
        impressions: 50,
        team_meetings: 0,
        gold_list_touches: 0,
      },
    });
    await db.sql(`INSERT INTO activity_entries (salesperson_id, entry_date, office_visits, impressions) VALUES ($1, '2026-09-29', 9, 30)`, [AE]);
    await db.sql(`UPDATE gold_list_agents SET agent_name = 'Sarah J. (renamed)' WHERE id = $1`, [SARAH]);
    const m2 = await startMeeting();
    await api.schedule(m2, SARAH, { description: "Lunch", scheduled_for: "2026-10-02" });

    const live = await json<{ activity: Snapshot }>(api.workspace());
    expect(live.activity.this_week.cells.office_visits).toMatchObject({ actual: 14, goal: 5 });

    const record = await json<{ meeting: { activity_snapshot: Snapshot }; gold_list_notes: Row[] }>(api.record(id));
    expect(record.meeting.activity_snapshot).toEqual(frozenSnapshot);
    expect(record.meeting.activity_snapshot.this_week.cells.office_visits).toMatchObject({
      actual: 5,
      goal: 20,
      percent: 25,
    });
    expect(record.gold_list_notes[0]).toEqual(frozenNote);
  });
});

// ---------------------------------------------------------------------------
// Legacy API contracts (preserved for clients built before the workspace)
// ---------------------------------------------------------------------------

describe("legacy coaching API contracts", () => {
  it("GET /api/admin/coaching/[ae_id] still returns the original Weekly Focus detail shape", async () => {
    const res = await api.legacyDetail();
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Object.keys(body).sort()).toEqual(
      [
        "ae",
        "archived_relationships",
        "carried_commitments",
        "current_week",
        "history",
        "manager_notes",
        "next_week_start",
        "relationships",
        "snapshot",
        "training",
        "weekly_goal_current",
        "weekly_goal_next_override",
      ].sort(),
    );
    expect(body.ae).toEqual({ id: AE, first_name: "Hilary" });
    expect(body.snapshot).toMatchObject({ percent: 57, week_totals: expect.objectContaining({ office_visits: 5 }) });
    expect(body.current_week).toMatchObject({ ae_id: AE, week_start: "2026-09-28", commitments: [] });
    expect(body.carried_commitments).toMatchObject([
      { id: LEGACY_C1, content: "Legacy follow-up", source_week_start: "2026-09-14" },
    ]);
    expect(body.history).toMatchObject([{ id: WEEK1, week_start: "2026-09-14" }]);
    expect(body.weekly_goal_current).toMatchObject({ source: "personal", values: expect.objectContaining({ office_visits: 20 }) });
  });

  it("GET /api/admin/coaching keeps the original summary fields and adds the 1:1 ones", async () => {
    const m = await startMeeting();
    await api.addCommitment(m, { description: "x" });
    const { summaries } = await json<{ summaries: Row[] }>(api.coachingList());
    const hilary = summaries.find((s) => s.id === AE)!;
    expect(hilary).toMatchObject({
      first_name: "Hilary",
      percent: 57,
      latest_week_start: "2026-09-14",
      open_commitments: 0,
      carried_commitments: 1,
      last_one_on_one_date: null,
      one_on_one_in_progress: true,
      open_one_on_one_commitments: 1,
    });
    expect(Object.keys(hilary).sort()).toEqual(
      [
        "id",
        "first_name",
        "percent",
        "rank",
        "latest_week_start",
        "open_commitments",
        "carried_commitments",
        "last_one_on_one_date",
        "one_on_one_in_progress",
        "open_one_on_one_commitments",
      ].sort(),
    );
  });

  it("GET …/legacy is the read-only view the workspace uses", async () => {
    const body = await json<{ weeks: Row[] }>(api.legacyRead());
    expect(body.weeks).toMatchObject([{ id: WEEK1, notes_focus: "Old focus", manager_notes: null }]);
    expect(body.weeks[0].commitments).toMatchObject([{ id: LEGACY_C1 }]);
  });
});

// ---------------------------------------------------------------------------
// Legacy Weekly Focus commitments edited from inside a 1:1
// ---------------------------------------------------------------------------

describe("legacy commitments vs. completion", () => {
  const legacyRow = async () =>
    (await db.sql(`SELECT status, completed, content, due_date FROM one_on_one_commitments WHERE id = $1`, [LEGACY_C1]))[0];
  const reviewOf = async (meetingId: string) =>
    (await json<{ commitment_reviews: Row[] }>(api.record(meetingId))).commitment_reviews.find(
      (r) => r.legacy_commitment_id === LEGACY_C1,
    );

  it("a change that commits first lands IN the snapshot", async () => {
    const id = await startMeeting();
    const res = await api.legacyScoped(id, LEGACY_C1, { status: "completed" });
    expect(res.status).toBe(200);
    expect((await json<{ commitment: Row }>(res)).commitment).toMatchObject({ status: "completed", completed: true });
    await api.complete(id);
    expect(await reviewOf(id)).toMatchObject({ status: "completed", origin: "carryover" });
  });

  // The exact interleaving: the route passed its in-progress check, then the
  // 1:1 completes, then the route's transactional write runs.
  for (const [label, run, before] of [
    ["toggle complete", (id: string) => api.legacyScoped(id, LEGACY_C1, { status: "completed" }), "open"],
    ["edit", (id: string) => api.legacyScoped(id, LEGACY_C1, { content: "Reworded", due_date: "2026-10-09" }), "open"],
    ["drop (DELETE)", (id: string) => api.legacyScopedDrop(id, LEGACY_C1), "open"],
  ] as const) {
    it(`${label}: can't land after the frozen snapshot`, async () => {
      const id = await startMeeting();
      db.beforeWrite("update_legacy_commitment_in_one_on_one", "rpc", async () => {
        expect((await api.complete(id)).status).toBe(200);
      });
      const res = await run(id);
      expect(res.status).toBe(409);
      expect(await json(res)).toMatchObject({ error: "This 1:1 is completed and read-only." });
      expect(await legacyRow()).toMatchObject({ status: before, content: "Legacy follow-up", due_date: null });
      // Snapshot and live row agree — nothing changed behind the record.
      expect(await reviewOf(id)).toMatchObject({ status: before, description: "Legacy follow-up" });
    });
  }

  it("reopen: can't land after the frozen snapshot either", async () => {
    await db.sql(`UPDATE one_on_one_commitments SET status = 'completed', completed = true, completed_at = now() WHERE id = $1`, [
      LEGACY_C1,
    ]);
    const id = await startMeeting();
    db.beforeWrite("update_legacy_commitment_in_one_on_one", "rpc", async () => {
      await api.complete(id);
    });
    expect((await api.legacyScoped(id, LEGACY_C1, { status: "open" })).status).toBe(409);
    expect(await legacyRow()).toMatchObject({ status: "completed", completed: true });
  });

  it("refuses a legacy commitment of another AE through this AE's 1:1", async () => {
    const other = "dddddddd-0000-4000-8000-000000000009";
    await db.sql(
      `INSERT INTO one_on_ones (id, ae_id, week_start, meeting_date) VALUES ('cccccccc-0000-4000-8000-000000000009', $1, '2026-09-14', '2026-09-15')`,
      [OTHER_AE],
    );
    await db.sql(
      `INSERT INTO one_on_one_commitments (id, one_on_one_id, ae_id, content, status) VALUES ($1, 'cccccccc-0000-4000-8000-000000000009', $2, 'Kennedy legacy', 'open')`,
      [other, OTHER_AE],
    );
    const id = await startMeeting();
    expect((await api.legacyScoped(id, other, { status: "completed" })).status).toBe(404);
  });

  it("a failed legacy write leaves the 1:1 in progress and completable", async () => {
    const id = await startMeeting();
    const rpc = db.client.rpc;
    db.client.rpc = async () => ({ data: null, error: { code: "08006", message: "connection reset" } });
    try {
      expect((await api.legacyScoped(id, LEGACY_C1, { status: "completed" })).status).toBe(500);
    } finally {
      db.client.rpc = rpc;
    }
    expect(await meetingRow(id)).toMatchObject({ status: "in_progress" });
    expect(await legacyRow()).toMatchObject({ status: "open" });
    expect((await api.legacyScoped(id, LEGACY_C1, { status: "completed" })).status).toBe(200); // retry
    expect((await api.complete(id)).status).toBe(200);
    expect(await reviewOf(id)).toMatchObject({ status: "completed" });
  });

  it("the original Weekly Focus route is unchanged outside a 1:1", async () => {
    const res = await api.legacyOld(LEGACY_C1, { status: "completed" });
    expect(res.status).toBe(200);
    expect(await legacyRow()).toMatchObject({ status: "completed", completed: true });
  });
});

// ---------------------------------------------------------------------------
// Cross-tab optimistic concurrency
// ---------------------------------------------------------------------------

describe("draft text: a stale tab can't overwrite newer work", () => {
  it("meeting fields: newer save wins; the stale save gets 409 with the newer text", async () => {
    const id = await startMeeting();
    const tabA = await api.saveField(id, "wins", "Tab A — newer", 0);
    expect(tabA.status).toBe(200);
    expect(await json(tabA)).toMatchObject({ field: "wins", revision: 1 });

    const tabB = await api.saveField(id, "wins", "Tab B — stale", 0);
    expect(tabB.status).toBe(409);
    expect(await json(tabB)).toMatchObject({ conflict: { value: "Tab A — newer", revision: 1 } });
    expect(await meetingRow(id)).toMatchObject({ wins: "Tab A — newer", wins_rev: 1 });

    // Another field is independent: no false conflict.
    expect((await api.saveField(id, "coaching_notes", "Tab B notes", 0)).status).toBe(200);
    // "Keep mine": re-save on top of the revision the conflict reported.
    const keepMine = await api.saveField(id, "wins", "Tab B — stale", 1);
    expect(keepMine.status).toBe(200);
    expect(await meetingRow(id)).toMatchObject({ wins: "Tab B — stale", wins_rev: 2, coaching_notes: "Tab B notes" });
  });

  it("discussion notes: first note from two tabs, and stale edits, conflict instead of overwriting", async () => {
    const id = await startMeeting();
    const first = await api.saveNote(id, SARAH, "Tab A note", 0);
    expect(first.status).toBe(200);
    expect((await json<{ note: Row }>(first)).note).toMatchObject({ note: "Tab A note", revision: 1 });

    const racingCreate = await api.saveNote(id, SARAH, "Tab B note", 0);
    expect(racingCreate.status).toBe(409);
    expect(await json(racingCreate)).toMatchObject({ conflict: { value: "Tab A note", revision: 1 } });

    expect((await api.saveNote(id, SARAH, "Tab A edit", 1)).status).toBe(200);
    const staleEdit = await api.saveNote(id, SARAH, "Tab B edit", 1);
    expect(staleEdit.status).toBe(409);
    expect(await json(staleEdit)).toMatchObject({ conflict: { value: "Tab A edit", revision: 2 } });
    expect(
      await db.sql(`SELECT note, revision FROM one_on_one_gold_list_notes WHERE meeting_id = $1`, [id]),
    ).toEqual([{ note: "Tab A edit", revision: 2 }]);
  });

  it("a stale save to a completed meeting is read-only, not a conflict", async () => {
    const id = await startMeeting();
    await api.complete(id);
    const res = await api.saveField(id, "wins", "late", 0);
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: "This 1:1 is completed and read-only." });
  });
});

// ---------------------------------------------------------------------------
// History pagination with tied completed_at
// ---------------------------------------------------------------------------

describe("history pagination", () => {
  it("returns every completed 1:1 exactly once when completed_at values tie", async () => {
    // 45 completed meetings sharing only 3 distinct completed_at instants
    // (inserted directly — completed rows can't be updated).
    const stamps = ["2026-09-01T18:00:00.123456+00:00", "2026-08-01T18:00:00.123456+00:00", "2026-07-01T18:00:00+00:00"];
    const expected: Array<{ id: string; at: string }> = [];
    for (let i = 0; i < 45; i++) {
      const at = stamps[i % 3];
      const [row] = await db.sql<{ id: string }>(
        `INSERT INTO one_on_one_meetings (ae_id, meeting_date, status, started_at, completed_at, activity_snapshot)
         VALUES ($1, $2::timestamptz::date, 'completed', $2, $2, '{"version":1}') RETURNING id`,
        [AE, at],
      );
      expected.push({ id: row.id, at });
    }
    const seen: string[] = [];
    const page = await json<{ history: Row[]; history_has_more: boolean }>(api.workspace());
    seen.push(...page.history.map((h) => h.id as string));
    let more = page.history_has_more;
    let cursor = page.history.at(-1)!;
    let guard = 0;
    while (more && guard++ < 10) {
      const next = await json<{ items: Row[]; has_more: boolean }>(
        api.history({ completed_at: cursor.completed_at as string, id: cursor.id as string }),
      );
      seen.push(...next.items.map((h) => h.id as string));
      more = next.has_more;
      cursor = next.items.at(-1)!;
    }
    expect(seen).toHaveLength(45);
    expect(new Set(seen).size).toBe(45); // no duplicates
    const order = [...expected].sort((a, b) =>
      a.at === b.at ? (a.id < b.id ? 1 : -1) : Date.parse(b.at) - Date.parse(a.at),
    );
    expect(seen).toEqual(order.map((e) => e.id)); // newest first, then id desc
  });
});

// ---------------------------------------------------------------------------
// The ORIGINAL Weekly Focus commitment route (compatibility) vs. 1:1s
// ---------------------------------------------------------------------------

describe("compatibility route /api/admin/one-on-ones/[week]/commitments/[cid]", () => {
  const LEGACY_COLUMNS = [
    "id",
    "one_on_one_id",
    "ae_id",
    "content",
    "completed",
    "completed_at",
    "due_date",
    "created_at",
    "updated_at",
    "status",
  ].sort();
  const oldPatch = (body: unknown, week = WEEK1, cid = LEGACY_C1) =>
    legacyOldRoute.PATCH(req(ADMIN, "/x", { method: "PATCH", body }), p({ id: week, cid }));
  const oldDelete = (week = WEEK1, cid = LEGACY_C1) =>
    legacyOldRoute.DELETE(req(ADMIN, "/x", { method: "DELETE" }), p({ id: week, cid }));
  const row = async () =>
    (await db.sql(`SELECT status, completed, content, due_date FROM one_on_one_commitments WHERE id = $1`, [LEGACY_C1]))[0];
  const reviewOf = async (meetingId: string) =>
    (await json<{ commitment_reviews: Row[] }>(api.record(meetingId))).commitment_reviews.find(
      (r) => r.legacy_commitment_id === LEGACY_C1,
    );

  const OPS = [
    {
      name: "toggle complete",
      run: () => oldPatch({ status: "completed" }),
      after: { status: "completed", completed: true },
    },
    {
      name: "toggle via legacy `completed` boolean",
      run: () => oldPatch({ completed: true }),
      after: { status: "completed", completed: true },
    },
    {
      name: "edit",
      run: () => oldPatch({ content: "Reworded", due_date: "2026-10-09" }),
      after: { content: "Reworded", due_date: "2026-10-09" },
    },
    { name: "delete (soft drop)", run: () => oldDelete(), after: { status: "dropped", completed: false } },
  ] as const;

  describe("no active 1:1 — behaves exactly as before", () => {
    for (const op of OPS) {
      it(op.name, async () => {
        const res = await op.run();
        expect(res.status).toBe(200);
        const body = await json<{ commitment: Row }>(res);
        expect(Object.keys(body)).toEqual(["commitment"]);
        expect(Object.keys(body.commitment).sort()).toEqual(LEGACY_COLUMNS);
        expect(body.commitment).toMatchObject({ id: LEGACY_C1, one_on_one_id: WEEK1, ...op.after });
        expect(await row()).toMatchObject(op.after);
      });
    }

    it("reopen", async () => {
      await oldPatch({ status: "completed" });
      const res = await oldPatch({ status: "open" });
      expect(res.status).toBe(200);
      expect((await json<{ commitment: Row }>(res)).commitment).toMatchObject({
        status: "open",
        completed: false,
        completed_at: null,
      });
    });

    it("keeps its errors: 404 on a mismatched week, 400 on an empty or ambiguous body", async () => {
      const wrongWeek = "cccccccc-0000-4000-8000-00000000ffff";
      expect((await oldPatch({ status: "completed" }, wrongWeek)).status).toBe(404);
      expect((await oldDelete(wrongWeek)).status).toBe(404);
      expect((await oldPatch({})).status).toBe(400);
      expect((await oldPatch({ status: "completed", completed: true })).status).toBe(400);
      expect(await row()).toMatchObject({ status: "open" });
    });

    it("isn't blocked by the AE's COMPLETED 1:1s", async () => {
      await api.complete(await startMeeting());
      expect((await oldPatch({ status: "completed" })).status).toBe(200);
    });
  });

  describe("active 1:1 for the same AE", () => {
    for (const op of OPS) {
      it(`${op.name}: a write that commits first is in the snapshot`, async () => {
        const id = await startMeeting();
        expect((await op.run()).status).toBe(200);
        await api.complete(id);
        const review = await reviewOf(id);
        if ("content" in op.after) expect(review).toMatchObject({ description: op.after.content });
        if ("status" in op.after) expect(review).toMatchObject({ status: op.after.status });
      });

      it(`${op.name}: staged between the route's checks and its DB write, completion wins — the write lands AFTER, not through, the snapshot`, async () => {
        const id = await startMeeting();
        db.beforeWrite("update_legacy_commitment", "rpc", async () => {
          expect((await api.complete(id)).status).toBe(200);
        });
        const res = await op.run();
        expect(res.status).toBe(200); // contract: old clients aren't rejected
        expect(await row()).toMatchObject(op.after); // live row moved on…
        expect(await reviewOf(id)).toMatchObject({
          status: "open",
          description: "Legacy follow-up",
        }); // …the frozen record did not
      });
    }

    it("reopen: staged after the route's checks, completion wins", async () => {
      await db.sql(`UPDATE one_on_one_commitments SET status = 'completed', completed = true, completed_at = now() WHERE id = $1`, [
        LEGACY_C1,
      ]);
      const id = await startMeeting();
      db.beforeWrite("update_legacy_commitment", "rpc", async () => {
        await api.complete(id);
      });
      expect((await oldPatch({ status: "open" })).status).toBe(200);
      expect(await row()).toMatchObject({ status: "open" });
      expect(await reviewOf(id)).toMatchObject({ status: "completed" });
    });
  });

  it("cross-AE: another AE's 1:1 neither blocks nor captures this AE's write", async () => {
    const theirs = await startMeeting(OTHER_AE);
    expect((await oldPatch({ status: "completed" })).status).toBe(200);
    await api.complete(theirs);
    const record = await json<{ commitment_reviews: Row[] }>(api.record(theirs));
    expect(record.commitment_reviews.some((r) => r.legacy_commitment_id === LEGACY_C1)).toBe(false);
  });
});
