/**
 * Tests for the "channels migration not applied" detector.
 *
 * WHY THIS MATTERS
 *   Against a database that predates supabase/juice_box_channels.sql, every
 *   Juice Box request answered with an opaque "Something went wrong." — which
 *   reads like an app bug. Mapping that one condition to a clear 503 makes a
 *   local preview actionable. The risk is over-matching: a coincidental
 *   missing-object error elsewhere must NOT be reported as "run migration #45",
 *   or a real bug would be dressed up as a setup step. Both directions are
 *   pinned here.
 */

import { describe, expect, it } from "vitest";

import {
  isMissingChannelsMigration,
  JUICE_BOX_MIGRATION_REQUIRED_MESSAGE,
  migrationRequiredError,
} from "@/lib/server/juice-box-migration";

describe("isMissingChannelsMigration — recognizes the real thing", () => {
  it("detects the missing team_messages.channel column (42703)", () => {
    // Exactly what the live probe returned pre-migration.
    expect(
      isMissingChannelsMigration({
        code: "42703",
        message: "column team_messages.channel does not exist",
      }),
    ).toBe(true);
  });

  it("detects the missing channel-reads table (PGRST205)", () => {
    expect(
      isMissingChannelsMigration({
        code: "PGRST205",
        message:
          "Could not find the table 'public.team_message_channel_reads' in the schema cache",
      }),
    ).toBe(true);
  });

  it("detects the missing mark-read RPCs (PGRST202 / 42883)", () => {
    expect(
      isMissingChannelsMigration({
        code: "PGRST202",
        message:
          "Could not find the function public.juice_box_mark_channel_read(p_channel, p_salesperson_id) in the schema cache",
      }),
    ).toBe(true);
    expect(
      isMissingChannelsMigration({
        code: "42883",
        message: "function public.juice_box_mark_legacy_read(text) does not exist",
      }),
    ).toBe(true);
  });

  it("detects the missing move-conversation RPC and audit table", () => {
    expect(
      isMissingChannelsMigration({
        code: "PGRST202",
        message:
          "Could not find the function public.juice_box_move_conversation in the schema cache",
      }),
    ).toBe(true);
    expect(
      isMissingChannelsMigration({
        code: "PGRST205",
        message:
          "Could not find the table 'public.juice_box_conversation_moves' in the schema cache",
      }),
    ).toBe(true);
  });

  it("detects a schema-cache column miss (PGRST204)", () => {
    expect(
      isMissingChannelsMigration({
        code: "PGRST204",
        message: "Could not find the 'channel' column of 'team_messages'",
      }),
    ).toBe(true);
  });
});

describe("isMissingChannelsMigration — does not over-match", () => {
  it("ignores a missing-object error about something else entirely", () => {
    // A real bug must keep its generic 500, not be relabelled a setup step.
    expect(
      isMissingChannelsMigration({
        code: "42703",
        message: "column offices.office_phone does not exist",
      }),
    ).toBe(false);
    expect(
      isMissingChannelsMigration({
        code: "PGRST205",
        message: "Could not find the table 'public.ae_tasks' in the schema cache",
      }),
    ).toBe(false);
  });

  it("ignores non-missing-object errors even when they mention a channel", () => {
    for (const code of ["23505", "42501", "PGRST301", "57014", ""]) {
      expect(
        isMissingChannelsMigration({
          code,
          message: "something about channel went wrong",
        }),
      ).toBe(false);
    }
  });

  it("ignores null / empty / shapeless errors", () => {
    expect(isMissingChannelsMigration(null)).toBe(false);
    expect(isMissingChannelsMigration(undefined)).toBe(false);
    expect(isMissingChannelsMigration({})).toBe(false);
    expect(isMissingChannelsMigration({ code: "42703" })).toBe(false);
    expect(isMissingChannelsMigration({ message: "channel" })).toBe(false);
  });
});

describe("migrationRequiredError", () => {
  it("is a 503 naming the migration to run", () => {
    const err = migrationRequiredError();
    // 503, not 500: "this deployment isn't configured yet", not "broken".
    expect(err.status).toBe(503);
    expect(err.message).toBe(JUICE_BOX_MIGRATION_REQUIRED_MESSAGE);
    expect(err.message).toContain("juice_box_channels.sql");
  });
});
