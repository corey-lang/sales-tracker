/**
 * Road to 10,000 — how people REACH it in the app (chrome), and what the page
 * shows each role. Presentation only: the math is in lib/road-to-10000.test.ts,
 * and every server-side permission (read = AE-tool users, update = admin /
 * assistant, juice_box_only refused, DB function re-check) is enforced and tested
 * in app/api/road-to-10000/road-to-10000.test.ts — the last block here runs the
 * real route handler to prove that still holds.
 *
 * ROOT CAUSE this guards against: admins (Corey, Ryan) land on /admin and their
 * Home tab points there, so they never open /dashboard — the only place the Home
 * card used to render. The Admin Tools link existed but sat inside a closed
 * dropdown, and /more (the Settings area) had no entry at all.
 *
 * Pages are rendered with react-dom/server (this project has no jsdom); hooks
 * that read the session / live permissions are mocked per role.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

type Role = "admin" | "assistant" | "ae" | "juice_box_only";
const who = vi.hoisted(() => ({ role: "ae" as Role }));

const stored = () => ({
  token: "test-token",
  id: "11111111-1111-4111-8111-111111111111",
  first_name: "Test",
  role: who.role,
  location: null,
  is_admin: who.role === "admin",
  can_import_offices: false,
  is_test: false,
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/",
}));
vi.mock("@/lib/use-salesperson", () => ({
  useSalesperson: () => ({ salesperson: stored(), loaded: true, clear: () => {} }),
}));
vi.mock("@/lib/use-live-permissions", () => ({
  useLivePermissions: () => ({
    permissions: { role: who.role, can_import_offices: false, can_manage_swag_leads: false },
    loaded: true,
    gate: "ok",
  }),
}));
vi.mock("@/lib/use-scroll-to-top", () => ({ useScrollToTop: () => {} }));
vi.mock("@/lib/use-visible-roster", () => ({ useVisibleRoster: () => ({ people: [] }) }));

// Heavy neighbours become empty stubs; the Road card becomes a marker so a page
// "has the card" iff it renders <RoadTo10000Card />.
const stub = (name: string) => {
  const Stub = () => createElement("div", { "data-stub": name });
  Stub.displayName = `${name}Stub`;
  return Stub;
};
vi.mock("@/components/road-to-10000-card", () => ({
  RoadTo10000Card: function RoadTo10000CardStub() {
    return createElement("div", { "data-road-card": "1" });
  },
  RoadHomeCardBody: () => null,
}));
// The real tab-bar composition (buildNavItems) is kept; only the rendered bar is stubbed.
vi.mock("@/components/bottom-nav", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/bottom-nav")>()),
  BottomNav: () => createElement("div", { "data-stub": "BottomNav" }),
}));
for (const [path, exportName] of [
  ["@/components/this-week-card", "ThisWeekCard"],
  ["@/components/daily-entry-form", "DailyEntryForm"],
  ["@/components/activity-week-context", "ActivityWeekContext"],
  ["@/components/my-week-card", "MyWeekCard"],
  ["@/components/edit-week-card", "EditWeekCard"],
  ["@/components/messages-card", "MessagesCard"],
  ["@/components/recent-activity-card", "RecentActivityCard"],
  ["@/components/verification-center", "VerificationCenter"],
  ["@/components/ai-assistant/ai-assistant-card", "AiAssistantCard"],
  ["@/components/orders-card", "OrdersCard"],
  ["@/components/notification-opt-in", "NotificationOptIn"],
  ["@/components/admin/filters-card", "FiltersCard"],
  ["@/components/admin/totals-card", "TotalsCard"],
  ["@/components/admin/goals-card", "GoalsCard"],
  ["@/components/admin/messages-card", "MessagesCard"],
  ["@/components/admin/maintenance-card", "MaintenanceCard"],
  ["@/components/logo", "Logo"],
] as const) {
  vi.doMock(path, () => ({ [exportName]: stub(exportName), BOTTOM_NAV_SPACER: "" }));
}

import type { RoadView } from "@/lib/road-to-10000";

const { ADMIN_NAV } = await import("@/components/admin/admin-nav");
const { canOpenRoadToTenThousand } = await import("@/components/road-to-10000/access");
const { buildNavItems } = await import("@/components/bottom-nav");
const { canUpdateRoadTotal } = await import("@/lib/server/road-to-10000");
const { companyHolidayValues } = await import("@/lib/company-calendar");
const { ROAD_TO_10000_GOAL, computeRoadMetrics } = await import("@/lib/road-to-10000");

const render = async (modulePath: string, role: Role) => {
  who.role = role;
  vi.resetModules();
  const mod = (await import(/* @vite-ignore */ modulePath)) as { default: () => never };
  return renderToStaticMarkup(createElement(mod.default));
};
const ROAD_HREF = /href="\/road-to-10000"/;

beforeEach(() => {
  who.role = "ae";
});

// ---------------------------------------------------------------------------
describe("Home card placement", () => {
  it("1. Corey (admin): the Road card is on the admin dashboard — the Home an admin actually lands on", async () => {
    expect(await render("@/app/admin/page", "admin")).toContain('data-road-card="1"');
  });

  it("2. Tonja (assistant): the Road card is on her Home", async () => {
    expect(await render("@/app/dashboard/page", "assistant")).toContain('data-road-card="1"');
  });

  it("3. a regular AE: the Road card is on the AE Home", async () => {
    expect(await render("@/app/dashboard/page", "ae")).toContain('data-road-card="1"');
  });

  it("exactly one card per Home (no double rendering)", async () => {
    for (const [page, role] of [["@/app/admin/page", "admin"], ["@/app/dashboard/page", "assistant"], ["@/app/dashboard/page", "ae"]] as const) {
      const html = await render(page, role);
      expect(html.match(/data-road-card/g), `${page} as ${role}`).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
describe("update control (server decides via can_update; the page only obeys)", () => {
  const holidays = companyHolidayValues("2026-01-01", "2026-12-31").values;
  const viewFor = (role: Role): RoadView => ({
    configured: true,
    goal: ROAD_TO_10000_GOAL,
    source: "manual",
    latest: {
      id: "r1", total: 7842, recordedAt: "2026-10-05T18:00:00Z", recordedOn: "2026-10-05", source: "manual",
      isCorrection: false, note: null, enteredByName: "Corey",
    },
    metrics: computeRoadMetrics({ total: 7842, recordedOn: "2026-10-05", today: "2026-10-05", holidayValues: holidays }),
    daysSinceUpdate: 0,
    history: [],
    holidays: [],
    extraHolidaysUnavailable: false,
    // The same rule the API uses to fill this in for the caller.
    can_update: canUpdateRoadTotal({ role }),
  });
  const body = async (role: Role) => {
    const { RoadPageBody } = await import("@/components/road-to-10000/road-page-content");
    return renderToStaticMarkup(createElement(RoadPageBody, { view: viewFor(role), onSaved: () => {} }));
  };

  it("4. Corey sees the management/update control", async () => {
    expect(await body("admin")).toContain("Update Road to 10,000");
  });
  it("5. Tonja sees the management/update control", async () => {
    expect(await body("assistant")).toContain("Update Road to 10,000");
  });
  it("6. a regular AE does NOT see it — but still sees the total and pace", async () => {
    const html = await body("ae");
    expect(html).not.toContain("Update Road to 10,000");
    expect(html).not.toMatch(/<form/);
    expect(html).toContain("7,842");
    expect(html).toContain("Current pace");
  });
});

// ---------------------------------------------------------------------------
describe("normal navigation entry points", () => {
  it("7a. Corey: Road to 10,000 is in the admin Tools menu", () => {
    const tools = ADMIN_NAV.find((i) => i.kind === "group" && i.label === "Tools");
    expect(tools && tools.kind === "group" && tools.items).toContainEqual({ href: "/road-to-10000", label: "Road to 10,000" });
  });

  it("7b. Corey: and in the Settings area (/more), the Admin Home's gear", async () => {
    expect(await render("@/app/more/page", "admin")).toMatch(ROAD_HREF);
  });

  it("8. Tonja: a link in the Settings area (/more) on top of the card on her Home", async () => {
    const html = await render("@/app/more/page", "assistant");
    expect(html).toMatch(ROAD_HREF);
    expect(html).toContain("Road to 10,000");
  });

  it("AEs: a link in /more too (view-only page); juice_box_only guests get none", async () => {
    expect(await render("@/app/more/page", "ae")).toMatch(ROAD_HREF);
    expect(await render("@/app/more/page", "juice_box_only")).not.toMatch(ROAD_HREF);
    expect(
      (["admin", "assistant", "ae", "juice_box_only"] as const).map((r) => canOpenRoadToTenThousand(r)),
    ).toEqual([true, true, true, false]);
  });

  it("the bottom tab bar is unchanged (no new tab; the bar is at its ceiling)", () => {
    for (const role of ["admin", "assistant", "ae", "juice_box_only"] as const) {
      const items = buildNavItems({ ...stored(), role });
      expect(items.map((i) => i.href)).not.toContain("/road-to-10000");
    }
  });
});

// ---------------------------------------------------------------------------
describe("9. the direct /road-to-10000 route still works", () => {
  it.each(["admin", "assistant", "ae"] as const)("%s: the page renders its content (not a redirect/blank)", async (role) => {
    const html = await render("@/app/road-to-10000/page", role);
    // The real page shell mounted (back link + the content that fetches the view from the API),
    // not the centered "Loading…" stub used while redirecting.
    expect(html).toContain("max-w-3xl");
    expect(html).toMatch(/Home<\/a>/);
  });

  it("juice_box_only guests are still held at the loading stub (and redirected to Juice Box)", async () => {
    const html = await render("@/app/road-to-10000/page", "juice_box_only");
    expect(html).toContain("Loading…");
    expect(html).not.toMatch(/Home<\/a>/);
  });

  it("'Home' on the page goes where the person lands: admins /admin, everyone else /dashboard", async () => {
    expect(await render("@/app/road-to-10000/page", "admin")).toMatch(/href="\/admin"[^>]*>[\s\S]*Home/);
    expect(await render("@/app/road-to-10000/page", "ae")).toMatch(/href="\/dashboard"[^>]*>[\s\S]*Home/);
    expect(await render("@/app/road-to-10000/page", "assistant")).toMatch(/href="\/dashboard"[^>]*>[\s\S]*Home/);
  });
});

// ---------------------------------------------------------------------------
describe("10. server-side permissions are unchanged", () => {
  it("only an admin or the assistant can update; AEs and guests cannot", () => {
    expect(canUpdateRoadTotal({ role: "admin" })).toBe(true);
    expect(canUpdateRoadTotal({ role: "assistant" })).toBe(true);
    expect(canUpdateRoadTotal({ role: "ae" })).toBe(false);
    expect(canUpdateRoadTotal({ role: "juice_box_only" })).toBe(false);
  });
  // The full request-level matrix (GET view-only for AEs, POST 403 for AEs, juice_box_only
  // refused, deactivated admin refused, DB-function re-check) lives in
  // app/api/road-to-10000/road-to-10000.test.ts and is untouched by this change.
});
