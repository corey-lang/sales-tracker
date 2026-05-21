-- ===========================================================================
-- Manager 1:1 coaching system — Phase 1 schema (manager-only).
-- ===========================================================================
-- WHAT THIS IS
--   A lightweight coaching/development surface a manager (admin role) uses to
--   prep, run, and review 1:1s with each AE. Four tables:
--
--     * one_on_ones                 — one row per 1:1 meeting (date, notes,
--                                     visibility). The "meeting record".
--     * one_on_one_commitments      — checklist items added DURING a 1:1, to
--                                     be reviewed at the NEXT 1:1. The
--                                     "commitments before next 1:1" surface;
--                                     surfaced again as "previous 1:1
--                                     commitments" on the following meeting.
--     * coaching_relationships      — per-AE key relationship targets the
--                                     manager is tracking with the AE. Named
--                                     `coaching_*` (NOT `gold_list_*`) to keep
--                                     it visually distinct from the existing
--                                     `gold_list_targets` table, which is the
--                                     AE's PERSONAL touch list. Both can
--                                     coexist; this one is the manager's lens.
--     * training_commitments        — standing per-AE training/coaching
--                                     assignments (shadow a presentation,
--                                     practice objection handling, etc.).
--                                     Not tied to a single meeting.
--
-- VISIBILITY
--   `one_on_ones.visibility` ('manager_only' | 'shared') is wired now even
--   though Phase 1 is manager-only. Future AE-facing routes will gate reads
--   on `visibility = 'shared'`. All writes for both modes go through admin-
--   gated server routes; the column is the source of truth for AE reads.
--
-- ACCESS MODEL — server-only
--   RLS is ENABLED on every table with ZERO anon policies. The browser anon
--   key cannot read or write any of these rows — every access goes through
--   the /api/admin/coaching/* routes which run with the service-role key and
--   call requireAdmin(). No realtime channels yet.
--
-- WHY UUID FKs to salespeople (vs. TEXT)
--   These rows are pure server-managed coaching artifacts; they have no
--   "must survive a salesperson rename/remove" requirement like
--   team_messages. Hard FK is fine — if the manager deletes an AE row,
--   their 1:1 history goes with them (cascade).
--
-- Idempotent: re-runnable. CREATE TABLE IF NOT EXISTS, DROP TRIGGER IF
-- EXISTS + CREATE TRIGGER, CREATE OR REPLACE FUNCTION, ENABLE ROW LEVEL
-- SECURITY (no-op when already enabled).
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1) one_on_ones — the meeting record
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS one_on_ones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ae_id UUID NOT NULL REFERENCES salespeople(id) ON DELETE CASCADE,
  -- Nullable so a session that pre-dates a manager rotation still resolves.
  manager_id UUID REFERENCES salespeople(id) ON DELETE SET NULL,
  meeting_date DATE NOT NULL DEFAULT CURRENT_DATE,
  -- 'manager_only' (default) hides the row from any future AE-facing route;
  -- 'shared' allows it to surface to the AE whose ae_id this row carries.
  visibility TEXT NOT NULL DEFAULT 'manager_only'
    CHECK (visibility IN ('manager_only', 'shared')),
  -- Three loosely-structured note panes — keeps the UI from being a single
  -- giant blob while staying flexible. All optional.
  notes_wins TEXT,
  notes_opportunities TEXT,
  notes_focus TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot path: list an AE's 1:1s newest-first for the timeline + latest-meeting
-- lookup the detail page does.
CREATE INDEX IF NOT EXISTS idx_one_on_ones_ae_meeting_date
  ON one_on_ones(ae_id, meeting_date DESC);


-- ---------------------------------------------------------------------------
-- 2) one_on_one_commitments — checklist tied to a specific meeting
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS one_on_one_commitments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  one_on_one_id UUID NOT NULL REFERENCES one_on_ones(id) ON DELETE CASCADE,
  -- Denormalized so per-AE queries don't have to join through one_on_ones.
  ae_id UUID NOT NULL REFERENCES salespeople(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  due_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot path: pull every commitment for a given meeting (the "next commitments"
-- list during the meeting, and the "previous commitments" surface during the
-- following one).
CREATE INDEX IF NOT EXISTS idx_one_on_one_commitments_meeting
  ON one_on_one_commitments(one_on_one_id, created_at);

-- Hot path: the /admin/coaching index counts OPEN commitments per AE
-- across only the latest 1:1 (`WHERE one_on_one_id IN (...latest...)
-- AND completed = false`). A partial index keyed on one_on_one_id and
-- restricted to open rows keeps this query off the full meeting index
-- and reads only the in-flight items — cheap and aligns 1:1 with the
-- summary query's predicate.
CREATE INDEX IF NOT EXISTS idx_one_on_one_commitments_open
  ON one_on_one_commitments(one_on_one_id)
  WHERE completed = false;


-- ---------------------------------------------------------------------------
-- 3) coaching_relationships — manager's lens on the AE's key relationships
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS coaching_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ae_id UUID NOT NULL REFERENCES salespeople(id) ON DELETE CASCADE,
  contact_name TEXT NOT NULL,
  company TEXT,
  title TEXT,
  -- Free-form status string — kept intentionally text-only for V1 so the
  -- manager can write things like "Cold", "Warm", "Closing", "On hold"
  -- without us locking in a schema we haven't validated yet.
  status TEXT,
  next_step TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot path: list one AE's relationships, most-recently-updated first so
-- the manager sees what they just discussed at the top.
CREATE INDEX IF NOT EXISTS idx_coaching_relationships_ae_updated
  ON coaching_relationships(ae_id, updated_at DESC);


-- ---------------------------------------------------------------------------
-- 4) training_commitments — standing per-AE training/coaching assignments
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS training_commitments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ae_id UUID NOT NULL REFERENCES salespeople(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  due_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot path: per-AE list with open items first; completed items pushed down.
CREATE INDEX IF NOT EXISTS idx_training_commitments_ae_status
  ON training_commitments(ae_id, completed, updated_at DESC);


-- ---------------------------------------------------------------------------
-- updated_at maintenance — match the existing lightweight pattern used by
-- ae_tasks / business_card_contacts.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_coaching_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_one_on_ones_updated_at ON one_on_ones;
CREATE TRIGGER trg_one_on_ones_updated_at
  BEFORE UPDATE ON one_on_ones
  FOR EACH ROW EXECUTE FUNCTION set_coaching_updated_at();

DROP TRIGGER IF EXISTS trg_one_on_one_commitments_updated_at ON one_on_one_commitments;
CREATE TRIGGER trg_one_on_one_commitments_updated_at
  BEFORE UPDATE ON one_on_one_commitments
  FOR EACH ROW EXECUTE FUNCTION set_coaching_updated_at();

DROP TRIGGER IF EXISTS trg_coaching_relationships_updated_at ON coaching_relationships;
CREATE TRIGGER trg_coaching_relationships_updated_at
  BEFORE UPDATE ON coaching_relationships
  FOR EACH ROW EXECUTE FUNCTION set_coaching_updated_at();

DROP TRIGGER IF EXISTS trg_training_commitments_updated_at ON training_commitments;
CREATE TRIGGER trg_training_commitments_updated_at
  BEFORE UPDATE ON training_commitments
  FOR EACH ROW EXECUTE FUNCTION set_coaching_updated_at();


-- ---------------------------------------------------------------------------
-- RLS — server-only. All four tables: enabled, no policies. The anon key
-- is locked out; every read/write goes through the admin-gated server
-- routes using the service-role key (which bypasses RLS).
-- ---------------------------------------------------------------------------

ALTER TABLE one_on_ones                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE one_on_one_commitments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE coaching_relationships      ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_commitments        ENABLE ROW LEVEL SECURITY;


-- ===========================================================================
-- VERIFICATION (run after the migration)
-- ===========================================================================
-- SELECT tablename, rowsecurity FROM pg_tables
-- WHERE tablename IN ('one_on_ones', 'one_on_one_commitments',
--                     'coaching_relationships', 'training_commitments');
--   -- expect rowsecurity = true for all four
--
-- SELECT COUNT(*) FROM pg_policies
-- WHERE tablename IN ('one_on_ones', 'one_on_one_commitments',
--                     'coaching_relationships', 'training_commitments');
--   -- expect 0 (no anon policies)
