/**
 * Private Test AE — regression tests (real Postgres via PGlite, real auth).
 *
 * A test account (`salespeople.is_test = true`) owned by one admin
 * (`test_owner_id`) is:
 *   * VISIBLE only to its owner in workflows (Weekly Focus, 1:1s, goals,
 *     Gold List, selectors) — anyone else gets 404, never a hint it exists;
 *   * EXCLUDED from every company/team aggregate for EVERY viewer, owner
 *     included;
 *   * scored on its OWN pages by the same single-AE scoring path;
 *   * signed into only with its PIN.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDb, type TestDb } from "@/test/pglite-supabase";

process.env.SESSION_SECRET = "test-session-secret";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ getServerSupabase: () => holder.client }));

const { signSessionToken } = await import("@/lib/server/auth");
const { computeStandings } = await import("@/lib/server/leaderboard-standings");
const { buildActivityReport, buildSingleAeActivityWeek } = await import("@/lib/server/activity-report");
const { adjustedWeekScore, resolveActiveGoal } = await import("@/lib/goals");

const login = await import("@/app/api/auth/login/route");
const coachingList = await import("@/app/api/admin/coaching/route");
const legacyDetail = await import("@/app/api/admin/coaching/[ae_id]/route");
const legacyRead = await import("@/app/api/admin/coaching/[ae_id]/legacy/route");
const goalsRoute = await import("@/app/api/admin/coaching/[ae_id]/goals/route");
const relationships = await import("@/app/api/admin/coaching/[ae_id]/relationships/route");
const training = await import("@/app/api/admin/coaching/[ae_id]/training/route");
const workspace = await import("@/app/api/admin/coaching/[ae_id]/meetings/route");
const history = await import("@/app/api/admin/coaching/[ae_id]/meetings/history/route");
const meetingRoute = await import("@/app/api/admin/one-on-one-meetings/[id]/route");
const completeRoute = await import("@/app/api/admin/one-on-one-meetings/[id]/complete/route");
const mCommitments = await import("@/app/api/admin/one-on-one-meetings/[id]/commitments/route");
const mNote = await import("@/app/api/admin/one-on-one-meetings/[id]/gold-list/[agentId]/route");
const mActivities = await import("@/app/api/admin/one-on-one-meetings/[id]/gold-list/[agentId]/activities/route");
const mLegacy = await import("@/app/api/admin/one-on-one-meetings/[id]/legacy-commitments/[cid]/route");
const weekPatch = await import("@/app/api/admin/one-on-ones/[id]/route");
const weekCommitments = await import("@/app/api/admin/one-on-ones/[id]/commitments/route");
const weekCommitment = await import("@/app/api/admin/one-on-ones/[id]/commitments/[cid]/route");
const goldAgents = await import("@/app/api/gold-list/agents/route");
const goldActivities = await import("@/app/api/gold-list/agents/[id]/activities/route");
const leaderboard = await import("@/app/api/leaderboard/route");
const adminLeaderboard = await import("@/app/api/admin/leaderboard/route");
const scorecard = await import("@/app/api/admin/scorecard/route");
const activityReport = await import("@/app/api/admin/reports/activity/route");
const activityTotals = await import("@/app/api/admin/activity-totals/route");
const verification = await import("@/app/api/business-card/verification/route");
const rejectScan = await import("@/app/api/business-card/reject/route");
const exportContacts = await import("@/app/api/business-card/contacts/export/route");
const teamMessages = await import("@/app/api/team-messages/route");
const reactions = await import("@/app/api/team-messages/[id]/reactions/route");
const signUpload = await import("@/app/api/juice-box/media/sign-upload/route");
const { isAttributableAe } = await import("@/lib/server/cogent");

type Row = Record<string, unknown>;

const COREY = "55555555-5555-4555-8555-555555555555"; // admin, owns the Test AE
const RYAN = "66666666-6666-4666-8666-666666666666"; // another admin
const HILARY = "11111111-1111-4111-8111-111111111111"; // real AE
const KENNEDY = "22222222-2222-4222-8222-222222222222"; // real AE
const TEST_AE = "99999999-9999-4999-8999-999999999999"; // is_test, owner = Corey
const ORPHAN = "88888888-8888-4888-8888-888888888888"; // is_test, NO owner
const TEST_AGENT = "aaaaaaaa-0000-4000-8000-0000000000a1";
const TEST_WEEK = "cccccccc-0000-4000-8000-0000000000c1";
const TEST_LEGACY_C = "dddddddd-0000-4000-8000-0000000000d1";
const TEST_SCAN = "eeeeeeee-0000-4000-8000-0000000000e1";
const REAL_SCAN = "eeeeeeee-0000-4000-8000-0000000000e2";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  holder.client = db.client;
}, 60_000);

const PEOPLE: Record<string, { name: string; role: string; is_test?: boolean; owner?: string; pin?: string }> = {
  [COREY]: { name: "Corey", role: "admin", pin: "1111" },
  [RYAN]: { name: "Ryan", role: "admin", pin: "2222" },
  [HILARY]: { name: "Hilary", role: "ae" },
  [KENNEDY]: { name: "Kennedy", role: "ae" },
  [TEST_AE]: { name: "Test AE", role: "ae", is_test: true, owner: COREY, pin: "4242" },
  [ORPHAN]: { name: "Old Test", role: "ae", is_test: true, pin: "0000" },
};

async function seed() {
  await db.reset();
  for (const [id, p] of Object.entries(PEOPLE)) {
    await db.sql(
      `INSERT INTO salespeople (id, first_name, role, is_test, admin_pin) VALUES ($1, $2, $3, $4, $5)`,
      [id, p.name, p.role, p.is_test === true, p.pin ?? null],
    );
  }
  await db.sql(`UPDATE salespeople SET test_owner_id = $1 WHERE id = $2`, [COREY, TEST_AE]);
  await db.sql(
    `INSERT INTO weekly_goals (salesperson_id, effective_from, office_visits, impressions, presentations, created_at)
     VALUES (NULL, '2026-01-05', 40, 150, 1, '2026-01-01'), ($1, '2026-09-28', 20, 100, 1, '2026-09-27')`,
    [TEST_AE],
  );
  // Real activity.
  await db.sql(
    `INSERT INTO activity_entries (salesperson_id, entry_date, office_visits, impressions, presentations) VALUES
       ($1, '2026-09-22', 30, 120, 1), ($1, '2026-09-28', 8, 40, 0),
       ($2, '2026-09-23', 20, 90, 1), ($2, '2026-09-29', 4, 30, 1)`,
    [HILARY, KENNEDY],
  );
}

/** Substantial test activity (last week + this week). */
async function addTestActivity() {
  await db.sql(
    `INSERT INTO activity_entries (salesperson_id, entry_date, office_visits, impressions, presentations, ones_held) VALUES
       ($1, '2026-09-21', 200, 900, 9, 9), ($1, '2026-09-24', 150, 700, 5, 5),
       ($1, '2026-09-28', 12, 55, 1, 0), ($1, '2026-09-29', 6, 30, 1, 0),
       ($2, '2026-09-29', 500, 500, 50, 50)`,
    [TEST_AE, ORPHAN],
  );
}

function token(id: string, opts: { tp?: boolean } = {}) {
  const p = PEOPLE[id];
  return signSessionToken({
    sub: id,
    role: p.role as never,
    name: p.name,
    ...(opts.tp ? { tp: true as const } : {}),
  });
}
function req(who: string | null, path: string, init: { method?: string; body?: unknown; tp?: boolean } = {}) {
  return new Request(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(who ? { Authorization: `Bearer ${token(who, { tp: init.tp ?? PEOPLE[who]?.is_test })}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
async function json<T = Row>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}
const startMeeting = async (who: string, ae: string) =>
  (await json<{ meeting: Row }>(workspace.POST(req(who, "/x", { method: "POST" }), p({ ae_id: ae })))).meeting
    .id as string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-29T18:00:00.000Z"));
  await seed();
});
afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------
// Migration rules
// ---------------------------------------------------------------------------

describe("data model", () => {
  it("a real salesperson can't have a test owner", async () => {
    await expect(db.sql(`UPDATE salespeople SET test_owner_id = $1 WHERE id = $2`, [COREY, HILARY])).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("contacts from test scans (or for test accounts) are stamped is_test_data", async () => {
    await db.sql(
      `INSERT INTO business_card_scans (id, salesperson_id, image_url, is_test_data) VALUES ($1, $2, 'x', true), ($3, $4, 'y', false)`,
      [TEST_SCAN, TEST_AE, REAL_SCAN, HILARY],
    );
    await db.sql(
      `INSERT INTO business_card_contacts (scan_id, salesperson_id, contact_bucket, full_name) VALUES
         ($1, $2, 'agent', 'From test scan'), (NULL, $2, 'agent', 'For test AE'), ($3, $4, 'agent', 'Real')`,
      [TEST_SCAN, TEST_AE, REAL_SCAN, HILARY],
    );
    expect(
      await db.sql(`SELECT full_name, is_test_data FROM business_card_contacts ORDER BY full_name`),
    ).toEqual([
      { full_name: "For test AE", is_test_data: true },
      { full_name: "From test scan", is_test_data: true },
      { full_name: "Real", is_test_data: false },
    ]);
  });

  it("the migration re-runs cleanly", async () => {
    await db.asOwner(readFileSync(join(process.cwd(), "supabase/private_test_accounts.sql"), "utf8"));
    expect(await db.sql(`SELECT test_owner_id FROM salespeople WHERE id = $1`, [TEST_AE])).toEqual([
      { test_owner_id: COREY },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

describe("workflow privacy", () => {
  it("the Weekly Focus list shows Test AE to its owner only (last, unranked); an unowned test account to no one", async () => {
    await addTestActivity();
    const mine = (await json<{ summaries: Row[] }>(coachingList.GET(req(COREY, "/api/admin/coaching")))).summaries;
    const theirs = (await json<{ summaries: Row[] }>(coachingList.GET(req(RYAN, "/api/admin/coaching")))).summaries;
    expect(mine.map((s) => s.id)).toEqual([expect.any(String), expect.any(String), TEST_AE]);
    expect(mine.at(-1)).toMatchObject({ id: TEST_AE, rank: null });
    expect((mine.at(-1)!.percent as number) > 0).toBe(true);
    expect(theirs.map((s) => s.id).sort()).toEqual([HILARY, KENNEDY].sort());
    expect(mine.some((s) => s.id === ORPHAN) || theirs.some((s) => s.id === ORPHAN)).toBe(false);
    // Real ranks are identical for both viewers — the test AE takes no rank.
    const ranks = (xs: Row[]) => xs.filter((s) => s.id !== TEST_AE).map((s) => [s.id, s.rank, s.percent]);
    expect(ranks(mine)).toEqual(ranks(theirs));
  });

  it("the owner can open everything; another admin gets 404 on every Test AE manager route", async () => {
    const ae = p({ ae_id: TEST_AE });
    const calls: Array<(who: string) => Promise<Response>> = [
      (w) => workspace.GET(req(w, "/x"), ae),
      (w) => history.GET(req(w, "/x"), ae),
      (w) => legacyRead.GET(req(w, "/x"), ae),
      (w) => legacyDetail.GET(req(w, "/x"), ae),
    ];
    for (const call of calls) {
      expect((await call(COREY)).status).toBe(200);
      expect((await call(RYAN)).status).toBe(404);
    }
    const addRel = (w: string) =>
      relationships.POST(req(w, "/x", { method: "POST", body: { contact_name: `By ${w}` } }), ae);
    const addTraining = (w: string) => training.POST(req(w, "/x", { method: "POST", body: { content: `By ${w}` } }), ae);
    expect((await addRel(RYAN)).status).toBe(404);
    expect((await addTraining(RYAN)).status).toBe(404);
    expect((await addRel(COREY)).ok).toBe(true);
    expect((await addTraining(COREY)).ok).toBe(true);
    const goalBody = {
      start: "next_week",
      values: { office_visits: 1, service_requests: 0, ones_scheduled: 0, ones_held: 0, presentations: 0, impressions: 0, team_meetings: 0, gold_list_touches: 0 },
    };
    expect((await goalsRoute.PUT(req(RYAN, "/x", { method: "PUT", body: goalBody }), ae)).status).toBe(404);
    expect((await workspace.POST(req(RYAN, "/x", { method: "POST" }), ae)).status).toBe(404);
    expect((await goalsRoute.PUT(req(COREY, "/x", { method: "PUT", body: goalBody }), ae)).status).toBe(200);
    // An orphaned test account is private to everyone.
    expect((await workspace.GET(req(COREY, "/x"), p({ ae_id: ORPHAN }))).status).toBe(404);
  });

  it("a Test AE meeting id is useless to another admin", async () => {
    const id = await startMeeting(COREY, TEST_AE);
    const m = p({ id });
    const calls: Array<(who: string) => Promise<Response>> = [
      (w) => meetingRoute.GET(req(w, "/x"), m),
      (w) => meetingRoute.PATCH(req(w, "/x", { method: "PATCH", body: { field: "wins", value: "x", expected_revision: 0 } }), m),
      (w) => mCommitments.POST(req(w, "/x", { method: "POST", body: { description: "x" } }), m),
      (w) => mNote.PUT(req(w, "/x", { method: "PUT", body: { note: "x", expected_revision: 0 } }), p({ id, agentId: TEST_AGENT })),
      (w) => mLegacy.PATCH(req(w, "/x", { method: "PATCH", body: { status: "completed" } }), p({ id, cid: TEST_LEGACY_C })),
      (w) => completeRoute.POST(req(w, "/x", { method: "POST" }), m),
    ];
    for (const call of calls) expect((await call(RYAN)).status).toBe(404);
    expect(await db.sql(`SELECT status, wins FROM one_on_one_meetings WHERE id = $1`, [id])).toEqual([
      { status: "in_progress", wins: null },
    ]);
    expect((await meetingRoute.GET(req(COREY, "/x"), m)).status).toBe(200);
  });

  it("legacy Weekly Focus week routes: another admin gets 404", async () => {
    await db.sql(
      `INSERT INTO one_on_ones (id, ae_id, week_start, meeting_date) VALUES ($1, $2, '2026-09-14', '2026-09-15')`,
      [TEST_WEEK, TEST_AE],
    );
    await db.sql(
      `INSERT INTO one_on_one_commitments (id, one_on_one_id, ae_id, content, status) VALUES ($1, $2, $3, 'Test legacy', 'open')`,
      [TEST_LEGACY_C, TEST_WEEK, TEST_AE],
    );
    const w = p({ id: TEST_WEEK });
    expect((await weekPatch.PATCH(req(RYAN, "/x", { method: "PATCH", body: { notes_wins: "x" } }), w)).status).toBe(404);
    expect((await weekCommitments.POST(req(RYAN, "/x", { method: "POST", body: { content: "x" } }), w)).status).toBe(404);
    const c = p({ id: TEST_WEEK, cid: TEST_LEGACY_C });
    const denied = await weekCommitment.PATCH(req(RYAN, "/x", { method: "PATCH", body: { status: "completed" } }), c);
    expect(denied.status).toBe(404);
    expect(await json(denied)).toEqual({ error: "Commitment not found." });
    expect((await weekCommitment.PATCH(req(COREY, "/x", { method: "PATCH", body: { status: "completed" } }), c)).status).toBe(200);
  });

  it("real AEs can't reach manager data at all", async () => {
    expect((await workspace.GET(req(HILARY, "/x"), p({ ae_id: TEST_AE }))).status).toBe(403);
    expect((await coachingList.GET(req(HILARY, "/api/admin/coaching"))).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

describe("Test AE sign-in", () => {
  const signIn = (name: string, pin?: string) =>
    login.POST(new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pin === undefined ? { name } : { name, pin }),
    }));

  it("requires the PIN server-side", async () => {
    expect((await signIn("Test AE")).status).toBe(401);
    expect((await signIn("Test AE", "9999")).status).toBe(401);
    const ok = await signIn("Test AE", "4242");
    expect(ok.status).toBe(200);
    const body = await json<{ salesperson: Row; token: string }>(ok);
    expect(body.salesperson).toMatchObject({ id: TEST_AE, is_test: true, role: "ae" });
    // The PIN-verified session works on an AE route.
    const mine = await goldAgents.GET(
      new Request("http://localhost/api/gold-list/agents", { headers: { Authorization: `Bearer ${body.token}` } }),
    );
    expect(mine.status).toBe(200);
  });

  it("refuses a test account with no PIN set", async () => {
    await db.sql(`UPDATE salespeople SET admin_pin = NULL WHERE id = $1`, [TEST_AE]);
    expect((await signIn("Test AE", "")).status).toBe(401);
  });

  it("invalidates a test-account session minted without the PIN (e.g. before this change)", async () => {
    const res = await goldAgents.GET(req(TEST_AE, "/api/gold-list/agents", { tp: false }));
    expect(res.status).toBe(401);
  });

  it("leaves real AE sign-in exactly as it was (name only)", async () => {
    const res = await signIn("Hilary");
    expect(res.status).toBe(200);
    const body = await json<{ salesperson: Row; token: string }>(res);
    expect(body.salesperson).toMatchObject({ id: HILARY, is_test: false, role: "ae" });
    const mine = await goldAgents.GET(
      new Request("http://localhost/api/gold-list/agents", { headers: { Authorization: `Bearer ${body.token}` } }),
    );
    expect(mine.status).toBe(200);
  });

  it("keeps test accounts out of the public login name list", () => {
    const page = readFileSync(join(process.cwd(), "src/app/page.tsx"), "utf8");
    const query = page.slice(page.indexOf('.from("salespeople")'), page.indexOf(".then(", page.indexOf('.from("salespeople")')));
    expect(query).toContain('.eq("is_test", false)');
  });
});

// ---------------------------------------------------------------------------
// Reporting exclusion
// ---------------------------------------------------------------------------

describe("reporting: test activity never changes company/team numbers", () => {
  const WEEK = "2026-09-27"; // Sun of the current activity week (pickers send Sun or Mon)
  /** Every report must succeed AND contain the real team — no vacuous equality. */
  const ok = async (res: Response | Promise<Response>) => {
    const r = await res;
    const body = await r.json();
    expect(r.status, JSON.stringify(body).slice(0, 200)).toBe(200);
    const text = JSON.stringify(body);
    expect(text).toContain(HILARY);
    expect(text).toContain(KENNEDY);
    return body;
  };
  const reports = async (who: string) => ({
    leaderboard: await ok(leaderboard.GET(req(who, "/api/leaderboard"))),
    adminLeaderboard: await ok(adminLeaderboard.GET(req(who, `/x?weekStart=${WEEK}`))),
    scorecard: await ok(scorecard.GET(req(who, `/x?weekStart=${WEEK}`))),
    activityReport: await ok(activityReport.GET(req(who, `/x?weekStart=${WEEK}`))),
    totals: await ok(activityTotals.GET(req(who, `/x?from=2026-09-20&to=2026-10-03&salesperson=all`))),
    coachingRanks: (await json<{ summaries: Row[] }>(coachingList.GET(req(RYAN, "/api/admin/coaching")))).summaries,
  });

  it("leaderboards, scorecard, activity report, team totals and ranks are identical with or without heavy test activity — for the owner too", async () => {
    const before = await reports(COREY);
    await addTestActivity();
    const after = await reports(COREY);
    const strip = (v: unknown) => JSON.parse(JSON.stringify(v).replace(/"(computed_at|generatedAt|generated_at)":"[^"]*"/g, '"$1":""'));
    expect(strip(after)).toEqual(strip(before));
    const blob = JSON.stringify(after);
    expect(blob).not.toContain(TEST_AE);
    expect(blob).not.toContain(ORPHAN);
    expect(blob).not.toContain("Test AE");
  });

  it("the canonical team calculations never include a test account", async () => {
    await addTestActivity();
    const standings = await computeStandings(db.client as never, "2026-09-28", "2026-09-29", "2026-09-28", "2026-09-29");
    expect(standings.standings.map((s) => s.id).sort()).toEqual([HILARY, KENNEDY].sort());
    const report = await buildActivityReport(db.client as never, "2026-09-28", "2026-09-29", "2026-09-28", "2026-09-29");
    expect(report.rows.map((r) => r.id).sort()).toEqual([HILARY, KENNEDY].sort());
  });

  it("Cogent order attribution skips test accounts", () => {
    expect(isAttributableAe({ role: "ae", is_test: true, deactivated_at: null } as never)).toBe(false);
    expect(isAttributableAe({ role: "ae", is_test: false, deactivated_at: null } as never)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test AE's own 1:1 numbers
// ---------------------------------------------------------------------------

describe("Test AE 1:1 Activity & Results", () => {
  it("shows its own Last Week vs This Week, scored on its goals by the canonical path", async () => {
    await addTestActivity();
    const ws = await json<{ activity: { last_week: Row & { cells: Record<string, Row> }; this_week: Row & { cells: Record<string, Row> } } }>(
      workspace.GET(req(COREY, "/x"), p({ ae_id: TEST_AE })),
    );
    // Last week: team goal (40 visits) — its personal goal starts this Monday.
    expect(ws.activity.last_week.cells.office_visits).toMatchObject({ actual: 350, goal: 40, percent: 875 });
    // This week: personal goal (20 visits).
    expect(ws.activity.this_week.cells.office_visits).toMatchObject({ actual: 18, goal: 20, percent: 90 });
    const goals = await db.sql(`SELECT id, salesperson_id, effective_from::text, created_at, office_visits, service_requests, ones_scheduled, ones_held, presentations, impressions, team_meetings, gold_list_touches FROM weekly_goals`);
    const expected = adjustedWeekScore(
      { office_visits: 18, impressions: 85, presentations: 2, ones_held: 0 },
      resolveActiveGoal(TEST_AE, goals as never, "2026-09-28"),
      5,
    );
    expect(ws.activity.this_week.score).toBe(expected.percent);
  });

  it("the single-AE path gives a real AE exactly the team report's numbers", async () => {
    const team = await buildActivityReport(db.client as never, "2026-09-21", "2026-09-25", "2026-09-21", "2026-09-29");
    const single = await buildSingleAeActivityWeek(db.client as never, { id: HILARY, first_name: "Hilary" }, "2026-09-21", "2026-09-25", "2026-09-21", "2026-09-29");
    expect(single.row).toEqual(team.rows.find((r) => r.id === HILARY));
  });
});

// ---------------------------------------------------------------------------
// Gold List
// ---------------------------------------------------------------------------

describe("Test AE Gold List", () => {
  beforeEach(async () => {
    await db.sql(
      `INSERT INTO gold_list_agents (id, salesperson_id, agent_name) VALUES ($1, $2, 'Sandbox Agent')`,
      [TEST_AGENT, TEST_AE],
    );
    await db.sql(
      `INSERT INTO gold_list_agents (salesperson_id, agent_name) VALUES ($1, 'Real Agent')`,
      [HILARY],
    );
  });

  it("owner sees it in single-AE, All AEs, and the AE options; another admin sees none of it", async () => {
    const one = await goldAgents.GET(req(COREY, `/api/gold-list/agents?ae_id=${TEST_AE}`));
    expect(one.status).toBe(200);
    expect((await json<{ agents: Row[] }>(one)).agents.map((a) => a.agent_name)).toEqual(["Sandbox Agent"]);
    expect((await goldAgents.GET(req(RYAN, `/api/gold-list/agents?ae_id=${TEST_AE}`))).status).toBe(404);

    const allMine = await json<{ agents: Row[]; ae_options: Row[] }>(goldAgents.GET(req(COREY, "/api/gold-list/agents")));
    const allTheirs = await json<{ agents: Row[]; ae_options: Row[] }>(goldAgents.GET(req(RYAN, "/api/gold-list/agents")));
    // "All AEs" is a business aggregate: no test account's agents, even the owner's.
    expect(allMine.agents.map((a) => a.agent_name)).toEqual(["Real Agent"]);
    expect(allTheirs.agents.map((a) => a.agent_name)).toEqual(["Real Agent"]);
    expect(allMine.ae_options.map((o) => o.id)).toContain(TEST_AE);
    expect(allTheirs.ae_options.map((o) => o.id)).not.toContain(TEST_AE);
    expect(allMine.ae_options.map((o) => o.id)).not.toContain(ORPHAN);

    expect((await goldActivities.GET(req(RYAN, "/x"), p({ id: TEST_AGENT }))).status).toBe(404);
    expect((await goldActivities.GET(req(COREY, "/x"), p({ id: TEST_AGENT }))).status).toBe(200);
  });

  it("All AEs excludes Test AE's agents and count for every admin; the explicit Test AE filter still shows them", async () => {
    // Plenty of fake agents, to prove the aggregate really doesn't move.
    await db.sql(
      `INSERT INTO gold_list_agents (salesperson_id, agent_name) SELECT $1, 'Fake ' || i FROM generate_series(1, 40) i`,
      [TEST_AE],
    );
    await db.sql(`INSERT INTO gold_list_agents (salesperson_id, agent_name) VALUES ($1, 'Orphan Agent')`, [ORPHAN]);
    type Body = { agents: Row[]; active_count: number; scope: Row };
    const view = (who: string, ae?: string) =>
      json<Body>(goldAgents.GET(req(who, `/api/gold-list/agents${ae ? `?ae_id=${ae}` : ""}`)));

    for (const who of [COREY, RYAN]) {
      const all = await view(who);
      expect(all.agents.map((a) => a.agent_name)).toEqual(["Real Agent"]);
      expect(all.active_count).toBe(1);
      const explicitAll = await view(who, "all");
      expect(explicitAll.active_count).toBe(1);
      expect(JSON.stringify(explicitAll)).not.toMatch(/Sandbox Agent|Fake \d|Orphan Agent/);
    }
    // Corey explicitly selecting Test AE sees (and counts) its agents.
    const mine = await view(COREY, TEST_AE);
    expect(mine.active_count).toBe(41);
    expect(mine.agents.map((a) => a.agent_name)).toContain("Sandbox Agent");
    expect(mine.scope).toMatchObject({ view_all: false, ae_id: TEST_AE });
    // Another admin can't select it at all.
    expect((await goldAgents.GET(req(RYAN, `/api/gold-list/agents?ae_id=${TEST_AE}`))).status).toBe(404);
    // Real counts unchanged: a real AE's own list, and an explicit real-AE filter.
    expect((await view(HILARY)).active_count).toBe(1);
    expect((await view(COREY, HILARY)).active_count).toBe(1);
  });

  it("Test AE manages its own list when signed in; the owner manages it from a 1:1", async () => {
    const created = await goldActivities.POST(
      req(TEST_AE, "/x", { method: "POST", body: { description: "Coffee", scheduled_for: "2026-10-01" } }),
      p({ id: TEST_AGENT }),
    );
    expect(created.status).toBe(201);
    const newAgent = await goldAgents.POST(req(TEST_AE, "/x", { method: "POST", body: { agent_name: "Another Sandbox Agent" } }));
    expect(newAgent.status).toBe(201);

    const id = await startMeeting(COREY, TEST_AE);
    const { activity } = await json<{ activity: Row }>(created);
    await db.sql(`UPDATE gold_list_activities SET status = 'cancelled' WHERE id = $1`, [activity.id]);
    const scheduled = await mActivities.POST(
      req(COREY, "/x", { method: "POST", body: { description: "Lunch", scheduled_for: "2026-10-02" } }),
      p({ id, agentId: TEST_AGENT }),
    );
    expect(scheduled.status).toBe(201);
    expect((await mNote.PUT(req(COREY, "/x", { method: "PUT", body: { note: "Sandbox note", expected_revision: 0 } }), p({ id, agentId: TEST_AGENT }))).status).toBe(200);
    // Ryan can't touch it through a 1:1 either.
    expect(
      (await mActivities.POST(req(RYAN, "/x", { method: "POST", body: { description: "x", scheduled_for: "2026-10-03" } }), p({ id, agentId: TEST_AGENT }))).status,
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Other test-data leaks
// ---------------------------------------------------------------------------

describe("business cards", () => {
  beforeEach(async () => {
    await db.sql(
      `INSERT INTO business_card_scans (id, salesperson_id, salesperson_name, image_url, is_test_data) VALUES
         ($1, $2, 'Test AE', 'x', true), ($3, $4, 'Hilary', 'y', false)`,
      [TEST_SCAN, TEST_AE, REAL_SCAN, HILARY],
    );
    await db.sql(
      `INSERT INTO business_card_contacts (scan_id, salesperson_id, salesperson_name, contact_bucket, full_name, verification_status) VALUES
         ($1, $2, 'Test AE', 'agent', 'Sandbox Contact', 'approved'), ($3, $4, 'Hilary', 'agent', 'Real Contact', 'approved')`,
      [TEST_SCAN, TEST_AE, REAL_SCAN, HILARY],
    );
  });

  it("reviewers don't see another admin's test scans; the owner does", async () => {
    const theirs = await json<{ scans: Row[] }>(verification.GET(req(RYAN, "/x")));
    const mine = await json<{ scans: Row[] }>(verification.GET(req(COREY, "/x")));
    expect(theirs.scans.map((s) => s.id)).toEqual([REAL_SCAN]);
    expect(mine.scans.map((s) => s.id).sort()).toEqual([REAL_SCAN, TEST_SCAN].sort());
  });

  it("another reviewer can't act on a test scan by id", async () => {
    const res = await rejectScan.POST(req(RYAN, "/x", { method: "POST", body: { scanId: TEST_SCAN } }));
    expect(res.status).toBe(404);
    expect(await db.sql(`SELECT verification_status FROM business_card_scans WHERE id = $1`, [TEST_SCAN])).not.toEqual([
      { verification_status: "rejected" },
    ]);
  });

  it("test contacts never enter a real export — even for the owner", async () => {
    for (const who of [RYAN, COREY]) {
      const csv = await (await exportContacts.GET(req(who, "/x?includeExported=true"))).text();
      expect(csv).toContain("Real Contact");
      expect(csv).not.toContain("Sandbox Contact");
    }
  });
});

describe("Juice Box", () => {
  it("a test account can't post, react, or upload media", async () => {
    const post = await teamMessages.POST(req(TEST_AE, "/x", { method: "POST", body: { body: "hi team" } }));
    expect(post.status).toBe(403);
    expect(await json(post)).toEqual({ error: "Test accounts can't post to the Juice Box." });
    expect(
      (await reactions.POST(req(TEST_AE, "/x", { method: "POST", body: { emoji: "👍" } }), p({ id: "00000000-0000-4000-8000-000000000000" }))).status,
    ).toBe(403);
    expect((await signUpload.POST(req(TEST_AE, "/x", { method: "POST", body: {} }))).status).toBe(403);
  });
});
