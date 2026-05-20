-- ===========================================================================
-- Juice Box Pass 4 — conversation features.
-- ===========================================================================
-- WHAT THIS IS
--   * Adds `team_message_reactions` — a join table (message × user × emoji)
--     backing lightweight emoji reactions on /juice-box posts.
--   * Adds nullable reply columns to `team_messages` so a post can quote a
--     prior post:
--       - reply_to_message_id        (UUID pointer back to the parent)
--       - reply_to_salesperson_name  (denormalized author name)
--       - reply_to_message_preview   (truncated body of the parent)
--     Denormalized at write time so a reply still renders sensibly even if
--     the parent is later soft-deleted by an admin.
--
-- ACCESS MODEL — mirrors team_messages.sql
--   * RLS is ENABLED on team_message_reactions.
--   * The browser anon key has SELECT only — required so the supabase-js
--     client can subscribe to postgres_changes events (Realtime respects
--     RLS, subscribers must be able to read the row to receive the event).
--   * NO anon write policy. All insert/delete go through the
--     /api/team-messages/[id]/reactions route under the SERVICE-ROLE key.
--     Identity, the Juice Box rollout gate, and the allowed-emoji list are
--     enforced at the API layer.
--
-- REALTIME
--   team_message_reactions is published to supabase_realtime so INSERT and
--   DELETE events stream live. We set REPLICA IDENTITY FULL on the table so
--   DELETE payloads carry the full old row — the client needs message_id,
--   salesperson_id, and emoji to decrement local counts without a refetch.
--
-- Idempotent: re-runnable. CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF
-- NOT EXISTS, DROP POLICY IF EXISTS + CREATE POLICY, guarded publication ADD.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1) Reactions table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS team_message_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES team_messages(id) ON DELETE CASCADE,
  -- TEXT (not UUID FK) by design: matches team_messages.salesperson_id so a
  -- reaction remains attributable even if the underlying salespeople row is
  -- renamed/removed. salesperson_name is denormalized at write time for the
  -- same reason.
  salesperson_id TEXT NOT NULL,
  salesperson_name TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Allowed-emoji whitelist — DB-level defense in depth behind the API
-- check (isAllowedReaction). The route is the primary gate (anon writes
-- are blocked by RLS, and service-role calls go through it), but encoding
-- the closed set in Postgres prevents a future migration or one-off SQL
-- session from quietly seeding off-list reactions that every client would
-- then render verbatim.
--
-- DROP-then-ADD is the idempotent pattern for CHECK constraints: ALTER
-- TABLE ADD CONSTRAINT IF NOT EXISTS doesn't exist in Postgres, and we
-- also want to be able to UPDATE the allowed set in a future migration by
-- re-running this file. Drop is a no-op if absent thanks to IF EXISTS.
ALTER TABLE team_message_reactions
  DROP CONSTRAINT IF EXISTS team_message_reactions_emoji_allowed;
ALTER TABLE team_message_reactions
  ADD CONSTRAINT team_message_reactions_emoji_allowed
  CHECK (emoji IN ('😂', '🔥', '👏', '💪', '🍊', '❤️', '🧡', '‼️'));

-- One reaction per (message, user, emoji). Drives the toggle in the API
-- (insert → 23505 unique_violation means "already reacted, delete instead").
CREATE UNIQUE INDEX IF NOT EXISTS uq_team_message_reactions_unique
  ON team_message_reactions(message_id, salesperson_id, emoji);

-- Hot path: GET /api/team-messages hydrates reactions for the most recent
-- FEED_LIMIT messages with `WHERE message_id IN (...)`.
CREATE INDEX IF NOT EXISTS idx_team_message_reactions_message
  ON team_message_reactions(message_id);

ALTER TABLE team_message_reactions ENABLE ROW LEVEL SECURITY;

-- Anon SELECT — same reasoning as team_messages: required for Realtime to
-- deliver postgres_changes events to subscribed browsers. No anon write
-- policy exists, so the supabase-js client cannot insert/delete directly.
DROP POLICY IF EXISTS "team_message_reactions anon select"
  ON team_message_reactions;
CREATE POLICY "team_message_reactions anon select"
  ON team_message_reactions FOR SELECT TO anon
  USING (true);

-- REPLICA IDENTITY FULL — DELETE realtime payloads include the full old row.
-- Without this, Supabase only sends the primary key on DELETE, and the
-- client cannot tell which (message_id, emoji) just lost a reaction.
ALTER TABLE team_message_reactions REPLICA IDENTITY FULL;

-- Publish to Realtime. Guarded so re-running is safe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'team_message_reactions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE team_message_reactions;
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 2) Reply columns on team_messages
-- ---------------------------------------------------------------------------
-- All three are nullable: a normal (non-reply) post has all three NULL. A
-- reply has all three set, denormalized at insert time by the POST route
-- after looking up the parent. NO foreign key on reply_to_message_id — that
-- way a soft-deleted parent doesn't cascade-null these columns, and the
-- preview keeps rendering on the reply card.

ALTER TABLE team_messages
  ADD COLUMN IF NOT EXISTS reply_to_message_id UUID,
  ADD COLUMN IF NOT EXISTS reply_to_salesperson_name TEXT,
  ADD COLUMN IF NOT EXISTS reply_to_message_preview TEXT;

-- ===========================================================================
-- VERIFICATION (run after the migration)
-- ===========================================================================
-- SELECT tablename, rowsecurity FROM pg_tables
-- WHERE tablename = 'team_message_reactions';
--   -- expect rowsecurity = true
--
-- SELECT policyname, cmd, roles FROM pg_policies
-- WHERE tablename = 'team_message_reactions';
--   -- expect one row: "team_message_reactions anon select" / SELECT / {anon}
--
-- SELECT relreplident FROM pg_class
-- WHERE relname = 'team_message_reactions';
--   -- expect 'f' (FULL)
--
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
-- WHERE conrelid = 'team_message_reactions'::regclass
--   AND contype = 'c';
--   -- expect one row: team_message_reactions_emoji_allowed
--   -- with definition CHECK (emoji = ANY (ARRAY['😂', '🔥', '👏', '💪', '🍊', '❤️', '🧡', '‼️']))
--
-- SELECT tablename FROM pg_publication_tables
-- WHERE pubname = 'supabase_realtime'
--   AND tablename = 'team_message_reactions';
--   -- expect one row
--
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'team_messages'
--   AND column_name IN (
--     'reply_to_message_id',
--     'reply_to_salesperson_name',
--     'reply_to_message_preview'
--   );
--   -- expect three rows
