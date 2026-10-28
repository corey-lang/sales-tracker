-- ===========================================================================
-- Ownership-transfer provenance — who owned an office / Gold List agent BEFORE.
-- ===========================================================================
-- WHY THIS EXISTS
--   `offices.salesperson_id` and `gold_list_agents.salesperson_id` are
--   OPERATIONAL ownership: when an AE leaves, a replacement can inherit their
--   book. Re-pointing the column answers "who owns it now" but ERASES "who
--   owned it before" — nothing on those rows records it (office_visits keeps its
--   own salesperson_id per visit, but the office row itself does not). The
--   README's offboarding section requires this provenance to exist BEFORE the
--   first transfer, because backfilling it afterwards is guesswork.
--
-- WHAT IT ADDS (both tables, identical)
--   transferred_from_salesperson_id UUID  — the previous owner, set only when a
--                                           transfer script moves the row.
--   transferred_at                  TIMESTAMPTZ — when that happened.
--   Both stay NULL for every row that has never been transferred (i.e. every
--   row today), and for any row a person created themselves.
--
-- FOREIGN KEY: ON DELETE SET NULL
--   A salesperson row is never deleted in normal operation (offboarding is a
--   soft-disable), so this never fires. If it ever did, losing the provenance
--   pointer must not block or cascade into the office / agent it describes.
--
-- WHAT IT DOES NOT TOUCH
--   No row is read, moved or rewritten. No default, no backfill, no constraint
--   change on any existing column, no index change, no RLS / grant change (the
--   tables' existing access rules apply to the new columns unchanged). The
--   offices dedupe unique index and the gold_list_agents (id, salesperson_id)
--   key are not modified.
--
-- DEPLOY ORDER
--   Apply BEFORE `transfer_james_dfw_west_to_kimberlee.sql` (which writes these
--   columns). No application code reads them yet, so this can be applied at any
--   time without affecting the running app. Additive and idempotent.
-- See supabase/README.md for migration order.
-- ===========================================================================

ALTER TABLE offices
  ADD COLUMN IF NOT EXISTS transferred_from_salesperson_id UUID
    REFERENCES salespeople(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS transferred_at TIMESTAMPTZ;

ALTER TABLE gold_list_agents
  ADD COLUMN IF NOT EXISTS transferred_from_salesperson_id UUID
    REFERENCES salespeople(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS transferred_at TIMESTAMPTZ;
