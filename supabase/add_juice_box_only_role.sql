-- ===========================================================================
-- Add the `juice_box_only` role + seed Travis and Rizz.
-- ===========================================================================
-- WHAT THIS IS
--   `juice_box_only` is a fourth role that gates a salesperson down to the
--   Juice Box feed only — no Home / Leaderboard / To-Dos / Scan / Admin /
--   verification queue, no PIN. These accounts exist so guests can join the
--   team chat without being onboarded into the rest of the AE app.
--
-- WHAT CHANGES
--   * Widens the salespeople.role CHECK constraint to permit 'juice_box_only'
--     alongside the existing 'admin' / 'assistant' / 'ae' values.
--   * Inserts Travis and Rizz at role='juice_box_only'. Names are stored as
--     'Travis' / 'Rizz'; CITEXT means login lookups match regardless of case
--     (Travis / travis / TRAVIS, Rizz / rizz / RIZZ).
--   * No PIN — only admins are PIN-gated. juice_box_only users sign in with
--     just their first_name.
--
-- WHAT DOESN'T CHANGE
--   * Existing rows keep their roles.
--   * RLS policies, indexes, the realtime publication, push subscriptions,
--     team_messages, etc. are untouched. The new role flows through the same
--     session/auth pipeline as every other role.
--
-- Idempotent: re-runnable. DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT, and
-- INSERT ON CONFLICT DO UPDATE for the two seeded rows.
-- ===========================================================================

-- 1) Widen the role whitelist. DROP-then-ADD is the idempotent pattern for
--    CHECK constraints in Postgres (there's no IF NOT EXISTS form for them).
ALTER TABLE salespeople
  DROP CONSTRAINT IF EXISTS salespeople_role_check;

-- Postgres auto-names the unnamed constraint `salespeople_role_check` when
-- the original `add_role.sql` inlined the CHECK on ADD COLUMN. If the local
-- name was different on some envs, the DROP above is a no-op there and the
-- new ADD will succeed since no constraint by THIS name exists.
ALTER TABLE salespeople
  ADD CONSTRAINT salespeople_role_check
  CHECK (role IN ('admin', 'assistant', 'ae', 'juice_box_only'));

-- 2) Seed Travis and Rizz. first_name is CITEXT (case-insensitive unique),
--    so re-running this is safe — the ON CONFLICT branch just re-asserts
--    the role for the existing row. No PIN is set; juice_box_only sign-in
--    is name-only.
INSERT INTO salespeople (first_name, role)
VALUES
  ('Travis', 'juice_box_only'),
  ('Rizz',   'juice_box_only')
ON CONFLICT (first_name) DO UPDATE
  SET role = EXCLUDED.role;

-- ===========================================================================
-- VERIFICATION (run after the migration)
-- ===========================================================================
-- SELECT first_name, role FROM salespeople
-- WHERE first_name IN ('Travis', 'Rizz')
-- ORDER BY first_name;
--   -- expect two rows, both role='juice_box_only'
--
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
-- WHERE conrelid = 'salespeople'::regclass AND conname = 'salespeople_role_check';
--   -- expect: CHECK (role IN ('admin', 'assistant', 'ae', 'juice_box_only'))
