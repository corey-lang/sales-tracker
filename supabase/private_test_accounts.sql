BEGIN;

-- ===========================================================================
-- Private test accounts — an owned production sandbox (e.g. "Test AE").
-- ===========================================================================
-- WHAT THIS IS
--   `salespeople.is_test` already means "a test account": it is excluded
--   from every company/team aggregate (leaderboards, scorecard, activity
--   report, team totals, coaching ranks, Cogent attribution, business-card
--   counts…), its offices live in the "test" environment, and its scans are
--   `is_test_data`. That reporting rule is UNCHANGED here and applies to
--   every viewer, including the account's owner.
--
--   This migration adds OWNERSHIP so a test account can be private to one
--   admin in normal workflows (Weekly Focus, 1:1s, goals, Gold List,
--   selectors):
--
--     salespeople.test_owner_id  — the salespeople.id of the admin who owns
--                                  this test account. NULL for every real
--                                  person (enforced), and a test account
--                                  with no owner is visible to NO ONE
--                                  (fail private).
--
--   The app's workflow-visibility rule (src/lib/roster.ts):
--     visible  ⇔  NOT is_test  OR  test_owner_id = <the signed-in user's id>
--   The owner is identified by the session's salespeople.id — never by name
--   or email.
--
-- ALSO: business-card contacts keep their test identity
--   `business_card_contacts` had no test marker, so a contact approved from a
--   test scan (or created for a test account) could land in real CSV
--   exports and duplicate checks. `is_test_data` is added, stamped on every
--   insert by a trigger from the source scan / owning salesperson, and
--   backfilled once for existing rows.
--
-- Additive, idempotent, non-destructive: ADD COLUMN IF NOT EXISTS, guarded
-- constraint, CREATE OR REPLACE + DROP TRIGGER IF EXISTS, and a backfill
-- that only flips rows that genuinely came from test data. No real row's
-- data changes. Safe to re-run. Depends on salespeople_auth_columns.sql
-- (#4, is_test), business_card_contacts.sql (#7). Independent of the 1:1
-- migrations.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 0) Legacy "Test" row: report only, never reclassify
-- ---------------------------------------------------------------------------
-- Older seed runs could leave "Test" as a NORMAL salesperson. This migration
-- deliberately does NOT flag it (no immutable marker separates it from a real
-- person). If that ambiguous state is present it is reported below; convert
-- the row deliberately with supabase/provision_test_ae.template.sql. A
-- database that already has a test account is unaffected.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM salespeople WHERE is_test)
     AND EXISTS (SELECT 1 FROM salespeople WHERE first_name = 'Test' AND is_test = FALSE) THEN
    RAISE NOTICE 'AMBIGUOUS LEGACY STATE: an unflagged salesperson named "Test" exists and no test account does. It was NOT reclassified (it may be a real person). If it is the old seed row, convert it deliberately with supabase/provision_test_ae.template.sql (v_convert_legacy_row).';
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 1) Test-account ownership
-- ---------------------------------------------------------------------------

ALTER TABLE salespeople
  ADD COLUMN IF NOT EXISTS test_owner_id UUID
  REFERENCES salespeople(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'salespeople_test_owner_requires_test'
  ) THEN
    ALTER TABLE salespeople
      ADD CONSTRAINT salespeople_test_owner_requires_test
      CHECK (test_owner_id IS NULL OR is_test);
  END IF;
END$$;

-- Owner lookups ("my test accounts") and the visibility predicate.
CREATE INDEX IF NOT EXISTS idx_salespeople_test_owner
  ON salespeople(test_owner_id)
  WHERE test_owner_id IS NOT NULL;


-- ---------------------------------------------------------------------------
-- 2) business_card_contacts.is_test_data
-- ---------------------------------------------------------------------------

ALTER TABLE business_card_contacts
  ADD COLUMN IF NOT EXISTS is_test_data BOOLEAN NOT NULL DEFAULT FALSE;

-- One-time backfill: only contacts that came from a test scan or belong to a
-- test account. Re-running finds nothing new to flip.
UPDATE business_card_contacts c
   SET is_test_data = TRUE
 WHERE c.is_test_data = FALSE
   AND (
     EXISTS (SELECT 1 FROM business_card_scans s
              WHERE s.id = c.scan_id AND s.is_test_data = TRUE)
     OR EXISTS (SELECT 1 FROM salespeople p
                 WHERE p.id = c.salesperson_id AND p.is_test = TRUE)
   );

-- Every insert path (verification approve, AE "add to phone contacts", …)
-- inherits the test marker without app code having to remember it. A caller
-- can set it TRUE explicitly; it can never be forced FALSE for test data.
CREATE OR REPLACE FUNCTION stamp_business_card_contact_test_data()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.is_test_data := COALESCE(NEW.is_test_data, FALSE)
    OR EXISTS (SELECT 1 FROM business_card_scans s
                WHERE s.id = NEW.scan_id AND s.is_test_data = TRUE)
    OR EXISTS (SELECT 1 FROM salespeople p
                WHERE p.id = NEW.salesperson_id AND p.is_test = TRUE);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_business_card_contact_test_data ON business_card_contacts;
CREATE TRIGGER trg_stamp_business_card_contact_test_data
  BEFORE INSERT ON business_card_contacts
  FOR EACH ROW EXECUTE FUNCTION stamp_business_card_contact_test_data();

CREATE INDEX IF NOT EXISTS idx_bcc_real_export
  ON business_card_contacts(verification_status)
  WHERE is_test_data = FALSE;


-- ---------------------------------------------------------------------------
-- 3) Direct-API (anon / PostgREST) hardening
-- ---------------------------------------------------------------------------
-- The browser's anon key can call PostgREST directly, so "private" cannot
-- rest on app code alone. What is closed here (all targeted; no auth or RLS
-- rewrite, and every real row keeps exactly the access it has today):
--
--   a) salespeople: anon could read admin_pin (only column-revoked, which is
--      void while a table-level grant exists), would be able to read
--      test_owner_id, and could UPDATE/INSERT/DELETE any row (e.g. re-point
--      test_owner_id or flip is_test). Table privileges are now rebuilt:
--      read-only, every column EXCEPT admin_pin and test_owner_id.
--      ACCEPTED LIMITATION: the test salesperson's row (id, first_name,
--      is_test…) stays discoverable — that is all a client can learn.
--   b) Row-level RESTRICTIVE policies hide Test-AE-owned rows from
--      anon/authenticated on every anon-readable table that carries
--      per-person data: activity_entries, weekly_goals, business_card_scans,
--      business_card_contacts, gold_list_targets, gold_list_touches_log,
--      messages, team_messages, team_message_reactions. A RESTRICTIVE policy
--      is ANDed with the permissive ones, so real rows are untouched.
--      service_role bypasses RLS — the server routes (which enforce owner
--      checks themselves) are the ONLY way to reach a test account's data.
--   c) replace_activity_week is SECURITY INVOKER but was executable by anon;
--      the app only calls it from a server route (service role). EXECUTE is
--      revoked from anon/authenticated.
--
-- Tables that already have RLS enabled WITHOUT any anon policy stay fully
-- closed to anon (ae_tasks, offices, office_visits, gold_list_agents /
-- activities, one_on_one*, coaching_*, working_day_adjustments — the last
-- via an explicit REVOKE ALL).

-- Helpers. SECURITY DEFINER + fixed search_path so policies don't depend on
-- the caller's column privileges (anon cannot read test_owner_id).
CREATE OR REPLACE FUNCTION public.is_test_salesperson(p_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT s.is_test FROM public.salespeople s WHERE s.id = p_id), FALSE);
$$;

-- For the tables that key people by TEXT (team_messages & co.).
CREATE OR REPLACE FUNCTION public.is_test_salesperson_text(p_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT s.is_test FROM public.salespeople s WHERE s.id::text = p_id), FALSE);
$$;

CREATE OR REPLACE FUNCTION public.is_test_gold_list_target(p_target UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT s.is_test
       FROM public.gold_list_targets t
       JOIN public.salespeople s ON s.id = t.salesperson_id
      WHERE t.id = p_target), FALSE);
$$;

REVOKE ALL ON FUNCTION public.is_test_salesperson(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_test_salesperson_text(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_test_gold_list_target(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_test_salesperson(UUID)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_test_salesperson_text(TEXT)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_test_gold_list_target(UUID)
  TO anon, authenticated, service_role;

-- (a) salespeople privileges: read-only, minus admin_pin and test_owner_id.
-- Column list is derived from the live table so drifted columns keep working;
-- columns added LATER stay closed to anon until granted on purpose.
REVOKE ALL ON salespeople FROM anon, authenticated;
DO $$
DECLARE
  cols TEXT;
BEGIN
  SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position)
    INTO cols
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'salespeople'
     AND column_name NOT IN ('admin_pin', 'test_owner_id');
  EXECUTE format('GRANT SELECT (%s) ON salespeople TO anon, authenticated', cols);
END$$;

-- (b) row-level policies. Each block: ensure RLS, keep today's access for
-- real rows with an explicit permissive policy where none existed, then AND
-- a restrictive "no test data" policy on top.

-- activity_entries: had NO RLS (anon full access). Keep that for real rows.
ALTER TABLE activity_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "activity_entries legacy anon access" ON activity_entries;
CREATE POLICY "activity_entries legacy anon access"
  ON activity_entries FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "activity_entries hide test data" ON activity_entries;
CREATE POLICY "activity_entries hide test data"
  ON activity_entries AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (NOT public.is_test_salesperson(salesperson_id))
  WITH CHECK (NOT public.is_test_salesperson(salesperson_id));

-- weekly_goals: anon SELECT only (weekly_goals_lockdown.sql). NULL = global.
DROP POLICY IF EXISTS "weekly_goals hide test data" ON weekly_goals;
CREATE POLICY "weekly_goals hide test data"
  ON weekly_goals AS RESTRICTIVE FOR SELECT TO anon, authenticated
  USING (salesperson_id IS NULL OR NOT public.is_test_salesperson(salesperson_id));

-- business cards: anon SELECT policies exist (business_card_rls.sql).
DROP POLICY IF EXISTS "business_card_scans hide test data" ON business_card_scans;
CREATE POLICY "business_card_scans hide test data"
  ON business_card_scans AS RESTRICTIVE FOR SELECT TO anon, authenticated
  USING (NOT is_test_data);
DROP POLICY IF EXISTS "business_card_contacts hide test data" ON business_card_contacts;
CREATE POLICY "business_card_contacts hide test data"
  ON business_card_contacts AS RESTRICTIVE FOR SELECT TO anon, authenticated
  USING (NOT is_test_data);

-- Gold List (schema.sql tables): had NO RLS.
ALTER TABLE gold_list_targets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "gold_list_targets legacy anon access" ON gold_list_targets;
CREATE POLICY "gold_list_targets legacy anon access"
  ON gold_list_targets FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "gold_list_targets hide test data" ON gold_list_targets;
CREATE POLICY "gold_list_targets hide test data"
  ON gold_list_targets AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (NOT public.is_test_salesperson(salesperson_id))
  WITH CHECK (NOT public.is_test_salesperson(salesperson_id));

ALTER TABLE gold_list_touches_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "gold_list_touches_log legacy anon access" ON gold_list_touches_log;
CREATE POLICY "gold_list_touches_log legacy anon access"
  ON gold_list_touches_log FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "gold_list_touches_log hide test data" ON gold_list_touches_log;
CREATE POLICY "gold_list_touches_log hide test data"
  ON gold_list_touches_log AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (NOT public.is_test_gold_list_target(target_id))
  WITH CHECK (NOT public.is_test_gold_list_target(target_id));

-- Tables created outside the migration files (dashboard `messages`) or by
-- later Juice Box migrations: only touched if they exist, so this file stays
-- safe on any database.
DO $$
BEGIN
  IF to_regclass('public.messages') IS NOT NULL THEN
    -- Dashboard "message to an AE" rows (NULL salesperson_id = everyone). The
    -- admin card reads/writes them with the anon key today; keep that for
    -- real people and hide/refuse rows addressed to a test account.
    EXECUTE 'ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS "messages legacy anon access" ON public.messages';
    EXECUTE 'CREATE POLICY "messages legacy anon access" ON public.messages
             FOR ALL TO anon, authenticated USING (true) WITH CHECK (true)';
    EXECUTE 'DROP POLICY IF EXISTS "messages hide test data" ON public.messages';
    EXECUTE 'CREATE POLICY "messages hide test data" ON public.messages
             AS RESTRICTIVE FOR ALL TO anon, authenticated
             USING (salesperson_id IS NULL
                    OR NOT public.is_test_salesperson_text(salesperson_id::text))
             WITH CHECK (salesperson_id IS NULL
                    OR NOT public.is_test_salesperson_text(salesperson_id::text))';
  END IF;

  IF to_regclass('public.team_messages') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "team_messages hide test data" ON public.team_messages';
    EXECUTE 'CREATE POLICY "team_messages hide test data" ON public.team_messages
             AS RESTRICTIVE FOR SELECT TO anon, authenticated
             USING (NOT public.is_test_salesperson_text(salesperson_id))';
  END IF;

  IF to_regclass('public.team_message_reactions') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "team_message_reactions hide test data"
             ON public.team_message_reactions';
    EXECUTE 'CREATE POLICY "team_message_reactions hide test data"
             ON public.team_message_reactions
             AS RESTRICTIVE FOR SELECT TO anon, authenticated
             USING (NOT public.is_test_salesperson_text(salesperson_id))';
  END IF;
END$$;

-- (c) server-only RPC.
DO $$
BEGIN
  IF to_regprocedure('public.replace_activity_week(uuid,date,date,jsonb)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.replace_activity_week(UUID, DATE, DATE, JSONB)
      FROM anon, authenticated;
  END IF;
END$$;

COMMIT;


-- ===========================================================================
-- VERIFICATION (run after)
-- ===========================================================================
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'salespeople' AND column_name = 'test_owner_id';   -- 1 row
-- SELECT conname FROM pg_constraint
--  WHERE conname = 'salespeople_test_owner_requires_test';               -- 1 row
-- SELECT count(*) FROM salespeople
--  WHERE test_owner_id IS NOT NULL AND NOT is_test;                      -- 0
-- SELECT is_test_data, count(*) FROM business_card_contacts GROUP BY 1;
-- -- anon can read neither admin_pin nor test_owner_id, and cannot write:
-- SELECT column_name FROM information_schema.column_privileges
--  WHERE table_name = 'salespeople' AND grantee = 'anon'
--    AND column_name IN ('admin_pin', 'test_owner_id');                  -- 0 rows
-- SELECT privilege_type FROM information_schema.table_privileges
--  WHERE table_name = 'salespeople' AND grantee = 'anon';                -- none
-- -- restrictive policies present:
-- SELECT tablename, policyname FROM pg_policies
--  WHERE policyname LIKE '% hide test data' ORDER BY 1;                  -- 9 (or 7 without Juice Box / messages)
-- ===========================================================================
