BEGIN;

-- ===========================================================================
-- Road to 10,000 — the company goal: 10,000 Homescriptions sold in 2026.
-- ===========================================================================
-- WHAT THIS STORES
--   The CUMULATIVE number of Homescriptions sold, as of the moment it was
--   recorded — one row each time someone updates it. For V1 the number is typed
--   in by hand (from the Cogent Closed Transactions report); nobody enters daily
--   or weekly adds, only the running total. Everything on the card — percent,
--   Homescriptions to go, pace, required pace, projected finish — is computed
--   from the LATEST row by the application; nothing derived is stored.
--
-- THE DATA SOURCE CAN BE SWAPPED LATER
--   `source` says where a total came from ('manual' today). A future job that
--   reads the Cogent Closed Transactions total writes rows with source
--   'cogent_closed_transactions' through the same table; the UI and the pace math
--   only ever see "the latest total", so neither changes.
--
-- HISTORY IS THE AUDIT TRAIL — AND IS IMMUTABLE
--   Rows are append-only: UPDATE and DELETE are refused by trigger, for everyone
--   including the service role. "The current total" is simply the newest row.
--   There is no "overwrite": a mistake is fixed by recording a new, explicitly
--   flagged CORRECTION row, so what was believed at each point stays on record.
--
-- THE RULES (enforced in record_road_to_10000_total(), not just in the UI)
--   * the total is a whole number from 0 through 10,000 (also a table CHECK);
--   * it may not be LOWER than the current total — unless the entry is marked a
--     correction, which requires a short reason. Equal is fine ("re-checked, still
--     the same", which also refreshes "last updated");
--   * only an admin or the assistant (role 'admin' / 'assistant', active) may
--     record one — the function re-checks the actor itself, so the rule holds even
--     if an API route forgot;
--   * `p_expected_latest_id` is the id of the total the editing screen was
--     showing. If someone else recorded one meanwhile the save is refused (40001)
--     instead of landing on top of a number the editor never saw;
--   * recording is serialized with an advisory lock, so two people saving at the
--     same moment cannot both pass the "not lower" check against the same
--     predecessor.
--
-- ACCESS MODEL — server-only, like Gold List / Swag Leads: RLS is ENABLED with NO
-- policies and anon/authenticated have no grants. Reads and writes go through
-- /api/road-to-10000 (service role behind the session guard); the write function
-- is EXECUTE-granted to service_role only.
--
-- ADDITIVE and IDEMPOTENT: CREATE ... IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
-- DROP TRIGGER IF EXISTS. Safe to re-run; no existing table is touched and no row
-- is seeded (the card shows "no total recorded yet" until the first save).
-- ===========================================================================

CREATE TABLE IF NOT EXISTS road_to_10000_totals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Insertion order: "the latest" is the highest seq, never a timestamp tie-break.
  seq BIGINT GENERATED ALWAYS AS IDENTITY,
  goal_year INTEGER NOT NULL DEFAULT 2026 CHECK (goal_year BETWEEN 2000 AND 2100),
  -- Cumulative Homescriptions sold. 10,000 is the 2026 goal; a different goal is
  -- a new migration, not a silent edit.
  total INTEGER NOT NULL CHECK (total BETWEEN 0 AND 10000),
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'cogent_closed_transactions')),
  -- An explicit fix of an earlier value; the only way a total may go DOWN.
  is_correction BOOLEAN NOT NULL DEFAULT FALSE,
  note TEXT CHECK (note IS NULL OR char_length(note) <= 500),
  -- Who recorded it. The name is frozen so the trail reads correctly after a
  -- rename; no ON DELETE action (people are deactivated, never deleted).
  entered_by UUID NOT NULL REFERENCES salespeople(id) ON DELETE RESTRICT,
  entered_by_name TEXT NOT NULL,
  entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT road_to_10000_correction_needs_reason
    CHECK (NOT is_correction OR (note IS NOT NULL AND btrim(note) <> ''))
);

CREATE INDEX IF NOT EXISTS idx_road_to_10000_totals_latest
  ON road_to_10000_totals(goal_year, seq DESC);

-- Append-only: no edits, no deletes.
CREATE OR REPLACE FUNCTION road_to_10000_totals_are_immutable()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'Road to 10,000 history is immutable' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS trg_road_to_10000_totals_immutable ON road_to_10000_totals;
CREATE TRIGGER trg_road_to_10000_totals_immutable
  BEFORE UPDATE OR DELETE ON road_to_10000_totals
  FOR EACH ROW EXECUTE FUNCTION road_to_10000_totals_are_immutable();

ALTER TABLE road_to_10000_totals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON road_to_10000_totals FROM anon, authenticated;


-- ---------------------------------------------------------------------------
-- record_road_to_10000_total — the ONE write path
--   Error codes: 42501 not allowed · 40001 stale (someone recorded since the
--   editor loaded) · 23514 lower than the current total and not a correction ·
--   22023 invalid input · 22004 missing input.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION record_road_to_10000_total(
  p_actor UUID,
  p_total INTEGER,
  p_is_correction BOOLEAN,
  p_note TEXT,
  p_expected_latest_id UUID,
  p_goal_year INTEGER DEFAULT 2026
) RETURNS road_to_10000_totals
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_role TEXT;
  v_deactivated TIMESTAMPTZ;
  v_name TEXT;
  latest road_to_10000_totals;
  created road_to_10000_totals;
  v_note TEXT := NULLIF(btrim(p_note), '');
BEGIN
  -- Who: an active admin or the assistant. Re-read here, never trusted.
  SELECT role, deactivated_at, first_name::text
    INTO v_role, v_deactivated, v_name
    FROM salespeople WHERE id = p_actor;
  IF NOT FOUND OR v_deactivated IS NOT NULL OR v_role NOT IN ('admin', 'assistant') THEN
    RAISE EXCEPTION 'Only an admin or the assistant can update the Road to 10,000 total'
      USING ERRCODE = '42501';
  END IF;

  IF p_total IS NULL THEN
    RAISE EXCEPTION 'A total is required' USING ERRCODE = '22004';
  END IF;
  IF p_total < 0 OR p_total > 10000 THEN
    RAISE EXCEPTION 'The total must be a whole number from 0 to 10,000' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_is_correction, FALSE) AND v_note IS NULL THEN
    RAISE EXCEPTION 'Add a short reason for the correction' USING ERRCODE = '22023';
  END IF;

  -- Serialize recorders for this goal year: the "not lower" check below must see
  -- the row any concurrent save is about to add.
  PERFORM pg_advisory_xact_lock(hashtext('road_to_10000:' || p_goal_year::text));

  SELECT * INTO latest FROM road_to_10000_totals
   WHERE goal_year = p_goal_year ORDER BY seq DESC LIMIT 1;

  -- Stale screen: the editor must have been looking at the CURRENT total.
  IF p_expected_latest_id IS DISTINCT FROM latest.id THEN
    RAISE EXCEPTION 'The total was updated by someone else' USING ERRCODE = '40001';
  END IF;

  IF latest.id IS NOT NULL AND p_total < latest.total AND NOT COALESCE(p_is_correction, FALSE) THEN
    RAISE EXCEPTION 'That is lower than the current total (%). If you are correcting a mistake, mark it as a correction.',
      latest.total USING ERRCODE = '23514';
  END IF;

  INSERT INTO road_to_10000_totals (goal_year, total, is_correction, note, entered_by, entered_by_name)
  VALUES (p_goal_year, p_total, COALESCE(p_is_correction, FALSE), v_note, p_actor, v_name)
  RETURNING * INTO created;
  RETURN created;
END;
$$;

REVOKE ALL ON FUNCTION record_road_to_10000_total(UUID, INTEGER, BOOLEAN, TEXT, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_road_to_10000_total(UUID, INTEGER, BOOLEAN, TEXT, UUID, INTEGER) TO service_role;

COMMIT;


-- ===========================================================================
-- VERIFICATION (run after)
-- ===========================================================================
-- SELECT relname, relrowsecurity FROM pg_class WHERE relname = 'road_to_10000_totals';  -- true
-- SELECT count(*) FROM pg_policies WHERE tablename = 'road_to_10000_totals';            -- 0
-- SELECT has_function_privilege('anon',
--   'record_road_to_10000_total(uuid,integer,boolean,text,uuid,integer)', 'execute');  -- false
-- SELECT count(*) FROM road_to_10000_totals;                                             -- 0 until the first save
-- ===========================================================================
