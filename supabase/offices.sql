-- ===========================================================================
-- offices / office_visits / office_import_batches — Map & Office Visits MVP.
-- ===========================================================================
-- WHAT THIS IS
--   Data foundation for an upcoming AE office-map feature. Three tables:
--
--   * offices                  — imported office locations assigned to an AE.
--   * office_visits            — per-rep visit log entries against an office.
--   * office_import_batches    — provenance row created once per CSV import.
--
-- SANDBOX MODEL (sandbox-first rollout)
--   Every row carries `environment IN ('test', 'production')`. The first
--   iteration of this feature is test-only: the import route refuses
--   anything other than 'test', and the future read surface will scope
--   to the calling AE's `is_test` flag.
--
--   The `production` value exists on the CHECK constraint up front so a
--   later migration to flip the feature live doesn't need to widen the
--   constraint — we just lift the route-level guard.
--
-- DUPLICATE SCOPING (requirement: scoped by environment)
--   The partial UNIQUE index on offices includes `environment` in the key,
--   so a test import can never collide with — or shadow — a production
--   row, and vice-versa. Duplicate detection runs per (AE, environment,
--   normalized name+street+zip).
--
-- ACCESS MODEL
--   RLS is ENABLED with NO policies on all three tables. The anon key has
--   zero access; all reads/writes go through service-role server routes
--   (currently /api/admin/offices/import). This mirrors `ae_tasks.sql`'s
--   "RLS on, no policy" stance — safest default for a brand-new table
--   with no existing client readers.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
-- DROP TRIGGER IF EXISTS, ENABLE ROW LEVEL SECURITY all re-runnable. The
-- CHECK and FK constraints use ADD CONSTRAINT IF NOT EXISTS where possible
-- (Postgres 9.6+) — older Postgres falls back to a DO block.
-- See supabase/README.md for migration order.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1) office_import_batches — provenance row, one per CSV import
-- ---------------------------------------------------------------------------
-- Created first because offices.import_batch_id references it.
-- `source` is a free-form label set by the importer (e.g. "CRM-2026-Q1",
-- "manual-paste"); `row_count` is the FINAL count of inserted offices,
-- set by the route after the batch processes.

CREATE TABLE IF NOT EXISTS office_import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  -- FK action set below via DROP-then-ADD so the constraint is correct
  -- on both fresh databases and any earlier deployment of this file
  -- that landed with ON DELETE SET NULL.
  uploaded_by UUID NOT NULL REFERENCES salespeople(id),
  environment TEXT NOT NULL DEFAULT 'test'
    CHECK (environment IN ('test', 'production')),
  row_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- uploaded_by must stay populated for audit integrity. ON DELETE
-- RESTRICT means deleting a salesperson with imports fails loudly
-- (the admin must reassign or hard-delete the batches first) instead
-- of either:
--   * losing provenance (SET NULL — would violate uploaded_by NOT NULL
--     and silently fail the delete), or
--   * cascading and wiping the offices the batch produced (CASCADE).
-- DROP-then-ADD is the idempotent pattern for FK action changes —
-- ALTER TABLE … ADD CONSTRAINT IF NOT EXISTS doesn't exist for FKs in
-- Postgres < 16. The DROP IF EXISTS is a no-op on a clean DB.
ALTER TABLE office_import_batches
  DROP CONSTRAINT IF EXISTS office_import_batches_uploaded_by_fkey;
ALTER TABLE office_import_batches
  ADD CONSTRAINT office_import_batches_uploaded_by_fkey
  FOREIGN KEY (uploaded_by) REFERENCES salespeople(id) ON DELETE RESTRICT;

-- Most recent imports first — used by future admin "Imports" surface.
CREATE INDEX IF NOT EXISTS idx_office_import_batches_recent
  ON office_import_batches(environment, created_at DESC);


-- ---------------------------------------------------------------------------
-- 2) offices — one row per imported office record
-- ---------------------------------------------------------------------------
-- street/city/state/zip are all nullable so a sparse CSV still imports;
-- only `name` is required at the column level. The import route enforces
-- stricter "required fields" rules at validation time.
--
-- latitude / longitude are nullable because some imports won't have
-- coordinates — those rows are still useful to track (and can be
-- geocoded later before the map UI ships).
--
-- `dedupe_key` is a normalized form of name + street + zip computed by
-- the import route. The partial UNIQUE index below makes duplicate
-- detection a single INSERT that returns 23505 on conflict.

CREATE TABLE IF NOT EXISTS offices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salesperson_id UUID NOT NULL REFERENCES salespeople(id) ON DELETE CASCADE,
  import_batch_id UUID REFERENCES office_import_batches(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  street TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  source TEXT,
  dedupe_key TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'test'
    CHECK (environment IN ('test', 'production')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-AE listing for the map view. Filtering by environment first means
-- a test session never accidentally pulls production rows.
CREATE INDEX IF NOT EXISTS idx_offices_salesperson_env
  ON offices(salesperson_id, environment);

-- Duplicate scoping. UNIQUE(salesperson_id, environment, dedupe_key)
-- means re-importing the same office twice under the same env is a
-- no-op (route handles the 23505 by skipping + reporting), AND a test
-- import can never collide with an identical production row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_offices_dedupe_per_env
  ON offices(salesperson_id, environment, dedupe_key);

-- updated_at maintenance — matches the pattern from ae_tasks +
-- business_card_contacts.
CREATE OR REPLACE FUNCTION set_offices_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_offices_updated_at ON offices;
CREATE TRIGGER trg_offices_updated_at
  BEFORE UPDATE ON offices
  FOR EACH ROW
  EXECUTE FUNCTION set_offices_updated_at();


-- ---------------------------------------------------------------------------
-- 3) office_visits — per-rep visit log
-- ---------------------------------------------------------------------------
-- `note` is free-form ("Met with Jane, follow-up next week"); `visited_at`
-- is when the visit happened (default NOW() for in-the-moment logging).
-- environment is denormalized from the parent office at insert time by
-- the future write route, so report queries scoped by environment don't
-- need a join against offices.

CREATE TABLE IF NOT EXISTS office_visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id UUID NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  salesperson_id UUID NOT NULL REFERENCES salespeople(id) ON DELETE CASCADE,
  note TEXT,
  visited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  environment TEXT NOT NULL DEFAULT 'test'
    CHECK (environment IN ('test', 'production')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "Visits for this office, newest first" — primary UX query.
CREATE INDEX IF NOT EXISTS idx_office_visits_office_recent
  ON office_visits(office_id, visited_at DESC);

-- "My recent visits, scoped by environment" — powers the future AE list.
-- environment is in the key so a test session's query plan never even
-- considers production rows.
CREATE INDEX IF NOT EXISTS idx_office_visits_salesperson_env_recent
  ON office_visits(salesperson_id, environment, visited_at DESC);


-- Enforce the visit-environment invariant at the DB level.
--
-- A visit's environment MUST equal its parent office's environment —
-- otherwise a test office could grow production visits (skewing real
-- reports) or vice-versa. Rather than trust every write path to pass
-- the right value, we derive `environment` from the parent office on
-- every INSERT/UPDATE. Caller-supplied environment is overwritten.
--
-- This is also the cheapest invariant — a CHECK constraint can't
-- subquery, and a CHECK on (env IN ('test','production')) doesn't say
-- anything about cross-row consistency. A BEFORE trigger that
-- overwrites NEW.environment is the simplest enforcement Postgres
-- offers, and it works whether the caller passes the field or not.
--
-- If office_id doesn't resolve, RAISE EXCEPTION fires a clean error
-- before the FK constraint even runs — useful for early diagnostics.
CREATE OR REPLACE FUNCTION enforce_office_visits_environment()
RETURNS TRIGGER AS $$
DECLARE
  parent_env TEXT;
BEGIN
  SELECT environment INTO parent_env
    FROM offices
   WHERE id = NEW.office_id;
  IF parent_env IS NULL THEN
    RAISE EXCEPTION
      'office_visits.office_id % does not reference an existing office',
      NEW.office_id;
  END IF;
  NEW.environment := parent_env;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_office_visits_env_from_office ON office_visits;
CREATE TRIGGER trg_office_visits_env_from_office
  BEFORE INSERT OR UPDATE ON office_visits
  FOR EACH ROW
  EXECUTE FUNCTION enforce_office_visits_environment();


-- ---------------------------------------------------------------------------
-- 4) RLS — service-role-only on all three tables
-- ---------------------------------------------------------------------------
-- ENABLE RLS with NO policies. The anon key cannot SELECT / INSERT /
-- UPDATE / DELETE these tables. Service-role bypasses RLS, so server
-- routes (admin import + future AE read) continue to work normally.
-- Matches the stance from `ae_tasks.sql`.

ALTER TABLE office_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE offices ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_visits ENABLE ROW LEVEL SECURITY;


-- ===========================================================================
-- VERIFICATION
-- ===========================================================================
-- SELECT tablename, rowsecurity FROM pg_tables
-- WHERE tablename IN ('offices', 'office_visits', 'office_import_batches');
--   -- expect 3 rows, rowsecurity = true on each.
--
-- SELECT count(*) FROM pg_policies
-- WHERE tablename IN ('offices', 'office_visits', 'office_import_batches');
--   -- expect 0 (no policies — anon has no access).
--
-- SELECT indexname FROM pg_indexes WHERE tablename = 'offices'
-- ORDER BY indexname;
--   -- expect:
--   --   idx_offices_salesperson_env
--   --   offices_pkey
--   --   uq_offices_dedupe_per_env
--
-- -- Smoke test: inserting two identical rows under different envs MUST succeed:
-- INSERT INTO offices (salesperson_id, name, dedupe_key, environment)
-- VALUES ('<some-ae>', 'Test Office', 'test office||', 'test');
-- INSERT INTO offices (salesperson_id, name, dedupe_key, environment)
-- VALUES ('<some-ae>', 'Test Office', 'test office||', 'production');
--   -- expect both succeed — env is part of the unique key.
--
-- -- Re-inserting under the SAME env must fail with 23505:
-- INSERT INTO offices (salesperson_id, name, dedupe_key, environment)
-- VALUES ('<some-ae>', 'Test Office', 'test office||', 'test');
--   -- expect: duplicate key value violates unique constraint
--   --         "uq_offices_dedupe_per_env"
--
-- -- Confirm the FK action on uploaded_by is RESTRICT (not SET NULL):
-- SELECT conname, confdeltype FROM pg_constraint
-- WHERE conrelid = 'office_import_batches'::regclass
--   AND conname = 'office_import_batches_uploaded_by_fkey';
--   -- expect: confdeltype = 'r' (RESTRICT)
--
-- -- Confirm the office_visits environment trigger is installed:
-- SELECT tgname FROM pg_trigger
-- WHERE tgrelid = 'office_visits'::regclass
--   AND tgname = 'trg_office_visits_env_from_office';
--   -- expect 1 row.
--
-- -- Trigger smoke test: visit's environment MUST follow the office's
-- -- regardless of what the caller passes:
-- INSERT INTO offices (salesperson_id, name, dedupe_key, environment)
-- VALUES ('<some-ae>', 'Smoke', 'smoke||', 'test')
-- RETURNING id;  -- copy as <office>
-- INSERT INTO office_visits (office_id, salesperson_id, environment)
-- VALUES ('<office>', '<some-ae>', 'production');
-- SELECT environment FROM office_visits WHERE office_id = '<office>';
--   -- expect 'test' — trigger overrode the caller's 'production'.
