// Who is visible where — the two roster rules, stated ONCE.
//
// 1) REPORTING rule (every viewer, owners included)
//      A salesperson counts toward company/team numbers only if
//      `is_test = false`. Leaderboards, scorecard, activity report, team
//      totals, coaching ranks, Cogent attribution, business-card counts…
//      all filter on it (`.eq("is_test", false)`). Test data never enters an
//      aggregate, even when the test account's owner is looking.
//
// 2) WORKFLOW VISIBILITY rule (selectors, per-AE pages, per-AE data)
//      A salesperson is visible to `viewer` if they are not a test account,
//      or they are a test account OWNED by `viewer`
//      (`test_owner_id = viewer.id`, the session's salespeople.id). A test
//      account with no owner is visible to no one — fail private. Nothing
//      here looks at names or emails.
//
// Safe to import from client components (no server-only imports). The
// server-side enforcement helpers live in lib/server/roster.ts.

export type RosterVisibilityRow = {
  is_test?: boolean | null;
  test_owner_id?: string | null;
};

/** Workflow visibility (rule 2). */
export function canSeeSalesperson(
  viewer: { id: string },
  row: RosterVisibilityRow,
): boolean {
  if (row.is_test !== true) return true;
  return row.test_owner_id != null && row.test_owner_id === viewer.id;
}

/**
 * PostgREST `or()` expression for rule 2 — for roster queries:
 *   `.or(visibleRosterOr(viewer.id))`
 * `viewerId` is a UUID from the verified session, never user input.
 */
export function visibleRosterOr(viewerId: string): string {
  return `is_test.eq.false,test_owner_id.eq.${viewerId}`;
}
