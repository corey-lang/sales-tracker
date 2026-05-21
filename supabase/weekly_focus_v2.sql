-- ===========================================================================
-- Weekly Focus — durability + privacy hardening (v2).
-- ===========================================================================
-- DEPENDS ON
--   1. supabase/manager_one_on_ones.sql   (creates the coaching tables)
--   2. supabase/weekly_focus.sql          (adds week_start + Weekly Focus
--                                          notes columns, unique week index)
--   This migration MUST run after both of those. It assumes the columns
--   and tables they create are already present.
--
-- WHAT THIS DOES
--   * Adds a `status` lifecycle to commitments (open / completed / dropped)
--     so "remove from active focus" stops being a destructive delete.
--     Historical commitments are preserved; carryover only pulls `open`.
--   * Adds `archived_at` to coaching_relationships and a normalized unique
--     index so the same Gold List contact can't be added twice for one AE
--     while archived rows stay queryable as longitudinal history.
--   * Moves the manager-private "Manager Notes" pane off the shared
--     `one_on_ones` row into a separate `weekly_focus_private_notes`
--     table so a future AE-facing read (when visibility='shared') can
--     never accidentally leak private notes — they live on a different
--     table the AE-facing endpoints will never touch.
--   * Adds an (ae_id, status) index for the index-page summary path.
--
-- Idempotent: every step guards on existing state. Safe to re-run.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1) Commitment lifecycle — open / completed / dropped.
--
--    Existing rows carry `completed` (boolean) + `completed_at`. We add
--    `status` as the authoritative field, backfill it from `completed`,
--    and keep the boolean for back-compat (any older report query that
--    still filters on it will see consistent values; new code reads
--    `status`).
-- ---------------------------------------------------------------------------

ALTER TABLE one_on_one_commitments
  ADD COLUMN IF NOT EXISTS status TEXT;

UPDATE one_on_one_commitments
   SET status = CASE WHEN completed THEN 'completed' ELSE 'open' END
 WHERE status IS NULL;

ALTER TABLE one_on_one_commitments
  ALTER COLUMN status SET DEFAULT 'open';

ALTER TABLE one_on_one_commitments
  ALTER COLUMN status SET NOT NULL;

-- Defensive check constraint. Wrapped in a DO block so the migration is
-- re-runnable (ADD CONSTRAINT IF NOT EXISTS isn't available pre-PG 16).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'one_on_one_commitments_status_check'
  ) THEN
    ALTER TABLE one_on_one_commitments
      ADD CONSTRAINT one_on_one_commitments_status_check
      CHECK (status IN ('open', 'completed', 'dropped'));
  END IF;
END$$;


-- ---------------------------------------------------------------------------
-- 2) Indexes for the new status path.
--
--    The /admin/coaching index aggregates open vs carried commitments
--    across many AEs at once. That predicate is (ae_id IN (...) AND
--    status = 'open'), so a (ae_id, status) index is the hot path.
--
--    Also keep an (one_on_one_id, status) partial index — it replaces the
--    old `idx_one_on_one_commitments_open` (which was keyed only on
--    `completed = false`). New code never reads `completed` for filtering,
--    so the old partial index becomes dead weight.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_one_on_one_commitments_ae_status
  ON one_on_one_commitments(ae_id, status);

CREATE INDEX IF NOT EXISTS idx_one_on_one_commitments_focus_open
  ON one_on_one_commitments(one_on_one_id)
  WHERE status = 'open';

DROP INDEX IF EXISTS idx_one_on_one_commitments_open;


-- ---------------------------------------------------------------------------
-- 3) Coaching relationships — archive lifecycle + dedupe guard.
--
--    `archived_at` makes the "Remove" action a soft archive: the row stays
--    queryable as longitudinal history but drops out of the active Gold
--    List. The dedupe index is partial on archived_at IS NULL so an AE
--    can re-add a previously-archived relationship without the unique
--    index getting in the way (e.g. re-engaging a contact that cooled).
-- ---------------------------------------------------------------------------

ALTER TABLE coaching_relationships
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- ---- 3a) Auto-archive existing duplicate active relationships. ----------
--
-- The unique partial index below would fail outright on any upgraded DB
-- that already has two active rows with the same normalized identity for
-- one AE. Rather than rejecting the migration, we collapse the duplicates
-- non-destructively: for each (ae_id, normalized identity) group with
-- more than one active row, we keep the MOST RECENTLY UPDATED row active
-- and mark every older sibling as archived (archived_at = now()).
--
-- "Most recently updated" wins because that's the relationship the
-- manager has been touching — keeping it active preserves the freshest
-- notes, status, and next_step. Older duplicates remain queryable for
-- longitudinal history; nothing is hard-deleted.
--
-- Idempotent: a re-run finds no remaining duplicates (because the first
-- run archived them) and is a no-op. A fresh DB with no duplicates skips
-- the UPDATE entirely.
WITH ranked AS (
  SELECT id,
         ae_id,
         ROW_NUMBER() OVER (
           PARTITION BY ae_id,
                        lower(btrim(contact_name)),
                        lower(btrim(COALESCE(company, ''))),
                        lower(btrim(COALESCE(title,   '')))
           ORDER BY updated_at DESC, created_at DESC, id DESC
         ) AS rn
    FROM coaching_relationships
   WHERE archived_at IS NULL
)
UPDATE coaching_relationships r
   SET archived_at = NOW()
  FROM ranked
 WHERE r.id = ranked.id
   AND ranked.rn > 1;

-- ---- 3b) Unique partial index. ------------------------------------------
--
-- Normalized identity = (ae_id, lower(trim(contact_name)),
--                        lower(trim(coalesce(company, ''))),
--                        lower(trim(coalesce(title,   '')))).
-- contact_name alone isn't unique (two "John Smith" entries at different
-- brokerages are legitimately different relationships), so we include
-- company + title in the key. WHERE archived_at IS NULL means soft-
-- archived rows don't block a fresh re-add and the dedupe pass above
-- doesn't leave the index in an invalid state.
CREATE UNIQUE INDEX IF NOT EXISTS idx_coaching_relationships_dedupe
  ON coaching_relationships (
    ae_id,
    lower(btrim(contact_name)),
    lower(btrim(COALESCE(company, ''))),
    lower(btrim(COALESCE(title,   '')))
  )
  WHERE archived_at IS NULL;


-- ---------------------------------------------------------------------------
-- 4) Private manager notes — separate table so future AE-share can't leak.
--
--    The "Manager Notes" pane is the one piece of Weekly Focus content
--    that is explicitly NOT meant to be visible to the AE, ever. Keeping
--    it on the same row as Wins/Focus/Blockers means any visibility-
--    shared read has to remember to strip the column. That's a footgun.
--
--    Putting it in its own table makes accidental leakage structurally
--    impossible: the AE-facing routes will simply not query this table.
--
--    The schema mirrors one_on_one_commitments' relationship to the
--    focus row (FK + denormalized ae_id) so per-AE queries are cheap.
--    Unique on weekly_focus_id keeps it one-to-one with the focus row.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS weekly_focus_private_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  weekly_focus_id UUID NOT NULL REFERENCES one_on_ones(id) ON DELETE CASCADE,
  ae_id UUID NOT NULL REFERENCES salespeople(id) ON DELETE CASCADE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_weekly_focus_private_notes_focus
  ON weekly_focus_private_notes(weekly_focus_id);

CREATE INDEX IF NOT EXISTS idx_weekly_focus_private_notes_ae
  ON weekly_focus_private_notes(ae_id);

DROP TRIGGER IF EXISTS trg_weekly_focus_private_notes_updated_at
  ON weekly_focus_private_notes;
CREATE TRIGGER trg_weekly_focus_private_notes_updated_at
  BEFORE UPDATE ON weekly_focus_private_notes
  FOR EACH ROW EXECUTE FUNCTION set_coaching_updated_at();

ALTER TABLE weekly_focus_private_notes ENABLE ROW LEVEL SECURITY;

-- Backfill from the old column on one_on_ones, if it still exists.
-- Wrapped in a DO block so a re-run on an already-migrated DB (column
-- already dropped) is a no-op rather than an error.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'one_on_ones'
       AND column_name = 'notes_manager'
  ) THEN
    INSERT INTO weekly_focus_private_notes (weekly_focus_id, ae_id, notes)
    SELECT id, ae_id, notes_manager
      FROM one_on_ones
     WHERE notes_manager IS NOT NULL
       AND notes_manager <> ''
    ON CONFLICT (weekly_focus_id) DO NOTHING;

    ALTER TABLE one_on_ones DROP COLUMN notes_manager;
  END IF;
END$$;


-- ===========================================================================
-- VERIFICATION (run after the migration)
-- ===========================================================================
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_name = 'one_on_one_commitments'
--    AND column_name = 'status';
--    -- expect 1 row, text, NOT NULL.
--
-- SELECT DISTINCT status FROM one_on_one_commitments;
--    -- expect a subset of {open, completed, dropped}.
--
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'one_on_ones' AND column_name = 'notes_manager';
--    -- expect 0 rows (column removed).
--
-- SELECT to_regclass('weekly_focus_private_notes');
--    -- expect a non-null OID.
--
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'coaching_relationships' AND column_name = 'archived_at';
--    -- expect 1 row.
--
-- SELECT indexname FROM pg_indexes
--  WHERE tablename = 'coaching_relationships'
--    AND indexname = 'idx_coaching_relationships_dedupe';
--    -- expect 1 row.
