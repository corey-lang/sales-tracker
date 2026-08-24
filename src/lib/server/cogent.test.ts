/**
 * Tests for the order-attribution allow-list (`isAttributableAe`).
 *
 * OPERATIONAL OWNERSHIP vs HISTORICAL AUTHORSHIP
 *   A territory (Austin) is transferable operational ownership. When its AE
 *   leaves, the territory must become UNASSIGNED — surfacing under
 *   `unmappedTerritories` — rather than continuing to credit orders to the
 *   person who left, and without touching any historical row. This predicate is
 *   the code half of that (the data half is `active = FALSE` on the mapping,
 *   see supabase/deactivate_chanel.sql); it is also what keeps Austin free for
 *   the next hire, since attribution follows the mapping's salesperson_id and
 *   nothing else.
 */

import { describe, expect, it } from "vitest";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const { isAttributableAe } = await import("@/lib/server/cogent");

const activeAe = {
  first_name: "Carli",
  role: "ae",
  is_test: false,
  deactivated_at: null,
};

describe("isAttributableAe", () => {
  it("credits an active production AE", () => {
    expect(isAttributableAe(activeAe)).toBe(true);
  });

  it("does NOT credit a deactivated AE — the territory goes unmapped", () => {
    // Chanel's shape after offboarding: still role='ae', still in the table
    // (her history depends on the row), but no longer attributable.
    expect(
      isAttributableAe({
        ...activeAe,
        first_name: "Chanel",
        deactivated_at: "2026-08-24T18:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("does not credit non-AE roles or the test account", () => {
    expect(isAttributableAe({ ...activeAe, role: "admin" })).toBe(false);
    expect(isAttributableAe({ ...activeAe, role: "assistant" })).toBe(false);
    expect(isAttributableAe({ ...activeAe, role: "juice_box_only" })).toBe(
      false,
    );
    expect(isAttributableAe({ ...activeAe, is_test: true })).toBe(false);
  });

  it("does not credit a missing relation", () => {
    expect(isAttributableAe(null)).toBe(false);
    expect(isAttributableAe({})).toBe(false);
  });

  it("credits a future Austin hire without any historical change", () => {
    // The replacement is just another active AE row: pointing the existing
    // Austin mapping at their id (and re-activating it) is all that's needed.
    // No historical activity/visit/message row is touched by that.
    expect(
      isAttributableAe({
        first_name: "NextAustinAe",
        role: "ae",
        is_test: false,
        deactivated_at: null,
      }),
    ).toBe(true);
  });
});
