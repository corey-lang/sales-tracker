/**
 * Database regression tests for supabase/one_on_one_meetings.sql, executed
 * against a REAL Postgres (PGlite) with the project's actual migrations.
 *
 * Complements one-on-one-meetings-sql.test.ts (static shape checks): these
 * prove the triggers, locks, and complete_one_on_one_meeting() BEHAVE as
 * intended — including the review findings they were written for:
 *   * the child freeze checks BOTH the old and new parent meeting (a row
 *     can't be edited in, moved out of, or moved into a completed 1:1);
 *   * meeting-scoped commitment / Gold List writes are refused once the
 *     meeting is completed, regardless of what the API checked first;
 *   * completion snapshots only EXPLICITLY attributed Gold List actions;
 *   * completion is all-or-nothing and safely retryable.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "@/test/pglite-supabase";

let t: TestDb;
let AE: string;
let OTHER: string;
let MGR: string;
let AGENT: string;

beforeAll(async () => {
  t = await createTestDb();
}, 60_000);

beforeEach(async () => {
  await t.reset();
  const people = await t.sql<{ id: string }>(
    `INSERT INTO salespeople (first_name, role) VALUES ('Hilary','ae'), ('Kennedy','ae'), ('Corey','admin') RETURNING id`,
  );
  [AE, OTHER, MGR] = people.map((p) => p.id);
  AGENT = (
    await t.sql<{ id: string }>(
      `INSERT INTO gold_list_agents (salesperson_id, agent_name, brokerage) VALUES ($1, 'Sarah', 'Compass') RETURNING id`,
      [AE],
    )
  )[0].id;
});

async function meeting(ae = AE): Promise<string> {
  return (
    await t.sql<{ id: string }>(
      `INSERT INTO one_on_one_meetings (ae_id, manager_id, meeting_date) VALUES ($1, $2, '2026-09-29') RETURNING id`,
      [ae, MGR],
    )
  )[0].id;
}

async function complete(id: string, snapshot: unknown = { version: 1 }) {
  return (
    await t.sql(`SELECT * FROM complete_one_on_one_meeting($1, $2, $3)`, [id, MGR, snapshot])
  )[0];
}

async function rejects(sql: string, params: unknown[], code = "23514") {
  await expect(t.sql(sql, params)).rejects.toMatchObject({ code });
}

async function note(meetingId: string, text = "n"): Promise<string> {
  return (
    await t.sql<{ id: string }>(
      `INSERT INTO one_on_one_gold_list_notes (meeting_id, ae_id, agent_id, agent_name, note) VALUES ($1, $2, $3, 'Sarah', $4) RETURNING id`,
      [meetingId, AE, AGENT, text],
    )
  )[0].id;
}

async function commitment(meetingId: string, description = "Follow up"): Promise<string> {
  return (
    await t.sql<{ id: string }>(
      `INSERT INTO one_on_one_meeting_commitments (ae_id, origin_meeting_id, description) VALUES ($1, $2, $3) RETURNING id`,
      [AE, meetingId, description],
    )
  )[0].id;
}

describe("migration", () => {
  it("re-runs cleanly on a database that already has it", async () => {
    const m = await meeting();
    await note(m);
    await t.asOwner(readFileSync(join(process.cwd(), "supabase/one_on_one_meetings.sql"), "utf8"));
    expect(await t.sql(`SELECT count(*)::int AS n FROM one_on_one_gold_list_notes`)).toEqual([{ n: 1 }]);
  });

  it("allows one in-progress meeting per AE", async () => {
    await meeting();
    await rejects(
      `INSERT INTO one_on_one_meetings (ae_id, meeting_date) VALUES ($1, '2026-09-29')`,
      [AE],
      "23505",
    );
    await meeting(OTHER); // a different AE is fine
  });

  it("only service_role may execute the completion function", async () => {
    const [row] = await t.sql<Record<string, boolean>>(`
      SELECT has_function_privilege('anon', 'complete_one_on_one_meeting(uuid,uuid,jsonb)', 'EXECUTE') AS anon,
             has_function_privilege('authenticated', 'complete_one_on_one_meeting(uuid,uuid,jsonb)', 'EXECUTE') AS authed,
             has_function_privilege('service_role', 'complete_one_on_one_meeting(uuid,uuid,jsonb)', 'EXECUTE') AS service`);
    expect(row).toEqual({ anon: false, authed: false, service: true });
  });
});

describe("completed meeting freeze", () => {
  it("keeps the completed meeting itself immutable", async () => {
    const m = await meeting();
    await complete(m);
    await rejects(`UPDATE one_on_one_meetings SET wins = 'x' WHERE id = $1`, [m]);
    await rejects(`UPDATE one_on_one_meetings SET status = 'in_progress', completed_at = NULL WHERE id = $1`, [m]);
    await rejects(`DELETE FROM one_on_one_meetings WHERE id = $1`, [m]);
  });

  it("rejects editing, adding, or deleting a completed meeting's children", async () => {
    const m = await meeting();
    const n = await note(m);
    await complete(m);
    await rejects(`UPDATE one_on_one_gold_list_notes SET note = 'rewrite' WHERE id = $1`, [n]);
    await rejects(`DELETE FROM one_on_one_gold_list_notes WHERE id = $1`, [n]);
    await rejects(
      `INSERT INTO one_on_one_gold_list_notes (meeting_id, ae_id, agent_name) VALUES ($1, $2, 'x')`,
      [m, AE],
    );
  });

  it("rejects moving a child OUT of a completed meeting", async () => {
    const done = await meeting();
    const n = await note(done);
    const c = await commitment(done);
    await complete(done);
    const open = await meeting();
    await rejects(`UPDATE one_on_one_gold_list_notes SET meeting_id = $2 WHERE id = $1`, [n, open]);
    const [review] = await t.sql<{ id: string }>(
      `SELECT id FROM one_on_one_commitment_reviews WHERE meeting_id = $1 AND commitment_id = $2`,
      [done, c],
    );
    await rejects(`UPDATE one_on_one_commitment_reviews SET status = 'completed' WHERE id = $1`, [review.id]);
    await rejects(`UPDATE one_on_one_commitment_reviews SET meeting_id = $2 WHERE id = $1`, [review.id, open]);
    expect(
      await t.sql(`SELECT meeting_id FROM one_on_one_gold_list_notes WHERE id = $1`, [n]),
    ).toEqual([{ meeting_id: done }]);
  });

  it("rejects moving a child INTO a completed meeting (and between open ones)", async () => {
    const done = await meeting();
    await complete(done);
    const open = await meeting();
    const n = await note(open);
    await rejects(`UPDATE one_on_one_gold_list_notes SET meeting_id = $2 WHERE id = $1`, [n, done]);
    const other = await meeting(OTHER);
    await rejects(`UPDATE one_on_one_gold_list_notes SET meeting_id = $2 WHERE id = $1`, [n, other]);
  });
});

describe("meeting-scoped commitment writes", () => {
  it("refuses creating, rewording, deleting, or closing inside a completed meeting", async () => {
    const m1 = await meeting();
    const c = await commitment(m1);
    await complete(m1);
    await rejects(
      `INSERT INTO one_on_one_meeting_commitments (ae_id, origin_meeting_id, description) VALUES ($1, $2, 'late')`,
      [AE, m1],
    );
    await rejects(`UPDATE one_on_one_meeting_commitments SET description = 'x' WHERE id = $1`, [c]);
    await rejects(`DELETE FROM one_on_one_meeting_commitments WHERE id = $1`, [c]);
    // Closing it "in" the completed meeting (no resolving meeting) is refused.
    await rejects(
      `UPDATE one_on_one_meeting_commitments SET status = 'completed', completed_at = now() WHERE id = $1`,
      [c],
    );
  });

  it("allows resolving carryover in the NEXT open meeting, then freezes that resolution", async () => {
    const m1 = await meeting();
    const c = await commitment(m1);
    await complete(m1);
    const m2 = await meeting();
    await t.sql(
      `UPDATE one_on_one_meeting_commitments SET status = 'completed', completed_at = now(), resolved_in_meeting_id = $2 WHERE id = $1`,
      [c, m2],
    );
    await complete(m2);
    // Reopening it later would rewrite what m2 recorded.
    const m3 = await meeting();
    await rejects(
      `UPDATE one_on_one_meeting_commitments SET status = 'open', completed_at = NULL, resolved_in_meeting_id = NULL WHERE id = $1`,
      [c],
    );
    await rejects(
      `UPDATE one_on_one_meeting_commitments SET resolved_in_meeting_id = $2 WHERE id = $1`,
      [c, m3],
    );
  });

  it("refuses attaching a commitment to another AE's meeting and changing provenance", async () => {
    const theirs = await meeting(OTHER);
    await rejects(
      `INSERT INTO one_on_one_meeting_commitments (ae_id, origin_meeting_id, description) VALUES ($1, $2, 'x')`,
      [AE, theirs],
    );
    const mine = await meeting();
    const c = await commitment(mine);
    await rejects(`UPDATE one_on_one_meeting_commitments SET origin_meeting_id = $2 WHERE id = $1`, [c, theirs]);
  });
});

describe("Gold List meeting attribution", () => {
  async function activity(fields: Record<string, unknown> = {}) {
    const cols = ["agent_id", "salesperson_id", "description", "scheduled_for", ...Object.keys(fields)];
    const vals = [AGENT, AE, "Coffee", "2026-10-01", ...Object.values(fields)];
    return (
      await t.sql<{ id: string }>(
        `INSERT INTO gold_list_activities (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
        vals,
      )
    )[0].id;
  }

  it("never involves a meeting for plain AE writes", async () => {
    const m = await meeting();
    await complete(m);
    const a = await activity(); // AE's own write while/after a 1:1 exists
    await t.sql(`UPDATE gold_list_activities SET status = 'completed', completed_at = now() WHERE id = $1`, [a]);
  });

  it("refuses attributing to a completed meeting or another AE's meeting", async () => {
    const done = await meeting();
    await complete(done);
    await rejects(
      `INSERT INTO gold_list_activities (agent_id, salesperson_id, description, scheduled_for, created_in_meeting_id) VALUES ($1, $2, 'x', '2026-10-01', $3)`,
      [AGENT, AE, done],
    );
    const theirs = await meeting(OTHER);
    await rejects(
      `INSERT INTO gold_list_activities (agent_id, salesperson_id, description, scheduled_for, created_in_meeting_id) VALUES ($1, $2, 'x', '2026-10-01', $3)`,
      [AGENT, AE, theirs],
    );
  });

  it("keeps attribution permanent", async () => {
    const m = await meeting();
    const a = await activity({ created_in_meeting_id: m });
    await rejects(`UPDATE gold_list_activities SET created_in_meeting_id = NULL WHERE id = $1`, [a]);
  });
});

describe("complete_one_on_one_meeting()", () => {
  it("snapshots only attributed Gold List actions — not the AE's own activity during the draft", async () => {
    const m = await meeting();
    // The AE's own Gold List work while the draft is open…
    const own = (
      await t.sql<{ id: string }>(
        `INSERT INTO gold_list_activities (agent_id, salesperson_id, description, scheduled_for) VALUES ($1, $2, 'AE own call', '2026-09-29') RETURNING id`,
        [AGENT, AE],
      )
    )[0].id;
    await t.sql(`UPDATE gold_list_activities SET status = 'completed', completed_at = now() WHERE id = $1`, [own]);
    // …and one action the manager took FROM the 1:1.
    await t.sql(
      `INSERT INTO gold_list_activities (agent_id, salesperson_id, description, scheduled_for, created_by, created_in_meeting_id) VALUES ($1, $2, 'Lunch', '2026-10-03', $3, $4)`,
      [AGENT, AE, MGR, m],
    );

    await complete(m);
    const notes = await t.sql(`SELECT * FROM one_on_one_gold_list_notes WHERE meeting_id = $1`, [m]);
    expect(notes).toHaveLength(1); // added automatically — no note was typed
    expect(notes[0]).toMatchObject({
      agent_id: AGENT,
      agent_name: "Sarah",
      brokerage: "Compass",
      action_taken: true,
      last_activity_description: "AE own call", // live context, fine
      next_activity_on: "2026-10-03",
      next_activity_description: "Lunch",
      activity_changes: [{ kind: "scheduled", description: "Lunch", date: "2026-10-03" }],
    });
    expect(notes[0].snapshot_taken_at).toBeTruthy();
  });

  it("does not mark a noted agent as acted-on when the only activity was the AE's own", async () => {
    const m = await meeting();
    await note(m, "Discussed Q4");
    await t.sql(
      `INSERT INTO gold_list_activities (agent_id, salesperson_id, description, scheduled_for) VALUES ($1, $2, 'AE call', '2026-09-30')`,
      [AGENT, AE],
    );
    await complete(m);
    const [n] = await t.sql(`SELECT action_taken, activity_changes, note FROM one_on_one_gold_list_notes WHERE meeting_id = $1`, [m]);
    expect(n).toEqual({ action_taken: false, activity_changes: [], note: "Discussed Q4" });
  });

  it("writes ordered commitment reviews and flips status in one step", async () => {
    const m1 = await meeting();
    const carry = await commitment(m1, "Carry me");
    await complete(m1);
    const m2 = await meeting();
    await commitment(m2, "New one");
    const done = await complete(m2);
    expect(done).toMatchObject({ status: "completed", completed_by: MGR, activity_snapshot: { version: 1 } });
    const reviews = await t.sql(
      `SELECT commitment_id, origin, description, status FROM one_on_one_commitment_reviews WHERE meeting_id = $1 ORDER BY sort_order`,
      [m2],
    );
    expect(reviews).toMatchObject([
      { commitment_id: carry, origin: "carryover", description: "Carry me", status: "open" },
      { origin: "new", description: "New one", status: "open" },
    ]);
  });

  it("is idempotent and all-or-nothing", async () => {
    const m = await meeting();
    await commitment(m);
    // A failing attempt (missing snapshot) rolls everything back.
    await expect(t.sql(`SELECT * FROM complete_one_on_one_meeting($1, $2, NULL)`, [m, MGR])).rejects.toMatchObject({
      code: "22004",
    });
    expect(await t.sql(`SELECT status FROM one_on_one_meetings WHERE id = $1`, [m])).toEqual([{ status: "in_progress" }]);
    expect(await t.sql(`SELECT count(*)::int AS n FROM one_on_one_commitment_reviews`)).toEqual([{ n: 0 }]);

    const first = await complete(m, { version: 1, marker: "first" });
    const again = await complete(m, { version: 1, marker: "second" });
    expect(again).toEqual(first); // unchanged — not re-snapshotted
    await expect(
      t.sql(`SELECT * FROM complete_one_on_one_meeting(gen_random_uuid(), $1, '{}')`, [MGR]),
    ).rejects.toMatchObject({ code: "P0002" });
  });
});

describe("update_legacy_commitment_in_one_on_one()", () => {
  async function legacy(): Promise<string> {
    const [w] = await t.sql<{ id: string }>(
      `INSERT INTO one_on_ones (ae_id, week_start, meeting_date) VALUES ($1, '2026-09-14', '2026-09-15') RETURNING id`,
      [AE],
    );
    const [c] = await t.sql<{ id: string }>(
      `INSERT INTO one_on_one_commitments (one_on_one_id, ae_id, content, status) VALUES ($1, $2, 'Legacy', 'open') RETURNING id`,
      [w.id, AE],
    );
    return c.id;
  }
  const call = (m: string, c: string, patch: unknown) =>
    t.sql(`SELECT * FROM update_legacy_commitment_in_one_on_one($1, $2, $3)`, [m, c, patch]);

  it("applies the patch while the 1:1 is in progress, and the snapshot sees it", async () => {
    const c = await legacy();
    const m = await meeting();
    const [row] = await call(m, c, { status: "completed", completed: true, completed_at: "2026-09-29T18:00:00Z" });
    expect(row).toMatchObject({ status: "completed", completed: true });
    await call(m, c, { content: "Reworded", due_date: "2026-10-09" });
    await complete(m);
    const [review] = await t.sql(
      `SELECT description, status FROM one_on_one_commitment_reviews WHERE meeting_id = $1 AND legacy_commitment_id = $2`,
      [m, c],
    );
    expect(review).toEqual({ description: "Reworded", status: "completed" });
  });

  it("refuses once the 1:1 is completed — the row is untouched", async () => {
    const c = await legacy();
    const m = await meeting();
    await complete(m);
    await expect(call(m, c, { status: "dropped", completed: false, completed_at: null })).rejects.toMatchObject({
      code: "23514",
    });
    expect(await t.sql(`SELECT status FROM one_on_one_commitments WHERE id = $1`, [c])).toEqual([{ status: "open" }]);
  });

  it("refuses another AE's legacy commitment, and unknown ids", async () => {
    const c = await legacy();
    const theirs = await meeting(OTHER);
    await expect(call(theirs, c, { status: "completed" })).rejects.toMatchObject({ code: "P0002" });
    await expect(
      t.sql(`SELECT * FROM update_legacy_commitment_in_one_on_one(gen_random_uuid(), $1, '{}')`, [c]),
    ).rejects.toMatchObject({ code: "P0002" });
  });

  it("is service_role-only", async () => {
    const [row] = await t.sql<Record<string, boolean>>(`
      SELECT has_function_privilege('anon', 'update_legacy_commitment_in_one_on_one(uuid,uuid,jsonb)', 'EXECUTE') AS anon,
             has_function_privilege('service_role', 'update_legacy_commitment_in_one_on_one(uuid,uuid,jsonb)', 'EXECUTE') AS service`);
    expect(row).toEqual({ anon: false, service: true });
  });

  it("leaves ordinary Weekly Focus writes (no 1:1 in progress) unlocked", async () => {
    const c = await legacy();
    await t.sql(`UPDATE one_on_one_commitments SET status = 'completed', completed = true, completed_at = now() WHERE id = $1`, [c]);
    const m = await meeting();
    // Even with a draft open, the original route's plain UPDATE still works.
    await t.sql(`UPDATE one_on_one_commitments SET status = 'open', completed = false, completed_at = NULL WHERE id = $1`, [c]);
    await complete(m);
  });
});

describe("draft revisions", () => {
  it("adds per-field revisions starting at 0", async () => {
    const m = await meeting();
    const [row] = await t.sql(
      `SELECT wins_rev, activity_notes_rev, coaching_focus_rev, coaching_notes_rev FROM one_on_one_meetings WHERE id = $1`,
      [m],
    );
    expect(row).toEqual({ wins_rev: 0, activity_notes_rev: 0, coaching_focus_rev: 0, coaching_notes_rev: 0 });
    const n = await note(m);
    expect(await t.sql(`SELECT revision FROM one_on_one_gold_list_notes WHERE id = $1`, [n])).toEqual([{ revision: 0 }]);
  });

  it("the lock never blocks a draft field save running alongside a child write", async () => {
    // KEY SHARE (child writes) is compatible with the meeting's own UPDATE.
    const m = await meeting();
    await t.pg.transaction(async (tx) => {
      await tx.query(`UPDATE one_on_one_meetings SET wins = 'w', wins_rev = 1 WHERE id = $1`, [m]);
      await tx.query(
        `INSERT INTO one_on_one_gold_list_notes (meeting_id, ae_id, agent_id, agent_name, note) VALUES ($1, $2, $3, 'Sarah', 'n')`,
        [m, AE, AGENT],
      );
    });
    expect(await t.sql(`SELECT count(*)::int AS n FROM one_on_one_gold_list_notes`)).toEqual([{ n: 1 }]);
  });
});
