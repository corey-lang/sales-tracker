-- ===========================================================================
-- Swag Leads — ONE-TIME load of the existing spreadsheet (TEMPLATE, not a
-- migration). Run it AFTER swag_leads.sql, in the Supabase SQL editor, once the
-- spreadsheet rows are pasted into the VALUES list below. It is deliberately a
-- script and not an in-app import feature: this load happens once.
-- ===========================================================================
-- WHAT IT DOES
--   Loads each spreadsheet row through create_swag_lead() — the same function
--   the app uses — so every lead gets its owner, its validation, and a
--   'created' history row. Nothing is inserted behind the function's back.
--
-- THE 12 SPREADSHEET COLUMNS, then the one the sheet doesn't have:
--   NAME | Contact info | Confirmed realtor? | Transactions in last 12 months |
--   Date Lead Received | Date of first contact | # of follow up attempts |
--   Swag delivered? | Did you meet in person? | Any orders received? | How many? |
--   Notes   +   assigned  (the AE's first name exactly as in salespeople, or OOA)
--
-- HOW EACH CELL IS READ (nothing is reinterpreted):
--   yes/no columns   yes / y / true / 1 / x  => Yes; anything else (incl. blank) => No.
--   Transactions     a whole number; blank => not recorded (NULL).
--   Dates            yyyy-mm-dd (reformat in Excel first); blank first-contact => not yet
--                    contacted ("Needs First Contact"). A blank Date Lead Received
--                    loads as TODAY — fill it in; it drives "oldest waiting first".
--   # follow ups     a whole number; blank => 0.
--   Any orders? / How many?   the AGENT's business with Elevate — not swag. A count above
--                    zero requires "Any orders received?" = yes (the row is reported
--                    and skipped otherwise, never silently "fixed").
--   Notes / Contact  loaded verbatim (trimmed).
--
-- SAFE TO RE-RUN. Each row carries a deterministic request id (a hash of name +
-- contact + date received), so running the script twice — or again after fixing
-- the rows it reported — loads each lead exactly once. A row the database
-- rejects (impossible date, first contact before received, unknown AE …) is
-- SKIPPED with a WARNING naming it; every other row still loads.
--
-- BEFORE YOU RUN
--   * `v_actor` below must be the admin the history should credit (Corey).
--   * `assigned` must name an existing, active, non-test AE, or OOA.
--   * The history starts on the load date: 'created' events carry today's
--     timestamp, not the original Date Lead Received (that stays in its column).
-- ===========================================================================

DO $$
DECLARE
  v_actor UUID := (SELECT id FROM salespeople WHERE first_name = 'Corey' AND role = 'admin' LIMIT 1);
  r RECORD;
  v_to UUID;
  v_ooa BOOLEAN;
  v_fields JSONB;
  v_loaded INTEGER := 0;
  v_skipped INTEGER := 0;
  v_row INTEGER := 0;
  yes TEXT[] := ARRAY['yes', 'y', 'true', '1', 'x'];
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Set v_actor: no admin named Corey found';
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      -- Paste one line per spreadsheet row, in column order, then the AE:
      --   ('Dana Whitaker', 'dana@example.com 801-555-0100', 'yes', '14', '2026-09-01',
      --    '2026-09-03', '3', 'yes', 'yes', 'yes', '4', 'Met at the open house', 'Hilary'),
      -- (This placeholder row is ignored.)
      (NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
       NULL::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::text)
    ) AS t(name, contact_info, confirmed_realtor, transactions, received, first_contact,
           followups, swag, met, orders_any, orders_n, notes, assigned)
    WHERE t.name IS NOT NULL
  LOOP
    v_row := v_row + 1;
    BEGIN
      v_ooa := upper(btrim(COALESCE(r.assigned, ''))) IN ('OOA', 'OUT OF AREA');
      IF v_ooa THEN
        v_to := NULL;
      ELSE
        SELECT id INTO v_to FROM salespeople
         WHERE first_name = btrim(r.assigned) AND role = 'ae'
           AND deactivated_at IS NULL AND NOT COALESCE(is_test, FALSE);
        IF NOT FOUND THEN
          RAISE EXCEPTION 'no active AE named "%" (use OOA for out-of-area leads)', r.assigned;
        END IF;
      END IF;

      v_fields := jsonb_strip_nulls(jsonb_build_object(
        'name', btrim(r.name),
        'contact_info', NULLIF(btrim(r.contact_info), ''),
        'confirmed_realtor', lower(btrim(COALESCE(r.confirmed_realtor, ''))) = ANY (yes),
        'transactions_last_12_months', NULLIF(btrim(r.transactions), '')::int,
        'date_lead_received', NULLIF(btrim(r.received), '')::date,
        'date_first_contact', NULLIF(btrim(r.first_contact), '')::date,
        'follow_up_attempts', COALESCE(NULLIF(btrim(r.followups), '')::int, 0),
        'swag_delivered', lower(btrim(COALESCE(r.swag, ''))) = ANY (yes),
        'met_in_person', lower(btrim(COALESCE(r.met, ''))) = ANY (yes),
        'orders_received', lower(btrim(COALESCE(r.orders_any, ''))) = ANY (yes),
        'orders_count', NULLIF(btrim(r.orders_n), '')::int,
        'notes', NULLIF(btrim(r.notes), '')));

      PERFORM create_swag_lead(
        v_actor, v_fields, v_to, v_ooa,
        md5('swag-lead-import|' || btrim(r.name) || '|' || COALESCE(btrim(r.contact_info), '')
            || '|' || COALESCE(btrim(r.received), ''))::uuid);
      v_loaded := v_loaded + 1;
    EXCEPTION WHEN OTHERS THEN
      v_skipped := v_skipped + 1;
      RAISE WARNING 'Row % (%) skipped: %', v_row, r.name, SQLERRM;
    END;
  END LOOP;

  RAISE NOTICE 'Swag leads load finished: % loaded (already-loaded rows count as loaded), % skipped.',
    v_loaded, v_skipped;
END $$;

-- CHECK AFTERWARDS
-- SELECT COALESCE(s.first_name::text, 'OOA') AS owner, count(*) AS leads,
--        count(*) FILTER (WHERE l.date_first_contact IS NULL) AS needs_first_contact,
--        sum(COALESCE(l.orders_count, 0)) AS orders
--   FROM swag_leads l LEFT JOIN salespeople s ON s.id = l.assigned_to
--  GROUP BY 1 ORDER BY 1;
