-- ===========================================================================
-- salespeople.state_code — the AE's assigned state, used as Ask Smitty's
-- default state context for Coverage Intelligence lookups.
--
-- WHY
--   Ask Smitty (the Test-AE-only assistant) answers coverage/pricing questions
--   ONLY from the current, approved brochure for the AE's state. To do that it
--   needs to know which state an AE belongs to. `salespeople.location` is free
--   text and `cogent_territory` is a sales-territory label — neither is a clean
--   USPS state code, so we add an explicit, normalized column.
--
-- SHAPE
--   Nullable two-letter USPS code, stored UPPER (e.g. 'UT','TX','AZ','NV') so it
--   matches plan_brochures.state_code / the authoritative_* views exactly. NULL
--   means "no assigned state" — Ask Smitty then declines to answer coverage
--   questions (it never guesses a state) and asks an admin to set one.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + a named CHECK added only when absent.
-- Safe to re-run. Mirrors the additive style of salespeople_auth_columns.sql.
-- ===========================================================================

ALTER TABLE salespeople
  ADD COLUMN IF NOT EXISTS state_code TEXT;

-- Constrain to a normalized USPS code (or NULL). Added separately + guarded so
-- re-running doesn't error on the duplicate constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'salespeople_state_code_check'
  ) THEN
    ALTER TABLE salespeople
      ADD CONSTRAINT salespeople_state_code_check
      CHECK (
        state_code IS NULL
        OR (state_code = UPPER(state_code) AND char_length(state_code) = 2)
      );
  END IF;
END $$;

-- Assign the seeded Test AE a state so the first-state rollout works end to end.
-- Change 'UT' to whichever state's brochure is current + approved first. Only
-- the test account is touched; real AEs are assigned via a later admin action.
UPDATE salespeople
  SET state_code = 'UT'
  WHERE is_test = TRUE AND state_code IS NULL;
