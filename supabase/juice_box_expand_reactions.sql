-- ===========================================================================
-- Expand the Juice Box reaction set.
-- ===========================================================================
-- WHAT THIS IS
--   Widens the `team_message_reactions.emoji` CHECK constraint to accept
--   four additional emoji (🎉 🚀 🙌 🏆) on top of the nine introduced in
--   `juice_box_pass4_conversations.sql` (migration #15). All previously-
--   allowed emoji remain valid — historical reaction rows are untouched.
--
-- WHY A SEPARATE FILE
--   `juice_box_pass4_conversations.sql` is the historical record of the
--   reaction model. Layering this expansion as its own tiny migration
--   keeps that history legible and makes it obvious from `git log` /
--   `supabase/README.md` exactly when the team's vocabulary grew.
--
-- WHAT DOESN'T CHANGE
--   * Existing reaction rows (every emoji in the old set is still in the
--     new set).
--   * The `(message_id, salesperson_id)` unique index — still one
--     reaction per user per message.
--   * RLS, realtime publication, REPLICA IDENTITY, indexes — untouched.
--   * Any app code paths other than `src/lib/team-messages.ts`'s
--     `ALLOWED_REACTIONS` array (which is kept in lockstep).
--
-- KEEPING THE TYPE & DB IN LOCKSTEP
--   The TS allow-list and this CHECK constraint must agree. If you add
--   another emoji later, update both in the same change:
--     1. Append to `ALLOWED_REACTIONS` in `src/lib/team-messages.ts`.
--     2. Drop-then-recreate the CHECK below (or add a new migration that
--        does the same).
--   Order in the CHECK doesn't matter; order in `ALLOWED_REACTIONS`
--   determines the on-screen order of the inline emoji bar.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT. Safe to re-run
-- against a database that already has the expanded set.
-- ===========================================================================

ALTER TABLE team_message_reactions
  DROP CONSTRAINT IF EXISTS team_message_reactions_emoji_allowed;
ALTER TABLE team_message_reactions
  ADD CONSTRAINT team_message_reactions_emoji_allowed
  CHECK (emoji IN (
    -- Original Pass 4 set (kept):
    '😂', '🔥', '👏', '💪', '🍊', '❤️', '🧡', '‼️', '👍',
    -- Culture-polish additions:
    '🎉', '🚀', '🙌', '🏆'
  ));

-- ===========================================================================
-- VERIFICATION (run after the migration)
-- ===========================================================================
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
-- WHERE conrelid = 'team_message_reactions'::regclass
--   AND contype = 'c';
--   -- expect one row: team_message_reactions_emoji_allowed
--   -- with the 13-element ARRAY definition above.
--
-- -- No historical rows should be invalidated. Sanity check:
-- SELECT DISTINCT emoji FROM team_message_reactions
-- WHERE emoji NOT IN
--   ('😂','🔥','👏','💪','🍊','❤️','🧡','‼️','👍','🎉','🚀','🙌','🏆');
--   -- expect zero rows
