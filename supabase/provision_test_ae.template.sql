-- ===========================================================================
-- Provision (or re-provision) a PRIVATE TEST ACCOUNT — TEMPLATE. NOT a migration.
-- ===========================================================================
-- Run in the Supabase SQL editor AFTER private_test_accounts.sql is applied.
-- Do NOT add this file to the migration order, and NEVER commit an edited
-- copy: the two UUIDs and the PIN are entered in the SQL editor only and are
-- not saved anywhere in the repository.
--
-- WHAT IT DOES (all-or-nothing — the DO block is one transaction; any failed
-- check RAISES and NOTHING is changed):
--   1. Identifies BOTH accounts strictly by UUID. No name, email or any other
--      lookup is used anywhere as a security decision.
--   2. Verifies the TEST account is exactly one existing row that is already
--      flagged is_test = true, role = 'ae', active, and not owned by anyone
--      else. It never turns a real person into a test account on its own: the
--      ONLY exception is the explicit v_convert_legacy_row opt-in below, which
--      flags the single id you name, and only if no test account exists yet,
--      the row is an active role='ae' with no PIN.
--   3. Verifies the OWNER is exactly one existing, active, non-test ADMIN.
--   4. Sets test_owner_id = owner and admin_pin = the PIN you typed below.
--   5. Re-reads the row and verifies every field again; RAISES if any differs.
--   The PIN is never echoed, logged or returned.
--
-- CANNOT RUN AS WRITTEN: the placeholders below are not valid UUIDs / a valid
-- PIN, so an unedited copy errors out immediately (invalid uuid syntax, or the
-- PIN guard) before touching any data.
--
-- STEP 0 — read-only: find the two UUIDs (run this alone first; copy the ids
-- from the rows YOU recognise — never paste ids you have not looked at):
--
--   SELECT id, first_name, role, is_test, test_owner_id, deactivated_at,
--          (admin_pin IS NOT NULL) AS has_pin
--     FROM salespeople
--    WHERE is_test OR role = 'admin'
--          OR (first_name ILIKE 'test%' AND NOT is_test)   -- legacy candidates
--    ORDER BY is_test DESC, first_name;
--
-- A fresh install (current seed.sql) already has its test row flagged. A row
-- named "Test" with is_test = false is AMBIGUOUS (old seed row, or a real
-- person) and is never changed automatically — only you can decide, by id.

-- STOP if: there is no is_test row (create/flag the account first), more than
-- one is_test row and you are not sure which is the sandbox, the owner is not
-- listed as role = 'admin', or either row shows a deactivated_at.
-- ===========================================================================

DO $$
DECLARE
  -- ---- EDIT THESE THREE VALUES (in the SQL editor only) ------------------
  v_test_id  uuid := '<TEST_AE_UUID>'::uuid;      -- the is_test account's id
  v_owner_id uuid := '<OWNER_ADMIN_UUID>'::uuid;  -- the owning admin's id
  v_pin      text := '<CHOOSE_A_PIN>';            -- 4-12 digits; not saved anywhere
  -- Leave FALSE unless STEP 0 showed the test account is a LEGACY row that was
  -- seeded as a normal salesperson (is_test = false) and you have confirmed,
  -- by its id, that it is the old seed row and not a real person. TRUE flags
  -- exactly that one id as a test account — nothing is ever matched by name.
  v_convert_legacy_row boolean := false;
  -- ------------------------------------------------------------------------
  t salespeople%ROWTYPE;
  o salespeople%ROWTYPE;
  n int;
BEGIN
  -- Guards against an unedited / careless run.
  IF v_pin !~ '^[0-9]{4,12}$' THEN
    RAISE EXCEPTION 'STOP: the PIN must be 4-12 digits (did you replace the <CHOOSE_A_PIN> placeholder?).';
  END IF;
  IF v_test_id = v_owner_id THEN
    RAISE EXCEPTION 'STOP: the test account and its owner must be different rows.';
  END IF;

  -- The test account: exactly one row with that id.
  SELECT count(*) INTO n FROM salespeople WHERE id = v_test_id;
  IF n <> 1 THEN
    RAISE EXCEPTION 'STOP: expected exactly 1 salespeople row for the test id, found %.', n;
  END IF;
  SELECT * INTO t FROM salespeople WHERE id = v_test_id;
  IF t.is_test IS DISTINCT FROM TRUE THEN
    IF NOT v_convert_legacy_row THEN
      RAISE EXCEPTION 'STOP: that row is not flagged is_test = true — refusing to convert a real person into a test account. (If it really is the legacy seed row, set v_convert_legacy_row := true after checking its id.)';
    END IF;
    -- Deliberate, single-row conversion: the operator named this id and opted in.
    SELECT count(*) INTO n FROM salespeople WHERE is_test;
    IF n <> 0 THEN
      RAISE EXCEPTION 'STOP: a test account already exists (%); refusing to create a second one by conversion.', n;
    END IF;
    IF t.role IS DISTINCT FROM 'ae' OR t.deactivated_at IS NOT NULL OR t.admin_pin IS NOT NULL THEN
      RAISE EXCEPTION 'STOP: only an active role=''ae'' row with no PIN can be converted (this one looks like a real, in-use account).';
    END IF;
    UPDATE salespeople SET is_test = TRUE WHERE id = v_test_id;
    SELECT * INTO t FROM salespeople WHERE id = v_test_id;
    RAISE NOTICE 'Converted legacy row % to a test account.', v_test_id;
  END IF;
  IF t.role IS DISTINCT FROM 'ae' THEN
    RAISE EXCEPTION 'STOP: the test account must have role = ''ae'' (found %).', t.role;
  END IF;
  IF t.deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION 'STOP: the test account is deactivated.';
  END IF;
  IF t.test_owner_id IS NOT NULL AND t.test_owner_id <> v_owner_id THEN
    RAISE EXCEPTION 'STOP: the test account already belongs to a DIFFERENT owner. Clear that deliberately first.';
  END IF;

  -- The owner: exactly one active, real (non-test) admin.
  SELECT count(*) INTO n FROM salespeople WHERE id = v_owner_id;
  IF n <> 1 THEN
    RAISE EXCEPTION 'STOP: expected exactly 1 salespeople row for the owner id, found %.', n;
  END IF;
  SELECT * INTO o FROM salespeople WHERE id = v_owner_id;
  IF o.role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'STOP: the owner must have role = ''admin'' (found %).', o.role;
  END IF;
  IF o.is_test IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'STOP: the owner must not be a test account.';
  END IF;
  IF o.deactivated_at IS NOT NULL THEN
    RAISE EXCEPTION 'STOP: the owner is deactivated.';
  END IF;

  UPDATE salespeople
     SET test_owner_id = v_owner_id,
         admin_pin     = v_pin
   WHERE id = v_test_id;

  -- Re-verify from the table, not from local variables.
  SELECT * INTO t FROM salespeople WHERE id = v_test_id;
  IF NOT (
        t.is_test = TRUE
    AND t.role = 'ae'
    AND t.test_owner_id = v_owner_id
    AND t.deactivated_at IS NULL
    AND t.admin_pin IS NOT NULL
    AND length(btrim(t.admin_pin)) >= 4
  ) THEN
    RAISE EXCEPTION 'STOP: post-update verification failed; rolling back.';
  END IF;
  SELECT count(*) INTO n FROM salespeople WHERE test_owner_id = v_owner_id AND is_test;
  RAISE NOTICE 'OK: test account % is now owned by admin % (that admin owns % test account(s)); PIN set.',
    v_test_id, v_owner_id, n;
END
$$;

-- ===========================================================================
-- STEP 2 — read-only verification (run after; the PIN is never selected):
--
--   SELECT id, first_name, role, is_test, test_owner_id, deactivated_at,
--          (admin_pin IS NOT NULL) AS has_pin
--     FROM salespeople
--    WHERE id IN ('<TEST_AE_UUID>'::uuid, '<OWNER_ADMIN_UUID>'::uuid);
--
--   -- Expect: test row = role ae / is_test true / test_owner_id = the owner /
--   -- active / has_pin true; owner row = role admin / is_test false / active.
--
--   -- No real person may carry an owner or an is_test flag by accident:
--   SELECT count(*) FROM salespeople WHERE test_owner_id IS NOT NULL AND NOT is_test;  -- 0
--
--   -- Any OTHER is_test account is private to no one (fail-private) — list them:
--   SELECT id, first_name FROM salespeople WHERE is_test AND test_owner_id IS NULL;
-- ===========================================================================
