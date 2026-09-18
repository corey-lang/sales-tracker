BEGIN;

-- ===========================================================================
-- Gold List — per-AE relationship follow-up (agents + scheduled activities).
-- ===========================================================================
-- WHAT THIS IS
--   A deliberately lightweight follow-up loop for Account Executives:
--
--     add an agent -> schedule an activity -> complete it (with an optional
--     outcome note) -> schedule the next activity, with every completed
--     activity preserved as history.
--
--   It is NOT a CRM. There are no pipelines, stages, deal values, or
--   automation. Two tables, one open activity per agent at a time.
--
-- HOW THIS DIFFERS FROM THE THREE EXISTING "gold list" THINGS
--   * `gold_list_targets` / `gold_list_touches_log` (schema.sql) — the daily
--     activity counter. A rep taps names they touched today and the count
--     lands on `activity_entries.gold_list_touches`. Day-scoped tally; no
--     scheduling, no history per relationship. Untouched by this migration.
--   * `coaching_relationships` (weekly_focus_v2.sql) — the MANAGER's coaching
--     layer, admin-written, rendered inside the Weekly Focus surface at
--     /admin/coaching/[ae_id]. Admin-owned, not AE-owned.
--   * THIS — AE-owned, lives on its own page (/gold-list), and persists
--     independently of any weekly focus record. Nothing here is week-scoped:
--     there is no week_start column, and no row is ever reset or rolled over.
--
--   The three are kept separate on purpose. Merging this into
--   `coaching_relationships` would tie an AE's own follow-up list to the
--   manager's weekly meeting record, which is exactly what this feature must
--   not do.
--
-- ACCESS MODEL
--   RLS is ENABLED with NO policy on both tables, so the browser anon key has
--   zero access — same posture as `ae_tasks.sql` (#9) and
--   `working_day_adjustments.sql` (#35). Every read and write goes through the
--   `/api/gold-list/*` routes, which use the service-role key and resolve the
--   caller from the signed session token:
--     * an AE reads and writes ONLY rows where `salesperson_id` = their own id;
--     * an admin may READ any AE's list (and filter by AE) but writes are
--       still owner-only — an admin edits only their own agents.
--   `salesperson_id` is never taken from a request body or query string on a
--   write; it is always the authenticated caller's id.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
-- DROP TRIGGER IF EXISTS, ENABLE ROW LEVEL SECURITY. Safe to re-run.
-- See supabase/README.md for migration order.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1) gold_list_agents — the AE's personal list of people they are working.
--
--    "Agent" is the business term (real-estate agents are who the AEs court),
--    not a system actor. Only `agent_name` is required; everything else is
--    optional so adding someone from a phone takes one field.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS gold_list_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Owner. Assigned server-side from the session on INSERT; never client-supplied.
  salesperson_id UUID NOT NULL REFERENCES salespeople(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  brokerage TEXT,
  phone TEXT,
  email TEXT,
  notes TEXT,
  -- Soft delete. `archived_at IS NULL` is the active-row predicate and the
  -- basis of the header's active-agent count. Archive rather than DELETE so
  -- the activity history a rep built up survives (same reasoning as
  -- offices.archived_at #33 and coaching_relationships.archived_at #21).
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Target of the composite FK on gold_list_activities below, which is what
  -- makes an activity's denormalized owner provably equal to its agent's owner.
  CONSTRAINT gold_list_agents_id_owner_key UNIQUE (id, salesperson_id)
);

-- Hot path: "my active Gold List, newest first".
CREATE INDEX IF NOT EXISTS idx_gold_list_agents_owner_active
  ON gold_list_agents(salesperson_id, created_at DESC)
  WHERE archived_at IS NULL;

-- Names are advisory matches, never unique identities.
DROP INDEX IF EXISTS idx_gold_list_agents_unique_active;

-- ---------------------------------------------------------------------------
-- 2) gold_list_activities — one scheduled/completed touch on one agent.
--
--    `salesperson_id` is denormalized from the parent agent so every list
--    query can scope by owner without a join. The composite FK below makes
--    that copy impossible to desynchronize: a row can only exist if
--    (agent_id, salesperson_id) is a real pair in gold_list_agents. It is the
--    only FK on the table — agent deletes and salesperson deletes both reach
--    these rows through it via ON DELETE CASCADE.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS gold_list_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  salesperson_id UUID NOT NULL,
  -- Mirrors GOLD_LIST_ACTIVITY_TYPES in src/lib/gold-list.ts. Adding a type
  -- means editing BOTH this CHECK and that constant.
  activity_type TEXT NOT NULL DEFAULT 'other' CHECK (activity_type IN (
    'call', 'text', 'email', 'office_visit', 'one_on_one',
    'lunch', 'event', 'other'
  )),
  -- Plain DATE. "Today" / "overdue" are judged against America/Denver
  -- (APP_TIMEZONE in src/lib/dates.ts) on both the client and the server, so a
  -- late-evening entry never reads as tomorrow's.
  scheduled_for DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  -- Optional free text captured when the activity is completed ("met at the
  -- office, wants the Q3 deck"). Never required — completing with no note is
  -- the common case.
  outcome_note TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT gold_list_activities_agent_fkey
    FOREIGN KEY (agent_id, salesperson_id)
    REFERENCES gold_list_agents(id, salesperson_id)
    ON DELETE CASCADE,
  -- completed_at and status can't disagree. Cancelled and scheduled rows carry
  -- no completion stamp; a completed row always carries one.
  CONSTRAINT gold_list_activities_completed_at_matches_status CHECK (
    (status = 'completed' AND completed_at IS NOT NULL) OR
    (status <> 'completed' AND completed_at IS NULL)
  )
);

-- Per-agent history, most recent first — the expanded card's read.
CREATE INDEX IF NOT EXISTS idx_gold_list_activities_agent_date
  ON gold_list_activities(agent_id, scheduled_for DESC);

-- Per-owner summary read (the board fetches every scoped agent's activities in
-- one query and groups them client-side).
CREATE INDEX IF NOT EXISTS idx_gold_list_activities_owner_status
  ON gold_list_activities(salesperson_id, status);

-- THE PRODUCT RULE, ENFORCED IN THE DATABASE: at most ONE scheduled (open)
-- activity per agent. The workflow is sequential by design — complete the open
-- activity, then schedule the next — so a second open activity is a bug, not a
-- feature. Completed and cancelled rows are excluded, so history is unbounded.
-- The API maps 23505 on this index to a 409 telling the rep to complete or
-- reschedule the existing one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_gold_list_activities_one_open
  ON gold_list_activities(agent_id)
  WHERE status = 'scheduled';


-- ---------------------------------------------------------------------------
-- 3) updated_at maintenance. The project has no shared trigger (see CLAUDE.md);
--    these mirror the small self-contained triggers in ae_tasks.sql.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_gold_list_agents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_gold_list_agents_updated_at ON gold_list_agents;
CREATE TRIGGER trg_gold_list_agents_updated_at
  BEFORE UPDATE ON gold_list_agents
  FOR EACH ROW
  EXECUTE FUNCTION set_gold_list_agents_updated_at();

CREATE OR REPLACE FUNCTION set_gold_list_activities_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_gold_list_activities_updated_at ON gold_list_activities;
CREATE TRIGGER trg_gold_list_activities_updated_at
  BEFORE UPDATE ON gold_list_activities
  FOR EACH ROW
  EXECUTE FUNCTION set_gold_list_activities_updated_at();


-- ---------------------------------------------------------------------------
-- 4) Server-only access: RLS on, no policy. The service-role key (the
--    /api/gold-list/* routes) bypasses RLS; the anon key is fully locked out.
-- ---------------------------------------------------------------------------

ALTER TABLE gold_list_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE gold_list_activities ENABLE ROW LEVEL SECURITY;


-- ===========================================================================
-- VERIFICATION
-- ===========================================================================
-- -- Tables + RLS posture (expect rowsecurity = true for both):
-- SELECT tablename, rowsecurity
--   FROM pg_tables
--  WHERE tablename IN ('gold_list_agents', 'gold_list_activities');
--
-- -- No policies should exist (server-only access):
-- SELECT COUNT(*) FROM pg_policies
--  WHERE tablename IN ('gold_list_agents', 'gold_list_activities');  -- expect 0
--
-- -- The one-open-activity rule (expect a unique_violation on the 2nd insert):
-- -- INSERT INTO gold_list_activities (agent_id, salesperson_id, activity_type, scheduled_for)
-- -- VALUES ('<agent>', '<owner>', 'call', CURRENT_DATE);
-- -- INSERT INTO gold_list_activities (agent_id, salesperson_id, activity_type, scheduled_for)
-- -- VALUES ('<agent>', '<owner>', 'text', CURRENT_DATE + 1);  -- 23505
--
-- -- Active agent count for one AE (what the page header renders):
-- SELECT COUNT(*) FROM gold_list_agents
--  WHERE salesperson_id = '<ae-uuid>' AND archived_at IS NULL;
--
-- -- The three separate note columns all exist and stayed separate:
-- SELECT table_name, column_name, is_nullable
--   FROM information_schema.columns
--  WHERE (table_name = 'gold_list_agents'     AND column_name = 'notes')
--     OR (table_name = 'gold_list_activities' AND column_name IN ('activity_note', 'outcome_note'))
--  ORDER BY table_name, column_name;   -- expect 3 rows, all is_nullable = 'YES'
--
-- -- Existing activities survive the upgrade with an empty scheduled note:
-- SELECT COUNT(*) FILTER (WHERE activity_note IS NULL) AS without_note,
--        COUNT(*) FILTER (WHERE activity_note IS NOT NULL) AS with_note
--   FROM gold_list_activities;

-- Upgrade the original draft without discarding any historical activity.
ALTER TABLE gold_list_activities ADD COLUMN IF NOT EXISTS description TEXT;
UPDATE gold_list_activities SET description = initcap(replace(activity_type, '_', ' ')) WHERE description IS NULL;
ALTER TABLE gold_list_activities ALTER COLUMN description SET NOT NULL;
ALTER TABLE gold_list_activities ALTER COLUMN activity_type SET DEFAULT 'other';
ALTER TABLE gold_list_activities DROP CONSTRAINT IF EXISTS gold_list_activity_description_valid;
ALTER TABLE gold_list_activities ADD CONSTRAINT gold_list_activity_description_valid CHECK (length(btrim(description)) BETWEEN 1 AND 500);

-- The OPTIONAL scheduled-activity note: what this planned touch is FOR
-- ("get him on the phone about his upcoming listing"). Three distinct notes
-- exist in this feature and none of them is a rename of another:
--   * gold_list_agents.notes          — the standing relationship note.
--   * gold_list_activities.activity_note  — THIS: the plan for one activity,
--                                       written when it is scheduled.
--   * gold_list_activities.outcome_note   — what happened, written when the
--                                       activity is completed.
-- Nullable with no backfill, so this is safe on a fresh database, on one that
-- already ran the original Gold List migration, and on one holding live agents
-- and activities: existing rows simply read NULL ("no scheduled note"), and no
-- value in any other column is touched.
--
-- IMMUTABILITY IS UNCHANGED. `activity_note` is an ordinary column on a row
-- that `protect_gold_list_activity_history` already freezes once its status
-- leaves 'scheduled', so a completed activity's plan note can no more be
-- rewritten than its outcome note or its completion stamp. The API's
-- scheduled-only UPDATE predicate still applies as well.
ALTER TABLE gold_list_activities ADD COLUMN IF NOT EXISTS activity_note TEXT;
ALTER TABLE gold_list_activities DROP CONSTRAINT IF EXISTS gold_list_activity_note_valid;
ALTER TABLE gold_list_activities ADD CONSTRAINT gold_list_activity_note_valid
  CHECK (activity_note IS NULL OR length(activity_note) <= 2000);

-- Ownership is the creator: every insert is owner-only and this identity is immutable.
-- Protect completed/cancelled history even from future accidental server updates.
CREATE OR REPLACE FUNCTION protect_gold_list_activity_history()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.status <> 'scheduled' OR NEW.agent_id <> OLD.agent_id
     OR NEW.salesperson_id <> OLD.salesperson_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Activity history and creator are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_gold_list_activity_history ON gold_list_activities;
CREATE TRIGGER trg_gold_list_activity_history BEFORE UPDATE ON gold_list_activities
FOR EACH ROW EXECUTE FUNCTION protect_gold_list_activity_history();
CREATE INDEX IF NOT EXISTS idx_gold_list_activities_completion
ON gold_list_activities(agent_id, completed_at DESC);

CREATE OR REPLACE FUNCTION check_gold_list_activity_parent()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE archived TIMESTAMPTZ;
BEGIN
  SELECT archived_at INTO archived FROM gold_list_agents
    WHERE id = NEW.agent_id AND salesperson_id = NEW.salesperson_id FOR UPDATE;
  IF archived IS NOT NULL THEN
    RAISE EXCEPTION 'Restore archived agent before changing activities' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_gold_list_activity_parent ON gold_list_activities;
CREATE TRIGGER trg_gold_list_activity_parent BEFORE INSERT OR UPDATE ON gold_list_activities
FOR EACH ROW EXECUTE FUNCTION check_gold_list_activity_parent();

CREATE INDEX IF NOT EXISTS idx_gold_list_agents_owner_id
ON gold_list_agents(salesperson_id, id);

COMMIT;
