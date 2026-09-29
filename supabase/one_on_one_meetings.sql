BEGIN;

-- ===========================================================================
-- Manager 1:1 meetings — irregular, completable 1:1 records (manager-only).
-- ===========================================================================
-- WHAT THIS IS
--   The Weekly Focus page becomes a 1:1 WORKSPACE: the manager starts a 1:1
--   with an AE, works through Wins → Activity & Results → Gold List →
--   Coaching → Commitments, and completes it. A completed 1:1 is a durable,
--   read-only historical record.
--
--   1:1s are NOT week-scoped. They can happen weekly, biweekly, or whenever,
--   so this is a NEW table rather than another lifecycle on `one_on_ones`,
--   whose `(ae_id, week_start)` unique index and NOT NULL `week_start` encode
--   "exactly one row per business week". `one_on_ones` and everything hanging
--   off it (commitments, private notes, coaching_relationships,
--   training_commitments) are LEFT EXACTLY AS THEY ARE — this migration does
--   not alter, move, or delete a single legacy row.
--
-- TABLES
--   * one_on_one_meetings            — the meeting. `status` is 'in_progress'
--                                      (a draft that autosaves) or
--                                      'completed' (frozen). At most ONE
--                                      in-progress meeting per AE, enforced
--                                      by a partial unique index, so a double
--                                      tap on "Start 1:1" or a refresh can
--                                      never fork a second draft.
--   * one_on_one_gold_list_notes     — one row per (meeting, Gold List agent)
--                                      discussed: the manager's discussion
--                                      note plus a LIGHT snapshot of the
--                                      agent taken at completion. It REFERENCES
--                                      the live `gold_list_agents` row; it is
--                                      not a second Gold List.
--   * one_on_one_meeting_commitments — LIVE commitments/follow-ups. Each keeps
--                                      the meeting it came from
--                                      (`origin_meeting_id`) and, once closed
--                                      as carryover, the meeting that resolved
--                                      it (`resolved_in_meeting_id`). Open
--                                      rows surface automatically in the next
--                                      1:1.
--   * one_on_one_commitment_reviews  — FROZEN per-meeting copy of each
--                                      commitment's wording + status as of
--                                      that meeting's completion. This is what
--                                      history renders, so completing a
--                                      carryover next month never rewrites
--                                      what an older meeting recorded.
--
-- LIVE vs. HISTORICAL
--   Live operational data (activity_entries, weekly_goals, gold_list_*) keeps
--   changing. A completed meeting must not. So at completion the server
--   writes:
--     * `activity_snapshot` — the Last Week / This Week comparison exactly as
--       reviewed: per-activity actual, adjusted goal, original goal, %, the
--       weekly scores, and the week windows. JSONB on purpose: it is a
--       frozen computed report that is only ever read whole, never filtered
--       or joined, and splitting it into a 2 × 8 × 4 cell table would add a
--       table without adding a single query it could answer.
--     * the Gold List note snapshots and the commitment reviews (relational).
--   and flips `status` to 'completed' — all inside ONE database transaction
--   (complete_one_on_one_meeting, section 8) holding a lock on the meeting
--   row. Every meeting-scoped write takes the same lock (section 7), so
--   nothing can slip into a meeting after its snapshot. Triggers reject any
--   later change to a completed meeting or its notes/reviews.
--
-- ACCESS MODEL — server-only, same posture as manager_one_on_ones.sql (#19)
--   RLS ENABLED with ZERO policies on every table: the browser anon key can
--   neither read nor write. Every access goes through /api/admin/* routes that
--   run with the service-role key behind requireAdmin().
--
-- ALSO: Gold List actor + meeting-attribution columns
--   Managers may now add/complete/reschedule an AE's Gold List activities
--   from inside an in-progress 1:1. `gold_list_activities.created_by` /
--   `completed_by` record WHO did it; `created_in_meeting_id` /
--   `closed_in_meeting_id` / `rescheduled_in_meeting_id` record WHICH 1:1 it
--   was done from (section 5). All nullable, no backfill, no FK. NULL means
--   "the owning AE, outside any 1:1" — every pre-existing and AE-made row.
--
-- DEPENDS ON
--   schema.sql (salespeople) and gold_list.sql (#46). Independent of the
--   coaching chain (#19–#21), which it does not touch.
--
-- Idempotent: CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS + CREATE TRIGGER,
-- guarded constraints. Additive only. Safe to re-run.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1) one_on_one_meetings
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS one_on_one_meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT, not CASCADE: 1:1 history must never disappear as a side effect.
  -- People who leave are soft-disabled with salespeople.deactivated_at (#43).
  ae_id UUID NOT NULL REFERENCES salespeople(id) ON DELETE RESTRICT,
  manager_id UUID REFERENCES salespeople(id) ON DELETE SET NULL,
  -- Display names captured when the meeting starts, so the record still
  -- reads correctly if a name is edited or a row is later removed.
  ae_name TEXT,
  manager_name TEXT,
  -- America/Denver calendar date the meeting was held.
  meeting_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'completed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES salespeople(id) ON DELETE SET NULL,
  wins TEXT,
  activity_notes TEXT,
  coaching_focus TEXT,
  coaching_notes TEXT,
  -- Frozen Last Week / This Week comparison. Written once, at completion.
  activity_snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT one_on_one_meetings_completion_consistent CHECK (
    (status = 'completed' AND completed_at IS NOT NULL AND activity_snapshot IS NOT NULL)
    OR (status = 'in_progress' AND completed_at IS NULL)
  ),
  CONSTRAINT one_on_one_meetings_text_lengths CHECK (
    (wins IS NULL OR length(wins) <= 5000)
    AND (activity_notes IS NULL OR length(activity_notes) <= 5000)
    AND (coaching_focus IS NULL OR length(coaching_focus) <= 300)
    AND (coaching_notes IS NULL OR length(coaching_notes) <= 5000)
  )
);

-- THE no-duplicate-drafts rule: one in-progress meeting per AE. "Start 1:1"
-- inserts; a 23505 here means one already exists and the server resumes it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_on_one_meetings_one_in_progress
  ON one_on_one_meetings(ae_id)
  WHERE status = 'in_progress';

-- Hot path: "last completed 1:1" + the newest-first history list.
CREATE INDEX IF NOT EXISTS idx_one_on_one_meetings_ae_completed
  ON one_on_one_meetings(ae_id, completed_at DESC)
  WHERE status = 'completed';


-- ---------------------------------------------------------------------------
-- 2) one_on_one_gold_list_notes — agents discussed in a meeting
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS one_on_one_gold_list_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID NOT NULL REFERENCES one_on_one_meetings(id) ON DELETE CASCADE,
  ae_id UUID NOT NULL REFERENCES salespeople(id) ON DELETE RESTRICT,
  -- Reference to the LIVE agent. SET NULL (not CASCADE) so a draft's note
  -- survives a hard delete of the agent. For a COMPLETED meeting the SET NULL
  -- is itself an UPDATE the freeze trigger refuses, so an agent discussed in a
  -- completed 1:1 can only be archived (the Gold List's normal path), never
  -- hard-deleted — history wins.
  agent_id UUID REFERENCES gold_list_agents(id) ON DELETE SET NULL,
  -- Manager-only discussion note for THIS meeting. Distinct from the Gold
  -- List's own notes (agent notes, activity plan note, outcome note).
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  -- Set at completion: true when a Gold List action for this agent was
  -- explicitly attributed to this meeting (*_in_meeting_id, section 5), so
  -- it counts as "discussed" even with no note.
  action_taken BOOLEAN NOT NULL DEFAULT FALSE,
  -- Light snapshot, refreshed at completion.
  agent_name TEXT NOT NULL,
  brokerage TEXT,
  last_activity_on DATE,
  last_activity_description TEXT,
  next_activity_on DATE,
  next_activity_description TEXT,
  -- Gold List actions attributed to this meeting, frozen for display:
  -- [{ "kind": "completed" | "scheduled" | "rescheduled" | "cancelled",
  --    "description": "...", "date": "yyyy-mm-dd" }]
  activity_changes JSONB NOT NULL DEFAULT '[]'::jsonb,
  snapshot_taken_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT one_on_one_gold_list_notes_meeting_agent_key
    UNIQUE (meeting_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_one_on_one_gold_list_notes_meeting
  ON one_on_one_gold_list_notes(meeting_id);


-- ---------------------------------------------------------------------------
-- 3) one_on_one_meeting_commitments — live commitments with carryover
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS one_on_one_meeting_commitments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ae_id UUID NOT NULL REFERENCES salespeople(id) ON DELETE RESTRICT,
  -- The meeting the commitment was made in. Permanent provenance.
  origin_meeting_id UUID NOT NULL
    REFERENCES one_on_one_meetings(id) ON DELETE RESTRICT,
  description TEXT NOT NULL
    CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  owner TEXT NOT NULL DEFAULT 'ae' CHECK (owner IN ('ae', 'manager')),
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'completed', 'dropped')),
  completed_at TIMESTAMPTZ,
  -- The LATER meeting in which a carryover commitment was closed out. Null
  -- while open, and for items closed in the meeting that created them.
  resolved_in_meeting_id UUID
    REFERENCES one_on_one_meetings(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT one_on_one_meeting_commitments_completed_at_matches CHECK (
    (status = 'completed' AND completed_at IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL)
  )
);

-- Hot path: open carryover for one AE.
CREATE INDEX IF NOT EXISTS idx_one_on_one_meeting_commitments_ae_status
  ON one_on_one_meeting_commitments(ae_id, status);

CREATE INDEX IF NOT EXISTS idx_one_on_one_meeting_commitments_origin
  ON one_on_one_meeting_commitments(origin_meeting_id);


-- ---------------------------------------------------------------------------
-- 4) one_on_one_commitment_reviews — frozen per-meeting commitment state
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS one_on_one_commitment_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID NOT NULL REFERENCES one_on_one_meetings(id) ON DELETE CASCADE,
  -- Exactly one of these two is set: a 1:1 commitment, or a legacy Weekly
  -- Focus commitment (one_on_one_commitments) reviewed as carryover. No FK on
  -- either — the review must outlive its source row.
  commitment_id UUID,
  legacy_commitment_id UUID,
  -- 'new' = created in this meeting; 'carryover' = came in open from before.
  origin TEXT NOT NULL CHECK (origin IN ('new', 'carryover')),
  origin_meeting_date DATE,
  description TEXT NOT NULL,
  owner TEXT NOT NULL CHECK (owner IN ('ae', 'manager')),
  due_date DATE,
  status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'dropped')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT one_on_one_commitment_reviews_one_source CHECK (
    (commitment_id IS NOT NULL) <> (legacy_commitment_id IS NOT NULL)
  ),
  CONSTRAINT one_on_one_commitment_reviews_meeting_commitment_key
    UNIQUE (meeting_id, commitment_id),
  CONSTRAINT one_on_one_commitment_reviews_meeting_legacy_key
    UNIQUE (meeting_id, legacy_commitment_id)
);

CREATE INDEX IF NOT EXISTS idx_one_on_one_commitment_reviews_meeting
  ON one_on_one_commitment_reviews(meeting_id);


-- ---------------------------------------------------------------------------
-- 5) Gold List actor + meeting-attribution columns. Nullable, no backfill,
--    no FK (an id must outlive a deleted row without firing an UPDATE on a
--    frozen history row; the guard trigger below validates meeting ids).
--
--    Manager actions taken FROM a 1:1 are attributed EXPLICITLY, in the same
--    statement as the Gold List change itself:
--      created_in_meeting_id     — scheduled from that 1:1
--      closed_in_meeting_id      — completed or cancelled from that 1:1
--      rescheduled_in_meeting_id — edited/rescheduled from that 1:1
--    The completion snapshot reads ONLY these columns, so an AE's own Gold
--    List activity while a draft happens to be open is never attributed to
--    the 1:1. AE writes never set them and never take the meeting lock.
-- ---------------------------------------------------------------------------

ALTER TABLE gold_list_activities ADD COLUMN IF NOT EXISTS created_by UUID;
ALTER TABLE gold_list_activities ADD COLUMN IF NOT EXISTS completed_by UUID;
ALTER TABLE gold_list_activities ADD COLUMN IF NOT EXISTS created_in_meeting_id UUID;
ALTER TABLE gold_list_activities ADD COLUMN IF NOT EXISTS closed_in_meeting_id UUID;
ALTER TABLE gold_list_activities ADD COLUMN IF NOT EXISTS rescheduled_in_meeting_id UUID;

CREATE INDEX IF NOT EXISTS idx_gold_list_activities_created_in_meeting
  ON gold_list_activities(created_in_meeting_id)
  WHERE created_in_meeting_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gold_list_activities_closed_in_meeting
  ON gold_list_activities(closed_in_meeting_id)
  WHERE closed_in_meeting_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gold_list_activities_rescheduled_in_meeting
  ON gold_list_activities(rescheduled_in_meeting_id)
  WHERE rescheduled_in_meeting_id IS NOT NULL;

-- Optimistic concurrency for draft text (two tabs / devices on one draft).
-- One revision PER FIELD, so saving Wins never conflicts with a concurrent
-- save of Coaching notes. A save names the revision it was based on and
-- only lands if that is still current (see PATCH /one-on-one-meetings/[id]
-- and PUT …/gold-list/[agentId]); a stale save gets a 409 instead of
-- silently replacing newer text.
ALTER TABLE one_on_one_meetings ADD COLUMN IF NOT EXISTS wins_rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE one_on_one_meetings ADD COLUMN IF NOT EXISTS activity_notes_rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE one_on_one_meetings ADD COLUMN IF NOT EXISTS coaching_focus_rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE one_on_one_meetings ADD COLUMN IF NOT EXISTS coaching_notes_rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE one_on_one_gold_list_notes ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;

-- Stable display order for a meeting's frozen commitment reviews.
ALTER TABLE one_on_one_commitment_reviews
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;


-- ---------------------------------------------------------------------------
-- 6) updated_at maintenance — self-contained, like gold_list.sql.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_one_on_one_meeting_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_one_on_one_meetings_updated_at ON one_on_one_meetings;
CREATE TRIGGER trg_one_on_one_meetings_updated_at
  BEFORE UPDATE ON one_on_one_meetings
  FOR EACH ROW EXECUTE FUNCTION set_one_on_one_meeting_updated_at();

DROP TRIGGER IF EXISTS trg_one_on_one_gold_list_notes_updated_at ON one_on_one_gold_list_notes;
CREATE TRIGGER trg_one_on_one_gold_list_notes_updated_at
  BEFORE UPDATE ON one_on_one_gold_list_notes
  FOR EACH ROW EXECUTE FUNCTION set_one_on_one_meeting_updated_at();

DROP TRIGGER IF EXISTS trg_one_on_one_meeting_commitments_updated_at ON one_on_one_meeting_commitments;
CREATE TRIGGER trg_one_on_one_meeting_commitments_updated_at
  BEFORE UPDATE ON one_on_one_meeting_commitments
  FOR EACH ROW EXECUTE FUNCTION set_one_on_one_meeting_updated_at();


-- ---------------------------------------------------------------------------
-- 7) Meeting lifecycle guards — immutability AND serialization.
--
--    THE LOCK PROTOCOL
--      Every meeting-scoped write (discussion notes, commitment reviews,
--      commitments made/resolved/reopened/deleted in a meeting, and manager
--      Gold List actions attributed to a meeting) passes through
--      lock_open_one_on_one_meeting(), which takes FOR KEY SHARE NOWAIT on
--      the meeting row and refuses unless the meeting is in progress.
--      Completion (complete_one_on_one_meeting, section 8) takes FOR UPDATE
--      on the same row before reading anything. So, under concurrency:
--        * a write that locked first commits first, and completion (which
--          waits for it) then sees it — it lands IN the snapshot;
--        * a write that arrives while completion holds the row fails at once
--          (55P03, lock_not_available) and one that arrives after completion
--          committed re-reads the row as 'completed' (23514). Both are a 409.
--      Nothing can commit "inside" a meeting after its snapshot was taken,
--      whatever the API layer checked earlier.
--
--    WHY KEY SHARE + NOWAIT
--      * FOR KEY SHARE conflicts only with FOR UPDATE, i.e. with completion.
--        Draft autosaves UPDATE the meeting row (FOR NO KEY UPDATE), which
--        is compatible, so a note save never waits on a field save.
--      * NOWAIT: a child write already holds its own row's lock when its
--        BEFORE trigger runs (e.g. a note upsert that hit an existing row),
--        while completion holds the meeting and needs that note row. Waiting
--        here would deadlock; failing fast releases the row immediately.
--      Plain AE Gold List writes never name a meeting and never take this
--      lock.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION lock_open_one_on_one_meeting(
  p_meeting_id UUID,
  p_ae_id UUID,
  p_allow_missing BOOLEAN DEFAULT FALSE
) RETURNS VOID LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  m_status TEXT;
  m_ae UUID;
BEGIN
  SELECT status, ae_id INTO m_status, m_ae
    FROM one_on_one_meetings WHERE id = p_meeting_id FOR KEY SHARE NOWAIT;
  IF NOT FOUND THEN
    -- A cascade from deleting an in-progress meeting reaches its children
    -- after the parent row is gone; nothing to protect in that case.
    IF p_allow_missing THEN RETURN; END IF;
    RAISE EXCEPTION 'Unknown 1:1' USING ERRCODE = '23503';
  END IF;
  IF m_status <> 'in_progress' THEN
    RAISE EXCEPTION 'A completed 1:1 is read-only' USING ERRCODE = '23514';
  END IF;
  IF p_ae_id IS NOT NULL AND m_ae <> p_ae_id THEN
    RAISE EXCEPTION 'Row does not belong to this 1:1''s AE' USING ERRCODE = '23514';
  END IF;
END;
$$;

-- The meeting row itself: a completed meeting can't be edited, reopened, or
-- deleted, and no meeting can change AE.
CREATE OR REPLACE FUNCTION protect_completed_one_on_one_meeting()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.status = 'completed' THEN
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

DROP TRIGGER IF EXISTS trg_protect_completed_one_on_one_meeting ON one_on_one_meetings;
CREATE TRIGGER trg_protect_completed_one_on_one_meeting
  BEFORE UPDATE OR DELETE ON one_on_one_meetings
  FOR EACH ROW EXECUTE FUNCTION protect_completed_one_on_one_meeting();

-- Children frozen with their meeting (discussion notes, commitment reviews).
-- On UPDATE BOTH parents are checked: the row's current (OLD) meeting must be
-- open, and a row can't be moved at all — so nothing can leave a completed
-- meeting, and nothing can be moved into one.
CREATE OR REPLACE FUNCTION protect_completed_one_on_one_children()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM lock_open_one_on_one_meeting(NEW.meeting_id, NULL);
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM lock_open_one_on_one_meeting(OLD.meeting_id, NULL, TRUE);
    RETURN OLD;
  END IF;
  PERFORM lock_open_one_on_one_meeting(OLD.meeting_id, NULL);
  IF NEW.meeting_id IS DISTINCT FROM OLD.meeting_id THEN
    PERFORM lock_open_one_on_one_meeting(NEW.meeting_id, NULL);
    RAISE EXCEPTION 'A 1:1 record row cannot be moved to another 1:1'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_completed_one_on_one_gold_list_notes ON one_on_one_gold_list_notes;
CREATE TRIGGER trg_protect_completed_one_on_one_gold_list_notes
  BEFORE INSERT OR UPDATE OR DELETE ON one_on_one_gold_list_notes
  FOR EACH ROW EXECUTE FUNCTION protect_completed_one_on_one_children();

DROP TRIGGER IF EXISTS trg_protect_completed_one_on_one_commitment_reviews ON one_on_one_commitment_reviews;
CREATE TRIGGER trg_protect_completed_one_on_one_commitment_reviews
  BEFORE INSERT OR UPDATE OR DELETE ON one_on_one_commitment_reviews
  FOR EACH ROW EXECUTE FUNCTION protect_completed_one_on_one_children();

-- Live commitments. Not frozen wholesale (a commitment made in a completed
-- 1:1 must stay closable in a later one), but every change is scoped to the
-- meeting it happens IN, which must be open:
--   * made / deleted          -> its origin meeting;
--   * reworded (description, owner, due date) -> its origin meeting;
--   * closed (completed/dropped) -> the resolving meeting
--                                   (resolved_in, else origin);
--   * reopened or re-resolved  -> the meeting that had closed it.
-- Provenance (origin meeting, AE) is immutable.
CREATE OR REPLACE FUNCTION guard_one_on_one_meeting_commitment()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM lock_open_one_on_one_meeting(NEW.origin_meeting_id, NEW.ae_id);
    IF NEW.resolved_in_meeting_id IS NOT NULL THEN
      PERFORM lock_open_one_on_one_meeting(NEW.resolved_in_meeting_id, NEW.ae_id);
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM lock_open_one_on_one_meeting(OLD.origin_meeting_id, OLD.ae_id);
    RETURN OLD;
  END IF;

  IF NEW.origin_meeting_id <> OLD.origin_meeting_id OR NEW.ae_id <> OLD.ae_id THEN
    RAISE EXCEPTION 'A commitment''s origin 1:1 and AE are permanent'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.description IS DISTINCT FROM OLD.description
     OR NEW.owner IS DISTINCT FROM OLD.owner
     OR NEW.due_date IS DISTINCT FROM OLD.due_date THEN
    PERFORM lock_open_one_on_one_meeting(OLD.origin_meeting_id, OLD.ae_id);
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.resolved_in_meeting_id IS DISTINCT FROM OLD.resolved_in_meeting_id THEN
    IF OLD.status <> 'open' THEN
      PERFORM lock_open_one_on_one_meeting(
        COALESCE(OLD.resolved_in_meeting_id, OLD.origin_meeting_id), OLD.ae_id);
    END IF;
    IF NEW.status <> 'open' THEN
      PERFORM lock_open_one_on_one_meeting(
        COALESCE(NEW.resolved_in_meeting_id, NEW.origin_meeting_id), NEW.ae_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_one_on_one_meeting_commitment ON one_on_one_meeting_commitments;
CREATE TRIGGER trg_guard_one_on_one_meeting_commitment
  BEFORE INSERT OR UPDATE OR DELETE ON one_on_one_meeting_commitments
  FOR EACH ROW EXECUTE FUNCTION guard_one_on_one_meeting_commitment();

-- Gold List meeting attribution: setting (or changing) any *_in_meeting_id
-- locks that meeting and requires it to be an in-progress 1:1 with the
-- activity's own AE. Attribution is permanent once set. Rows that don't touch
-- these columns — every AE write — skip the lock entirely.
CREATE OR REPLACE FUNCTION guard_gold_list_activity_meeting_attribution()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
       (OLD.created_in_meeting_id IS NOT NULL AND NEW.created_in_meeting_id IS DISTINCT FROM OLD.created_in_meeting_id)
    OR (OLD.closed_in_meeting_id IS NOT NULL AND NEW.closed_in_meeting_id IS DISTINCT FROM OLD.closed_in_meeting_id)
  ) THEN
    RAISE EXCEPTION 'Gold List 1:1 attribution is permanent' USING ERRCODE = '23514';
  END IF;
  IF NEW.created_in_meeting_id IS NOT NULL AND (
       TG_OP = 'INSERT' OR NEW.created_in_meeting_id IS DISTINCT FROM OLD.created_in_meeting_id) THEN
    PERFORM lock_open_one_on_one_meeting(NEW.created_in_meeting_id, NEW.salesperson_id);
  END IF;
  IF NEW.closed_in_meeting_id IS NOT NULL AND (
       TG_OP = 'INSERT' OR NEW.closed_in_meeting_id IS DISTINCT FROM OLD.closed_in_meeting_id) THEN
    PERFORM lock_open_one_on_one_meeting(NEW.closed_in_meeting_id, NEW.salesperson_id);
  END IF;
  IF NEW.rescheduled_in_meeting_id IS NOT NULL AND (
       TG_OP = 'INSERT' OR NEW.rescheduled_in_meeting_id IS DISTINCT FROM OLD.rescheduled_in_meeting_id) THEN
    PERFORM lock_open_one_on_one_meeting(NEW.rescheduled_in_meeting_id, NEW.salesperson_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_gold_list_activity_meeting_attribution ON gold_list_activities;
CREATE TRIGGER trg_guard_gold_list_activity_meeting_attribution
  BEFORE INSERT OR UPDATE ON gold_list_activities
  FOR EACH ROW EXECUTE FUNCTION guard_gold_list_activity_meeting_attribution();


-- ---------------------------------------------------------------------------
-- 8) complete_one_on_one_meeting — completion as ONE transaction.
--
--    Called by POST /api/admin/one-on-one-meetings/[id]/complete with the
--    Last Week / This Week comparison the server computed (live activity +
--    goals, not meeting-scoped data). Under FOR UPDATE on the meeting row it:
--      1. adds a discussion row for every agent with a Gold List action
--         attributed to this meeting (even if no note was typed);
--      2. snapshots every discussion row from the LIVE Gold List (last
--         completed + next scheduled activity) and freezes the attributed
--         actions as `activity_changes`;
--      3. rewrites the frozen commitment reviews: commitments made in this
--         meeting, open carryover, carryover resolved in this meeting, and
--         legacy Weekly Focus commitments open (or closed since the start);
--      4. flips status → 'completed'.
--    All-or-nothing: any failure rolls back every step, leaving an ordinary
--    in-progress draft that can simply be completed again. Completing an
--    already-completed meeting returns it unchanged (idempotent retry).
--
--    SECURITY INVOKER; EXECUTE revoked from PUBLIC/anon/authenticated and
--    granted to service_role only — same posture as the Juice Box RPCs.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION complete_one_on_one_meeting(
  p_meeting_id UUID,
  p_completed_by UUID,
  p_activity_snapshot JSONB
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

  -- Legacy Weekly Focus commitments are snapshotted in step 3 but aren't
  -- meeting rows, so hold them still for the rest of this transaction: a
  -- write from an old client waits and lands after completion (never inside
  -- the snapshot). Lock order is always meeting row → legacy rows, the same
  -- as update_legacy_commitment_in_one_on_one(), so the two can't deadlock.
  PERFORM 1 FROM one_on_one_commitments WHERE ae_id = m.ae_id FOR SHARE;

  -- 1) Agents acted on in this 1:1 count as discussed.
  INSERT INTO one_on_one_gold_list_notes (meeting_id, ae_id, agent_id, agent_name, brokerage)
  SELECT m.id, m.ae_id, a.id, a.agent_name, a.brokerage
    FROM gold_list_agents a
   WHERE a.salesperson_id = m.ae_id
     AND EXISTS (
       SELECT 1 FROM gold_list_activities x
        WHERE x.agent_id = a.id
          AND (x.created_in_meeting_id = m.id
               OR x.closed_in_meeting_id = m.id
               OR x.rescheduled_in_meeting_id = m.id))
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
         action_taken = COALESCE(jsonb_array_length(s.changes), 0) > 0,
         snapshot_taken_at = NOW()
    FROM (
      SELECT n2.id AS note_id,
             a.id AS agent_id, a.agent_name, a.brokerage,
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

REVOKE ALL ON FUNCTION complete_one_on_one_meeting(UUID, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_one_on_one_meeting(UUID, UUID, JSONB) FROM anon;
REVOKE ALL ON FUNCTION complete_one_on_one_meeting(UUID, UUID, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION complete_one_on_one_meeting(UUID, UUID, JSONB) TO service_role;

REVOKE ALL ON FUNCTION lock_open_one_on_one_meeting(UUID, UUID, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION lock_open_one_on_one_meeting(UUID, UUID, BOOLEAN) FROM anon;
REVOKE ALL ON FUNCTION lock_open_one_on_one_meeting(UUID, UUID, BOOLEAN) FROM authenticated;
-- Triggers call it as the role doing the write (the server's service_role),
-- so that role needs EXECUTE explicitly rather than via default privileges.
GRANT EXECUTE ON FUNCTION lock_open_one_on_one_meeting(UUID, UUID, BOOLEAN) TO service_role;


-- ---------------------------------------------------------------------------
-- 9) update_legacy_commitment_in_one_on_one — a legacy Weekly Focus
--    commitment changed FROM an in-progress 1:1, as ONE transaction.
--
--    The workspace lists open legacy commitments as carryover, and
--    completion snapshots them. The original route
--    (/api/admin/one-on-ones/[id]/commitments/[cid]) has no notion of a 1:1,
--    so the workspace uses this instead: it locks the meeting (the same
--    lock_open_one_on_one_meeting() as every meeting-scoped write), checks it
--    is this AE's in-progress 1:1, and only then applies the patch. The
--    change therefore either commits before completion (and is in the
--    snapshot) or is refused once the meeting is completing/completed —
--    never lands after the snapshot as if it were part of the meeting.
--
--    `p_patch` carries only the columns to set, built by the same rules as
--    the legacy route (lib/legacy-commitments.ts): status / completed /
--    completed_at / content / due_date. Legacy rows are otherwise untouched
--    by this migration, and Weekly Focus writes outside a 1:1 take no lock.
-- ---------------------------------------------------------------------------

-- The one definition of how a legacy patch is applied (columns the legacy
-- route may change). Callers MUST already hold the locks they need, in the
-- order meeting row → commitment row.
CREATE OR REPLACE FUNCTION apply_legacy_commitment_patch(
  p_commitment_id UUID,
  p_patch JSONB
) RETURNS one_on_one_commitments
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  c one_on_one_commitments;
BEGIN
  UPDATE one_on_one_commitments
     SET status = CASE WHEN p_patch ? 'status' THEN p_patch->>'status' ELSE status END,
         completed = CASE WHEN p_patch ? 'completed' THEN (p_patch->>'completed')::boolean ELSE completed END,
         completed_at = CASE WHEN p_patch ? 'completed_at' THEN (p_patch->>'completed_at')::timestamptz ELSE completed_at END,
         content = CASE WHEN p_patch ? 'content' THEN p_patch->>'content' ELSE content END,
         due_date = CASE WHEN p_patch ? 'due_date' THEN (p_patch->>'due_date')::date ELSE due_date END
   WHERE id = p_commitment_id
  RETURNING * INTO c;
  RETURN c;
END;
$$;

CREATE OR REPLACE FUNCTION update_legacy_commitment_in_one_on_one(
  p_meeting_id UUID,
  p_commitment_id UUID,
  p_patch JSONB
) RETURNS one_on_one_commitments
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  m_ae UUID;
  c one_on_one_commitments;
BEGIN
  SELECT ae_id INTO m_ae FROM one_on_one_meetings WHERE id = p_meeting_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '1:1 not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM lock_open_one_on_one_meeting(p_meeting_id, m_ae);

  SELECT * INTO c FROM one_on_one_commitments
   WHERE id = p_commitment_id AND ae_id = m_ae
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commitment not found' USING ERRCODE = 'P0002';
  END IF;

  RETURN apply_legacy_commitment_patch(c.id, p_patch);
END;
$$;

REVOKE ALL ON FUNCTION update_legacy_commitment_in_one_on_one(UUID, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION update_legacy_commitment_in_one_on_one(UUID, UUID, JSONB) FROM anon;
REVOKE ALL ON FUNCTION update_legacy_commitment_in_one_on_one(UUID, UUID, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION update_legacy_commitment_in_one_on_one(UUID, UUID, JSONB) TO service_role;


-- ---------------------------------------------------------------------------
-- 9b) update_legacy_commitment — the ORIGINAL Weekly Focus route's write
--     (/api/admin/one-on-ones/[week]/commitments/[cid], PATCH + DELETE),
--     made safe against a concurrent 1:1 completion for the same AE.
--
--    The route's request/response contract is unchanged and callers need no
--    1:1 id. At the database boundary:
--      1. find the commitment (pinned to its week, like the route always
--         did) and its AE — no locks yet;
--      2. if that AE has an IN-PROGRESS 1:1, take FOR KEY SHARE on that
--         meeting row, WAITING if completion holds it (safe: nothing else is
--         locked yet, so no deadlock). Postgres re-checks the row after the
--         wait: if completion committed meanwhile it no longer matches
--         `status = 'in_progress'` and the write simply proceeds as an
--         ordinary post-completion Weekly Focus change;
--      3. only then lock and update the commitment row.
--    So the write either commits BEFORE completion takes the meeting (and is
--    in the snapshot) or AFTER completion commits — never through it. Lock
--    order is meeting row → commitment row, exactly like completion and
--    update_legacy_commitment_in_one_on_one(). An AE whose 1:1s are all
--    completed (or who has none) matches no meeting row: no lock, same
--    behavior as before. The old route is never rejected because of a 1:1.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION update_legacy_commitment(
  p_week_id UUID,
  p_commitment_id UUID,
  p_patch JSONB
) RETURNS one_on_one_commitments
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_ae UUID;
  c one_on_one_commitments;
BEGIN
  SELECT ae_id INTO v_ae FROM one_on_one_commitments
   WHERE id = p_commitment_id AND one_on_one_id = p_week_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commitment not found' USING ERRCODE = 'P0002';
  END IF;

  -- Meeting row first (only the AE's in-progress 1:1, if any).
  PERFORM 1 FROM one_on_one_meetings
   WHERE ae_id = v_ae AND status = 'in_progress'
   FOR KEY SHARE;

  -- Then the commitment row.
  SELECT * INTO c FROM one_on_one_commitments
   WHERE id = p_commitment_id AND one_on_one_id = p_week_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commitment not found' USING ERRCODE = 'P0002';
  END IF;

  RETURN apply_legacy_commitment_patch(c.id, p_patch);
END;
$$;

REVOKE ALL ON FUNCTION update_legacy_commitment(UUID, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION update_legacy_commitment(UUID, UUID, JSONB) FROM anon;
REVOKE ALL ON FUNCTION update_legacy_commitment(UUID, UUID, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION update_legacy_commitment(UUID, UUID, JSONB) TO service_role;

REVOKE ALL ON FUNCTION apply_legacy_commitment_patch(UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION apply_legacy_commitment_patch(UUID, JSONB) FROM anon;
REVOKE ALL ON FUNCTION apply_legacy_commitment_patch(UUID, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION apply_legacy_commitment_patch(UUID, JSONB) TO service_role;


-- ---------------------------------------------------------------------------
-- 10) RLS — server-only. Enabled, no policies.
-- ---------------------------------------------------------------------------

ALTER TABLE one_on_one_meetings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE one_on_one_gold_list_notes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE one_on_one_meeting_commitments ENABLE ROW LEVEL SECURITY;
ALTER TABLE one_on_one_commitment_reviews  ENABLE ROW LEVEL SECURITY;

COMMIT;


-- ===========================================================================
-- VERIFICATION (run after the migration)
-- ===========================================================================
-- SELECT tablename, rowsecurity FROM pg_tables
--  WHERE tablename IN ('one_on_one_meetings', 'one_on_one_gold_list_notes',
--                      'one_on_one_meeting_commitments',
--                      'one_on_one_commitment_reviews');
--   -- expect 4 rows, rowsecurity = true
--
-- SELECT COUNT(*) FROM pg_policies
--  WHERE tablename LIKE 'one_on_one_%';
--   -- expect 0 (no anon policies on any 1:1 table, legacy or new)
--
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'gold_list_activities'
--    AND column_name IN ('created_by', 'completed_by');
--   -- expect 2 rows
--
-- -- Legacy Weekly Focus data untouched (counts match before/after):
-- SELECT (SELECT COUNT(*) FROM one_on_ones) AS weeks,
--        (SELECT COUNT(*) FROM one_on_one_commitments) AS commitments,
--        (SELECT COUNT(*) FROM weekly_focus_private_notes) AS private_notes;
--
-- -- One in-progress meeting per AE (expect 23505 on the second insert):
-- -- INSERT INTO one_on_one_meetings (ae_id, meeting_date) VALUES ('<ae>', CURRENT_DATE);
-- -- INSERT INTO one_on_one_meetings (ae_id, meeting_date) VALUES ('<ae>', CURRENT_DATE);
-- ===========================================================================
