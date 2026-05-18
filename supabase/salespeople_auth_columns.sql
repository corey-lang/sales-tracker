-- ===========================================================================
-- Schema reconciliation: salespeople auth / identity columns.
-- ===========================================================================
-- WHY THIS FILE EXISTS
--   The app reads three `salespeople` columns that NO migration file ever
--   created — is_admin, is_test, admin_pin. They were added directly in the
--   Supabase dashboard, so a database rebuilt purely from supabase/*.sql would
--   be missing them and the app (login, admin page, leaderboard) would break.
--
--   This migration records those columns so the file set is self-consistent.
--   It is ADDITIVE and IDEMPOTENT — running it against the live database,
--   where the columns already exist, is a harmless no-op.
--
--   See supabase/README.md for the authoritative migration order.
-- ---------------------------------------------------------------------------

-- 1. The drifted columns.
--    role (added by add_role.sql) is the source of truth for permission
--    checks; is_admin is the legacy boolean still used by some queries.
ALTER TABLE salespeople
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS admin_pin TEXT;

-- 2. Keep the legacy is_admin boolean consistent with role for any row that
--    predates is_admin. role remains authoritative.
UPDATE salespeople
  SET is_admin = TRUE
  WHERE role = 'admin' AND is_admin IS DISTINCT FROM TRUE;
UPDATE salespeople
  SET is_admin = FALSE
  WHERE role <> 'admin' AND is_admin IS DISTINCT FROM FALSE;

-- ---------------------------------------------------------------------------
-- 3. Hardening: keep admin_pin out of the browser anon key's reach.
-- ---------------------------------------------------------------------------
-- The salespeople table has no RLS, so the anon key can SELECT every column.
-- admin_pin is a plaintext login secret. Column-level privileges remove it
-- from the anon (and authenticated) grant WITHOUT needing full RLS.
--
-- This is safe: as of Phase 0 the app never reads admin_pin from the browser
-- — the PIN check runs server-side in /api/auth/login using the service-role
-- key, which bypasses these grants. The anon key keeps SELECT on every other
-- column (the login screen + admin page still read id / first_name / role /
-- is_admin / is_test directly).
REVOKE SELECT (admin_pin) ON salespeople FROM anon;
REVOKE SELECT (admin_pin) ON salespeople FROM authenticated;

-- VERIFICATION (run after; service role bypasses these grants):
--   SELECT column_name, privilege_type
--   FROM information_schema.column_privileges
--   WHERE table_name = 'salespeople' AND grantee = 'anon'
--   ORDER BY column_name;
--   -- expect NO row for admin_pin
