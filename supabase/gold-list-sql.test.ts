/**
 * Guard tests for the Gold List migration.
 *
 * `supabase/gold_list.sql` is applied BY HAND in the Supabase SQL editor (see
 * supabase/README.md), against three different starting points:
 *
 *   1. a fresh database,
 *   2. a database that already ran an earlier version of this same file,
 *   3. a database holding live agents and activities, including completed
 *      history.
 *
 * There is no automated apply step to catch a mistake, so this file asserts the
 * SHAPE of the SQL. The rules it protects are the ones whose violation would be
 * silent and irreversible in production: data loss on re-run, a NOT NULL column
 * added to a populated table, or a weakening of the history protections.
 *
 * It is a static check, not an execution — it cannot prove the SQL runs, only
 * that it never says the things it must not say.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

const raw = readFileSync(join(here, "gold_list.sql"), "utf8");

/** Statements only, with `--` comment lines stripped. */
const sql = raw
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

describe("gold_list.sql — re-runnable against existing data", () => {
  it("wraps everything in one transaction, so a failed run leaves nothing half-applied", () => {
    expect(sql.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("creates both tables only when absent", () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS gold_list_agents/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS gold_list_activities/);
  });

  it("never drops, deletes or truncates Gold List data", () => {
    // DROP INDEX / DROP TRIGGER / DROP CONSTRAINT are fine — they rebuild
    // themselves on the next line. Losing rows is not.
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/TRUNCATE/i);
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
  });

  it("re-creates every trigger and constraint idempotently", () => {
    for (const statement of sql.match(/CREATE TRIGGER (\w+)/g) ?? []) {
      const name = statement.replace("CREATE TRIGGER ", "");
      expect(sql).toMatch(new RegExp(`DROP TRIGGER IF EXISTS ${name}`));
    }
    for (const statement of sql.match(/ADD CONSTRAINT (\w+)/g) ?? []) {
      const name = statement.replace("ADD CONSTRAINT ", "");
      // Table-definition constraints live inside CREATE TABLE IF NOT EXISTS;
      // only the ALTER-added ones need an explicit drop first.
      if (!sql.includes(`ALTER TABLE gold_list_activities ADD CONSTRAINT ${name}`))
        continue;
      expect(sql).toMatch(new RegExp(`DROP CONSTRAINT IF EXISTS ${name}`));
    }
  });
});

describe("gold_list.sql — the scheduled activity note", () => {
  it("adds activity_note only when absent, so a re-run is a no-op", () => {
    expect(sql).toMatch(
      /ALTER TABLE gold_list_activities\s+ADD COLUMN IF NOT EXISTS activity_note TEXT;/,
    );
  });

  it("leaves the column NULLABLE — existing activities need no backfill", () => {
    expect(sql).not.toMatch(/ALTER COLUMN activity_note SET NOT NULL/);
    expect(sql).not.toMatch(/ADD COLUMN IF NOT EXISTS activity_note TEXT NOT NULL/);
    // And nothing writes a value into it, so live rows keep reading "no note".
    expect(sql).not.toMatch(/SET activity_note/);
  });

  it("bounds the note with a re-addable CHECK that tolerates NULL", () => {
    expect(sql).toMatch(
      /DROP CONSTRAINT IF EXISTS gold_list_activity_note_valid/,
    );
    expect(sql).toMatch(
      /CHECK \(activity_note IS NULL OR length\(activity_note\) <= 2000\)/,
    );
  });

  it("does NOT reuse or rename the completion note column", () => {
    // outcome_note keeps its own definition in the table…
    expect(sql).toMatch(/^\s*outcome_note TEXT,/m);
    // …and is never renamed into, or dropped in favour of, the new column.
    expect(sql).not.toMatch(/RENAME COLUMN outcome_note/i);
    expect(sql).not.toMatch(/RENAME\s+.*\s+TO activity_note/i);
    // The agent's own relationship note is likewise a separate column.
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS gold_list_agents[\s\S]*?\n {2}notes TEXT,/);
  });
});

describe("gold_list.sql — protections the note must not weaken", () => {
  it("still freezes an activity once it leaves 'scheduled'", () => {
    // The trigger compares OLD.status, so EVERY column on a finished row —
    // including activity_note — is immutable. Adding the column changed
    // nothing here, and this test fails if that guard is ever relaxed.
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION protect_gold_list_activity_history/);
    expect(sql).toMatch(/OLD\.status <> 'scheduled'/);
    expect(sql).toMatch(
      /CREATE TRIGGER trg_gold_list_activity_history BEFORE UPDATE ON gold_list_activities/,
    );
  });

  it("still allows only one open activity per agent", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_gold_list_activities_one_open[\s\S]*?ON gold_list_activities\(agent_id\)[\s\S]*?WHERE status = 'scheduled'/,
    );
  });

  it("still keeps an activity's owner tied to its agent, and RLS closed", () => {
    expect(sql).toMatch(
      /FOREIGN KEY \(agent_id, salesperson_id\)[\s\S]*?REFERENCES gold_list_agents\(id, salesperson_id\)/,
    );
    expect(sql).toMatch(/ALTER TABLE gold_list_agents ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(
      /ALTER TABLE gold_list_activities ENABLE ROW LEVEL SECURITY/,
    );
    // Server-only: no policy may be granted to the browser's anon key.
    expect(sql).not.toMatch(/CREATE POLICY/i);
  });
});
