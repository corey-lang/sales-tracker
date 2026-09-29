-- Test data: one salesperson + one weekly goals row.
-- Safe to re-run: ON CONFLICT DO NOTHING keeps existing rows.
-- first_name is CITEXT, so "Test" / "test" / "TEST" all collide.

INSERT INTO salespeople (first_name, location) VALUES
  ('Alex',   'HQ'),
  ('Jordan', 'HQ')
ON CONFLICT (first_name) DO NOTHING;

-- The seeded test account.
--
-- FRESH-INSTALL SAFETY: `is_test` is normally created by
-- salespeople_auth_columns.sql, which the documented order runs AFTER this
-- file. The column is therefore ensured here (same definition; the later
-- ADD COLUMN IF NOT EXISTS is a no-op), so the seeded row is ALWAYS inserted
-- with is_test = TRUE — there is no ordering in which "Test" can be seeded as
-- a normal, reportable salesperson.
ALTER TABLE salespeople
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

-- LEGACY DATABASES ARE NEVER GUESSED AT. An older version of this file could
-- insert "Test" as a normal salesperson. There is no immutable marker that
-- proves such a row is the old seed row rather than a real person, so it is
-- NOT reclassified automatically (that could silently remove a real person
-- from login and reporting). It is reported instead; convert it deliberately
-- with supabase/provision_test_ae.template.sql (UUID-based, verified).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM salespeople WHERE is_test)
     AND EXISTS (SELECT 1 FROM salespeople WHERE first_name = 'Test' AND is_test = FALSE) THEN
    RAISE NOTICE 'AMBIGUOUS LEGACY STATE: an unflagged salesperson named "Test" exists and no test account does. It was NOT reclassified (it may be a real person). If it is the old seed row, convert it deliberately with supabase/provision_test_ae.template.sql (v_convert_legacy_row).';
  END IF;
END$$;

-- Create the test account only when the database has NO test account yet:
-- once the seeded row is flagged (and perhaps renamed, e.g. "Test AE"),
-- re-running this file must NOT create a new "Test" salesperson.
INSERT INTO salespeople (first_name, location, is_test)
SELECT 'Test', 'HQ', TRUE
 WHERE NOT EXISTS (SELECT 1 FROM salespeople WHERE is_test)
ON CONFLICT (first_name) DO NOTHING;

-- Daily goals (table is named weekly_goals for legacy reasons; values are daily).
-- effective_from is unique-per-row-by-itself here; if you re-seed, this will
-- silently do nothing because there's no conflict key, so adjust manually if
-- you want to change goals after the first run.
INSERT INTO weekly_goals (
  effective_from,
  office_visits,
  service_requests,
  ones_scheduled,
  ones_held,
  impressions,
  team_meetings,
  gold_list_touches
)
SELECT
  CURRENT_DATE,
  25,  -- office_visits
  5,   -- service_requests
  2,   -- ones_scheduled
  1,   -- ones_held
  150, -- impressions
  4,   -- team_meetings
  25   -- gold_list_touches
WHERE NOT EXISTS (SELECT 1 FROM weekly_goals);
