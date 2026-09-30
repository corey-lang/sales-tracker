BEGIN;

-- ===========================================================================
-- Manager 1:1 workspace v2 — Gold List management, notes rework, AE follow-up
-- email. ADDITIVE on top of one_on_one_meetings.sql (#47); nothing there is
-- edited, and no existing row changes.
-- ===========================================================================
-- WHAT THIS ADDS
--   1) NOTES. "1:1 Notes" is the existing `coaching_notes` column (its
--      meaning is unchanged — normal, shareable meeting notes — so every
--      earlier meeting's notes carry over untouched). `coaching_focus` is no
--      longer edited by the app but stays readable on old records.
--      NEW `private_notes` (+ `private_notes_rev`): the manager's PRIVATE
--      notes. Same table as the other meeting text, so they autosave with the
--      same per-field revision protocol, freeze with the meeting, and sit
--      behind the same RLS-with-no-policies posture. They are excluded from
--      the AI follow-up email by construction in the application (see
--      src/lib/server/followup-context.ts) — never by a flag.
--   2) AE FOLLOW-UP EMAIL. `followup_subject` / `followup_body` (each with its
--      own revision column, so the email autosaves and conflicts exactly like
--      the other fields), plus generation metadata: when it was generated, the
--      fingerprint of the shareable meeting content it was generated from
--      (`followup_context_hash` — how the UI notices "meeting details changed
--      since this email was generated"), and the model used. The FINAL edited
--      subject/body freezes with the meeting.
--   3) GOLD LIST MANAGEMENT INSIDE A 1:1. Managers may now also ADD an agent
--      to the AE's real Gold List and EDIT an agent's details from an
--      in-progress 1:1 (activities were already supported). Attribution
--      mirrors gold_list_activities: `created_in_meeting_id` /
--      `edited_in_meeting_id` (+ actor columns) on gold_list_agents, guarded by
--      a trigger that takes the SAME meeting lock as every other
--      meeting-scoped write. Completion snapshots `agent_added` /
--      `agent_edited` onto the meeting's Gold List note so a completed 1:1
--      still says "Added during this 1:1" after the live list changes.
--      complete_one_on_one_meeting() is replaced (CREATE OR REPLACE) with the
--      original body plus exactly those additions.
--   4) GOAL CHANGES made from the 1:1: `goal_changes` JSONB on the meeting.
--      update_weekly_goal_in_one_on_one() writes the LIVE weekly_goals row and
--      appends the history in ONE transaction, meeting lock first, so the two
--      can't diverge and a goal change can't slip past completion. Completion
--      (4-argument complete_one_on_one_meeting) verifies its activity snapshot
--      against the goal changes the meeting holds.
--
-- ACCESS MODEL — unchanged. RLS is already enabled with ZERO policies on
-- one_on_one_meetings / one_on_one_gold_list_notes; new columns inherit it, so
-- the browser anon key can neither read nor write any of this. All access is
-- via /api/admin/* (service role behind requireAdmin()).
--
-- DEPENDS ON  one_on_one_meetings.sql (#47) and gold_list.sql (#46).
-- Idempotent: ADD COLUMN IF NOT EXISTS, guarded constraint, CREATE OR REPLACE,
-- DROP TRIGGER IF EXISTS + CREATE TRIGGER. Safe to re-run.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1) one_on_one_meetings — private notes, follow-up email, goal changes
-- ---------------------------------------------------------------------------

ALTER TABLE one_on_one_meetings ADD COLUMN IF NOT EXISTS private_notes TEXT;
ALTER TABLE one_on_one_meetings ADD COLUMN IF NOT EXISTS private_notes_rev INTEGER NOT NULL DEFAULT 0;

ALTER TABLE one_on_one_meetings ADD COLUMN IF NOT EXISTS followup_subject TEXT;
ALTER TABLE one_on_one_meetings ADD COLUMN IF NOT EXISTS followup_subject_rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE one_on_one_meetings ADD COLUMN IF NOT EXISTS followup_body TEXT;
ALTER TABLE one_on_one_meetings ADD COLUMN IF NOT EXISTS followup_body_rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE one_on_one_meetings ADD COLUMN IF NOT EXISTS followup_generated_at TIMESTAMPTZ;
ALTER TABLE one_on_one_meetings ADD COLUMN IF NOT EXISTS followup_context_hash TEXT;
ALTER TABLE one_on_one_meetings ADD COLUMN IF NOT EXISTS followup_model TEXT;

-- Goal changes made from this 1:1: [{ "start": "this_week" | "next_week",
--   "effective_from": "yyyy-mm-dd", "values": { ... }, "at": "<iso>" }]
ALTER TABLE one_on_one_meetings ADD COLUMN IF NOT EXISTS goal_changes JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'one_on_one_meetings_v2_text_lengths'
  ) THEN
    ALTER TABLE one_on_one_meetings ADD CONSTRAINT one_on_one_meetings_v2_text_lengths CHECK (
      (private_notes IS NULL OR length(private_notes) <= 5000)
      AND (followup_subject IS NULL OR length(followup_subject) <= 300)
      AND (followup_body IS NULL OR length(followup_body) <= 10000)
    );
  END IF;
END$$;


-- ---------------------------------------------------------------------------
-- 2) one_on_one_gold_list_notes — snapshot flags
-- ---------------------------------------------------------------------------

ALTER TABLE one_on_one_gold_list_notes ADD COLUMN IF NOT EXISTS agent_added BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE one_on_one_gold_list_notes ADD COLUMN IF NOT EXISTS agent_edited BOOLEAN NOT NULL DEFAULT FALSE;


-- ---------------------------------------------------------------------------
-- 3) gold_list_agents — who added / edited an agent, and from which 1:1.
--    Nullable, no backfill, no FK (same reasoning as the activity columns:
--    an id must outlive a deleted row without firing an UPDATE on frozen
--    history; the trigger below validates meeting ids). NULL = the owning AE,
--    outside any 1:1 — every pre-existing and AE-made row.
-- ---------------------------------------------------------------------------

ALTER TABLE gold_list_agents ADD COLUMN IF NOT EXISTS created_by UUID;
ALTER TABLE gold_list_agents ADD COLUMN IF NOT EXISTS created_in_meeting_id UUID;
ALTER TABLE gold_list_agents ADD COLUMN IF NOT EXISTS edited_by UUID;
ALTER TABLE gold_list_agents ADD COLUMN IF NOT EXISTS edited_in_meeting_id UUID;
ALTER TABLE gold_list_agents ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_gold_list_agents_created_in_meeting
  ON gold_list_agents(created_in_meeting_id) WHERE created_in_meeting_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gold_list_agents_edited_in_meeting
  ON gold_list_agents(edited_in_meeting_id) WHERE edited_in_meeting_id IS NOT NULL;

-- Attribution to a 1:1 locks that meeting (lock_open_one_on_one_meeting,
-- section 7 of one_on_one_meetings.sql) and requires it to be an in-progress
-- 1:1 with the agent's own AE — the same protocol as every meeting-scoped
-- write, so an add/edit either commits before completion (and is in the
-- snapshot) or is refused (55P03 while completing, 23514 once completed).
-- `edited_at` is written fresh by every manager edit, so a repeat edit in the
-- same 1:1 re-checks the lock even though edited_in_meeting_id is unchanged.
-- Rows that don't touch these columns — every AE write — skip the lock.
CREATE OR REPLACE FUNCTION guard_gold_list_agent_meeting_attribution()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.created_in_meeting_id IS NOT NULL
     AND NEW.created_in_meeting_id IS DISTINCT FROM OLD.created_in_meeting_id THEN
    RAISE EXCEPTION 'Gold List 1:1 attribution is permanent' USING ERRCODE = '23514';
  END IF;
  IF NEW.created_in_meeting_id IS NOT NULL AND (
       TG_OP = 'INSERT' OR NEW.created_in_meeting_id IS DISTINCT FROM OLD.created_in_meeting_id) THEN
    PERFORM lock_open_one_on_one_meeting(NEW.created_in_meeting_id, NEW.salesperson_id);
  END IF;
  IF NEW.edited_in_meeting_id IS NOT NULL AND (
       TG_OP = 'INSERT'
       OR NEW.edited_in_meeting_id IS DISTINCT FROM OLD.edited_in_meeting_id
       OR NEW.edited_at IS DISTINCT FROM OLD.edited_at) THEN
    PERFORM lock_open_one_on_one_meeting(NEW.edited_in_meeting_id, NEW.salesperson_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_gold_list_agent_meeting_attribution ON gold_list_agents;
CREATE TRIGGER trg_guard_gold_list_agent_meeting_attribution
  BEFORE INSERT OR UPDATE ON gold_list_agents
  FOR EACH ROW EXECUTE FUNCTION guard_gold_list_agent_meeting_attribution();


-- ---------------------------------------------------------------------------
-- 4) update_weekly_goal_in_one_on_one — a goal change made from an in-progress
--    1:1: the LIVE weekly_goals write AND the meeting's goal-change history
--    in ONE transaction, serialized with completion.
--
--    LOCK ORDER (meeting first, like every other meeting-scoped write):
--      1. lock_open_one_on_one_meeting(): FOR KEY SHARE NOWAIT on the meeting
--         row; refuses unless it is still in_progress and this AE's.
--         Completion's FOR UPDATE conflicts with it, so whichever of the two
--         locks first wins: a goal change that got here first makes
--         completion WAIT for it (and completion then sees the change); one
--         that arrives while completion holds the row fails AT ONCE with
--         55P03 (it never waits while holding anything), and one that arrives
--         after completion committed sees 'completed' and fails 23514.
--         Either refusal rolls the whole call back — nothing is written.
--      2. the live weekly_goals row (UPDATE in place / INSERT).
--      3. the meeting row again (UPDATE goal_changes — FOR NO KEY UPDATE, an
--         upgrade of the KEY SHARE this transaction already holds; it
--         conflicts only with other writers of the same row, none of which
--         wait on weekly_goals).
--    Completion never touches weekly_goals, and no path takes a meeting row
--    lock while holding a weekly_goals lock, so there is no reverse order.
--
--    There is no state in which the live goal changed but the history did
--    not, or the reverse: a failure anywhere (including step 3) rolls back
--    step 2. The history entry is built HERE from the same inputs as the
--    write, so the two can't describe different goals.
--
--    This REPLACES record_one_on_one_goal_change (history-only, separate
--    transaction from the goal write — the race this function closes). An
--    earlier draft of this file may have created it; it is dropped so no
--    history-only path remains.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS record_one_on_one_goal_change(UUID, JSONB);

CREATE OR REPLACE FUNCTION update_weekly_goal_in_one_on_one(
  p_meeting_id UUID,
  p_ae_id UUID,
  p_start TEXT,
  p_effective_from DATE,
  p_values JSONB,
  p_created_by UUID
) RETURNS one_on_one_meetings
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  goal_keys CONSTANT TEXT[] := ARRAY[
    'office_visits', 'service_requests', 'ones_scheduled', 'ones_held',
    'presentations', 'impressions', 'team_meetings', 'gold_list_touches'];
  k TEXT;
  vals JSONB := '{}'::jsonb;
  existing_id UUID;
  m one_on_one_meetings;
BEGIN
  IF p_start IS NULL OR p_start NOT IN ('this_week', 'next_week') THEN
    RAISE EXCEPTION 'start must be this_week or next_week' USING ERRCODE = '22023';
  END IF;
  IF p_effective_from IS NULL OR p_ae_id IS NULL THEN
    RAISE EXCEPTION 'effective_from and ae are required' USING ERRCODE = '22004';
  END IF;
  IF p_values IS NULL OR jsonb_typeof(p_values) <> 'object' THEN
    RAISE EXCEPTION 'values must be an object' USING ERRCODE = '22023';
  END IF;
  FOREACH k IN ARRAY goal_keys LOOP
    IF jsonb_typeof(p_values -> k) IS DISTINCT FROM 'number'
       OR (p_values ->> k) !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'goal % must be a whole number >= 0', k USING ERRCODE = '22023';
    END IF;
    vals := vals || jsonb_build_object(k, (p_values ->> k)::int);
  END LOOP;

  -- 1) Meeting lock FIRST (see the lock order above).
  PERFORM lock_open_one_on_one_meeting(p_meeting_id, p_ae_id);

  -- 2) The live goal: update the AE's row at this Monday in place, else
  --    insert. A concurrent non-1:1 insert at the same Monday surfaces as
  --    23505 and rolls everything back (the route answers 409).
  SELECT id INTO existing_id
    FROM weekly_goals
   WHERE salesperson_id = p_ae_id AND effective_from = p_effective_from
   ORDER BY created_at DESC, id DESC
   LIMIT 1
     FOR UPDATE;
  IF existing_id IS NOT NULL THEN
    UPDATE weekly_goals
       SET created_by = p_created_by,
           office_visits = (vals ->> 'office_visits')::int,
           service_requests = (vals ->> 'service_requests')::int,
           ones_scheduled = (vals ->> 'ones_scheduled')::int,
           ones_held = (vals ->> 'ones_held')::int,
           presentations = (vals ->> 'presentations')::int,
           impressions = (vals ->> 'impressions')::int,
           team_meetings = (vals ->> 'team_meetings')::int,
           gold_list_touches = (vals ->> 'gold_list_touches')::int
     WHERE id = existing_id;
  ELSE
    INSERT INTO weekly_goals (
      salesperson_id, effective_from, created_by,
      office_visits, service_requests, ones_scheduled, ones_held,
      presentations, impressions, team_meetings, gold_list_touches)
    VALUES (
      p_ae_id, p_effective_from, p_created_by,
      (vals ->> 'office_visits')::int, (vals ->> 'service_requests')::int,
      (vals ->> 'ones_scheduled')::int, (vals ->> 'ones_held')::int,
      (vals ->> 'presentations')::int, (vals ->> 'impressions')::int,
      (vals ->> 'team_meetings')::int, (vals ->> 'gold_list_touches')::int);
  END IF;

  -- 3) The meeting's history, in the same transaction.
  UPDATE one_on_one_meetings
     SET goal_changes = goal_changes || jsonb_build_array(jsonb_build_object(
           'start', p_start,
           'effective_from', p_effective_from,
           'values', vals,
           'at', NOW()))
   WHERE id = p_meeting_id
  RETURNING * INTO m;
  RETURN m;
END;
$$;

REVOKE ALL ON FUNCTION update_weekly_goal_in_one_on_one(UUID, UUID, TEXT, DATE, JSONB, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION update_weekly_goal_in_one_on_one(UUID, UUID, TEXT, DATE, JSONB, UUID) FROM anon;
REVOKE ALL ON FUNCTION update_weekly_goal_in_one_on_one(UUID, UUID, TEXT, DATE, JSONB, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION update_weekly_goal_in_one_on_one(UUID, UUID, TEXT, DATE, JSONB, UUID) TO service_role;


-- ---------------------------------------------------------------------------
-- 5) complete_one_on_one_meeting — the original transaction plus: agents
--    added / edited in this 1:1 count as discussed, the note snapshot records
--    agent_added / agent_edited, and (new) the activity snapshot is verified
--    against the goal changes recorded on the meeting.
--
--    WHY A VERSION CHECK. The activity snapshot (Last Week / This Week vs the
--    goals that applied) is computed by the application BEFORE this function
--    runs, so it cannot be computed under the meeting lock. Goal changes made
--    from the 1:1 append to meetings.goal_changes atomically with the live
--    goal (section 4), so `jsonb_array_length(goal_changes)` is an exact
--    version of "which goal changes this meeting contains". The caller reads
--    that count BEFORE computing the snapshot and passes it as
--    p_goal_changes_seen. Under the FOR UPDATE lock (taken first, which also
--    waits out any goal change that already holds the meeting), the count is
--    compared; if a goal change landed in between, this raises 40001
--    (serialization_failure) WITHOUT changing anything and the caller
--    recomputes the snapshot and retries. So a completed meeting can never
--    hold goal-change history for a goal its frozen comparison did not use.
--    The check is UNCONDITIONAL: NULL is rejected (22004), so no caller can opt
--    out. The original 3-argument signature is kept below only as a wrapper
--    that passes 0 ("I saw no goal changes"): the already-deployed application
--    (which never writes goal_changes) keeps completing meetings that have
--    none, and is refused (40001, nothing changed) on any meeting that has.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION complete_one_on_one_meeting(
  p_meeting_id UUID,
  p_completed_by UUID,
  p_activity_snapshot JSONB,
  p_goal_changes_seen INTEGER
) RETURNS one_on_one_meetings
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  m one_on_one_meetings;
BEGIN
  SELECT * INTO m FROM one_on_one_meetings WHERE id = p_meeting_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '1:1 not found' USING ERRCODE = 'P0002';
  END IF;
  IF m.status = 'completed' THEN
    RETURN m;
  END IF;
  IF p_activity_snapshot IS NULL THEN
    RAISE EXCEPTION 'activity snapshot is required' USING ERRCODE = '22004';
  END IF;
  IF p_goal_changes_seen IS NULL THEN
    RAISE EXCEPTION 'p_goal_changes_seen is required' USING ERRCODE = '22004';
  END IF;
  IF jsonb_array_length(m.goal_changes) <> p_goal_changes_seen THEN
    RAISE EXCEPTION 'goal changes landed after the activity snapshot was computed'
      USING ERRCODE = '40001';
  END IF;

  -- Legacy Weekly Focus commitments are snapshotted in step 3 but aren't
  -- meeting rows, so hold them still for the rest of this transaction: a
  -- write from an old client waits and lands after completion (never inside
  -- the snapshot). Lock order is always meeting row → legacy rows, the same
  -- as update_legacy_commitment_in_one_on_one(), so the two can't deadlock.
  PERFORM 1 FROM one_on_one_commitments WHERE ae_id = m.ae_id FOR SHARE;

  -- 1) Agents acted on in this 1:1 (an activity action, or the agent itself
  --    added / edited by the manager) count as discussed.
  INSERT INTO one_on_one_gold_list_notes (meeting_id, ae_id, agent_id, agent_name, brokerage)
  SELECT m.id, m.ae_id, a.id, a.agent_name, a.brokerage
    FROM gold_list_agents a
   WHERE a.salesperson_id = m.ae_id
     AND (
       a.created_in_meeting_id = m.id
       OR a.edited_in_meeting_id = m.id
       OR EXISTS (
         SELECT 1 FROM gold_list_activities x
          WHERE x.agent_id = a.id
            AND (x.created_in_meeting_id = m.id
                 OR x.closed_in_meeting_id = m.id
                 OR x.rescheduled_in_meeting_id = m.id)))
  ON CONFLICT (meeting_id, agent_id) DO NOTHING;

  -- 2) Snapshot every discussed agent.
  UPDATE one_on_one_gold_list_notes AS n
     SET agent_name = COALESCE(s.agent_name, n.agent_name),
         brokerage = CASE WHEN s.agent_id IS NULL THEN n.brokerage ELSE s.brokerage END,
         last_activity_on = (s.last_at AT TIME ZONE 'America/Denver')::date,
         last_activity_description = s.last_description,
         next_activity_on = s.next_on,
         next_activity_description = s.next_description,
         activity_changes = COALESCE(s.changes, '[]'::jsonb),
         agent_added = COALESCE(s.added, FALSE),
         agent_edited = COALESCE(s.edited, FALSE),
         action_taken = COALESCE(jsonb_array_length(s.changes), 0) > 0
                        OR COALESCE(s.added, FALSE)
                        OR COALESCE(s.edited, FALSE),
         snapshot_taken_at = NOW()
    FROM (
      SELECT n2.id AS note_id,
             a.id AS agent_id, a.agent_name, a.brokerage,
             (a.created_in_meeting_id = m.id) AS added,
             (a.edited_in_meeting_id = m.id) AS edited,
             l.completed_at AS last_at, l.description AS last_description,
             x.scheduled_for AS next_on, x.description AS next_description,
             c.changes
        FROM one_on_one_gold_list_notes n2
        LEFT JOIN gold_list_agents a ON a.id = n2.agent_id
        LEFT JOIN LATERAL (
          SELECT completed_at, description FROM gold_list_activities
           WHERE agent_id = n2.agent_id AND status = 'completed'
           ORDER BY completed_at DESC LIMIT 1
        ) l ON TRUE
        LEFT JOIN LATERAL (
          SELECT scheduled_for, description FROM gold_list_activities
           WHERE agent_id = n2.agent_id AND status = 'scheduled'
           LIMIT 1
        ) x ON TRUE
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(ch - 'at' ORDER BY ch->>'at') AS changes FROM (
            SELECT jsonb_build_object(
                     'kind', 'scheduled', 'description', description,
                     'date', scheduled_for, 'at', created_at) AS ch
              FROM gold_list_activities
             WHERE agent_id = n2.agent_id AND created_in_meeting_id = m.id
            UNION ALL
            SELECT jsonb_build_object(
                     'kind', CASE WHEN status = 'completed' THEN 'completed' ELSE 'cancelled' END,
                     'description', description,
                     'date', CASE WHEN status = 'completed'
                                  THEN (completed_at AT TIME ZONE 'America/Denver')::date
                                  ELSE scheduled_for END,
                     'at', COALESCE(completed_at, updated_at))
              FROM gold_list_activities
             WHERE agent_id = n2.agent_id AND closed_in_meeting_id = m.id
            UNION ALL
            SELECT jsonb_build_object(
                     'kind', 'rescheduled', 'description', description,
                     'date', scheduled_for, 'at', updated_at)
              FROM gold_list_activities
             WHERE agent_id = n2.agent_id
               AND rescheduled_in_meeting_id = m.id
               AND created_in_meeting_id IS DISTINCT FROM m.id
               AND closed_in_meeting_id IS DISTINCT FROM m.id
          ) q
        ) c ON TRUE
       WHERE n2.meeting_id = m.id
    ) s
   WHERE n.id = s.note_id;

  -- 3) Frozen commitment reviews (rewritten from scratch each attempt).
  DELETE FROM one_on_one_commitment_reviews WHERE meeting_id = m.id;

  INSERT INTO one_on_one_commitment_reviews (
    meeting_id, commitment_id, legacy_commitment_id, origin,
    origin_meeting_date, description, owner, due_date, status, sort_order)
  SELECT m.id, c.id, NULL,
         CASE WHEN c.origin_meeting_id = m.id THEN 'new' ELSE 'carryover' END,
         om.meeting_date, c.description, c.owner, c.due_date, c.status,
         ROW_NUMBER() OVER (
           ORDER BY (c.origin_meeting_id = m.id), om.meeting_date, c.created_at, c.id)
    FROM one_on_one_meeting_commitments c
    JOIN one_on_one_meetings om ON om.id = c.origin_meeting_id
   WHERE c.ae_id = m.ae_id
     AND (c.origin_meeting_id = m.id
          OR c.status = 'open'
          OR c.resolved_in_meeting_id = m.id);

  INSERT INTO one_on_one_commitment_reviews (
    meeting_id, commitment_id, legacy_commitment_id, origin,
    origin_meeting_date, description, owner, due_date, status, sort_order)
  SELECT m.id, NULL, lc.id, 'carryover', w.week_start, lc.content, 'ae',
         lc.due_date, lc.status,
         100000 + ROW_NUMBER() OVER (ORDER BY lc.created_at, lc.id)
    FROM one_on_one_commitments lc
    LEFT JOIN one_on_ones w ON w.id = lc.one_on_one_id
   WHERE lc.ae_id = m.ae_id
     AND (lc.status = 'open' OR lc.updated_at >= m.started_at);

  -- 4) Flip — last, inside the same transaction.
  UPDATE one_on_one_meetings
     SET status = 'completed',
         completed_at = NOW(),
         completed_by = p_completed_by,
         activity_snapshot = p_activity_snapshot
   WHERE id = m.id
  RETURNING * INTO m;
  RETURN m;
END;
$$;

REVOKE ALL ON FUNCTION complete_one_on_one_meeting(UUID, UUID, JSONB, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_one_on_one_meeting(UUID, UUID, JSONB, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION complete_one_on_one_meeting(UUID, UUID, JSONB, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION complete_one_on_one_meeting(UUID, UUID, JSONB, INTEGER) TO service_role;

-- The ORIGINAL 3-argument signature (already deployed by one_on_one_meetings.sql
-- and called by the currently-deployed application) stays for rollout
-- compatibility, but it is NOT a way around the goal-change check: it asserts
-- "zero goal changes seen" (0, never NULL). The deployed application never
-- writes goal_changes, so for it this is a no-op; on a meeting that holds V2
-- goal history it fails with 40001 and changes nothing, rather than freezing
-- a snapshot that may predate those goals. The checked 4-argument function is
-- the only implementation; there is no path that skips the check.
CREATE OR REPLACE FUNCTION complete_one_on_one_meeting(
  p_meeting_id UUID,
  p_completed_by UUID,
  p_activity_snapshot JSONB
) RETURNS one_on_one_meetings
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  RETURN complete_one_on_one_meeting(
    p_meeting_id, p_completed_by, p_activity_snapshot, 0);
END;
$$;

REVOKE ALL ON FUNCTION complete_one_on_one_meeting(UUID, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_one_on_one_meeting(UUID, UUID, JSONB) FROM anon;
REVOKE ALL ON FUNCTION complete_one_on_one_meeting(UUID, UUID, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION complete_one_on_one_meeting(UUID, UUID, JSONB) TO service_role;

COMMIT;


-- ===========================================================================
-- VERIFICATION (run after)
-- ===========================================================================
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'one_on_one_meetings'
--    AND column_name IN ('private_notes','followup_subject','followup_body','goal_changes');   -- 4 rows
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'gold_list_agents'
--    AND column_name IN ('created_in_meeting_id','edited_in_meeting_id');                      -- 2 rows
-- SELECT count(*) FROM pg_policies WHERE tablename LIKE 'one_on_one_%';                        -- 0 (still server-only)
-- SELECT has_function_privilege('anon', 'update_weekly_goal_in_one_on_one(uuid,uuid,text,date,jsonb,uuid)', 'execute'); -- false
-- SELECT has_function_privilege('anon', 'complete_one_on_one_meeting(uuid,uuid,jsonb,integer)', 'execute');              -- false
-- SELECT count(*) FROM pg_proc WHERE proname = 'record_one_on_one_goal_change';                                          -- 0
-- ===========================================================================
