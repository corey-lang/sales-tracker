-- ===========================================================================
-- offices — persistent per-office notes (office memory model).
-- ===========================================================================
-- WHAT THIS IS
--   Two free-text columns on `offices` that survive across visits.
--   They power the upcoming office-detail surface, which is "what the
--   AE sees every time they open this office":
--
--     * office_notes — long-term memory for the office. E.g.
--         "Broker is Sarah"
--         "Office meetings Tuesdays at 10am"
--         "Ask for Mike at the front desk"
--         "Prefers email over text"
--
--     * next_action — the next-step intent for this office. E.g.
--         "Drop off donuts week of 6/3"
--         "Follow up on A2L class"
--
--   Both nullable — an imported office starts blank and accumulates
--   memory over time. Per-visit notes continue to live in
--   `office_visits.note` (kept under that name to avoid renaming a
--   shipped column; semantically it IS the "visit note" described in
--   the office memory model).
--
-- WHY TWO COLUMNS (not one)
--   `office_notes` and `next_action` are different in the UX — notes
--   are reference info and `next_action` is an actionable to-do. They
--   render distinctly in the future detail view; storing them
--   separately avoids parsing free-form prose for "what's the next
--   step?" and lets a future "Clear next action" affordance touch one
--   column.
--
-- SANDBOX MODEL UNCHANGED
--   The `environment` column on each offices row continues to scope
--   reads/writes between test and production data. These persistent
--   columns don't change that — they apply per office regardless of
--   environment.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Safe to re-run.
-- ===========================================================================

ALTER TABLE offices
  ADD COLUMN IF NOT EXISTS office_notes TEXT;

ALTER TABLE offices
  ADD COLUMN IF NOT EXISTS next_action TEXT;

-- ===========================================================================
-- VERIFICATION
-- ===========================================================================
-- -- Columns exist, nullable, no default:
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_name = 'offices'
--    AND column_name IN ('office_notes', 'next_action')
--  ORDER BY column_name;
--   -- expect: both rows, data_type=text, is_nullable=YES, column_default=NULL
--
-- -- Existing rows weren't touched (no backfill, both columns NULL):
-- SELECT COUNT(*) FILTER (WHERE office_notes IS NULL) AS notes_null,
--        COUNT(*) FILTER (WHERE next_action IS NULL) AS next_null,
--        COUNT(*)                                    AS total
--   FROM offices;
--   -- expect: notes_null = total, next_null = total.
--
-- -- office_visits.note still in place (the visit-note column):
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'office_visits' AND column_name = 'note';
--   -- expect one row.
