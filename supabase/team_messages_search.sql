-- Juice Box full-history search indexes.
--
-- Why:
--   /api/team-messages/search scans message text and author names across
--   historical rows. These indexes keep that query fast as message volume
--   grows.
--
-- Idempotent and safe to rerun.

-- ILIKE acceleration (message body, author name, reply preview).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_team_messages_live_message_trgm
  ON team_messages USING GIN (message gin_trgm_ops)
  WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS idx_team_messages_live_salesperson_name_trgm
  ON team_messages USING GIN (salesperson_name gin_trgm_ops)
  WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS idx_team_messages_live_reply_preview_trgm
  ON team_messages USING GIN (reply_to_message_preview gin_trgm_ops)
  WHERE is_deleted = false;
