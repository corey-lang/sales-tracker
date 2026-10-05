/**
 * Juice Box "Seen by X of Y" — routes, run against the REAL migrations in an
 * in-process Postgres (PGlite), with the real auth guard (signed session tokens;
 * the caller's row is re-read from the database on every request).
 *
 *   POST /api/team-messages/seen/report   a person's screen showed these posts
 *   GET  /api/team-messages/seen?ids=…    counts for a batch of posts
 *   GET  /api/team-messages/:id/seen      the has / hasn't-seen lists for one post
 *
 * What is pinned here:
 *   * WHO: admins (Corey, Ryan) and users holding can_view_juice_box_seen (Tonja,
 *     Leah, Faith) — never an AE, never an un-granted Juice Box guest — enforced
 *     by the server, with NO read-state data in the refusal.
 *   * SEEN = wrote it, OR their screen reported reaching the post (a receipt).
 *     It is NOT derived from the channel read marker: that marker is stamped with
 *     now() when someone lands at the newest post, which also passes older posts
 *     that were never loaded and posts created mid-load. The first-open, race and
 *     scrolling tests below drive the real feed route and the real mark-read
 *     function to prove the two concepts stay separate — and that unread is
 *     untouched.
 *   * AUDIENCE = active, non-test people on the team when the post was written.
 *   * A reply is its own post. Pagination can't change an answer.
 *   * A constant number of queries however many posts/people there are.
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
const summaryRoute = await import("./seen/route");
const reportRoute = await import("./seen/report/route");
const feedRoute = await import("./route");
const detailRoute = await import("./[id]/seen/route");
const permissionsRoute = await import("../me/permissions/route");

type Row = Record<string, unknown>;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const COREY = id(1); // admin
const RYAN = id(2); // admin
const TONJA = id(3); // assistant, granted
const LEAH = id(4); // juice_box_only, granted
const FAITH = id(5); // juice_box_only, granted
const TRAVIS = id(6); // juice_box_only, NOT granted
const HILARY = id(7); // ae
const KENNEDY = id(8); // ae
const JAMES = id(9); // ae
const OLDIE = id(10); // ae, deactivated
const TESTER = id(11); // ae, is_test
const NEWBIE = id(12); // ae, joined 2026-03-01

const PEOPLE: Array<[string, string, string, { deactivated?: boolean; test?: boolean; flag?: boolean; joined?: string }]> = [
  [COREY, "Corey", "admin", {}],
  [RYAN, "Ryan", "admin", {}],
  [TONJA, "Tonja", "assistant", { flag: true }],
  [LEAH, "Leah", "juice_box_only", { flag: true }],
  [FAITH, "Faith", "juice_box_only", { flag: true }],
  [TRAVIS, "Travis", "juice_box_only", {}],
  [HILARY, "Hilary", "ae", {}],
  [KENNEDY, "Kennedy", "ae", {}],
  [JAMES, "James", "ae", {}],
  [OLDIE, "Oldie", "ae", { deactivated: true }],
  [TESTER, "Tester", "ae", { test: true }],
  [NEWBIE, "Newbie", "ae", { joined: "2026-03-01T00:00:00Z" }],
];
const roleOf = Object.fromEntries(PEOPLE.map((p) => [p[0], p[2]]));
const nameOf = Object.fromEntries(PEOPLE.map((p) => [p[0], p[1]]));

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

/** Counts every table read the routes make, so the query shape can be asserted. */
let reads: string[] = [];
function counting(client: TestDb["client"]) {
  return {
    rpc: client.rpc.bind(client),
    from: (table: string) => {
      reads.push(table);
      return client.from(table);
    },
  };
}

beforeEach(async () => {
  await db.reset();
  reads = [];
  holder.client = counting(db.client);
  for (const [pid, name, role, o] of PEOPLE) {
    await db.sql(
      `INSERT INTO salespeople (id, first_name, role, deactivated_at, is_test, can_view_juice_box_seen, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [pid, name, role, o.deactivated ? "2026-02-15T00:00:00Z" : null, o.test ?? false, o.flag ?? false, o.joined ?? "2026-01-01T00:00:00Z"],
    );
  }
});
afterEach(() => {
  holder.client = counting(db.client);
});

function req(who: string | null, path: string) {
  return new Request(`http://localhost${path}`, {
    headers: who
      ? { Authorization: `Bearer ${signSessionToken({ sub: who, role: roleOf[who] as never, name: nameOf[who] })}` }
      : {},
  });
}
const json = async <T = Row>(res: Response | Promise<Response>) => (await (await res).json()) as T;

type Detail = {
  id: string; seen: number; total: number;
  seen_people: Array<{ id: string; name: string }>;
  not_seen_people: Array<{ id: string; name: string }>;
};
type Summaries = { posts: Record<string, { seen: number; total: number }> };

const detail = (who: string | null, postId: string) =>
  detailRoute.GET(req(who, `/api/team-messages/${postId}/seen`), { params: Promise.resolve({ id: postId }) });
const summaries = (who: string | null, ids: string[]) =>
  summaryRoute.GET(req(who, `/api/team-messages/seen?ids=${ids.join(",")}`));
const names = (list: Array<{ name: string }>) => list.map((p) => p.name);

let postSeq = 100;
async function post(over: { at: string; by?: string; channel?: string; replyTo?: string; deleted?: boolean }) {
  const pid = id(postSeq++);
  await db.sql(
    `INSERT INTO team_messages (id, created_at, salesperson_id, salesperson_name, message, is_deleted, channel, reply_to_message_id)
     VALUES ($1,$2,$3,$4,'hi',$5,$6,$7)`,
    [pid, over.at, over.by ?? HILARY, nameOf[over.by ?? HILARY], over.deleted ?? false, over.channel ?? "general", over.replyTo ?? null],
  );
  return pid;
}
/** The existing read marker, stamped by the existing mark-read function (what POST /reads/me calls). */
const markChannelRead = (who: string, channel = "general") =>
  db.sql<{ juice_box_mark_channel_read: string }>(`SELECT juice_box_mark_channel_read($1, $2)`, [who, channel]);
const markerOf = async (who: string, channel = "general") =>
  (await db.sql<{ last_read_at: string }>(`SELECT last_read_at FROM team_message_channel_reads WHERE salesperson_id = $1 AND channel = $2`, [who, channel]))[0]?.last_read_at ?? null;

/** What a person's client does when posts have been on screen: POST the ids. */
const reach = (who: string, ids: string[]) =>
  reportRoute.POST(
    new Request("http://localhost/api/team-messages/seen/report", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${signSessionToken({ sub: who, role: roleOf[who] as never, name: nameOf[who] })}` },
      body: JSON.stringify({ ids }),
    }),
  );
const receipts = () => db.sql(`SELECT * FROM team_message_seen ORDER BY message_id, salesperson_id`);

/** The real feed route, as the client calls it. */
const feed = async (who: string, qs = "") => {
  const res = await feedRoute.GET(req(who, `/api/team-messages?channel=general${qs}`));
  expect(res.status).toBe(200);
  return ((await res.json()) as { messages: Array<{ id: string; created_at: string }>; hasMore: boolean });
};

const POST_AT = "2026-02-01T12:00:00.000Z";

// ===========================================================================
describe("who may see it — enforced by the server", () => {
  it.each([
    ["Corey (admin)", COREY],
    ["Ryan (admin)", RYAN],
    ["Tonja (granted)", TONJA],
    ["Leah (granted)", LEAH],
    ["Faith (granted)", FAITH],
  ])("%s can retrieve the detail and the counts", async (_label, who) => {
    const p = await post({ at: POST_AT });
    const d = await detail(who, p);
    expect(d.status).toBe(200);
    expect(((await d.json()) as Detail).total).toBe(9);
    const s = await summaries(who, [p]);
    expect(s.status).toBe(200);
    expect(((await s.json()) as Summaries).posts[p]).toEqual({ seen: 1, total: 9 }); // only the author has seen it
  });

  it.each([
    ["Hilary (AE)", HILARY],
    ["Kennedy (AE)", KENNEDY],
    ["Travis (juice_box_only, not granted)", TRAVIS],
  ])("%s is refused with a 403 and NO read-state data", async (_label, who) => {
    const p = await post({ at: POST_AT });
    await reach(COREY, [p]);
    for (const res of [await detail(who, p), await summaries(who, [p])]) {
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: "Not available." });
      for (const n of Object.values(nameOf)) expect(text).not.toContain(n);
      expect(text).not.toMatch(/seen|total|not_seen/i);
    }
  });

  it("an unauthorized caller learns nothing from the response: a real post, a deleted post and an invented id all look identical", async () => {
    const real = await post({ at: POST_AT });
    const deleted = await post({ at: POST_AT, deleted: true });
    const bodies = [];
    for (const target of [real, deleted, id(9999)]) {
      const res = await detail(HILARY, target);
      bodies.push([res.status, await res.text()]);
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0][0]).toBe(403);
    // The access check runs before the ids are parsed, so a malformed request doesn't leak either.
    expect((await summaryRoute.GET(req(HILARY, "/api/team-messages/seen?ids=not-a-uuid"))).status).toBe(403);
  });

  it("signed-out callers get 401", async () => {
    const p = await post({ at: POST_AT });
    expect((await detail(null, p)).status).toBe(401);
    expect((await summaries(null, [p])).status).toBe(401);
  });

  it("it is a CAPABILITY, not a list of names: revoking Faith's flag refuses her; granting Hilary's lets an AE in", async () => {
    const p = await post({ at: POST_AT });
    await db.sql(`UPDATE salespeople SET can_view_juice_box_seen = FALSE WHERE id = $1`, [FAITH]);
    await db.sql(`UPDATE salespeople SET can_view_juice_box_seen = TRUE WHERE id = $1`, [HILARY]);
    expect((await detail(FAITH, p)).status).toBe(403);
    expect((await detail(HILARY, p)).status).toBe(200);
  });

  it("a deactivated account loses it immediately (the token stops working)", async () => {
    const p = await post({ at: POST_AT });
    await db.sql(`UPDATE salespeople SET deactivated_at = NOW() WHERE id = $1`, [TONJA]);
    expect((await detail(TONJA, p)).status).toBe(401);
  });

  it("the permissions endpoint tells the UI: true for the five, false for AEs and un-granted guests", async () => {
    const can = async (who: string) =>
      (await json<{ can_view_juice_box_seen: boolean }>(permissionsRoute.GET(req(who, "/api/me/permissions")))).can_view_juice_box_seen;
    expect(await Promise.all([COREY, RYAN, TONJA, LEAH, FAITH].map(can))).toEqual([true, true, true, true, true]);
    expect(await Promise.all([HILARY, KENNEDY, TRAVIS].map(can))).toEqual([false, false, false]);
  });
});

// ===========================================================================
describe("one-time grant in the migration", () => {
  it("grants Tonja, Leah and Faith ONCE; an admin's later revocation survives a re-run; nobody else is granted", async () => {
    const sql = readFileSync(join(process.cwd(), "supabase", "juice_box_seen_by.sql"), "utf8");
    await db.asOwner(`ALTER TABLE salespeople DROP COLUMN can_view_juice_box_seen`);
    await db.asOwner(sql);
    const flags = async () =>
      Object.fromEntries((await db.sql<{ first_name: string; f: boolean }>(`SELECT first_name::text, can_view_juice_box_seen AS f FROM salespeople`)).map((r) => [r.first_name, r.f]));
    expect(await flags()).toMatchObject({ Tonja: true, Leah: true, Faith: true, Travis: false, Hilary: false, Corey: false, Ryan: false });

    await db.sql(`UPDATE salespeople SET can_view_juice_box_seen = FALSE WHERE id = $1`, [LEAH]);
    await db.asOwner(sql); // re-run
    expect((await flags()).Leah).toBe(false);
  });
});

// ===========================================================================
describe("the report endpoint", () => {
  it("records the caller's receipt; every signed-in user may report (their screens are the evidence), the response carries nothing", async () => {
    const p = await post({ at: POST_AT, by: JAMES });
    for (const who of [HILARY, TRAVIS, KENNEDY, COREY]) {
      const res = await reach(who, [p]);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
    expect((await receipts()).map((r) => r.salesperson_id).sort()).toEqual([COREY, HILARY, KENNEDY, TRAVIS].sort());
  });

  it("is idempotent: reporting again adds nothing and never moves seen_at", async () => {
    const p = await post({ at: POST_AT });
    await reach(RYAN, [p]);
    const [first] = await receipts();
    await reach(RYAN, [p, p]);
    expect(await receipts()).toEqual([first]);
  });

  it("identity is the session's: the body can only name posts, never a person", async () => {
    const p = await post({ at: POST_AT });
    const res = await reportRoute.POST(
      new Request("http://localhost/api/team-messages/seen/report", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${signSessionToken({ sub: HILARY, role: "ae" as never, name: "Hilary" })}` },
        body: JSON.stringify({ ids: [p], salesperson_id: RYAN }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await receipts()).toEqual([]);
  });

  it("skips deleted and unknown posts and a person's own posts; rejects bad input; signed-out is 401", async () => {
    const live = await post({ at: POST_AT });
    const gone = await post({ at: POST_AT, deleted: true });
    const mine = await post({ at: POST_AT, by: RYAN });
    await reach(RYAN, [live, gone, mine, id(9997)]);
    expect((await receipts()).map((r) => r.message_id)).toEqual([live]);

    expect((await reach(RYAN, [])).status).toBe(400);
    expect((await reach(RYAN, ["nope"])).status).toBe(400);
    expect((await reach(RYAN, Array.from({ length: 101 }, (_, i) => id(6000 + i)))).status).toBe(400);
    expect((await reportRoute.POST(new Request("http://localhost/x", { method: "POST", body: "{}" }))).status).toBe(401);
  });

  it("never touches a read marker (it is a separate concept from unread)", async () => {
    const p = await post({ at: POST_AT });
    await markChannelRead(KENNEDY);
    const before = await db.sql(`SELECT * FROM team_message_channel_reads`);
    await reach(KENNEDY, [p]);
    expect(await db.sql(`SELECT * FROM team_message_channel_reads`)).toEqual(before);
  });

  it("a database without the migration answers 503 with what to apply, not a 500", async () => {
    await db.asOwner(`DROP FUNCTION juice_box_mark_seen(uuid, jsonb)`);
    try {
      const p = await post({ at: POST_AT });
      const res = await reach(RYAN, [p]);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toMatch(/juice_box_seen_by\.sql/);
    } finally {
      const sql = readFileSync(join(process.cwd(), "supabase", "juice_box_seen_by.sql"), "utf8");
      await db.asOwner(sql);
    }
  });
});

// ===========================================================================
describe("the count and the lists", () => {
  it("Seen by X of Y with the right people on each side, sorted by name", async () => {
    const p = await post({ at: POST_AT, by: HILARY });
    for (const who of [COREY, RYAN, FAITH, KENNEDY]) await reach(who, [p]);
    // Tonja, Leah, Travis, James never reached it; Hilary wrote it.

    const d = await json<Detail>(detail(COREY, p));
    expect(d.seen).toBe(5);
    expect(d.total).toBe(9);
    expect(names(d.seen_people)).toEqual(["Corey", "Faith", "Hilary", "Kennedy", "Ryan"]);
    expect(names(d.not_seen_people)).toEqual(["James", "Leah", "Tonja", "Travis"]);
    expect((await json<Summaries>(summaries(COREY, [p]))).posts[p]).toEqual({ seen: 5, total: 9 });
  });

  it("the author counts as seen with no receipt of their own", async () => {
    const p = await post({ at: POST_AT, by: JAMES });
    const d = await json<Detail>(detail(TONJA, p));
    expect(names(d.seen_people)).toEqual(["James"]);
    expect(d.total).toBe(9);
    expect(await receipts()).toEqual([]);
  });

  it("excluded from BOTH sides: deactivated users, test users, and people who joined after the post — even with receipts", async () => {
    const p = await post({ at: POST_AT });
    for (const who of [OLDIE, TESTER, NEWBIE]) await reach(who, [p]);
    const d = await json<Detail>(detail(COREY, p));
    const everyone = names([...d.seen_people, ...d.not_seen_people]);
    for (const n of ["Oldie", "Tester", "Newbie"]) expect(everyone).not.toContain(n);
    expect(d.total).toBe(9);

    // …but a post written AFTER Newbie joined does include them.
    const later = await post({ at: "2026-04-01T12:00:00Z" });
    await reach(NEWBIE, [later]);
    const d2 = await json<Detail>(detail(COREY, later));
    expect(names(d2.seen_people)).toContain("Newbie");
    expect(d2.total).toBe(10);
  });

  it("a deactivated AUTHOR is not in the audience either (no phantom seen)", async () => {
    const p = await post({ at: POST_AT, by: OLDIE });
    const d = await json<Detail>(detail(COREY, p));
    expect(names([...d.seen_people, ...d.not_seen_people])).not.toContain("Oldie");
    expect(d).toMatchObject({ seen: 0, total: 9 });
  });

  it("every active role counts — AEs, admins, the assistant and juice_box_only guests — there is no per-channel membership to narrow it", async () => {
    const p = await post({ at: POST_AT });
    const d = await json<Detail>(detail(COREY, p));
    expect(names([...d.seen_people, ...d.not_seen_people]).sort()).toEqual(
      ["Corey", "Faith", "Hilary", "James", "Kennedy", "Leah", "Ryan", "Tonja", "Travis"],
    );
  });

  it("someone who has never reached the post is NOT seen — never assumed", async () => {
    const p = await post({ at: POST_AT });
    const d = await json<Detail>(detail(COREY, p));
    expect(names(d.not_seen_people)).toEqual(expect.arrayContaining(["Ryan", "Leah"]));
  });

  it("receipts belong to the POST, not the channel: moving a conversation keeps who saw it", async () => {
    const p = await post({ at: POST_AT, channel: "general" });
    await reach(RYAN, [p]);
    await db.sql(`UPDATE team_messages SET channel = 'product_help' WHERE id = $1`, [p]);
    expect(names((await json<Detail>(detail(COREY, p))).seen_people)).toContain("Ryan");
  });
});

// ===========================================================================
describe("FIRST OPEN: the read marker overstates, Seen By does not", () => {
  const at = (i: number) => new Date(Date.UTC(2026, 1, 1, 0, i)).toISOString();

  async function hundredTwentyPosts() {
    const ids: string[] = [];
    for (let i = 0; i < 120; i++) ids.push(await post({ at: at(i), by: i % 2 ? HILARY : JAMES }));
    return ids; // oldest → newest
  }

  it("a never-opened channel with 120 posts: landing at the latest marks the channel read, yet only what was on screen counts as seen", async () => {
    const ids = await hundredTwentyPosts();

    // Ryan has never opened the channel. The REAL feed route returns only the latest page.
    const page = await feed(RYAN);
    expect(page.messages).toHaveLength(50);
    expect(page.hasMore).toBe(true);
    expect(page.messages[0].id).toBe(ids[70]); // posts 0–69 were never loaded
    expect(page.messages[49].id).toBe(ids[119]);

    // He lands at the latest post: the EXISTING behaviour stamps the read marker with now() …
    await markChannelRead(RYAN);
    const marker = await markerOf(RYAN);
    expect(marker).not.toBeNull();
    for (const pid of ids) {
      const [{ created_at }] = await db.sql<{ created_at: string }>(`SELECT created_at FROM team_messages WHERE id = $1`, [pid]);
      expect(Date.parse(marker!)).toBeGreaterThanOrEqual(Date.parse(created_at)); // …past ALL 120 posts (unread: caught up)
    }
    // … while his screen showed only the last two.
    await reach(RYAN, [ids[118], ids[119]]);

    const seen = (await json<Summaries>(summaries(COREY, ids))).posts;
    const sawIt = async (pid: string) => names((await json<Detail>(detail(COREY, pid))).seen_people).includes("Ryan");
    expect(await sawIt(ids[119])).toBe(true);
    expect(await sawIt(ids[118])).toBe(true);
    expect(await sawIt(ids[117])).toBe(false); // loaded, never scrolled to
    expect(await sawIt(ids[70])).toBe(false); // oldest LOADED post
    expect(await sawIt(ids[69])).toBe(false); // never loaded
    expect(await sawIt(ids[0])).toBe(false); // never loaded, older than the marker
    // Counts agree: one reader of the author's own posts only.
    expect(seen[ids[0]]).toEqual({ seen: 1, total: 9 }); // just the author
    expect(seen[ids[119]]).toEqual({ seen: 2, total: 9 }); // author (James) + Ryan
  });

  it("existing unread behaviour is unchanged: the marker covers everything exactly as before", async () => {
    const ids = await hundredTwentyPosts();
    expect(await markerOf(RYAN)).toBeNull(); // never opened
    await markChannelRead(RYAN);
    const [{ n }] = await db.sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM team_messages t JOIN team_message_channel_reads r ON r.salesperson_id = $1 AND r.channel = t.channel WHERE t.created_at > r.last_read_at`,
      [RYAN],
    );
    expect(n).toBe(0); // unread = 0: nothing newer than the marker
    await reach(RYAN, [ids[119]]);
    const [{ n: after }] = await db.sql<{ n: number }>(`SELECT count(*)::int AS n FROM team_message_channel_reads WHERE salesperson_id = $1`, [RYAN]);
    expect(after).toBe(1); // reporting never creates/changes a marker
  });

  it("RACE: a post created between the feed fetch and the mark-read write is covered by the marker but NOT claimed as seen", async () => {
    await hundredTwentyPosts();
    const page = await feed(RYAN); // the client's snapshot
    const loaded = new Set(page.messages.map((m) => m.id));

    const arrivedMidLoad = await post({ at: new Date().toISOString(), by: KENNEDY }); // created after the fetch…
    expect(loaded.has(arrivedMidLoad)).toBe(false);
    await markChannelRead(RYAN); // …but before the write: marker = now() passes it
    const [{ created_at }] = await db.sql<{ created_at: string }>(`SELECT created_at FROM team_messages WHERE id = $1`, [arrivedMidLoad]);
    expect(Date.parse((await markerOf(RYAN))!)).toBeGreaterThanOrEqual(Date.parse(created_at)); // existing behaviour, unchanged

    await reach(RYAN, page.messages.slice(-3).map((m) => m.id)); // the client can only report what it rendered
    const d = await json<Detail>(detail(COREY, arrivedMidLoad));
    expect(names(d.seen_people)).toEqual(["Kennedy"]); // the author only
    expect(names(d.not_seen_people)).toContain("Ryan");
  });

  it("PAGINATION: loading older pages claims nothing; only posts actually reached on those pages become seen", async () => {
    const ids = await hundredTwentyPosts();
    const first = await feed(RYAN);
    const older = await feed(RYAN, `&before=${encodeURIComponent(first.messages[0].created_at)}`);
    expect(older.messages).toHaveLength(50);
    expect(older.messages[49].id).toBe(ids[69]);

    // Loading the older page is not evidence of anything…
    expect(await receipts()).toEqual([]);
    // …scrolling up to the oldest posts on it is.
    await reach(RYAN, [ids[20], ids[21]]);
    const sawIt = async (pid: string) => names((await json<Detail>(detail(COREY, pid))).seen_people).includes("Ryan");
    expect(await sawIt(ids[20])).toBe(true);
    expect(await sawIt(ids[21])).toBe(true);
    expect(await sawIt(ids[22])).toBe(false);
    expect(await sawIt(ids[19])).toBe(false);
  });

  it("NORMAL SCROLLING: not seen → the user scrolls to the post → the same post is now seen (and nothing else changed)", async () => {
    const ids = await hundredTwentyPosts();
    await markChannelRead(RYAN);
    await reach(RYAN, [ids[119]]);
    const target = ids[100];
    const before = await json<Detail>(detail(COREY, target));
    expect(names(before.not_seen_people)).toContain("Ryan");

    await reach(RYAN, [ids[102], ids[101], target]); // scrolling up through the feed, newest first
    const after = await json<Detail>(detail(COREY, target));
    expect(names(after.seen_people)).toContain("Ryan");
    expect(after.seen).toBe(before.seen + 1);
    expect(after.total).toBe(before.total);
    // The post the user has NOT reached yet is still not seen.
    expect(names((await json<Detail>(detail(COREY, ids[99]))).not_seen_people)).toContain("Ryan");
  });
});

// ===========================================================================
describe("replies are their own posts", () => {
  it("reaching the parent does not mark the reply seen (and vice versa); each counts its own author", async () => {
    const parent = await post({ at: "2026-02-01T12:00:00Z", by: HILARY });
    const reply = await post({ at: "2026-02-01T15:00:00Z", by: KENNEDY, replyTo: parent });
    await reach(RYAN, [parent]);
    await reach(TONJA, [reply]);
    const dParent = await json<Detail>(detail(COREY, parent));
    const dReply = await json<Detail>(detail(COREY, reply));
    expect(names(dParent.seen_people)).toEqual(["Hilary", "Ryan"]);
    expect(names(dReply.seen_people)).toEqual(["Kennedy", "Tonja"]);
    expect(names(dParent.not_seen_people)).toContain("Tonja");
    expect(names(dReply.not_seen_people)).toContain("Ryan");
    const s = (await json<Summaries>(summaries(COREY, [parent, reply]))).posts;
    expect([s[parent].seen, s[reply].seen]).toEqual([2, 2]);
  });

  it("a reply on a later page is judged on its own receipt, however old the parent is", async () => {
    const parent = await post({ at: "2026-02-01T12:00:00Z", by: HILARY });
    await reach(RYAN, [parent]);
    const reply = await post({ at: "2026-03-01T12:00:00Z", by: KENNEDY, replyTo: parent });
    expect(names((await json<Detail>(detail(COREY, reply))).not_seen_people)).toContain("Ryan");
  });
});

// ===========================================================================
describe("pagination and ordering cannot change an answer", () => {
  it("60 posts: each post's count is the same whether asked alone, in a page, out of order, or all at once", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) {
      ids.push(await post({ at: new Date(Date.UTC(2026, 1, 1, 0, i)).toISOString(), by: i % 2 ? HILARY : JAMES }));
    }
    await reach(RYAN, ids.slice(0, 30)); // Ryan reached the first 30
    await reach(TONJA, ids); // Tonja reached all 60

    const all = (await json<Summaries>(summaries(COREY, ids))).posts;
    expect(Object.keys(all)).toHaveLength(60);
    // Post i: author(1) + Tonja(1) + Ryan if i < 30 (+ Tonja is never the author here).
    ids.forEach((pid, i) => expect(all[pid], `post ${i}`).toEqual({ seen: 2 + (i < 30 ? 1 : 0), total: 9 }));

    const page = ids.slice(10, 20);
    const subset = (await json<Summaries>(summaries(COREY, [...page].reverse()))).posts;
    for (const pid of page) expect(subset[pid]).toEqual(all[pid]);
    expect((await json<Summaries>(summaries(COREY, [ids[45]]))).posts[ids[45]]).toEqual(all[ids[45]]);
  });

  it("deleted posts and unknown ids are absent from the summaries; the detail of a deleted post is a 404 for an authorized caller", async () => {
    const live = await post({ at: POST_AT });
    const gone = await post({ at: POST_AT, deleted: true });
    const posts = (await json<Summaries>(summaries(COREY, [live, gone, id(9998)]))).posts;
    expect(Object.keys(posts)).toEqual([live]);
    expect((await detail(COREY, gone)).status).toBe(404);
  });

  it("input validation for an authorized caller: no ids, bad ids, and over-200 are 400", async () => {
    expect((await summaryRoute.GET(req(COREY, "/api/team-messages/seen"))).status).toBe(400);
    expect((await summaryRoute.GET(req(COREY, "/api/team-messages/seen?ids=nope"))).status).toBe(400);
    const tooMany = Array.from({ length: 201 }, (_, i) => id(5000 + i)).join(",");
    expect((await summaryRoute.GET(req(COREY, `/api/team-messages/seen?ids=${tooMany}`))).status).toBe(400);
    expect((await detail(COREY, "nope")).status).toBe(400);
  });
});

// ===========================================================================
describe("performance: no N+1", () => {
  const tableCounts = () =>
    reads.reduce<Record<string, number>>((acc, t) => ({ ...acc, [t]: (acc[t] ?? 0) + 1 }), {});

  async function seedPosts(postCount: number) {
    const ids: string[] = [];
    for (let i = 0; i < postCount; i++) ids.push(await post({ at: new Date(Date.UTC(2026, 1, 1, 0, i)).toISOString() }));
    return ids;
  }

  it("the number of queries is the same for 3 posts as for 120, and doesn't scale with people", async () => {
    const small = await seedPosts(3);
    for (const who of [RYAN, TONJA, LEAH]) await reach(who, small);
    reads = [];
    expect((await summaries(COREY, small)).status).toBe(200);
    const smallCounts = tableCounts();

    await db.reset();
    for (const [pid, name, role, o] of PEOPLE) {
      await db.sql(
        `INSERT INTO salespeople (id, first_name, role, deactivated_at, is_test, created_at) VALUES ($1,$2,$3,$4,$5,'2026-01-01T00:00:00Z')`,
        [pid, name, role, o.deactivated ? "2026-02-15T00:00:00Z" : null, o.test ?? false],
      );
    }
    const large = await seedPosts(120);
    for (const who of [RYAN, TONJA, LEAH]) await reach(who, large.slice(0, 100));
    reads = [];
    expect((await summaries(COREY, large)).status).toBe(200);
    expect(tableCounts()).toEqual(smallCounts);
    // posts + the caller's identity row + the audience + ONE receipts read.
    expect(smallCounts).toEqual({ salespeople: 2, team_messages: 1, team_message_seen: 1 });
  });

  it("the detail view is also constant-size", async () => {
    const p = await post({ at: POST_AT });
    reads = [];
    expect((await detail(COREY, p)).status).toBe(200);
    expect(tableCounts()).toEqual({ salespeople: 2, team_messages: 1, team_message_seen: 1 });
  });

  it("the report is ONE database call however many posts (no per-post writes)", async () => {
    const ids = await seedPosts(100);
    const calls: string[] = [];
    const real = db.client;
    holder.client = { rpc: (fn: string, args: Row) => (calls.push(fn), real.rpc(fn, args)), from: real.from.bind(real) };
    expect((await reach(RYAN, ids)).status).toBe(200);
    expect(calls).toEqual(["juice_box_mark_seen"]);
    expect(await receipts()).toHaveLength(100);
  });

  it("worst case 200 posts x everyone (1,800 receipts, past PostgREST's 1,000-row cap): counts stay exact and it is still a handful of reads", async () => {
    const ids = await seedPosts(200);
    await db.sql(
      `INSERT INTO team_message_seen (message_id, salesperson_id)
       SELECT m.id, p.id FROM team_messages m CROSS JOIN salespeople p
        WHERE p.deactivated_at IS NULL AND NOT p.is_test AND p.id::text <> m.salesperson_id`,
    );
    reads = [];
    const posts = (await json<Summaries>(summaries(COREY, ids))).posts;
    expect(Object.keys(posts)).toHaveLength(200);
    for (const pid of ids) expect(posts[pid]).toEqual({ seen: 9, total: 9 }); // NOT truncated at 1,000 rows
    expect(tableCounts().team_message_seen).toBe(2); // ceil(1,800 / 1,000) pages — never per post
  });
});
