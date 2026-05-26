-- ===========================================================================
-- Seed Faith as a juice_box_only user.
-- ===========================================================================
-- WHAT THIS IS
--   A single-row seed migration that adds Faith to `salespeople` with
--   role='juice_box_only', mirroring how Travis and Rizz were added in
--   `add_juice_box_only_role.sql` (migration #18). The juice_box_only role
--   itself is already on the role CHECK constraint by that earlier migration;
--   this file only inserts the new row.
--
-- WHY A SEPARATE FILE
--   `add_juice_box_only_role.sql` is the historical record of when the role
--   was introduced. New juice_box_only seats are layered on top as their own
--   tiny migration so the history of who-was-added-when stays legible.
--
-- ACCESS POSTURE (inherited from the role)
--   * Excluded from leaderboards — `src/lib/server/leaderboard-standings.ts`
--     filters salespeople by `role = 'ae'` (positive allow-list).
--   * Excluded from AE tracker / To-Do / business-card surfaces — every AE
--     route uses `requireAeToolAccess`, which rejects juice_box_only callers
--     with 403 before any DB read.
--   * Excluded from the coaching list — `src/lib/server/coaching.ts` also
--     uses the `role = 'ae'` positive allow-list.
--   * Redirected from /dashboard, /todos, /leaderboard, etc. to /juice-box
--     by the role-routing logic in `src/lib/role-routing.ts` and per-page
--     guards (e.g. `src/app/dashboard/page.tsx`).
--   * Sign-in: name-only (no PIN). first_name is CITEXT, so 'Faith' /
--     'faith' / 'FAITH' all resolve to the same row.
--
--   * Excluded from admin production / activity views — `src/app/admin/page.tsx`
--     and `src/app/admin/reports/activity/page.tsx` were flipped to a positive
--     `role = 'ae'` allow-list alongside this seed, so juice_box_only rows
--     (Travis, Rizz, Faith, …) no longer appear in the salesperson selector,
--     totals, goal scope, or activity report.
--
-- Idempotent: ON CONFLICT DO UPDATE re-asserts the role for an existing row,
-- so re-runs (or applying this on top of a hand-inserted row) are safe.
-- ===========================================================================

INSERT INTO salespeople (first_name, role)
VALUES ('Faith', 'juice_box_only')
ON CONFLICT (first_name) DO UPDATE
  SET role = EXCLUDED.role;

-- ===========================================================================
-- VERIFICATION (run after the migration)
-- ===========================================================================
-- SELECT first_name, role FROM salespeople
-- WHERE first_name = 'Faith';
--   -- expect one row, role='juice_box_only'
