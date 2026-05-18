-- ===========================================================================
-- ae_tasks — lightweight per-AE To-Do / Follow-Up tasks.
-- ===========================================================================
-- WHAT THIS IS
--   A standalone task list shown on the AE home screen. Each task belongs to
--   one salesperson. This is intentionally minimal — NOT the CRM follow-ups
--   system. It is shaped so it can later evolve into CRM tasks (e.g. an
--   optional contact_id / company_id could be added) without a rewrite.
--
-- ACCESS MODEL
--   RLS is ENABLED with NO policy, so the browser anon key has zero access.
--   All reads/writes go through the /api/tasks/* server routes, which use the
--   service-role key (bypasses RLS) and scope every query to the authenticated
--   salesperson from the signed session token. Unlike weekly_goals, this table
--   is brand new — there are no client-side readers — so enabling RLS up front
--   breaks nothing.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
-- DROP TRIGGER IF EXISTS, and ENABLE ROW LEVEL SECURITY are all re-runnable.
-- See supabase/README.md for migration order.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS ae_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salesperson_id UUID NOT NULL REFERENCES salespeople(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'done', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- General per-AE listing, ordered by due date.
CREATE INDEX IF NOT EXISTS idx_ae_tasks_salesperson_due
  ON ae_tasks(salesperson_id, due_date);

-- Hot path: the home-screen card only ever lists a rep's OPEN tasks.
CREATE INDEX IF NOT EXISTS idx_ae_tasks_open
  ON ae_tasks(salesperson_id, due_date)
  WHERE status = 'open';

-- updated_at maintenance. The project has no shared trigger (see CLAUDE.md);
-- this mirrors the small self-contained trigger in business_card_contacts.sql.
CREATE OR REPLACE FUNCTION set_ae_tasks_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ae_tasks_updated_at ON ae_tasks;
CREATE TRIGGER trg_ae_tasks_updated_at
  BEFORE UPDATE ON ae_tasks
  FOR EACH ROW
  EXECUTE FUNCTION set_ae_tasks_updated_at();

-- Server-only access: RLS on, no policy. The service-role key (server routes)
-- bypasses RLS; the anon key is fully locked out.
ALTER TABLE ae_tasks ENABLE ROW LEVEL SECURITY;
