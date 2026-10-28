-- ===========================================================================
-- Onboard Kimberlee Duncan as the DFW West AE — replacing James.
-- ===========================================================================
-- WHAT THIS DOES (one atomic DO block; a failure anywhere changes nothing)
--   1. Creates Kimberlee as her OWN salesperson row — a new id, role 'ae'
--      (the standard AE role: every Sales Tracker AE tool plus Juice Box), a
--      real (non-test) account, with `started_on` = her first day.
--   2. Deactivates James (`deactivated_at`, migration #43): he can no longer
--      sign in, every API call from a session he already holds is refused, and
--      he leaves every live roster/selector. His row is KEPT.
--   3. Revokes James's Web Push devices (credentials, not history).
--   4. Points the existing "DFW West" Cogent territory mapping at Kimberlee, so
--      current rosters / order attribution show her for DFW West.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   * It does NOT rename James's row or reuse his id. He stays "James" with his
--     own id, so everything he did stays attributed to him: `activity_entries`,
--     `weekly_goals`, `office_visits`, `team_messages` (+ the author name stored
--     on each message), reactions/reads, `business_card_*`, `one_on_ones` and
--     coaching rows, `working_day_adjustments`. This script never UPDATEs or
--     DELETEs any of those tables.
--   * It does NOT transfer anything James OWNS (offices, Gold List agents, open
--     tasks, …). That is "operational ownership", a business decision — see
--     "OPERATIONAL RECORDS" below and supabase/README.md "Offboarding &
--     reassignment". Nothing is moved until someone approves a specific plan.
--   * It does NOT touch Cogent/order history: no order totals are stored per AE
--     (see TERRITORY HISTORY).
--
-- START DATE — CONFIRMED, NOT GUESSED
--   v_start_date is set to 2026-10-26 (Kimberlee's official first day, confirmed
--   by the business). It becomes `salespeople.started_on`, which keeps her OUT
--   of every report window that ended before she started, so her activity and
--   performance begin on their own, separate from James's. If it is ever set
--   back to NULL the script REFUSES TO RUN. Requires migration
--   `salespeople_started_on.sql` first.
--
--   TRANSITION WEEK (week of Mon 2026-10-26): both are on the roster for any
--   window that overlaps their dates — James through the day he is deactivated,
--   Kimberlee from 2026-10-26 — so that week's Activity Report, past-week
--   leaderboard and admin totals include both, and James's logged activity is
--   preserved. James's last logged activity today is 2026-10-20.
--
--   Login needs no other input: real AEs sign in by FIRST NAME alone — there is
--   no email or credential column for an AE, so none is created or guessed.
--
-- TERRITORY HISTORY ("DFW West keeps its history")
--   Territory reporting is keyed by the territory NAME ("DFW West"), which is
--   not renamed, recreated or deleted here — only the AE it rolls up to
--   changes. The By-Territory view and the per-territory daily baselines
--   (`order_today_baseline.territory_totals`) are keyed by that name, so they
--   continue across the staffing change. Order totals themselves are not stored
--   per AE: they are computed live, month-to-date, from Cogent through the
--   CURRENT mapping (src/lib/server/cogent.ts), so there is no stored per-AE
--   order history to preserve or lose.
--   The mapping is a single row per territory (UNIQUE on the name); re-pointing
--   it keeps the same row id and created_at, and `updated_at` records the
--   change. Previous holder: James (id 5f156683-b660-4684-b673-1afd5709fa27).
--
-- WHEN TO RUN IT (cutover timing — matters for the Orders tile only)
--   Orders are attributed through the mapping at the moment of each sync. The
--   daily "Today Orders" baseline is captured at the first sync of each Denver
--   day. If this runs AFTER that day's baseline exists, Kimberlee has no
--   baseline entry and her "Today" for the rest of that day would show the
--   whole month-to-date DFW West total (and her MTD would include orders James
--   closed earlier this month, since MTD is attributed to whoever holds the
--   territory). To avoid a misleading day: run it before the day's first sync
--   (the cron window starts at 11:00 UTC), or accept that one-day artifact, and
--   prefer the 1st of a month if business timing allows. The script does not
--   decide this for you.
--
-- OPERATIONAL RECORDS — IDENTIFIED, NOT MOVED
--   Counted from production on 2026-10-28 (read-only). THIS script moves none of
--   it — the separate transfer_james_dfw_west_to_kimberlee.sql does (run after
--   this one, once approved):
--     offices.salesperson_id            1,751 active offices (0 with next_action)
--     gold_list_agents.salesperson_id      15 agents (Gold List relationships)
--     ae_tasks (open)                       0
--     business_card_scans / _contacts       1 / 1 (authorship — would NOT move)
--     coaching_relationships               0 (nothing to move)
--   Historical authorship (never moves): activity_entries 99, office_visits 1,
--   team_messages 33 (+4 reactions, 47 seen markers), one_on_ones 7,
--   one_on_one_meetings 1, weekly_goals 1.
--   The transfer script moves ONLY the transferable category (offices and Gold
--   List agents) and records James as the previous owner in the nullable
--   `transferred_from_salesperson_id` provenance columns
--   (`ownership_transfer_provenance.sql`, applied first).
--
-- REVERSAL
--   UPDATE salespeople SET deactivated_at = NULL WHERE first_name = 'James';
--   UPDATE cogent_territory_mappings
--      SET salesperson_id = (SELECT id FROM salespeople WHERE first_name = 'James'),
--          updated_at = NOW()
--    WHERE sales_territory_name = 'DFW West';
--   (Kimberlee's row can be soft-disabled the same way; never deleted.)
--
-- IDEMPOTENT — SAFE TO RE-RUN
--   * `first_name` is CITEXT UNIQUE, and the script looks Kimberlee up before
--     creating her, so a re-run can never create a second account (or a
--     case/spacing variant of the name).
--   * An existing Kimberlee is verified (real AE, not deactivated). Her
--     `started_on` must be NULL (it is then filled) or ALREADY 2026-10-26 (kept
--     as is). A recorded start date that DIFFERS makes the script stop and
--     change nothing — a conflicting date is a data question for a person, not
--     something to overwrite or silently ignore.
--   * James's deactivation is COALESCE-guarded: a re-run keeps the ORIGINAL
--     timestamp (his final active day).
--   * The mapping is only updated when it does not already point at Kimberlee,
--     and the script refuses to run if DFW West is held by anyone other than
--     James or Kimberlee (someone reassigned it since this was written).
--   * Deleting push devices is a no-op once they are gone.
--   Depends on #43 (`deactivated_at`), #34 (`cogent_territory_mappings`) and
--   `salespeople_started_on.sql`. See supabase/README.md for migration order.
-- ===========================================================================

DO $$
DECLARE
  -- Kimberlee's first day — confirmed as Monday 2026-10-26. (Setting this back to
  -- NULL makes the script refuse to run; it is never defaulted or guessed.)
  v_start_date DATE := DATE '2026-10-26';

  -- OPTIONAL: James's final active moment, if it differs from "now". NULL (the
  -- default) stamps the moment this script runs, like every other deactivation.
  -- Only the DATE matters to reports: he stays on every report window that
  -- overlaps it. Leave NULL unless he stopped working before this script is run
  -- (e.g. TIMESTAMPTZ '2026-10-23 17:00-06').
  v_james_deactivated_at TIMESTAMPTZ := NULL;

  v_new_name   CONSTANT TEXT := 'Kimberlee';
  v_old_name   CONSTANT TEXT := 'James';
  v_territory  CONSTANT TEXT := 'DFW West';

  v_new_id     UUID;
  v_old_id     UUID;
  v_new_role   TEXT;
  v_new_test   BOOLEAN;
  v_new_deact  TIMESTAMPTZ;
  v_new_started DATE;
  v_holder_id  UUID;
  v_created    BOOLEAN := FALSE;
  v_rows       INTEGER;
BEGIN
  -- ---- Preconditions: fail loudly before changing anything ------------------
  IF v_start_date IS NULL THEN
    RAISE EXCEPTION 'Set v_start_date (Kimberlee''s first day, DATE ''yyyy-mm-dd'') before running this script. It is intentionally not guessed.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'salespeople' AND column_name = 'started_on'
  ) THEN
    RAISE EXCEPTION 'salespeople.started_on is missing. Apply supabase/salespeople_started_on.sql first.';
  END IF;

  -- first_name is CITEXT; comparing it to a TEXT variable would silently become
  -- case-SENSITIVE, so cast — otherwise 'kimberlee' would not be found.
  SELECT id INTO v_old_id FROM salespeople WHERE first_name = v_old_name::citext;
  IF v_old_id IS NULL THEN
    RAISE EXCEPTION 'No salesperson named % found — nothing to replace.', v_old_name;
  END IF;

  SELECT id, role, is_test, deactivated_at, started_on
    INTO v_new_id, v_new_role, v_new_test, v_new_deact, v_new_started
    FROM salespeople WHERE first_name = v_new_name::citext;

  SELECT salesperson_id INTO v_holder_id
    FROM cogent_territory_mappings WHERE sales_territory_name = v_territory;
  IF v_holder_id IS NOT NULL AND v_holder_id <> v_old_id AND v_holder_id IS DISTINCT FROM v_new_id THEN
    RAISE EXCEPTION '% is currently mapped to a salesperson other than % or % — refusing to overwrite. Review the mapping first.',
      v_territory, v_old_name, v_new_name;
  END IF;

  -- ---- 1) Kimberlee: create once, or verify the existing row ---------------
  IF v_new_id IS NULL THEN
    INSERT INTO salespeople (first_name, role, started_on)
    VALUES (v_new_name, 'ae', v_start_date)
    RETURNING id INTO v_new_id;
    v_created := TRUE;
  ELSE
    IF v_new_role <> 'ae' OR v_new_test OR v_new_deact IS NOT NULL THEN
      RAISE EXCEPTION 'A salesperson named % already exists but is not an active, real AE (role=%, is_test=%, deactivated=%). Resolve that row deliberately instead of re-using it here.',
        v_new_name, v_new_role, v_new_test, v_new_deact;
    END IF;
    IF v_new_started IS NOT NULL AND v_new_started <> v_start_date THEN
      RAISE EXCEPTION '% already exists with started_on = %, but this script onboards her as starting on %. Resolve the conflicting start date deliberately; nothing was changed.',
        v_new_name, v_new_started, v_start_date;
    END IF;
    UPDATE salespeople SET started_on = v_start_date
     WHERE id = v_new_id AND started_on IS NULL;   -- fill only; a matching date is left as is
  END IF;

  -- ---- 2) James: deactivate (soft-disable). First timestamp is kept. --------
  UPDATE salespeople
     SET deactivated_at = COALESCE(deactivated_at, v_james_deactivated_at, NOW())
   WHERE id = v_old_id;

  -- ---- 3) James: revoke push devices (salesperson_id is TEXT on this table) -
  DELETE FROM push_subscriptions WHERE salesperson_id = v_old_id::text;

  -- ---- 4) DFW West → Kimberlee (same mapping row; history keyed by name) ----
  -- Upsert so a missing row is created rather than silently skipped.
  INSERT INTO cogent_territory_mappings (sales_territory_name, salesperson_id, active)
  VALUES (v_territory, v_new_id, TRUE)
  ON CONFLICT (sales_territory_name) DO UPDATE
    SET salesperson_id = EXCLUDED.salesperson_id,
        active = TRUE,
        updated_at = NOW()
    WHERE cogent_territory_mappings.salesperson_id IS DISTINCT FROM EXCLUDED.salesperson_id
       OR cogent_territory_mappings.active IS DISTINCT FROM TRUE;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  RAISE NOTICE 'Kimberlee id=% (%), started_on=%; James id=% deactivated; % mapping row(s) changed.',
    v_new_id, CASE WHEN v_created THEN 'created' ELSE 'already existed' END, v_start_date, v_old_id, v_rows;
END
$$;

-- ===========================================================================
-- VERIFICATION (run after; read-only)
-- ===========================================================================
-- -- Exactly one Kimberlee, a real active AE, with her own id:
-- SELECT id, first_name, role, is_test, started_on, deactivated_at
--   FROM salespeople WHERE first_name IN ('Kimberlee', 'James');
--   -- expect Kimberlee: role 'ae', is_test false, started_on = her first day, deactivated_at NULL
--   -- expect James: SAME id as before, deactivated_at NOT NULL
--
-- -- DFW West now rolls up to Kimberlee:
-- SELECT m.sales_territory_name, s.first_name, m.active
--   FROM cogent_territory_mappings m JOIN salespeople s ON s.id = m.salesperson_id
--  WHERE m.sales_territory_name = 'DFW West';
--   -- expect 'DFW West' → Kimberlee, active = true
--
-- -- Current roster (login list / selectors): Kimberlee in, James out:
-- SELECT first_name FROM salespeople
--  WHERE role = 'ae' AND is_test = false AND deactivated_at IS NULL
--    AND first_name IN ('Kimberlee', 'James');
--   -- expect exactly one row: Kimberlee
--
-- -- James's history is untouched (counts must equal what they were before):
-- SELECT
--   (SELECT COUNT(*) FROM activity_entries WHERE salesperson_id = s.id)          AS activity_entries,   -- 99
--   (SELECT COUNT(*) FROM offices          WHERE salesperson_id = s.id)          AS offices,            -- 1751
--   (SELECT COUNT(*) FROM office_visits    WHERE salesperson_id = s.id)          AS office_visits,      -- 1
--   (SELECT COUNT(*) FROM team_messages    WHERE salesperson_id = s.id::text)    AS team_messages,      -- 33
--   (SELECT COUNT(*) FROM one_on_ones      WHERE ae_id = s.id)                   AS one_on_ones         -- 7
--   FROM salespeople s WHERE s.first_name = 'James';
--
-- -- Kimberlee starts with nothing of James's:
-- SELECT
--   (SELECT COUNT(*) FROM activity_entries WHERE salesperson_id = s.id) AS activity_entries,  -- 0
--   (SELECT COUNT(*) FROM offices          WHERE salesperson_id = s.id) AS offices            -- 0
--   FROM salespeople s WHERE s.first_name = 'Kimberlee';
