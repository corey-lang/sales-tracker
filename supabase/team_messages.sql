-- ===========================================================================
-- team_messages — Juice Box live team feed (Pass 2).
-- ===========================================================================
-- WHAT THIS IS
--   The backing table for /juice-box. Pass 2 ships text-only posts with
--   admin soft-delete. Access during this rollout is gated to admins + test
--   accounts at the route layer (see /api/team-messages); the database is
--   not aware of the rollout gate.
--
-- ACCESS MODEL — mirrors business_card_rls.sql
--   * RLS is ENABLED.
--   * The browser anon key has SELECT ONLY. Required so the supabase-js
--     client can subscribe to postgres_changes events live (Realtime respects
--     RLS — subscribers must be able to read the row to receive the event).
--   * The anon key has NO write policy. All inserts/updates go through the
--     /api/team-messages routes using the SERVICE-ROLE key (which bypasses
--     RLS). Identity, role gating, and content validation live there.
--
-- REALTIME
--   The table is published to `supabase_realtime` so INSERT/UPDATE events
--   reach subscribed browsers. Soft delete is an UPDATE that flips
--   is_deleted to true — the UI filters those out, so deleted messages
--   disappear instantly without a separate delete event channel.
--
-- Idempotent: re-runnable. CREATE TABLE/INDEX IF NOT EXISTS, DROP POLICY IF
-- EXISTS + CREATE POLICY, and a guarded publication ADD.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS team_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- TEXT (not UUID FK) by design: keeps a post readable as authored even if
  -- the salesperson row is later removed/renamed. salesperson_name is
  -- denormalized at write time so historical posts never lose their byline.
  salesperson_id TEXT NOT NULL,
  salesperson_name TEXT NOT NULL,
  message TEXT NOT NULL,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

-- Newest-at-top read path — the feed only ever fetches the most recent N
-- rows, then renders oldest -> newest in the UI.
CREATE INDEX IF NOT EXISTS idx_team_messages_created_at
  ON team_messages(created_at DESC);

-- Hot path: GET /api/team-messages does
--   WHERE is_deleted = false ORDER BY created_at DESC LIMIT 200
-- The partial index keeps only live rows in the index, mirrors the order,
-- and skips tombstones entirely — both cheaper to scan and smaller to keep
-- in cache than the unconditional created_at index above.
CREATE INDEX IF NOT EXISTS idx_team_messages_live_created_at
  ON team_messages(created_at DESC)
  WHERE is_deleted = false;

-- Per-author lookup (moderation, future "show only mine" filters).
CREATE INDEX IF NOT EXISTS idx_team_messages_salesperson
  ON team_messages(salesperson_id);

ALTER TABLE team_messages ENABLE ROW LEVEL SECURITY;

-- Anon SELECT is required for browser-side Realtime to deliver events. Read-
-- only; no anon write policy exists, so the supabase-js client cannot insert,
-- update, or delete. Writes go exclusively through the server routes.
DROP POLICY IF EXISTS "team_messages anon select" ON team_messages;
CREATE POLICY "team_messages anon select"
  ON team_messages FOR SELECT TO anon
  USING (true);

-- Publish to the Realtime publication. Guarded so re-running the migration
-- doesn't error with "relation already in publication".
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'team_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE team_messages;
  END IF;
END$$;

-- ===========================================================================
-- VERIFICATION (run in the SQL editor after the migration)
-- ===========================================================================
-- SELECT tablename, rowsecurity FROM pg_tables WHERE tablename = 'team_messages';
--   -- expect rowsecurity = true
--
-- SELECT policyname, cmd, roles FROM pg_policies WHERE tablename = 'team_messages';
--   -- expect exactly one row: "team_messages anon select" / SELECT / {anon}
--
-- SELECT tablename FROM pg_publication_tables
-- WHERE pubname = 'supabase_realtime' AND tablename = 'team_messages';
--   -- expect one row
