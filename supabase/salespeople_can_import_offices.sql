-- ===========================================================================
-- salespeople.can_import_offices — per-user permission for office imports.
-- ===========================================================================
-- WHAT THIS IS
--   A scoped permission flag on `salespeople`. Replaces the broad
--   `is_admin || role === 'assistant'` gate that office imports used in
--   the MVP, so we can grant import access to specific users (Tonja
--   first) without granting them every other admin/assistant capability
--   and without granting EVERY assistant the import permission.
--
-- DECISION TABLE — who can import offices going forward:
--   * is_admin = true              -> always allowed (admins bypass the flag)
--   * can_import_offices = true    -> allowed regardless of role
--   * everyone else                -> rejected (AEs, juice_box_only, plain
--                                     assistants without the flag)
--
-- WHY A COLUMN, NOT A PERMISSIONS TABLE
--   One permission for now. When/if a second scoped permission shows
--   up, we can either add another boolean column or migrate to a
--   `salesperson_permissions(salesperson_id, permission_name)` table.
--   A single column keeps SQL legible and avoids a join on every
--   session refresh. Easy to evolve later.
--
-- BACKFILL POLICY
--   * Default for ALL rows: FALSE (no implicit grants).
--   * Tonja gets TRUE here so her office-import access continues to work
--     after the MVP-wide gate narrows. Any other future grant is a
--     one-line UPDATE per user — no schema change.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + name-keyed UPDATE.
-- See supabase/README.md for migration order.
-- ===========================================================================

-- 1) Permission column. NOT NULL DEFAULT FALSE so legacy rows
--    immediately reflect the safe-default "no implicit access" stance.
ALTER TABLE salespeople
  ADD COLUMN IF NOT EXISTS can_import_offices BOOLEAN NOT NULL DEFAULT FALSE;

-- 2) Grant the permission to Tonja. first_name is CITEXT (case-
--    insensitive unique), so this matches regardless of casing in the
--    row. Safe to re-run — the UPDATE is a no-op when the value is
--    already TRUE.
UPDATE salespeople
   SET can_import_offices = TRUE
 WHERE first_name = 'Tonja';

-- ===========================================================================
-- VERIFICATION
-- ===========================================================================
-- -- Column exists and is non-nullable with the right default:
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_name = 'salespeople'
--    AND column_name = 'can_import_offices';
--   -- expect: boolean, NO, false
--
-- -- Tonja is the only granted user post-backfill:
-- SELECT first_name, role, is_admin, can_import_offices
--   FROM salespeople
--  WHERE can_import_offices = TRUE
--  ORDER BY first_name;
--   -- expect: exactly one row, Tonja.
--
-- -- Granting another user later (no schema change):
-- UPDATE salespeople SET can_import_offices = TRUE WHERE first_name = '<name>';
