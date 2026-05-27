-- ===========================================================================
-- ae_tasks — optional back-link to the source office.
-- ===========================================================================
-- WHAT THIS IS
--   Adds `office_id UUID NULL REFERENCES offices(id) ON DELETE SET NULL`
--   to `ae_tasks`. When the Office Detail page's "Also add to my AE
--   To-Dos" checkbox creates a task from a Next Action, the resulting
--   task carries the source office id. The /todos UI then renders a
--   tappable "From office: <name>" line that navigates back to the
--   office's detail page.
--
-- ON DELETE SET NULL
--   When the source office row is deleted (or RLS-pruned in the test
--   sandbox), the task survives with office_id = NULL — the To-Do is
--   the AE's personal artifact and shouldn't vanish because the
--   office row went away. The /todos UI degrades gracefully: if
--   office_id is set but the office can't be looked up, it shows the
--   plain "From office: (no longer available)" text rather than a
--   broken link.
--
-- NOT IN THE UNIQUE / PRIMARY KEY
--   A task does not need to be unique per (salesperson, office) — an
--   AE may have several follow-up tasks tied to one office over time
--   ("drop donuts this week," "schedule meeting next month," etc.).
--
-- PARTIAL INDEX
--   `WHERE office_id IS NOT NULL` keeps the index narrow — only
--   linked tasks pay the storage cost — and supports the future
--   office-detail "related To-Dos" lookup without scanning the
--   whole task table.
--
-- WRITE PATH
--   The only writer that sets `office_id` is the office-detail page's
--   client-side dual-write to /api/tasks. Manually-created To-Dos
--   (the AeTasksCard quick-add input) leave it null, so existing
--   tasks are entirely unaffected.
--
-- IDEMPOTENT
--   ADD COLUMN IF NOT EXISTS + DROP-then-ADD FK + CREATE INDEX IF
--   NOT EXISTS. Re-runnable on a clean database AND on an already-
--   migrated one.
-- ===========================================================================

ALTER TABLE ae_tasks
  ADD COLUMN IF NOT EXISTS office_id UUID;

-- DROP-then-ADD because Postgres < 16 has no `ADD CONSTRAINT IF NOT
-- EXISTS` for FKs. The DROP IF EXISTS no-ops on a fresh DB; the ADD
-- locks in the ON DELETE SET NULL behavior described above.
ALTER TABLE ae_tasks
  DROP CONSTRAINT IF EXISTS ae_tasks_office_id_fkey;
ALTER TABLE ae_tasks
  ADD CONSTRAINT ae_tasks_office_id_fkey
  FOREIGN KEY (office_id) REFERENCES offices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ae_tasks_office
  ON ae_tasks(office_id)
  WHERE office_id IS NOT NULL;

-- ===========================================================================
-- VERIFICATION
-- ===========================================================================
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'ae_tasks' AND column_name = 'office_id';
--   -- expect one row, data_type=uuid, is_nullable=YES.
--
-- SELECT conname, confdeltype FROM pg_constraint
-- WHERE conrelid = 'ae_tasks'::regclass
--   AND conname = 'ae_tasks_office_id_fkey';
--   -- expect: confdeltype = 'n' (SET NULL).
--
-- SELECT indexname FROM pg_indexes
-- WHERE tablename = 'ae_tasks' AND indexname = 'idx_ae_tasks_office';
--   -- expect one row.
