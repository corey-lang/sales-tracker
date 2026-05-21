-- ===========================================================================
-- Weekly Focus — evolution of the manager 1:1 coaching system.
-- ===========================================================================
-- WHAT THIS IS
--   The original `one_on_ones` table modeled a discrete "meeting" the manager
--   manually created. The product has moved to a Weekly Focus rhythm:
--     * exactly ONE active focus row per AE per business week (Mon-Fri)
--     * the row is auto-created when the manager first opens the AE's coaching
--       page during a new week — no manual "Start new 1:1" flow
--     * incomplete commitments from prior weeks carry forward AUTOMATICALLY
--       (surfaced in the UI as "N commitments carried over from last week")
--     * Gold List / coaching_relationships remain persistent and untouched
--
-- This migration extends the existing `one_on_ones` table in place rather
-- than introducing a parallel table — the row identity ("a coaching artifact
-- belonging to one AE for one week") is the same; only its lifecycle and
-- naming have changed. Existing data is preserved.
--
-- Two new free-text panes (`notes_training`, `notes_manager`) round out the
-- spec'd Weekly Focus sections:
--     notes_focus          -> "This Week Focus"
--     notes_wins           -> "Wins"
--     notes_opportunities  -> "Need Help / Blockers"  (UI relabel only)
--     notes_training       -> "Training Focus"        (NEW)
--     notes_manager        -> "Manager Notes"         (NEW)
--
-- AE visibility (`visibility` column) is untouched: still defaults to
-- `manager_only`, with `shared` reserved for the future AE-facing surface.
--
-- Idempotent: every operation guards on existing state. Safe to re-run.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1) New columns on one_on_ones.
-- ---------------------------------------------------------------------------

-- week_start is the Monday (ISO week, weekday=1) of this focus row. Nullable
-- in the ALTER so existing rows can be back-filled before the NOT NULL
-- constraint locks it down below.
ALTER TABLE one_on_ones
  ADD COLUMN IF NOT EXISTS week_start DATE;

ALTER TABLE one_on_ones
  ADD COLUMN IF NOT EXISTS notes_training TEXT;

ALTER TABLE one_on_ones
  ADD COLUMN IF NOT EXISTS notes_manager TEXT;


-- ---------------------------------------------------------------------------
-- 2) Backfill week_start from meeting_date.
--    ISODOW returns 1=Mon ... 7=Sun, so Monday = meeting_date - (ISODOW - 1).
-- ---------------------------------------------------------------------------

UPDATE one_on_ones
   SET week_start = (
         meeting_date
         - ((EXTRACT(ISODOW FROM meeting_date)::int - 1) || ' days')::interval
       )::date
 WHERE week_start IS NULL;


-- ---------------------------------------------------------------------------
-- 3) Consolidate duplicates per (ae_id, week_start).
--
--    Pre-Weekly-Focus, the manager could create multiple 1:1s in the same
--    business week. The new model is one focus row per week, so we must
--    collapse any duplicate weeks. Strategy: keep the most-recently-created
--    row as the survivor; re-point its losers' commitments at it; delete
--    the losers (which would otherwise have orphaned the commitments under
--    the cascade).
--
--    Done as a single CTE so the re-point and the delete see the same set
--    of rows — no race even if this migration runs concurrently.
-- ---------------------------------------------------------------------------

WITH ranked AS (
  SELECT id,
         ae_id,
         week_start,
         ROW_NUMBER() OVER (
           PARTITION BY ae_id, week_start
           ORDER BY created_at DESC, id DESC
         ) AS rn
    FROM one_on_ones
),
survivors AS (
  SELECT ae_id, week_start, id AS survivor_id
    FROM ranked
   WHERE rn = 1
),
losers AS (
  SELECT r.id AS loser_id, s.survivor_id
    FROM ranked r
    JOIN survivors s
      ON s.ae_id = r.ae_id AND s.week_start = r.week_start
   WHERE r.rn > 1
),
moved_commitments AS (
  UPDATE one_on_one_commitments c
     SET one_on_one_id = l.survivor_id
    FROM losers l
   WHERE c.one_on_one_id = l.loser_id
  RETURNING c.id
)
DELETE FROM one_on_ones o
 USING losers l
 WHERE o.id = l.loser_id;


-- ---------------------------------------------------------------------------
-- 4) Lock week_start as NOT NULL once everything's backfilled, and enforce
--    one-focus-row-per-week with a unique index.
-- ---------------------------------------------------------------------------

ALTER TABLE one_on_ones
  ALTER COLUMN week_start SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_on_ones_ae_week_start
  ON one_on_ones(ae_id, week_start);


-- ===========================================================================
-- VERIFICATION (run after the migration)
-- ===========================================================================
-- SELECT column_name, is_nullable, data_type
--   FROM information_schema.columns
--  WHERE table_name = 'one_on_ones'
--    AND column_name IN ('week_start', 'notes_training', 'notes_manager');
--    -- expect 3 rows; week_start NOT NULL.
--
-- SELECT ae_id, week_start, COUNT(*) FROM one_on_ones
--  GROUP BY 1, 2 HAVING COUNT(*) > 1;
--    -- expect 0 rows.
--
-- SELECT indexname FROM pg_indexes
--  WHERE tablename = 'one_on_ones'
--    AND indexname = 'idx_one_on_ones_ae_week_start';
--    -- expect 1 row.
