/**
 * Navigation composition tests for the bottom tab bar.
 *
 * WHY THIS FILE EXISTS
 *   Gold List replaced Leaderboard in the bottom nav (Leaderboard moved to
 *   /more, unchanged). The tab bar is the one place where a role's visible
 *   surface is assembled, and two of its rules are easy to break silently:
 *
 *     * Gold List must sit in the slot Leaderboard used to hold, so the
 *       muscle memory of the third tab carries over;
 *     * Gold List must NOT render for `assistant` or `juice_box_only`, whose
 *       accounts have no Gold List surface — /gold-list redirects them and
 *       /api/gold-list/* 403s them, and this keeps the chrome consistent with
 *       that.
 *
 *   `buildNavItems` is a pure function of the stored session, so the whole
 *   per-role matrix can be asserted without a DOM (this project has no
 *   jsdom / testing-library setup).
 *
 * NOT AN AUTHORIZATION TEST. Nothing here is a security boundary — the stored
 * session is user-editable by design (see the note in use-salesperson.ts) and
 * every route re-checks the caller server-side. These assertions are about
 * what the app SHOWS, not what it ALLOWS.
 */

import { describe, expect, it } from "vitest";

// The nav module pulls in the Juice Box unread provider, which imports the
// browser Supabase client; that module throws at load without these.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const { buildNavItems } = await import("@/components/bottom-nav");

import type { StoredSalesperson } from "@/lib/use-salesperson";
import type { UserRole } from "@/lib/permissions";

function session(role: UserRole): StoredSalesperson {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    first_name: "Carli",
    role,
    token: "header.signature",
  };
}

const hrefs = (role: UserRole) => buildNavItems(session(role)).map((i) => i.href);

describe("buildNavItems", () => {
  it("gives an AE six tabs with Gold List in Leaderboard's old slot", () => {
    expect(hrefs("ae")).toEqual([
      "/dashboard",
      "/juice-box",
      "/gold-list",
      "/offices?view=map",
      "/todos",
      "/scan-biz-card",
    ]);
  });

  it("gives an admin the same tabs, with Home pointing at /admin", () => {
    expect(hrefs("admin")).toEqual([
      "/admin",
      "/juice-box",
      "/gold-list",
      "/offices?view=map",
      "/todos",
      "/scan-biz-card",
    ]);
  });

  it("hides Gold List from assistants", () => {
    expect(hrefs("assistant")).toEqual(["/dashboard", "/juice-box"]);
  });

  it("hides Gold List from juice_box_only accounts", () => {
    expect(hrefs("juice_box_only")).toEqual(["/juice-box"]);
  });

  it("shows only the AE home tab when signed out", () => {
    expect(buildNavItems(null).map((i) => i.href)).toEqual(["/dashboard"]);
  });

  it("uses the full 'Gold List' label", () => {
    const goldList = buildNavItems(session("ae")).find(
      (i) => i.href === "/gold-list",
    );
    expect(goldList?.label).toBe("Gold List");
  });

  it("no longer renders a Leaderboard tab for any role — it lives on /more", () => {
    for (const role of [
      "ae",
      "admin",
      "assistant",
      "juice_box_only",
    ] as UserRole[]) {
      expect(hrefs(role)).not.toContain("/leaderboard");
    }
    expect(buildNavItems(null).map((i) => i.href)).not.toContain("/leaderboard");
  });

  it("never exceeds six tabs — the grid ladder in BottomNav stops there", () => {
    for (const role of [
      "ae",
      "admin",
      "assistant",
      "juice_box_only",
    ] as UserRole[]) {
      expect(buildNavItems(session(role)).length).toBeLessThanOrEqual(6);
    }
  });
});
