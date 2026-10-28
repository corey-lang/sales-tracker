-- ===========================================================================
-- READ-ONLY: what is still with James after the DFW West transfer, and why.
-- ===========================================================================
-- One query, one result table (the Supabase SQL editor shows only the LAST
-- statement's result, so this is deliberately a single SELECT). It changes
-- nothing — it can be run before, between and after runs of
-- transfer_james_dfw_west_to_kimberlee.sql.
--
-- COLUMNS
--   kind    'summary' | 'office' | 'agent'
--   id      the office / agent id (NULL on summary rows)
--   name    office name / agent name
--   detail  street address / brokerage — enough to find it
--   reason  why it is still with James, and what to do:
--             COLLISION …    an office Kimberlee already has matches it (same
--                            name+address+zip key, stored or recomputed, or the
--                            same Badger id). Reconcile the duplicate by hand
--                            (keep one, archive/merge the other), then re-run
--                            the transfer.
--             HAS ACTIVITIES the Gold List agent has activities, which are
--                            immutable and keyed to James. Decide separately.
--             ARCHIVED       an archived Gold List agent — outside the approved
--                            scope, left with James by design.
--             UNEXPLAINED …  still James's but none of the rules above explain
--                            it. This should not happen; do NOT run the transfer
--                            again until someone has looked.
--   The two 'summary' rows are the accounting the transfer enforces on every run:
--   still-with-James + provably-moved-to-Kimberlee should equal the approved
--   counts (1751 offices, 15 ACTIVE agents). status is OK or MISMATCH.
--
-- EXPECTED RIGHT AFTER A CLEAN TRANSFER: only the two summary rows (status OK,
-- left = 0, moved = 1751 / 15) and nothing else.
-- ===========================================================================

WITH j AS (SELECT id FROM salespeople WHERE first_name = 'James'),
     k AS (SELECT id FROM salespeople WHERE first_name = 'Kimberlee'),

-- Every office James still owns, with Kimberlee's matching office (if any).
-- The match rule is the one the transfer script and the importer use.
off_left AS (
  SELECT o.id, o.name, o.street,
         (SELECT 'COLLISION: same ' ||
                 CASE WHEN x.dedupe_key = o.dedupe_key
                        OR x.ckey = o.dedupe_key
                        OR x.dedupe_key = o.ckey
                        OR x.ckey = o.ckey
                      THEN 'name+address+zip'
                      ELSE 'external_badger_id' END ||
                 ' as Kimberlee''s office ' || x.id || ' ("' || x.name || '", ' || coalesce(x.street, '') || ')'
            FROM (
              SELECT kk.id, kk.name, kk.street, kk.dedupe_key, kk.environment, kk.external_badger_id,
                     btrim(regexp_replace(lower(coalesce(kk.name,   '')), '[^a-z0-9]+', ' ', 'g')) || '|' ||
                     btrim(regexp_replace(lower(coalesce(kk.street, '')), '[^a-z0-9]+', ' ', 'g')) || '|' ||
                     btrim(regexp_replace(lower(coalesce(kk.zip,    '')), '[^a-z0-9]+', ' ', 'g')) AS ckey
                FROM offices kk WHERE kk.salesperson_id = (SELECT id FROM k)
            ) x
           WHERE x.environment = o.environment
             AND (   x.dedupe_key = o.dedupe_key
                  OR x.ckey = o.dedupe_key
                  OR x.dedupe_key = o.ckey
                  OR x.ckey = o.ckey
                  OR (nullif(btrim(o.external_badger_id), '') IS NOT NULL
                      AND btrim(x.external_badger_id) = btrim(o.external_badger_id)))
           ORDER BY x.id LIMIT 1) AS collision
    FROM (
      SELECT oo.*,
             btrim(regexp_replace(lower(coalesce(oo.name,   '')), '[^a-z0-9]+', ' ', 'g')) || '|' ||
             btrim(regexp_replace(lower(coalesce(oo.street, '')), '[^a-z0-9]+', ' ', 'g')) || '|' ||
             btrim(regexp_replace(lower(coalesce(oo.zip,    '')), '[^a-z0-9]+', ' ', 'g')) AS ckey
        FROM offices oo WHERE oo.salesperson_id = (SELECT id FROM j)
    ) o
),

ag_left AS (
  SELECT g.id, g.agent_name, g.brokerage, g.archived_at,
         (SELECT COUNT(*) FROM gold_list_activities a WHERE a.agent_id = g.id) AS activities
    FROM gold_list_agents g
   WHERE g.salesperson_id = (SELECT id FROM j)
)

SELECT * FROM (
  -- Accounting: the transfer's own invariant, per kind.
  SELECT 'summary'::text AS kind, NULL::uuid AS id, 'offices'::text AS name,
         ('with James: ' || (SELECT COUNT(*) FROM off_left) ||
          ' | moved to Kimberlee (by provenance): ' ||
          (SELECT COUNT(*) FROM offices WHERE salesperson_id = (SELECT id FROM k) AND transferred_from_salesperson_id = (SELECT id FROM j)) ||
          ' | approved: 1751')::text AS detail,
         (CASE WHEN (SELECT COUNT(*) FROM off_left) +
                    (SELECT COUNT(*) FROM offices WHERE salesperson_id = (SELECT id FROM k) AND transferred_from_salesperson_id = (SELECT id FROM j)) = 1751
               THEN 'status: OK' ELSE 'status: MISMATCH — records are missing, unexplained or newly added' END)::text AS reason
  UNION ALL
  SELECT 'summary', NULL::uuid, 'active gold list agents',
         'active with James: ' || (SELECT COUNT(*) FROM ag_left WHERE archived_at IS NULL) ||
         ' | moved to Kimberlee (by provenance): ' ||
         (SELECT COUNT(*) FROM gold_list_agents WHERE salesperson_id = (SELECT id FROM k) AND transferred_from_salesperson_id = (SELECT id FROM j)) ||
         ' | approved: 15',
         CASE WHEN (SELECT COUNT(*) FROM ag_left WHERE archived_at IS NULL) +
                   (SELECT COUNT(*) FROM gold_list_agents WHERE salesperson_id = (SELECT id FROM k) AND transferred_from_salesperson_id = (SELECT id FROM j)) = 15
              THEN 'status: OK' ELSE 'status: MISMATCH — records are missing, unexplained or newly added' END

  UNION ALL
  -- Every office still with James, and why.
  SELECT 'office', l.id, l.name, l.street,
         coalesce(l.collision,
                  'UNEXPLAINED: no collision with Kimberlee''s list — it should have moved, so investigate before re-running')
    FROM off_left l

  UNION ALL
  -- Every Gold List agent still with James, and why.
  SELECT 'agent', a.id, a.agent_name, a.brokerage,
         CASE WHEN a.archived_at IS NOT NULL THEN 'ARCHIVED: outside the approved scope — left with James by design'
              WHEN a.activities > 0 THEN 'HAS ACTIVITIES (' || a.activities || '): immutable Gold List history keyed to James — decide separately'
              ELSE 'UNEXPLAINED: active, no activities — it should have moved, so investigate before re-running' END
    FROM ag_left a
) t
ORDER BY (CASE kind WHEN 'summary' THEN 0 WHEN 'office' THEN 1 ELSE 2 END), reason, name;
