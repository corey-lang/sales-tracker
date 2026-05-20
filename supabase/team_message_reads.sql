-- ===========================================================================
-- team_message_reads — per-user read marker for the Juice Box live team feed.
-- ===========================================================================
-- WHAT THIS IS
--   One row per salesperson tracking the timestamp through which they have
--   read the Juice Box feed. Anything in `team_messages` with
--   created_at > last_read_at is considered unread for that user. Used to
--   power the "New messages" divider and the bottom-nav unread badge.
--
-- ACCESS MODEL
--   RLS is ENABLED with NO policies. Read-state is per-user — no other
--   client needs to subscribe to it, so it's strictly server-mediated.
--   All access goes through /api/team-messages/reads/me and
--   /api/team-messages/unread, which use the service-role key (bypasses
--   RLS) and scope every query to the authenticated salesperson from the
--   signed session token. The anon key has zero access.
--
-- NOT IN supabase_realtime
--   This table is intentionally NOT published to the realtime stream.
--   Other clients shouldn't see each other's read markers.
--
-- Idempotent: re-runnable. CREATE TABLE/INDEX IF NOT EXISTS, CREATE OR
-- REPLACE FUNCTION, DROP TRIGGER + CREATE TRIGGER. See supabase/README.md
-- for migration order.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS team_message_reads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- TEXT mirrors team_messages.salesperson_id (see team_messages.sql for
  -- the rationale: keeps records readable even if a salespeople row is
  -- removed). Holds the UUID string from salespeople.id at write time.
  salesperson_id TEXT NOT NULL,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One read marker per salesperson. The /reads/me POST upserts on this key,
-- so the unique index also drives ON CONFLICT.
CREATE UNIQUE INDEX IF NOT EXISTS uq_team_message_reads_salesperson
  ON team_message_reads(salesperson_id);

-- Most lookups are by salesperson_id alone; the unique index above already
-- supports those. last_read_at currently has no read path that benefits
-- from a dedicated index — the unread-count query filters team_messages
-- by created_at > last_read_at, which scans team_messages, not this table.
-- Adding an unused index here would only slow writes; intentionally skipped.

-- updated_at maintenance — same lightweight pattern as ae_tasks.sql /
-- business_card_contacts.sql. Server routes also write updated_at on
-- upsert; this trigger guarantees correctness if anything else ever
-- updates a row directly.
CREATE OR REPLACE FUNCTION set_team_message_reads_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_team_message_reads_updated_at ON team_message_reads;
CREATE TRIGGER trg_team_message_reads_updated_at
  BEFORE UPDATE ON team_message_reads
  FOR EACH ROW
  EXECUTE FUNCTION set_team_message_reads_updated_at();

-- Server-only access. RLS on, no policy — service-role bypasses; anon is
-- locked out.
ALTER TABLE team_message_reads ENABLE ROW LEVEL SECURITY;

-- ===========================================================================
-- VERIFICATION
-- ===========================================================================
-- SELECT tablename, rowsecurity FROM pg_tables WHERE tablename = 'team_message_reads';
--   -- expect rowsecurity = true
--
-- SELECT count(*) FROM pg_policies WHERE tablename = 'team_message_reads';
--   -- expect 0 (no anon policies)
--
-- SELECT tablename FROM pg_publication_tables
-- WHERE pubname = 'supabase_realtime' AND tablename = 'team_message_reads';
--   -- expect 0 rows (intentionally NOT in the realtime publication)
