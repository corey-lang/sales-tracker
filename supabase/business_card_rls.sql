-- ===========================================================================
-- Business card scanner — Row Level Security lockdown.
-- ===========================================================================
-- WHY THIS EXISTS
--   Production AEs hit, after uploading a card:
--     "new row violates row-level security policy for table
--      business_card_scans"
--   ...because RLS is ENABLED on business_card_scans in production, but the
--   table has no policy that lets the browser's anon key INSERT. The original
--   Phase 3 migration assumed RLS would stay OFF (see the header of
--   business_card_scans.sql); production has it ON, so every anon insert is
--   denied.
--
-- AUTH MODEL — READ THIS BEFORE CHANGING ANYTHING
--   The Sales Tracker has NO Supabase Auth. Reps "log in" by picking their
--   name from a dropdown; the choice is cached in localStorage. Every request
--   from the browser therefore uses the shared `anon` key, and auth.uid() is
--   always NULL. RLS literally cannot tell which AE (Carli, Tonja, ...) is
--   acting — the app UI knows, the database does not. An "AEs may only insert
--   their own rows" policy is therefore impossible to express in SQL today.
--   Identity is instead validated SERVER-SIDE (see DESIGN below).
--
-- DESIGN
--   * RLS stays ENABLED on the business card tables.
--   * The browser anon key gets SELECT only — the Verification Center reads
--     scans + contacts directly from the browser. This matches the rest of
--     the app, where the anon key already has full read access for the closed
--     11-person team (see CLAUDE.md "Open questions / RLS policies").
--   * The anon key gets NO insert/update/delete policy — it is fully locked
--     out of WRITING these tables.
--   * ALL writes go through Next.js route handlers that use the Supabase
--     SERVICE-ROLE key, which BYPASSES RLS. Those routes validate the
--     salesperson against the `salespeople` table before inserting, so the
--     stored salesperson_id / salesperson_name / is_test_data are
--     server-trusted and cannot be spoofed past what the server accepts.
--
--   Tradeoff that is being made explicit: with no auth system, "an AE may
--   only insert scans for their own identity" cannot be enforced by RLS. It
--   is enforced by the server route, which (a) refuses any salespersonId that
--   is not a real salespeople row and (b) ignores the client-supplied name,
--   re-reading it from the DB. This is strictly tighter than the previous
--   state (no RLS / wide-open anon writes) and avoids a wide-open public
--   INSERT policy.
--
-- PREREQUISITE — DO THIS FIRST
--   SUPABASE_SERVICE_ROLE_KEY must be set in the deployment environment
--   (Vercel) and in local .env.local BEFORE running this migration. Without
--   it the server routes can no longer fall back to the anon key, and — with
--   RLS now enforced — every server-side write would fail. getServerSupabase()
--   now throws a clear error if the key is missing.
--
-- Idempotent: re-runnable. ENABLE ROW LEVEL SECURITY is harmless to repeat;
-- each policy is dropped-if-exists then recreated.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. business_card_scans
-- ---------------------------------------------------------------------------
ALTER TABLE business_card_scans ENABLE ROW LEVEL SECURITY;

-- Browser (anon) may READ scans — the Verification Center renders them.
DROP POLICY IF EXISTS "business_card_scans anon select" ON business_card_scans;
CREATE POLICY "business_card_scans anon select"
  ON business_card_scans FOR SELECT TO anon
  USING (true);

-- Intentionally NO anon INSERT/UPDATE/DELETE policy. Scan rows are written
-- only by server routes using the service-role key (POST /api/business-card/
-- scan for intake; the process/approve/reject/mark-duplicate routes for the
-- verification workflow).

-- ---------------------------------------------------------------------------
-- 2. business_card_contacts
-- ---------------------------------------------------------------------------
ALTER TABLE business_card_contacts ENABLE ROW LEVEL SECURITY;

-- Browser (anon) may READ contacts — the Verification Center's export summary
-- and contact list query this table directly.
DROP POLICY IF EXISTS "business_card_contacts anon select"
  ON business_card_contacts;
CREATE POLICY "business_card_contacts anon select"
  ON business_card_contacts FOR SELECT TO anon
  USING (true);

-- Intentionally NO anon write policy. Contact rows are created/updated only by
-- the server-side extraction (process) and verification (approve/reject/
-- mark-duplicate/export) routes, all using the service-role key.

-- ---------------------------------------------------------------------------
-- 3. business_card_export_batches
-- ---------------------------------------------------------------------------
-- Nothing in the browser reads or writes this table — the CSV export route is
-- entirely server-side. Enable RLS with NO policy at all: the anon key is
-- fully locked out, and the service role still bypasses RLS for the export
-- route.
ALTER TABLE business_card_export_batches ENABLE ROW LEVEL SECURITY;

-- ===========================================================================
-- VERIFICATION (run after the migration; service role / SQL editor bypasses
-- RLS, so use these to confirm policy shape rather than to test access)
-- ===========================================================================
-- SELECT tablename, rowsecurity
-- FROM pg_tables
-- WHERE tablename IN ('business_card_scans', 'business_card_contacts',
--                     'business_card_export_batches');
--   -- expect rowsecurity = true for all three
--
-- SELECT tablename, policyname, cmd, roles
-- FROM pg_policies
-- WHERE tablename IN ('business_card_scans', 'business_card_contacts',
--                     'business_card_export_batches')
-- ORDER BY tablename, policyname;
--   -- expect exactly two policies, both SELECT / {anon}; zero write policies
