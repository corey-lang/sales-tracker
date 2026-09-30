/**
 * Guard tests for supabase/one_on_one_meetings.sql.
 *
 * Like every migration here, it's applied BY HAND in the Supabase SQL editor
 * against a production database that already holds Weekly Focus history. This
 * is a static check of the SQL's SHAPE (it can't prove the SQL runs) that
 * pins the properties whose violation would be silent and irreversible: data
 * loss, touching legacy Weekly Focus tables, weakening server-only access, or
 * dropping the rules that keep a completed 1:1 immutable.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "one_on_one_meetings.sql"), "utf8");
/** Statements only, `--` comment lines stripped. */
const sql = raw
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

/** Top-level statements only: plpgsql function bodies ($$…$$) removed, since
 *  they run only when explicitly called, never as part of applying the file. */
const topLevel = sql.replace(/\$\$[\s\S]*?\$\$/g, "$$$$");

const NEW_TABLES = [
  "one_on_one_meetings",
  "one_on_one_gold_list_notes",
  "one_on_one_meeting_commitments",
  "one_on_one_commitment_reviews",
];
const LEGACY_TABLES = [
  "one_on_ones",
  "one_on_one_commitments",
  "weekly_focus_private_notes",
  "coaching_relationships",
  "training_commitments",
];

describe("one_on_one_meetings.sql — additive and re-runnable", () => {
  it("runs in one transaction", () => {
    expect(sql.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("creates each new table only when absent", () => {
    for (const t of NEW_TABLES) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(`));
    }
  });

  it("never drops, deletes, truncates, or updates data when applied", () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/TRUNCATE/i);
    expect(topLevel).not.toMatch(/DELETE\s+FROM/i);
    expect(topLevel).not.toMatch(/^\s*UPDATE\s/im);
  });

  it("does not alter any legacy Weekly Focus table", () => {
    for (const t of LEGACY_TABLES) {
      expect(sql).not.toMatch(new RegExp(`ALTER TABLE\\s+${t}\\b`, "i"));
      expect(sql).not.toMatch(new RegExp(`ON\\s+${t}\\b`, "i"));
    }
  });

  it("only ADDs nullable, default-less actor/attribution columns to gold_list_activities", () => {
    const alters = sql.match(/ALTER TABLE gold_list_activities[^;]*;/g) ?? [];
    expect(alters).toHaveLength(5);
    for (const a of alters) {
      expect(a).toMatch(
        /ADD COLUMN IF NOT EXISTS (created_by|completed_by|created_in_meeting_id|closed_in_meeting_id|rescheduled_in_meeting_id) UUID;$/,
      );
      expect(a).not.toMatch(/NOT NULL|DEFAULT|REFERENCES/i);
    }
  });

  it("re-creates every trigger idempotently", () => {
    for (const statement of sql.match(/CREATE TRIGGER (\w+)/g) ?? []) {
      const name = statement.replace("CREATE TRIGGER ", "");
      expect(sql).toMatch(new RegExp(`DROP TRIGGER IF EXISTS ${name}`));
    }
  });
});

describe("one_on_one_meetings.sql — the rules the app relies on", () => {
  it("allows at most one in-progress meeting per AE", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_one_on_one_meetings_one_in_progress\s+ON one_on_one_meetings\(ae_id\)\s+WHERE status = 'in_progress';/,
    );
  });

  it("freezes completed meetings and their notes/reviews in the database", () => {
    expect(sql).toMatch(
      /BEFORE UPDATE OR DELETE ON one_on_one_meetings\s+FOR EACH ROW EXECUTE FUNCTION protect_completed_one_on_one_meeting\(\)/,
    );
    for (const t of ["one_on_one_gold_list_notes", "one_on_one_commitment_reviews"]) {
      expect(sql).toMatch(
        new RegExp(
          `BEFORE INSERT OR UPDATE OR DELETE ON ${t}\\s+FOR EACH ROW EXECUTE FUNCTION protect_completed_one_on_one_children\\(\\)`,
        ),
      );
    }
    expect(sql).toMatch(/IF OLD\.status = 'completed' THEN\s+RAISE EXCEPTION/);
  });

  it("keeps a completed meeting's snapshot mandatory", () => {
    expect(sql).toMatch(
      /status = 'completed' AND completed_at IS NOT NULL AND activity_snapshot IS NOT NULL/,
    );
  });

  it("never cascades 1:1 history away with a salesperson", () => {
    expect(sql).toMatch(/ae_id UUID NOT NULL REFERENCES salespeople\(id\) ON DELETE RESTRICT/);
    expect(sql).not.toMatch(/REFERENCES salespeople\(id\) ON DELETE CASCADE/);
  });

  it("is server-only: RLS on every new table, no policies, RPC for service_role only", () => {
    for (const t of NEW_TABLES) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE ${t}\\s+ENABLE ROW LEVEL SECURITY;`));
    }
    expect(sql).not.toMatch(/CREATE POLICY/i);
    const grants = sql.match(/^GRANT[^;]*;/gm) ?? [];
    // service_role is the ONLY grantee, of exactly these functions.
    expect(grants).toEqual([
      "GRANT EXECUTE ON FUNCTION complete_one_on_one_meeting(UUID, UUID, JSONB) TO service_role;",
      "GRANT EXECUTE ON FUNCTION lock_open_one_on_one_meeting(UUID, UUID, BOOLEAN) TO service_role;",
      "GRANT EXECUTE ON FUNCTION update_legacy_commitment_in_one_on_one(UUID, UUID, JSONB) TO service_role;",
      "GRANT EXECUTE ON FUNCTION update_legacy_commitment(UUID, UUID, JSONB) TO service_role;",
      "GRANT EXECUTE ON FUNCTION apply_legacy_commitment_patch(UUID, JSONB) TO service_role;",
    ]);
    for (const sig of [
      "complete_one_on_one_meeting(UUID, UUID, JSONB)",
      "lock_open_one_on_one_meeting(UUID, UUID, BOOLEAN)",
      "update_legacy_commitment_in_one_on_one(UUID, UUID, JSONB)",
      "update_legacy_commitment(UUID, UUID, JSONB)",
      "apply_legacy_commitment_patch(UUID, JSONB)",
    ]) {
      for (const role of ["PUBLIC", "anon", "authenticated"]) {
        expect(sql).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM ${role};`);
      }
    }
    expect(sql).toMatch(/complete_one_on_one_meeting\([\s\S]*?SECURITY INVOKER/);
  });

  it("serializes completion with meeting-scoped writes (FOR UPDATE vs FOR KEY SHARE NOWAIT)", () => {
    expect(sql).toMatch(/FROM one_on_one_meetings WHERE id = p_meeting_id FOR UPDATE;/);
    expect(sql).toMatch(/FROM one_on_one_meetings WHERE id = p_meeting_id FOR KEY SHARE NOWAIT;/);
    // Completion holds legacy rows still, always AFTER the meeting row —
    // the same order the meeting-scoped legacy write uses (no deadlock).
    const complete = sql.slice(
      sql.indexOf("FUNCTION complete_one_on_one_meeting("),
      sql.indexOf("REVOKE ALL ON FUNCTION complete_one_on_one_meeting"),
    );
    expect(complete.indexOf("FOR UPDATE;")).toBeLessThan(
      complete.indexOf("FROM one_on_one_commitments WHERE ae_id = m.ae_id FOR SHARE;"),
    );
    const legacy = sql.slice(sql.indexOf("FUNCTION update_legacy_commitment_in_one_on_one("));
    expect(legacy.indexOf("lock_open_one_on_one_meeting(p_meeting_id, m_ae)")).toBeLessThan(
      legacy.indexOf("FOR UPDATE;"),
    );
    // The original Weekly Focus route's write: meeting row, THEN commitment.
    const compat = sql.slice(
      sql.indexOf("FUNCTION update_legacy_commitment("),
      sql.indexOf("REVOKE ALL ON FUNCTION update_legacy_commitment(UUID"),
    );
    expect(compat).toMatch(/WHERE ae_id = v_ae AND status = 'in_progress'\s+FOR KEY SHARE;/);
    expect(compat.indexOf("FOR KEY SHARE;")).toBeLessThan(compat.indexOf("FOR UPDATE;"));
    expect(compat).not.toMatch(/NOWAIT/); // waits: it holds no other lock yet
    for (const t of ["one_on_one_meeting_commitments", "gold_list_activities"]) {
      expect(sql).toMatch(new RegExp(`BEFORE INSERT OR UPDATE[\\s\\S]{0,20}ON ${t}`));
    }
  });

  it("checks BOTH the old and new parent when a frozen child row is updated", () => {
    const fn = sql.slice(
      sql.indexOf("FUNCTION protect_completed_one_on_one_children"),
      sql.indexOf("DROP TRIGGER IF EXISTS trg_protect_completed_one_on_one_gold_list_notes"),
    );
    expect(fn).toMatch(/lock_open_one_on_one_meeting\(OLD\.meeting_id, NULL\);/);
    expect(fn).toMatch(/IF NEW\.meeting_id IS DISTINCT FROM OLD\.meeting_id THEN\s+PERFORM lock_open_one_on_one_meeting\(NEW\.meeting_id, NULL\);\s+RAISE EXCEPTION/);
  });

  it("gives upserts the unique keys the server uses", () => {
    expect(sql).toMatch(/UNIQUE \(meeting_id, agent_id\)/);
    expect(sql).toMatch(/UNIQUE \(meeting_id, commitment_id\)/);
    expect(sql).toMatch(/UNIQUE \(meeting_id, legacy_commitment_id\)/);
  });
});

// ---------------------------------------------------------------------------
// Goal-change consistency check: no completion path may skip it
// ---------------------------------------------------------------------------

describe("every completion path is checked against goal changes", () => {
  const v2 = readFileSync(join(process.cwd(), "supabase", "one_on_one_workspace_v2.sql"), "utf8");
  const fnBodies = (sql: string) =>
    [...sql.matchAll(/CREATE OR REPLACE FUNCTION complete_one_on_one_meeting\(([\s\S]*?)\n\$\$;/g)].map((m) => m[0]);

  it("V2 defines exactly two signatures: the checked 4-arg implementation and a 3-arg wrapper that passes 0", () => {
    const bodies = fnBodies(v2);
    expect(bodies).toHaveLength(2);
    const [four, three] = bodies;
    expect(four).toContain("p_goal_changes_seen INTEGER");
    // Unconditional: NULL is rejected, and the comparison has no NULL escape hatch.
    expect(four).toMatch(/IF p_goal_changes_seen IS NULL THEN\s+RAISE EXCEPTION[\s\S]*?22004/);
    expect(four).toMatch(/IF jsonb_array_length\(m\.goal_changes\) <> p_goal_changes_seen THEN/);
    expect(four).not.toMatch(/p_goal_changes_seen IS NOT NULL/);
    // The wrapper only delegates, with a literal 0 — never NULL, never a variable.
    expect(three).not.toContain("p_goal_changes_seen INTEGER");
    expect(three).toMatch(/RETURN complete_one_on_one_meeting\(\s*p_meeting_id, p_completed_by, p_activity_snapshot, 0\);/);
    expect(three).not.toMatch(/NULL::integer|, NULL\)/);
    expect(three).not.toMatch(/UPDATE one_on_one_meetings/); // no second implementation
  });

  it("the original (3-arg) body is replaced by V2 — the only other definition is the deployed migration it supersedes", () => {
    const original = readFileSync(join(process.cwd(), "supabase", "one_on_one_meetings.sql"), "utf8");
    expect(fnBodies(original)).toHaveLength(1);
    // Applied in README order, V2 (#49) always runs after it (#47).
    const readme = readFileSync(join(process.cwd(), "supabase", "README.md"), "utf8");
    expect(readme.indexOf("`one_on_one_meetings.sql`")).toBeLessThan(readme.indexOf("`one_on_one_workspace_v2.sql`"));
  });

  it("no other SQL file defines or calls completion", () => {
    const dir = join(process.cwd(), "supabase");
    const others = readdirSync(dir)
      .filter((f) => f.endsWith(".sql") && f !== "one_on_one_meetings.sql" && f !== "one_on_one_workspace_v2.sql")
      .filter((f) => readFileSync(join(dir, f), "utf8").includes("complete_one_on_one_meeting"));
    expect(others).toEqual([]);
  });

  it("the ONLY application call passes p_goal_changes_seen (and nothing calls the 3-arg form)", () => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !full.includes("/src/test/")) {
          const text = readFileSync(full, "utf8");
          for (const m of text.matchAll(/rpc\(\s*["']complete_one_on_one_meeting["']\s*,\s*\{([\s\S]*?)\}\s*\)/g)) {
            hits.push(`${full}: ${m[1].includes("p_goal_changes_seen") ? "checked" : "UNCHECKED"}`);
          }
        }
      }
    };
    walk(join(process.cwd(), "src"));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/one-on-one-meetings\.ts: checked$/);
  });
});
