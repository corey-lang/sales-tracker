-- ===========================================================================
-- offices — Badger import fields (phone / email / external id).
-- ===========================================================================
-- WHAT THIS IS
--   Adds three nullable columns to `offices` so the Office Import surface
--   can persist the Badger Maps export shape directly:
--
--     * office_phone        TEXT NULL  — Badger's `_Phone`
--     * office_email        TEXT NULL  — Badger's `_Email`
--     * external_badger_id  TEXT NULL  — Badger's `_CustomerId`
--                                         (Badger-side UUID, opaque to us)
--
-- WHY ADDITIVE COLUMNS
--   `_Phone` / `_Email` had no schema home prior to this migration — the
--   import previously listed them in the "Recognized but not stored yet"
--   bucket and dropped the values. Office CRM work is upcoming and needs
--   these fields persisted from the source-of-truth import.
--
-- WHY external_badger_id IS NOT IN THE DEDUPE KEY (YET)
--   The current dedupe key is `normalize(name) | normalize(street) |
--   normalize(zip)` and the partial UNIQUE index in offices.sql keys
--   off that. external_badger_id would be a STRONGER per-(AE,env)
--   dedupe signal but switching is out of scope here — existing rows
--   would all dedupe-key-mismatch a re-import that started keying off
--   external_badger_id, producing duplicates instead of updates. A
--   later migration can promote it once we're ready to migrate.
--
--   For now we just store the value so a future migration has it to
--   work with, and so future surfaces (e.g. "open this office in
--   Badger") have the id at hand.
--
-- NO UNIQUE INDEX
--   We deliberately do NOT add a UNIQUE constraint on external_badger_id
--   in this migration. If the Badger export has any internal duplicates
--   (it occasionally does — same customer record exported twice from
--   different saved views), a UNIQUE would 23505 the second row and
--   surface as a confusing "Database insert failed for this row."
--   error rather than the intended "duplicate, updated in place"
--   behavior. We can revisit once the field is reliably unique upstream.
--
-- IDEMPOTENT
--   ADD COLUMN IF NOT EXISTS. Safe to re-run.
-- ===========================================================================

ALTER TABLE offices
  ADD COLUMN IF NOT EXISTS office_phone       TEXT,
  ADD COLUMN IF NOT EXISTS office_email       TEXT,
  ADD COLUMN IF NOT EXISTS external_badger_id TEXT;

-- ===========================================================================
-- VERIFICATION
-- ===========================================================================
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'offices'
--   AND column_name IN ('office_phone', 'office_email', 'external_badger_id')
-- ORDER BY column_name;
--   -- expect 3 rows, all data_type=text, is_nullable=YES.
