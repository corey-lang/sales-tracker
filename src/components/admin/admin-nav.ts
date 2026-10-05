// The admin section navigation (top bar + "Reports" / "Tools" dropdowns). Pure
// data, kept out of admin/layout.tsx because a Next.js layout file may only
// export the framework's own names — and so tests can assert what the menu holds.

/** Top-level admin sections. Some are direct links; "Reports" and "Tools"
 *  are dropdown groups so the row stays scannable without cutting any
 *  destinations.
 *
 *  /office-imports and /gold-list live outside /admin so non-admin users
 *  (assistants via /more; every AE via the bottom nav) can still reach them
 *  without passing this layout's role==='admin' gate.
 *  They still nest cleanly under the admin "Tools" group here because the
 *  active-state matcher keys off pathname, not URL ancestry. */
export type NavLeaf = { href: string; label: string };
export type NavItem =
  | { kind: "link"; href: string; label: string }
  | { kind: "group"; label: string; items: NavLeaf[] };

export const ADMIN_NAV: NavItem[] = [
  { kind: "link", href: "/admin", label: "Dashboard" },
  { kind: "link", href: "/admin/coaching", label: "Weekly Focus" },
  { kind: "link", href: "/admin/scorecard", label: "Scorecard" },
  {
    kind: "group",
    label: "Reports",
    items: [
      // The leaderboard is the meeting/team view — percentage-only by
      // product rule, no raw KPI counts. Labeled here as "Meeting View"
      // so its purpose is obvious from the menu without renaming the
      // page or its /admin/leaderboard URL.
      { href: "/admin/leaderboard", label: "Leaderboard / Meeting View" },
      { href: "/admin/reports/activity", label: "Activity Reports" },
    ],
  },
  {
    kind: "group",
    label: "Tools",
    items: [
      { href: "/admin/business-cards", label: "Business Cards" },
      // Lives outside /admin (it's an AE surface that admins can read in
      // full via its AE filter), same arrangement as Office Imports below.
      { href: "/gold-list", label: "Gold List" },
      // Also outside /admin so the leads team (Tonja, Faith) can open it.
      { href: "/swag-leads", label: "Swag Leads" },
      // The company goal (10,000 Homescriptions in 2026) — outside /admin so
      // everyone can open it; admins update the total from there.
      { href: "/road-to-10000", label: "Road to 10,000" },
      { href: "/office-imports", label: "Office Imports" },
      { href: "/admin/cogent", label: "Cogent Orders" },
      { href: "/admin/working-days", label: "Working Day Adjustments" },
      { href: "/admin/coverage", label: "Coverage Intelligence" },
    ],
  },
];
