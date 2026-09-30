BEGIN;

-- ===========================================================================
-- Manager 1:1 workspace v2.1 — the AE follow-up email stays editable AFTER a
-- 1:1 is completed. ADDITIVE on top of one_on_one_workspace_v2.sql (#49), which
-- is ALREADY APPLIED in production and is NOT edited: this is its own file.
-- ===========================================================================
-- THE RULE
--   A completed 1:1 stays frozen. The follow-up email is the ONE communication
--   artifact that may still be written, edited and regenerated afterwards.
--   Everything else — wins, notes (incl. Private Manager Notes), the activity
--   snapshot, commitments, goal history, completion stamps, status, the AE —
--   remains immutable exactly as before.
--
-- WHAT CHANGES
--   protect_completed_one_on_one_meeting() (installed by one_on_one_meetings.sql
--   §6, used by the BEFORE UPDATE OR DELETE trigger on one_on_one_meetings) used
--   to refuse EVERY change to a completed row. It now lets an UPDATE through
--   only when, after setting the email columns aside, NEW and OLD are
--   IDENTICAL:
--       to_jsonb(NEW) - <email columns>  =  to_jsonb(OLD) - <email columns>
--   Comparing whole rows (rather than listing the frozen columns) is
--   deliberate: a column added to the table in the future is frozen by
--   default, and "status stays completed", "completed_at/by unchanged",
--   "activity_snapshot unchanged" and "ae_id unchanged" all hold without
--   being spelled out one by one. DELETE is still refused outright.
--
--   The columns that may change after completion:
--     followup_subject, followup_subject_rev, followup_body, followup_body_rev,
--     followup_generated_at, followup_context_hash, followup_model
--     (the email text, its per-field revisions for compare-and-set, and the
--     generation metadata), plus updated_at (the table's own BEFORE UPDATE
--     trigger bumps it on every write; it is bookkeeping, not meeting
--     content — completed_at is NOT in this list and cannot move).
--
--   The one-in-progress-per-AE index, the lock_open_one_on_one_meeting()
--   protocol (completion vs. meeting-scoped writes), and the freeze triggers on
--   notes / commitment reviews / commitments are untouched. Email writes take
--   no meeting lock: they never read or write anything the completion snapshot
--   captures, and two writers of the email serialize on the row and compare
--   revisions in the application's single-statement UPDATE (CAS).
--
-- ACCESS MODEL — unchanged. RLS is enabled with ZERO policies on
-- one_on_one_meetings; the browser anon key can neither read nor write it. All
-- access is via /api/admin/* (service role behind requireAdmin()), and the
-- email routes write only the email columns.
--
-- Idempotent: CREATE OR REPLACE FUNCTION (the trigger is unchanged and keeps
-- pointing at it). Safe to re-run. Existing completed meetings are untouched;
-- their saved emails simply become editable.
-- ===========================================================================

CREATE OR REPLACE FUNCTION protect_completed_one_on_one_meeting()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  -- The ONLY columns an UPDATE of a completed meeting may change.
  email_columns CONSTANT TEXT[] := ARRAY[
    'followup_subject', 'followup_subject_rev',
    'followup_body', 'followup_body_rev',
    'followup_generated_at', 'followup_context_hash', 'followup_model',
    'updated_at'];
BEGIN
  IF OLD.status = 'completed' THEN
    IF TG_OP = 'UPDATE'
       AND (to_jsonb(NEW) - email_columns) = (to_jsonb(OLD) - email_columns) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'A completed 1:1 is read-only' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.ae_id <> OLD.ae_id THEN
    RAISE EXCEPTION 'A 1:1 cannot change AE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- (Re)assert the trigger so a database missing it (or pointing elsewhere) is
-- repaired; identical to one_on_one_meetings.sql.
DROP TRIGGER IF EXISTS trg_protect_completed_one_on_one_meeting ON one_on_one_meetings;
CREATE TRIGGER trg_protect_completed_one_on_one_meeting
  BEFORE UPDATE OR DELETE ON one_on_one_meetings
  FOR EACH ROW EXECUTE FUNCTION protect_completed_one_on_one_meeting();

COMMIT;


-- ===========================================================================
-- VERIFICATION (run after; all inside a transaction you roll back)
-- ===========================================================================
-- BEGIN;
--   -- pick any completed meeting
--   UPDATE one_on_one_meetings SET followup_body = 'x' WHERE id = '<completed id>';  -- succeeds
--   UPDATE one_on_one_meetings SET wins = 'x'          WHERE id = '<completed id>';  -- ERROR 23514
--   UPDATE one_on_one_meetings SET status = 'in_progress' WHERE id = '<completed id>'; -- ERROR 23514
--   DELETE FROM one_on_one_meetings WHERE id = '<completed id>';                      -- ERROR 23514
-- ROLLBACK;
-- ===========================================================================
