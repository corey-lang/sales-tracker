BEGIN;

-- ===========================================================================
-- Juice Box — "Seen by X of Y": a per-user CAPABILITY, nothing else.
-- ===========================================================================
-- WHAT THE FEATURE NEEDS FROM THE DATABASE
--   1. A per-user CAPABILITY ("may see who has / has not seen a post"), and
--   2. A record of which posts each person actually REACHED.
--
-- WHY "SEEN" CANNOT BE DERIVED FROM THE READ MARKERS
--   Juice Box keeps one read marker per (person, channel) and stamps it with the
--   database's now() when the person lands at the newest post. On a first open the
--   feed has loaded only the latest page (50), yet that single write moves the
--   marker past EVERY older post, loaded or not — and past a post created between
--   the feed fetch and the write. That is right for the unread badge and the NEW
--   MESSAGES divider ("nothing newer than here is unread") and WRONG for "Seen by",
--   which claims a person reached one specific post. So the two concepts are kept
--   apart: the read markers are untouched and still drive unread; "seen" has its
--   own evidence.
--
-- THE EVIDENCE: team_message_seen
--   One row per (post, person) — written only when that person's client reports
--   the post was actually on their screen (visible, held in view briefly, tab
--   foregrounded). Nothing is written for posts never reached, so there is no
--   user x post fan-out; a first open with 100+ posts writes rows for the few
--   posts really on screen, and scrolling up writes the rest as they are reached.
--   The author needs no row (they wrote it). Rows are never updated: the first
--   time a post was reached is the only fact kept. NOT backfilled from the read
--   markers — that would reintroduce exactly the overstatement described above.
--
--   Written ONLY through juice_box_mark_seen(), which stamps the caller's id (the
--   route supplies the verified session's id; a client can never name another
--   person), ignores deleted / unknown posts, and is idempotent.
-- THE FLAG
--   salespeople.can_view_juice_box_seen — the same orthogonal per-user grant as
--   can_import_offices and can_manage_swag_leads. Admins (Corey, Ryan) need no
--   flag. Leah and Faith are juice_box_only accounts, and other juice_box_only
--   guests exist who must NOT get this, so a role cannot express it — a flag can.
--
--   Granted to Tonja, Leah and Faith ONCE, in the run that CREATES the column.
--   Re-running this file never restores a grant an administrator revoked. Anyone
--   added later is granted deliberately:
--     UPDATE salespeople SET can_view_juice_box_seen = TRUE WHERE first_name = '…';
--
-- ACCESS MODEL
--   Unchanged: salespeople is server-only (RLS on, no anon grants), and every
--   Juice Box "seen" read goes through /api/team-messages/seen* behind a
--   server-side check of this flag (or role = 'admin').
--
-- ADDITIVE and IDEMPOTENT: one guarded ADD COLUMN, one CREATE TABLE IF NOT EXISTS,
-- one CREATE OR REPLACE FUNCTION. No existing row is altered beyond the one-time
-- grant above, and no existing table, marker or function is touched. Safe to re-run.
-- ===========================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'salespeople'
       AND column_name = 'can_view_juice_box_seen'
  ) THEN
    ALTER TABLE salespeople
      ADD COLUMN can_view_juice_box_seen BOOLEAN NOT NULL DEFAULT FALSE;
    EXECUTE $grant$
      UPDATE salespeople
         SET can_view_juice_box_seen = TRUE
       WHERE first_name IN ('Tonja', 'Leah', 'Faith')
    $grant$;
  END IF;
END $$;


-- ---------------------------------------------------------------------------
-- team_message_seen — which posts each person actually reached
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS team_message_seen (
  message_id UUID NOT NULL REFERENCES team_messages(id) ON DELETE CASCADE,
  -- people are deactivated, never deleted (see supabase/README.md), so CASCADE only
  -- ever fires for an erased test row.
  salesperson_id UUID NOT NULL REFERENCES salespeople(id) ON DELETE CASCADE,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, salesperson_id)
);

-- Server-only, like the read markers: RLS on, no policies, no browser grants, not
-- in supabase_realtime.
ALTER TABLE team_message_seen ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON team_message_seen FROM anon, authenticated;

-- The ONE write path. `p_message_ids` is a JSON array of post ids (at most 100).
-- Returns how many NEW rows were recorded. Idempotent: a post already recorded for
-- this person is skipped, as are deleted / unknown posts and the person's own posts.
CREATE OR REPLACE FUNCTION juice_box_mark_seen(
  p_salesperson_id UUID,
  p_message_ids JSONB
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  recorded INTEGER;
BEGIN
  IF p_salesperson_id IS NULL OR p_message_ids IS NULL
     OR jsonb_typeof(p_message_ids) <> 'array' THEN
    RAISE EXCEPTION 'A person and an array of post ids are required' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_message_ids) > 100 THEN
    RAISE EXCEPTION 'At most 100 posts per call' USING ERRCODE = '22023';
  END IF;

  INSERT INTO team_message_seen (message_id, salesperson_id)
  SELECT m.id, p_salesperson_id
    FROM team_messages m
   WHERE m.id IN (SELECT DISTINCT (e)::uuid FROM jsonb_array_elements_text(p_message_ids) AS e)
     AND m.is_deleted = FALSE
     AND m.salesperson_id <> p_salesperson_id::text
  ON CONFLICT (message_id, salesperson_id) DO NOTHING;
  GET DIAGNOSTICS recorded = ROW_COUNT;
  RETURN recorded;
END;
$$;

REVOKE ALL ON FUNCTION juice_box_mark_seen(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION juice_box_mark_seen(UUID, JSONB) TO service_role;

COMMIT;


-- ===========================================================================
-- VERIFICATION (run after)
-- ===========================================================================
-- SELECT relname, relrowsecurity FROM pg_class WHERE relname = 'team_message_seen';   -- true
-- SELECT count(*) FROM team_message_seen;                                              -- 0 until people scroll
-- SELECT first_name, role, can_view_juice_box_seen FROM salespeople
--  WHERE can_view_juice_box_seen OR role = 'admin' ORDER BY role, first_name;
--   -- admins (Corey, Ryan, …) show FALSE: they are allowed by role, not by flag.
--   -- TRUE for Tonja, Leah, Faith.
-- ===========================================================================
