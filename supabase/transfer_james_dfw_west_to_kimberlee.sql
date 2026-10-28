-- ===========================================================================
-- Transfer James's DFW West book to Kimberlee: offices + ACTIVE Gold List agents.
-- ===========================================================================
-- WHAT THIS DOES (one atomic DO block; a failure anywhere changes nothing)
--   Re-points ONLY the two kinds of operational ownership that were approved:
--     * offices            — James's offices (1,751 expected: one Badger import
--                            from 2026-05-28, all with map coordinates)
--     * gold_list_agents   — James's ACTIVE Gold List agents (15 expected;
--                            `archived_at IS NULL`). Archived agents are not part
--                            of the transfer and stay with James.
--   For every row it moves it sets `salesperson_id` to Kimberlee and records the
--   previous owner: `transferred_from_salesperson_id` = James and
--   `transferred_at` = now. NOTHING ELSE on the row changes — the id, name,
--   address, coordinates, `office_notes`, `next_action`, contact details,
--   `external_badger_id`, `source`, `import_batch_id`, `created_at`, and every
--   Gold List note / relationship field stay exactly as they are. (The tables'
--   own `updated_at` trigger stamps the move time; that is the only other
--   difference.)
--
-- WHAT IT DOES NOT TOUCH — history stays James's
--   No statement here touches activity_entries, weekly_goals, office_visits,
--   team_messages (+ reactions/reads), business_card_*, one_on_ones /
--   commitments, working_day_adjustments, or Gold List ACTIVITIES. James's
--   visits stay attributed to him (office_visits.salesperson_id is unchanged),
--   as do his activity and Juice Box posts.
--   Visible consequence, by design: the office detail screen shows the visits of
--   the office's CURRENT owner, so James's one June 2026 visit (and any other
--   visit he logged) remains on his record but no longer renders in Kimberlee's
--   view of that office; the Map's "last visit" for Kimberlee likewise counts
--   only her own visits. Nothing is lost; it is simply not hers.
--
-- EVERY RECORD MUST BE ACCOUNTED FOR (checked on EVERY run, not just the first)
--   For offices, and separately for active Gold List agents:
--       still owned by James  +  already moved to Kimberlee  =  approved count
--   where "already moved" means rows owned by Kimberlee whose
--   `transferred_from_salesperson_id` is James. This makes a legitimate re-run
--   (nothing left to move, everything provably moved earlier) pass, and makes
--   everything else fail ATOMICALLY with nothing changed:
--     * rows missing or unexplained — deleted, re-assigned elsewhere, or moved
--       without provenance — so the two sides no longer add up;
--     * rows added since the review, so the set is not the one that was approved.
--   After the updates the script re-counts and aborts (rolling back) if the
--   result is not exactly what it set out to do.
--
-- OTHER SAFETY CHECKS (any failure raises and changes nothing)
--   * Both people exist; Kimberlee is an active, real AE; James is already
--     DEACTIVATED (so this cannot run before onboard_kimberlee_dfw_west.sql).
--   * The provenance columns exist (ownership_transfer_provenance.sql).
--
-- ROWS LEFT WITH JAMES — BY RULE, AND REPORTED (resolve, then re-run)
--   * OFFICES that collide with something Kimberlee already has, using the SAME
--     scope the application uses to decide two offices are the same one (the
--     importer, src/app/api/admin/offices/import/route.ts): within her list and
--     the same environment, either
--       - the same name+street+zip KEY — compared as stored OR as recomputed
--         from the office's current name/street/zip, so an AE edit through the
--         detail screen cannot hide a duplicate — which is also what the
--         `uq_offices_dedupe_per_env` unique index would reject; or
--       - the same non-blank `external_badger_id` (the importer's strongest
--         match). Two NULL/blank ids never collide.
--     Archived offices of hers count: the importer matches them too. Such a pair
--     is a duplicate to reconcile by hand, not to overwrite; the rest still move.
--   * GOLD LIST AGENTS that have Gold List activities. Activities are keyed to
--     (agent, owner) and immutable by trigger, so moving the agent would either
--     fail or rewrite activity history. (Production: James's agents have none.)
--   * ARCHIVED Gold List agents, by design: they are outside the approved scope.
--   Run supabase/transfer_james_dfw_west_leftovers.sql (read-only) any time to
--   list every office / agent still with James and exactly why.
--
-- IDENTITY MATCHING AFTER THE MOVE
--   The offices keep their `external_badger_id`. A later Badger import run for
--   Kimberlee matches these offices by that stable id instead of creating
--   duplicates, and fills only blanks.
--
-- WHEN TO RUN IT
--   After, and only after: (1) ownership_transfer_provenance.sql and (2)
--   onboard_kimberlee_dfw_west.sql. Run once approved; it is not part of the
--   onboarding. Existing sessions are unaffected — Kimberlee simply sees the
--   offices on her Map and the agents on her Gold List next load.
--
-- REVERSAL (only rows still carrying James as previous owner)
--   UPDATE offices SET salesperson_id = transferred_from_salesperson_id,
--          transferred_from_salesperson_id = NULL, transferred_at = NULL
--    WHERE transferred_from_salesperson_id = (SELECT id FROM salespeople WHERE first_name = 'James')
--      AND salesperson_id = (SELECT id FROM salespeople WHERE first_name = 'Kimberlee');
--   (Same for gold_list_agents. Edits Kimberlee made in the meantime stay on the
--   rows; her own visits to them would stay hers.)
--
-- IDEMPOTENT — SAFE TO RE-RUN
--   Only rows still owned by James are moved, so a re-run after completion moves
--   nothing and changes no timestamps (and passes the accounting check above
--   because every row is provably Kimberlee's by provenance); a re-run after
--   resolving a reported collision moves just the remainder.
-- See supabase/README.md for migration order.
-- ===========================================================================

DO $$
DECLARE
  v_from_name CONSTANT TEXT := 'James';
  v_to_name   CONSTANT TEXT := 'Kimberlee';

  -- The approved scope (counted from production on 2026-10-28).
  v_expected_offices CONSTANT INTEGER := 1751;
  v_expected_agents  CONSTANT INTEGER := 15;   -- ACTIVE agents only

  v_from UUID;
  v_to   UUID;
  v_to_role   TEXT;
  v_to_test   BOOLEAN;
  v_to_deact  TIMESTAMPTZ;
  v_from_deact TIMESTAMPTZ;

  v_off_todo INTEGER; v_off_done INTEGER; v_off_blocked INTEGER; v_off_moved INTEGER := 0;
  v_ag_todo  INTEGER; v_ag_done  INTEGER; v_ag_blocked  INTEGER; v_ag_moved  INTEGER := 0;
  v_after_left INTEGER; v_after_done INTEGER;
BEGIN
  -- ---- Preconditions --------------------------------------------------------
  IF (SELECT COUNT(*) FROM information_schema.columns
       WHERE table_schema = 'public'
         AND column_name IN ('transferred_from_salesperson_id', 'transferred_at')
         AND table_name IN ('offices', 'gold_list_agents')) <> 4 THEN
    RAISE EXCEPTION 'Provenance columns are missing. Apply supabase/ownership_transfer_provenance.sql first.';
  END IF;

  -- first_name is CITEXT; cast the TEXT variables so the match is case-insensitive.
  SELECT id, deactivated_at INTO v_from, v_from_deact FROM salespeople WHERE first_name = v_from_name::citext;
  IF v_from IS NULL THEN RAISE EXCEPTION 'No salesperson named % found.', v_from_name; END IF;

  SELECT id, role, is_test, deactivated_at INTO v_to, v_to_role, v_to_test, v_to_deact
    FROM salespeople WHERE first_name = v_to_name::citext;
  IF v_to IS NULL THEN
    RAISE EXCEPTION '% does not exist yet. Run supabase/onboard_kimberlee_dfw_west.sql first.', v_to_name;
  END IF;
  IF v_to_role <> 'ae' OR v_to_test OR v_to_deact IS NOT NULL THEN
    RAISE EXCEPTION '% is not an active, real AE (role=%, is_test=%, deactivated=%) — refusing to hand her a book.', v_to_name, v_to_role, v_to_test, v_to_deact;
  END IF;
  IF v_from_deact IS NULL THEN
    RAISE EXCEPTION '% is still active. Run supabase/onboard_kimberlee_dfw_west.sql first (it deactivates him).', v_from_name;
  END IF;

  -- ---- The application's notion of "same office" ----------------------------
  -- Mirrors buildOfficeDedupeKey(): normalize each part (lowercase, runs of
  -- non-alphanumerics → one space, trimmed) and join with '|'.
  CREATE OR REPLACE FUNCTION pg_temp.office_key(p_name TEXT, p_street TEXT, p_zip TEXT) RETURNS TEXT
  LANGUAGE sql IMMUTABLE AS $f$
    SELECT btrim(regexp_replace(lower(coalesce(p_name,   '')), '[^a-z0-9]+', ' ', 'g')) || '|' ||
           btrim(regexp_replace(lower(coalesce(p_street, '')), '[^a-z0-9]+', ' ', 'g')) || '|' ||
           btrim(regexp_replace(lower(coalesce(p_zip,    '')), '[^a-z0-9]+', ' ', 'g'))
  $f$;

  -- Why (if at all) James's office p_office cannot be moved into p_dest's list.
  -- NULL = no collision. Scope = the importer's: same owner list + environment,
  -- archived rows included.
  CREATE OR REPLACE FUNCTION pg_temp.office_collision(p_office UUID, p_dest UUID) RETURNS TEXT
  LANGUAGE sql STABLE AS $f$
    SELECT CASE
             WHEN k.dedupe_key = o.dedupe_key
               OR pg_temp.office_key(k.name, k.street, k.zip) = o.dedupe_key
               OR k.dedupe_key = pg_temp.office_key(o.name, o.street, o.zip)
               OR pg_temp.office_key(k.name, k.street, k.zip) = pg_temp.office_key(o.name, o.street, o.zip)
             THEN 'same name+address+zip as office ' || k.id
             ELSE 'same external_badger_id as office ' || k.id
           END
      FROM offices o
      JOIN offices k
        ON k.salesperson_id = p_dest
       AND k.environment = o.environment
     WHERE o.id = p_office
       AND (   k.dedupe_key = o.dedupe_key
            OR pg_temp.office_key(k.name, k.street, k.zip) = o.dedupe_key
            OR k.dedupe_key = pg_temp.office_key(o.name, o.street, o.zip)
            OR pg_temp.office_key(k.name, k.street, k.zip) = pg_temp.office_key(o.name, o.street, o.zip)
            OR (nullif(btrim(o.external_badger_id), '') IS NOT NULL
                AND btrim(k.external_badger_id) = btrim(o.external_badger_id)))
     ORDER BY k.id
     LIMIT 1
  $f$;

  -- ---- Offices ----------------------------------------------------------------
  SELECT COUNT(*) INTO v_off_todo FROM offices WHERE salesperson_id = v_from;
  SELECT COUNT(*) INTO v_off_done FROM offices
   WHERE salesperson_id = v_to AND transferred_from_salesperson_id = v_from;
  IF v_off_todo + v_off_done <> v_expected_offices THEN
    RAISE EXCEPTION 'Offices do not add up: approved scope is %, but % still belong to % and % are provably already Kimberlee''s (transferred from %). Missing, unexplained or newly added records — stopping with nothing changed.',
      v_expected_offices, v_off_todo, v_from_name, v_off_done, v_from_name;
  END IF;

  SELECT COUNT(*) INTO v_off_blocked FROM offices o
   WHERE o.salesperson_id = v_from AND pg_temp.office_collision(o.id, v_to) IS NOT NULL;

  UPDATE offices o
     SET salesperson_id = v_to,
         transferred_from_salesperson_id = v_from,
         transferred_at = NOW()
   WHERE o.salesperson_id = v_from
     AND pg_temp.office_collision(o.id, v_to) IS NULL;
  GET DIAGNOSTICS v_off_moved = ROW_COUNT;

  -- ---- Gold List agents (ACTIVE only) ---------------------------------------
  SELECT COUNT(*) INTO v_ag_todo FROM gold_list_agents
   WHERE salesperson_id = v_from AND archived_at IS NULL;
  -- "Already moved" is by provenance and does NOT require the agent to still be
  -- active: Kimberlee may have archived one since the transfer.
  SELECT COUNT(*) INTO v_ag_done FROM gold_list_agents
   WHERE salesperson_id = v_to AND transferred_from_salesperson_id = v_from;
  IF v_ag_todo + v_ag_done <> v_expected_agents THEN
    RAISE EXCEPTION 'Gold List agents do not add up: approved scope is % active agents, but % active ones still belong to % and % are provably already Kimberlee''s (transferred from %). Missing, unexplained or newly added records — stopping with nothing changed.',
      v_expected_agents, v_ag_todo, v_from_name, v_ag_done, v_from_name;
  END IF;

  SELECT COUNT(*) INTO v_ag_blocked FROM gold_list_agents g
   WHERE g.salesperson_id = v_from AND g.archived_at IS NULL
     AND EXISTS (SELECT 1 FROM gold_list_activities a WHERE a.agent_id = g.id);

  UPDATE gold_list_agents g
     SET salesperson_id = v_to,
         transferred_from_salesperson_id = v_from,
         transferred_at = NOW()
   WHERE g.salesperson_id = v_from
     AND g.archived_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM gold_list_activities a WHERE a.agent_id = g.id);
  GET DIAGNOSTICS v_ag_moved = ROW_COUNT;

  -- ---- Re-count: the result must be exactly what was planned ----------------
  SELECT COUNT(*) INTO v_after_left FROM offices WHERE salesperson_id = v_from;
  SELECT COUNT(*) INTO v_after_done FROM offices WHERE salesperson_id = v_to AND transferred_from_salesperson_id = v_from;
  IF v_after_left <> v_off_todo - v_off_moved OR v_after_done <> v_off_done + v_off_moved
     OR v_after_left <> v_off_blocked OR v_after_left + v_after_done <> v_expected_offices THEN
    RAISE EXCEPTION 'Office transfer result does not match the plan (left=%, moved-so-far=%, blocked=%, expected total=%) — rolling back.',
      v_after_left, v_after_done, v_off_blocked, v_expected_offices;
  END IF;

  SELECT COUNT(*) INTO v_after_left FROM gold_list_agents WHERE salesperson_id = v_from AND archived_at IS NULL;
  SELECT COUNT(*) INTO v_after_done FROM gold_list_agents WHERE salesperson_id = v_to AND transferred_from_salesperson_id = v_from;
  IF v_after_left <> v_ag_todo - v_ag_moved OR v_after_done <> v_ag_done + v_ag_moved
     OR v_after_left <> v_ag_blocked OR v_after_left + v_after_done <> v_expected_agents THEN
    RAISE EXCEPTION 'Gold List transfer result does not match the plan (active left=%, moved-so-far=%, blocked=%, expected total=%) — rolling back.',
      v_after_left, v_after_done, v_ag_blocked, v_expected_agents;
  END IF;

  RAISE NOTICE 'Offices: % moved to % (% already moved earlier), % left with % (collision with her list). Active Gold List agents: % moved (% already moved earlier), % left with % (have activities). Archived agents were not in scope. Run supabase/transfer_james_dfw_west_leftovers.sql to list what was left and why.',
    v_off_moved, v_to_name, v_off_done, v_off_blocked, v_from_name, v_ag_moved, v_ag_done, v_ag_blocked, v_from_name;
END
$$;

-- ===========================================================================
-- VERIFICATION (run after; read-only)
-- ===========================================================================
-- -- Everything moved, previous owner recorded:
-- SELECT
--   (SELECT COUNT(*) FROM offices WHERE salesperson_id = k.id AND transferred_from_salesperson_id = j.id) AS offices_moved,   -- 1751
--   (SELECT COUNT(*) FROM offices WHERE salesperson_id = j.id)                                            AS offices_left,    -- 0
--   (SELECT COUNT(*) FROM gold_list_agents WHERE salesperson_id = k.id AND transferred_from_salesperson_id = j.id) AS agents_moved, -- 15
--   (SELECT COUNT(*) FROM gold_list_agents WHERE salesperson_id = j.id AND archived_at IS NULL)           AS active_agents_left -- 0
--   FROM salespeople j, salespeople k WHERE j.first_name = 'James' AND k.first_name = 'Kimberlee';
--
-- -- James's history is untouched (counts must equal what they were before):
-- SELECT
--   (SELECT COUNT(*) FROM activity_entries WHERE salesperson_id = s.id)       AS activity_entries, -- 99
--   (SELECT COUNT(*) FROM office_visits    WHERE salesperson_id = s.id)       AS office_visits,    -- 1
--   (SELECT COUNT(*) FROM team_messages    WHERE salesperson_id = s.id::text) AS team_messages     -- 33
--   FROM salespeople s WHERE s.first_name = 'James';
