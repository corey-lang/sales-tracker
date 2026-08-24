/**
 * Guard tests for the offboarding migrations.
 *
 * These assert the SHAPE of the SQL we ask an admin to run, because the
 * business rule is about what must NOT happen: no historical row of Chanel's
 * may be deleted or re-attributed, and Austin must be left unassigned rather
 * than handed to anyone. A future edit that "cleans up" by deleting her row —
 * which cascades to activity entries, offices, visits, tasks, Juice Box
 * messages and coaching records — fails here instead of in production.
 *
 * Migration files are applied by hand in the Supabase SQL editor (see
 * supabase/README.md), so this static check is the only automated gate they
 * have.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const sql = (name: string) => readFileSync(join(here, name), "utf8");

/** Statements only, with `--` comment lines stripped. */
function statements(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

const DEACTIVATE = statements(sql("deactivate_chanel.sql"));
const COLUMN = statements(sql("salespeople_deactivated_at.sql"));
const LEAH = statements(sql("add_leah_juice_box_only.sql"));

/** Tables whose rows are historical authorship — never deleted, never moved. */
const HISTORY_TABLES = [
  "activity_entries",
  "office_visits",
  "offices",
  "ae_tasks",
  "team_messages",
  "team_message_reactions",
  "team_message_reads",
  "business_card_scans",
  "business_card_contacts",
  "one_on_ones",
  "one_on_one_commitments",
  "weekly_focus_private_notes",
  "weekly_goals",
  "working_day_adjustments",
];

describe("deactivate_chanel.sql preserves history", () => {
  it("soft-disables the person instead of deleting the row", () => {
    expect(DEACTIVATE).toMatch(/UPDATE salespeople/i);
    expect(DEACTIVATE).toMatch(/deactivated_at = COALESCE\(deactivated_at, NOW\(\)\)/i);
    expect(DEACTIVATE).not.toMatch(/DELETE\s+FROM\s+salespeople/i);
  });

  it("never deletes from a history table", () => {
    for (const table of HISTORY_TABLES) {
      expect(DEACTIVATE).not.toMatch(
        new RegExp(`DELETE\\s+FROM\\s+${table}\\b`, "i"),
      );
    }
  });

  it("never re-attributes a history row to someone else", () => {
    // Re-attribution would mean UPDATEing a salesperson_id / ae_id column.
    expect(DEACTIVATE).not.toMatch(/SET\s+salesperson_id\s*=/i);
    expect(DEACTIVATE).not.toMatch(/SET\s+ae_id\s*=/i);
    for (const table of HISTORY_TABLES) {
      expect(DEACTIVATE).not.toMatch(
        new RegExp(`UPDATE\\s+${table}\\b`, "i"),
      );
    }
  });

  it("releases the Austin territory by soft-disabling the mapping", () => {
    expect(DEACTIVATE).toMatch(/UPDATE cogent_territory_mappings/i);
    expect(DEACTIVATE).toMatch(/SET\s+active = FALSE/i);
    // The mapping row itself is kept (historical territory→AE link), and it is
    // NOT pointed at a different person here.
    expect(DEACTIVATE).not.toMatch(/DELETE\s+FROM\s+cogent_territory_mappings/i);
    expect(DEACTIVATE).not.toMatch(
      /INSERT\s+INTO\s+cogent_territory_mappings/i,
    );
  });

  it("does not assign Austin to a replacement AE", () => {
    // Austin stays unmapped until someone is hired; the file may only mention
    // it in commentary, which `statements()` has already stripped.
    expect(DEACTIVATE).not.toMatch(/'Austin'/);
  });

  it("revokes only push devices, which are credentials rather than history", () => {
    expect(DEACTIVATE).toMatch(/DELETE\s+FROM\s+push_subscriptions/i);
  });
});

describe("salespeople_deactivated_at.sql is additive", () => {
  it("adds a nullable column and nothing else", () => {
    expect(COLUMN).toMatch(
      /ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ/i,
    );
    expect(COLUMN).not.toMatch(/NOT NULL/i);
    expect(COLUMN).not.toMatch(/\bDROP\b/i);
    expect(COLUMN).not.toMatch(/DELETE\s+FROM/i);
  });

  it("does not touch RLS, policies, or grants", () => {
    expect(COLUMN).not.toMatch(/ROW LEVEL SECURITY/i);
    expect(COLUMN).not.toMatch(/CREATE POLICY/i);
    expect(COLUMN).not.toMatch(/\bGRANT\b/i);
    expect(COLUMN).not.toMatch(/\bREVOKE\b/i);
  });
});

describe("add_leah_juice_box_only.sql", () => {
  it("seeds exactly one juice_box_only row, idempotently", () => {
    expect(LEAH).toMatch(/INSERT INTO salespeople/i);
    expect(LEAH).toMatch(/'Leah',\s*'juice_box_only'/i);
    expect(LEAH).toMatch(/ON CONFLICT \(first_name\) DO UPDATE/i);
  });

  it("does not set an id, a PIN, or any elevated flag", () => {
    // The id comes from the table's gen_random_uuid() default — same source of
    // truth as every other salesperson.
    expect(LEAH).not.toMatch(/\bid\s*=/i);
    expect(LEAH).not.toMatch(/admin_pin/i);
    expect(LEAH).not.toMatch(/is_admin/i);
    expect(LEAH).not.toMatch(/can_import_offices/i);
    expect(LEAH).not.toMatch(/role\s*=\s*'ae'/i);
  });
});
