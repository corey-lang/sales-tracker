BEGIN;

-- ===========================================================================
-- Swag Leads — social-media prospecting leads worked by AEs.
-- ===========================================================================
-- WHAT THIS IS
--   A prospecting / follow-up tracker. An agent sees one of our social-media
--   posts and requests some of our swag; that gives the assigned AE a reason to
--   reach out, build a relationship and — hopefully — earn future business:
--
--     social lead -> AE contact -> follow-up -> relationship -> in-person
--     meeting -> swag delivered -> business/orders generated
--
--   It is NOT a swag-ordering system. There is no approval, rejection, vendor,
--   shipping, tracking, expected-delivery or order-status anywhere. "Swag
--   delivered?" is a plain yes/no prospecting outcome from the spreadsheet,
--   and "Any orders received?" / "How many?" mean business the AGENT has since
--   sent to Elevate — never swag quantities.
--
-- THE SPREADSHEET IS THE SOURCE OF TRUTH. Columns map 1:1, meaning unchanged:
--     NAME                          -> name
--     Contact info                  -> contact_info              (free text)
--     Confirmed realtor?            -> confirmed_realtor         (yes/no)
--     Transactions in last 12 mos   -> transactions_last_12_months (the lead's
--                                      production; NULL = not recorded)
--     Date Lead Received            -> date_lead_received
--     Date of first contact         -> date_first_contact        (NULL = not yet
--                                      contacted => "Needs First Contact")
--     # of follow up attempts       -> follow_up_attempts
--     Swag delivered?               -> swag_delivered            (yes/no)
--     Did you meet in person?       -> met_in_person             (yes/no)
--     Any orders received?          -> orders_received           (yes/no)
--     How many?                     -> orders_count              (orders the
--                                      agent sent us; NULL = not recorded)
--     Notes                         -> notes
--   Blank yes/no cells load as NO (FALSE). Orders: a count above zero requires
--   "orders received = yes" (CHECK); "yes" with no count is allowed (the answer
--   is known, the number isn't) and counts as an agent with orders, 0 orders.
--
-- APP FIELDS (not in the spreadsheet)
--   assigned_to / is_ooa  The CURRENT owner: exactly one of an AE
--                         (salespeople.id) or OOA = Out Of Area (is_ooa).
--                         OOA is a bucket, NOT a salespeople row / not an AE.
--                         Reuses the existing AE identity — no second AE list.
--   TERRITORY             Deliberately NOT a column. Territory already lives in
--                         cogent_territory_mappings (AE -> Cogent territory
--                         names, many per AE, reassignable). A copy on the lead
--                         would go stale the moment it was transferred, so the
--                         app DERIVES it from the current owner.
--   is_test_data          The lead belongs to a private test account (the Test
--                         AE sandbox). Immutable. Never counted anywhere.
--   revision              Bumped by every change; a save based on a stale
--                         revision is refused (409), so an old screen can't
--                         overwrite newer data or an owner's edit after a
--                         transfer.
--   create_request_id     Optional idempotency key so a double-tapped Save
--                         cannot create the lead twice.
--
-- ASSIGNMENT HISTORY IS IMMUTABLE
--   swag_lead_events records creation, every transfer (previous -> new, who,
--   when, why) and every important field change. UPDATE and DELETE on it are
--   refused by trigger, and its FK to swag_leads is RESTRICT, so a lead with
--   history can never be deleted. swag_leads.assigned_to / is_ooa can only
--   change inside transfer_swag_lead() (a trigger refuses any other path), so
--   an assignment can never change without its history row.
--
-- ALL WRITES GO THROUGH THREE service_role-ONLY FUNCTIONS, each ONE transaction
-- that RE-CHECKS the actor against the salespeople table itself (so the rules
-- hold even if an application route forgot):
--     create_swag_lead(actor, fields, assigned_to, ooa, request_id)
--     update_swag_lead(actor, id, expected_revision, patch)
--     transfer_swag_lead(actor, id, to_ae, to_ooa, reason, expected_revision)
--   WHO MAY DO WHAT
--     management  = role 'admin' OR salespeople.can_manage_swag_leads
--                   (Corey, Ryan, Tonja, Faith): create for anyone/OOA, edit
--                   every field, transfer any lead (incl. OOA -> AE).
--     AE (role 'ae'): create for THEMSELVES; edit the prospecting fields of a
--                   lead THEY currently own (not name / date received, which
--                   are source-of-truth data); transfer a lead they own to
--                   another AE or OOA. Nothing on anyone else's lead.
--   Concurrency: each function locks the lead row (FOR UPDATE) first, so two
--   transfers, or an edit and a transfer, serialize; the loser sees the new
--   owner / revision and is refused rather than overwriting.
--
-- ACCESS MODEL — server-only, like Gold List: RLS is ENABLED with NO policies
-- and anon/authenticated have no grants, so the browser key can neither read
-- nor write. Every read goes through /api/swag-leads/* (service role behind
-- requireSwagLeadsAccess).
--
-- NEW CAPABILITY FLAG: salespeople.can_manage_swag_leads, the same orthogonal
-- per-user grant pattern as can_import_offices (#26). Faith is a
-- juice_box_only account with no AE surface; a flag (not a role change) gives
-- her exactly this feature and nothing else. Granted to Tonja and Faith ONCE,
-- in the run that creates the column — re-running this file never restores a
-- revoked grant. Admins need no flag.
--
-- Additive and idempotent: ADD COLUMN IF NOT EXISTS, CREATE ... IF NOT EXISTS,
-- CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS. Safe to re-run; no
-- existing table or row is altered beyond the one new column.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1) Capability flag
-- ---------------------------------------------------------------------------

-- The initial grant (Tonja, Faith) happens ONCE: only in the run that CREATES the
-- column. A later re-run finds the column already there and grants nothing, so
-- an administrator who revokes someone's access is never overruled by a
-- re-applied migration. (Anyone added after this ran — e.g. a Faith/Tonja row
-- that did not exist yet — is granted deliberately:
--   UPDATE salespeople SET can_manage_swag_leads = TRUE WHERE first_name = '…';)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'salespeople'
       AND column_name = 'can_manage_swag_leads'
  ) THEN
    ALTER TABLE salespeople
      ADD COLUMN can_manage_swag_leads BOOLEAN NOT NULL DEFAULT FALSE;
    EXECUTE $grant$
      UPDATE salespeople
         SET can_manage_swag_leads = TRUE
       WHERE first_name IN ('Tonja', 'Faith')
    $grant$;
  END IF;
END $$;


-- ---------------------------------------------------------------------------
-- 2) swag_leads
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS swag_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ---- the spreadsheet, column for column ----
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  contact_info TEXT CHECK (contact_info IS NULL OR char_length(contact_info) <= 500),
  confirmed_realtor BOOLEAN NOT NULL DEFAULT FALSE,
  transactions_last_12_months INTEGER
    CHECK (transactions_last_12_months IS NULL
           OR transactions_last_12_months BETWEEN 0 AND 100000),
  date_lead_received DATE NOT NULL
    DEFAULT ((NOW() AT TIME ZONE 'America/Denver')::date),
  date_first_contact DATE,
  follow_up_attempts INTEGER NOT NULL DEFAULT 0
    CHECK (follow_up_attempts BETWEEN 0 AND 1000),
  swag_delivered BOOLEAN NOT NULL DEFAULT FALSE,
  met_in_person BOOLEAN NOT NULL DEFAULT FALSE,
  orders_received BOOLEAN NOT NULL DEFAULT FALSE,
  orders_count INTEGER CHECK (orders_count IS NULL OR orders_count BETWEEN 0 AND 100000),
  notes TEXT CHECK (notes IS NULL OR char_length(notes) <= 5000),

  -- ---- ownership ----
  -- RESTRICT: people are never deleted (deactivate instead), and a lead's
  -- owner must never silently vanish.
  assigned_to UUID REFERENCES salespeople(id) ON DELETE RESTRICT,
  is_ooa BOOLEAN NOT NULL DEFAULT FALSE,

  is_test_data BOOLEAN NOT NULL DEFAULT FALSE,
  revision INTEGER NOT NULL DEFAULT 0,
  create_request_id UUID,
  created_by UUID REFERENCES salespeople(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- EVERY lead has exactly one owner: an AE, or the OOA bucket.
  CONSTRAINT swag_leads_owner_xor_ooa CHECK ((assigned_to IS NOT NULL) <> is_ooa),
  -- First contact can't precede the lead existing.
  CONSTRAINT swag_leads_first_contact_not_before_received
    CHECK (date_first_contact IS NULL OR date_first_contact >= date_lead_received),
  -- Orders counted => "orders received" must be yes.
  CONSTRAINT swag_leads_orders_consistent
    CHECK (orders_count IS NULL OR orders_count = 0 OR orders_received)
);

CREATE INDEX IF NOT EXISTS idx_swag_leads_assigned_to
  ON swag_leads(assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_swag_leads_ooa
  ON swag_leads(date_lead_received DESC) WHERE is_ooa;
CREATE INDEX IF NOT EXISTS idx_swag_leads_received
  ON swag_leads(date_lead_received DESC, id);

-- A double-submitted create replays instead of duplicating.
CREATE UNIQUE INDEX IF NOT EXISTS idx_swag_leads_create_request
  ON swag_leads(create_request_id) WHERE create_request_id IS NOT NULL;


-- ---------------------------------------------------------------------------
-- 3) swag_lead_events — the immutable timeline
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS swag_lead_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Insertion order: the timeline's tiebreak-proof sort key (timestamps alone
  -- can tie), and proof of the order things actually happened in.
  seq BIGINT GENERATED ALWAYS AS IDENTITY,
  -- RESTRICT: a lead that has history can never be deleted.
  lead_id UUID NOT NULL REFERENCES swag_leads(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'transferred', 'updated')),
  -- Who did it. The name is frozen here so the record reads correctly even if
  -- a name is edited later. No ON DELETE action: people are deactivated, and a
  -- cascade/SET NULL would be an UPDATE on an immutable table.
  actor_id UUID NOT NULL REFERENCES salespeople(id) ON DELETE RESTRICT,
  actor_name TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Assignment: previous -> new. NULL id + label 'OOA' = Out Of Area. Frozen
  -- labels, like actor_name. 'created' has only the "to" side.
  from_assigned_to UUID,
  from_label TEXT,
  to_assigned_to UUID,
  to_label TEXT,
  reason TEXT CHECK (reason IS NULL OR char_length(reason) <= 500),
  -- 'updated': { field: { "from": <old>, "to": <new> } } (notes: { "changed": true }).
  changes JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT swag_lead_events_transfer_has_both_sides CHECK (
    event_type <> 'transferred' OR (from_label IS NOT NULL AND to_label IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_swag_lead_events_lead
  ON swag_lead_events(lead_id, seq);

-- History is append-only: no edits, no deletes — for anyone, including the
-- service role.
CREATE OR REPLACE FUNCTION swag_lead_events_are_immutable()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'Swag lead history is immutable' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS trg_swag_lead_events_immutable ON swag_lead_events;
CREATE TRIGGER trg_swag_lead_events_immutable
  BEFORE UPDATE OR DELETE ON swag_lead_events
  FOR EACH ROW EXECUTE FUNCTION swag_lead_events_are_immutable();


-- ---------------------------------------------------------------------------
-- 4) Row guard: what can never change, and assignment only via transfer
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION guard_swag_lead_row()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Swag leads are never deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.created_at <> OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.is_test_data <> OLD.is_test_data
     OR NEW.create_request_id IS DISTINCT FROM OLD.create_request_id THEN
    RAISE EXCEPTION 'That swag lead field is permanent' USING ERRCODE = '23514';
  END IF;
  -- Ownership moves ONLY inside transfer_swag_lead(), which also writes the
  -- history row in the same transaction. (The flag is transaction-local.)
  IF (NEW.assigned_to IS DISTINCT FROM OLD.assigned_to OR NEW.is_ooa <> OLD.is_ooa)
     AND COALESCE(current_setting('app.swag_lead_transfer', TRUE), '') <> 'on' THEN
    RAISE EXCEPTION 'A swag lead can only be reassigned through transfer_swag_lead()'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_swag_lead_row ON swag_leads;
CREATE TRIGGER trg_guard_swag_lead_row
  BEFORE UPDATE OR DELETE ON swag_leads
  FOR EACH ROW EXECUTE FUNCTION guard_swag_lead_row();


-- ---------------------------------------------------------------------------
-- 5) Server-only access
-- ---------------------------------------------------------------------------

ALTER TABLE swag_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE swag_lead_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON swag_leads FROM anon, authenticated;
REVOKE ALL ON swag_lead_events FROM anon, authenticated;


-- ---------------------------------------------------------------------------
-- 6) Helpers (internal; service_role only)
-- ---------------------------------------------------------------------------

-- Re-reads the actor from salespeople. Refuses unknown / deactivated people and
-- anyone who is neither management nor an AE (e.g. a plain juice_box_only
-- guest). Error 42501 = insufficient_privilege.
CREATE OR REPLACE FUNCTION swag_lead_actor(
  p_actor UUID,
  OUT o_is_manager BOOLEAN,
  OUT o_name TEXT,
  OUT o_is_test BOOLEAN
) LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v_role TEXT;
  v_flag BOOLEAN;
  v_deactivated TIMESTAMPTZ;
  v_name TEXT;
  v_test BOOLEAN;
BEGIN
  SELECT role, can_manage_swag_leads, deactivated_at, first_name::text, is_test
    INTO v_role, v_flag, v_deactivated, v_name, v_test
    FROM salespeople WHERE id = p_actor;
  IF NOT FOUND OR v_deactivated IS NOT NULL THEN
    RAISE EXCEPTION 'Unknown or inactive user' USING ERRCODE = '42501';
  END IF;
  o_is_manager := (v_role = 'admin') OR COALESCE(v_flag, FALSE);
  IF NOT o_is_manager AND v_role <> 'ae' THEN
    RAISE EXCEPTION 'Swag Leads is not available to this account' USING ERRCODE = '42501';
  END IF;
  o_name := v_name;
  o_is_test := COALESCE(v_test, FALSE);
END;
$$;

-- Validates a destination (exactly one of an AE or OOA) and returns its frozen
-- label. The AE must be an active AE on the SAME side of the test/real line as
-- the lead. Error 22023 = invalid_parameter_value.
CREATE OR REPLACE FUNCTION swag_lead_resolve_target(
  p_to UUID,
  p_ooa BOOLEAN,
  p_lead_is_test BOOLEAN,
  OUT o_label TEXT
) LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v_role TEXT;
  v_deactivated TIMESTAMPTZ;
  v_name TEXT;
  v_test BOOLEAN;
BEGIN
  IF COALESCE(p_ooa, FALSE) = (p_to IS NOT NULL) THEN
    RAISE EXCEPTION 'Choose exactly one of an AE or OOA' USING ERRCODE = '22023';
  END IF;
  IF p_ooa THEN
    o_label := 'OOA';
    RETURN;
  END IF;
  SELECT role, deactivated_at, first_name::text, is_test
    INTO v_role, v_deactivated, v_name, v_test
    FROM salespeople WHERE id = p_to;
  IF NOT FOUND OR v_role <> 'ae' THEN
    RAISE EXCEPTION 'Leads can only be assigned to an AE or OOA' USING ERRCODE = '22023';
  END IF;
  IF v_deactivated IS NOT NULL THEN
    RAISE EXCEPTION 'That AE is no longer active' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(v_test, FALSE) <> p_lead_is_test THEN
    RAISE EXCEPTION 'Test and real leads cannot be mixed' USING ERRCODE = '22023';
  END IF;
  o_label := v_name;
END;
$$;


-- ---------------------------------------------------------------------------
-- 7) create_swag_lead
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION create_swag_lead(
  p_actor UUID,
  p_fields JSONB,
  p_assigned_to UUID,
  p_ooa BOOLEAN,
  p_request_id UUID DEFAULT NULL
) RETURNS swag_leads
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  creatable CONSTANT TEXT[] := ARRAY[
    'name', 'contact_info', 'confirmed_realtor', 'transactions_last_12_months',
    'date_lead_received', 'date_first_contact', 'follow_up_attempts',
    'swag_delivered', 'met_in_person', 'orders_received', 'orders_count', 'notes'];
  a RECORD;
  f swag_leads;
  k TEXT;
  v_target_test BOOLEAN := FALSE;
  v_test BOOLEAN;
  v_label TEXT;
  existing swag_leads;
  created swag_leads;
BEGIN
  SELECT * INTO a FROM swag_lead_actor(p_actor);
  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object' THEN
    RAISE EXCEPTION 'fields must be an object' USING ERRCODE = '22023';
  END IF;
  FOR k IN SELECT jsonb_object_keys(p_fields) LOOP
    IF NOT (k = ANY(creatable)) THEN
      RAISE EXCEPTION 'Unknown swag lead field %', k USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- An AE may only create a lead for themselves; management may create for
  -- any AE or OOA.
  IF NOT a.o_is_manager AND (COALESCE(p_ooa, FALSE) OR p_assigned_to IS DISTINCT FROM p_actor) THEN
    RAISE EXCEPTION 'You can only add leads to your own list' USING ERRCODE = '42501';
  END IF;

  -- Replay of a double-submitted create: return the original, change nothing —
  -- but ONLY to someone who may still see it. Creating a lead does not entitle
  -- the creator to it forever: once it has been transferred away, the former
  -- owner gets "not found" (P0002) and no lead data, exactly as for any other
  -- read. Management may always see it.
  IF p_request_id IS NOT NULL THEN
    SELECT * INTO existing FROM swag_leads WHERE create_request_id = p_request_id;
    IF FOUND THEN
      IF existing.created_by IS DISTINCT FROM p_actor THEN
        RAISE EXCEPTION 'Request id already used' USING ERRCODE = '23505';
      END IF;
      IF NOT a.o_is_manager AND existing.assigned_to IS DISTINCT FROM p_actor THEN
        RAISE EXCEPTION 'Swag lead not found' USING ERRCODE = 'P0002';
      END IF;
      RETURN existing;
    END IF;
  END IF;

  IF p_assigned_to IS NOT NULL THEN
    SELECT COALESCE(is_test, FALSE) INTO v_target_test FROM salespeople WHERE id = p_assigned_to;
  END IF;
  v_test := a.o_is_test OR v_target_test;
  SELECT o_label INTO v_label FROM swag_lead_resolve_target(p_assigned_to, p_ooa, v_test);

  f := jsonb_populate_record(NULL::swag_leads, p_fields);
  IF f.name IS NULL OR btrim(f.name) = '' THEN
    RAISE EXCEPTION 'A lead needs a name' USING ERRCODE = '22023';
  END IF;

  BEGIN
    INSERT INTO swag_leads (
      name, contact_info, confirmed_realtor, transactions_last_12_months,
      date_lead_received, date_first_contact, follow_up_attempts,
      swag_delivered, met_in_person, orders_received, orders_count, notes,
      assigned_to, is_ooa, is_test_data, create_request_id, created_by)
    VALUES (
      btrim(f.name), NULLIF(btrim(f.contact_info), ''), COALESCE(f.confirmed_realtor, FALSE),
      f.transactions_last_12_months,
      COALESCE(f.date_lead_received, (NOW() AT TIME ZONE 'America/Denver')::date),
      f.date_first_contact, COALESCE(f.follow_up_attempts, 0),
      COALESCE(f.swag_delivered, FALSE), COALESCE(f.met_in_person, FALSE),
      COALESCE(f.orders_received, FALSE), f.orders_count, NULLIF(btrim(f.notes), ''),
      CASE WHEN COALESCE(p_ooa, FALSE) THEN NULL ELSE p_assigned_to END,
      COALESCE(p_ooa, FALSE), v_test, p_request_id, p_actor)
    RETURNING * INTO created;
  EXCEPTION WHEN unique_violation THEN
    -- Two taps of Save racing each other: the other one won. Replay it — under
    -- the same current-owner rule as the up-front replay above (the winner may
    -- already have been transferred away before this tap's insert gave up).
    IF p_request_id IS NOT NULL THEN
      SELECT * INTO existing FROM swag_leads WHERE create_request_id = p_request_id;
      IF FOUND AND existing.created_by IS NOT DISTINCT FROM p_actor THEN
        IF NOT a.o_is_manager AND existing.assigned_to IS DISTINCT FROM p_actor THEN
          RAISE EXCEPTION 'Swag lead not found' USING ERRCODE = 'P0002';
        END IF;
        RETURN existing;
      END IF;
    END IF;
    RAISE;
  END;

  INSERT INTO swag_lead_events (lead_id, event_type, actor_id, actor_name, to_assigned_to, to_label)
  VALUES (created.id, 'created', p_actor, a.o_name, created.assigned_to, v_label);

  RETURN created;
END;
$$;


-- ---------------------------------------------------------------------------
-- 8) update_swag_lead
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION update_swag_lead(
  p_actor UUID,
  p_id UUID,
  p_expected_revision INTEGER,
  p_patch JSONB
) RETURNS swag_leads
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  -- Fields the owning AE may change.
  ae_fields CONSTANT TEXT[] := ARRAY[
    'contact_info', 'confirmed_realtor', 'transactions_last_12_months',
    'date_first_contact', 'follow_up_attempts', 'swag_delivered', 'met_in_person',
    'orders_received', 'orders_count', 'notes'];
  -- Source-of-truth fields only management may change.
  manager_fields CONSTANT TEXT[] := ARRAY['name', 'date_lead_received'];
  a RECORD;
  old swag_leads;
  nw swag_leads;
  k TEXT;
  changes JSONB := '{}'::jsonb;
BEGIN
  SELECT * INTO a FROM swag_lead_actor(p_actor);
  IF p_expected_revision IS NULL THEN
    RAISE EXCEPTION 'expected_revision is required' USING ERRCODE = '22004';
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'patch must be an object' USING ERRCODE = '22023';
  END IF;

  -- The lead row is locked FIRST: edits, transfers and other edits serialize.
  SELECT * INTO old FROM swag_leads WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Swag lead not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT a.o_is_manager AND old.assigned_to IS DISTINCT FROM p_actor THEN
    RAISE EXCEPTION 'You can only edit your own leads' USING ERRCODE = '42501';
  END IF;
  IF old.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'This lead was changed by someone else' USING ERRCODE = '40001';
  END IF;

  FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF NOT (k = ANY(ae_fields) OR k = ANY(manager_fields)) THEN
      RAISE EXCEPTION 'Unknown or protected swag lead field %', k USING ERRCODE = '22023';
    END IF;
  END LOOP;

  nw := jsonb_populate_record(old, p_patch);
  nw.name := btrim(nw.name);
  nw.contact_info := NULLIF(btrim(nw.contact_info), '');
  nw.notes := NULLIF(btrim(nw.notes), '');

  FOREACH k IN ARRAY (ae_fields || manager_fields) LOOP
    IF to_jsonb(nw) -> k IS DISTINCT FROM to_jsonb(old) -> k THEN
      IF k = ANY(manager_fields) AND NOT a.o_is_manager THEN
        RAISE EXCEPTION 'Only management can change %', k USING ERRCODE = '42501';
      END IF;
      changes := changes || jsonb_build_object(
        k,
        CASE WHEN k = 'notes'
             THEN jsonb_build_object('changed', TRUE)
             ELSE jsonb_build_object('from', to_jsonb(old) -> k, 'to', to_jsonb(nw) -> k) END);
    END IF;
  END LOOP;

  -- Nothing actually changed: no revision bump, no history row.
  IF changes = '{}'::jsonb THEN
    RETURN old;
  END IF;

  UPDATE swag_leads SET
    name = nw.name, contact_info = nw.contact_info,
    confirmed_realtor = nw.confirmed_realtor,
    transactions_last_12_months = nw.transactions_last_12_months,
    date_lead_received = nw.date_lead_received,
    date_first_contact = nw.date_first_contact,
    follow_up_attempts = nw.follow_up_attempts,
    swag_delivered = nw.swag_delivered, met_in_person = nw.met_in_person,
    orders_received = nw.orders_received, orders_count = nw.orders_count,
    notes = nw.notes,
    revision = old.revision + 1
  WHERE id = p_id
  RETURNING * INTO nw;

  INSERT INTO swag_lead_events (lead_id, event_type, actor_id, actor_name, changes)
  VALUES (p_id, 'updated', p_actor, a.o_name, changes);

  RETURN nw;
END;
$$;


-- ---------------------------------------------------------------------------
-- 9) transfer_swag_lead
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION transfer_swag_lead(
  p_actor UUID,
  p_id UUID,
  p_to_assigned_to UUID,
  p_to_ooa BOOLEAN,
  p_reason TEXT DEFAULT NULL,
  p_expected_revision INTEGER DEFAULT NULL
) RETURNS swag_leads
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  a RECORD;
  old swag_leads;
  nw swag_leads;
  v_from_label TEXT;
  v_to_label TEXT;
BEGIN
  SELECT * INTO a FROM swag_lead_actor(p_actor);

  -- Lock first: a concurrent transfer/edit finishes before this one looks.
  SELECT * INTO old FROM swag_leads WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Swag lead not found' USING ERRCODE = 'P0002';
  END IF;
  -- Management may transfer anything (incl. OOA -> AE). An AE may transfer a
  -- lead only while THEY are its current owner.
  IF NOT a.o_is_manager AND old.assigned_to IS DISTINCT FROM p_actor THEN
    RAISE EXCEPTION 'You can only transfer your own leads' USING ERRCODE = '42501';
  END IF;
  IF p_expected_revision IS NOT NULL AND old.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'This lead was changed by someone else' USING ERRCODE = '40001';
  END IF;

  SELECT o_label INTO v_to_label
    FROM swag_lead_resolve_target(p_to_assigned_to, p_to_ooa, old.is_test_data);
  IF COALESCE(p_to_ooa, FALSE) = old.is_ooa
     AND p_to_assigned_to IS NOT DISTINCT FROM old.assigned_to THEN
    RAISE EXCEPTION 'That lead is already assigned there' USING ERRCODE = '23514';
  END IF;

  IF old.is_ooa THEN
    v_from_label := 'OOA';
  ELSE
    SELECT first_name::text INTO v_from_label FROM salespeople WHERE id = old.assigned_to;
  END IF;

  PERFORM set_config('app.swag_lead_transfer', 'on', TRUE);
  UPDATE swag_leads SET
    assigned_to = CASE WHEN COALESCE(p_to_ooa, FALSE) THEN NULL ELSE p_to_assigned_to END,
    is_ooa = COALESCE(p_to_ooa, FALSE),
    revision = old.revision + 1
  WHERE id = p_id
  RETURNING * INTO nw;
  PERFORM set_config('app.swag_lead_transfer', 'off', TRUE);

  INSERT INTO swag_lead_events (
    lead_id, event_type, actor_id, actor_name,
    from_assigned_to, from_label, to_assigned_to, to_label, reason)
  VALUES (
    p_id, 'transferred', p_actor, a.o_name,
    old.assigned_to, v_from_label, nw.assigned_to, v_to_label,
    NULLIF(btrim(p_reason), ''));

  RETURN nw;
END;
$$;


-- ---------------------------------------------------------------------------
-- 10) Grants: the application (service_role) only
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION swag_lead_actor(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION swag_lead_resolve_target(UUID, BOOLEAN, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION create_swag_lead(UUID, JSONB, UUID, BOOLEAN, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION update_swag_lead(UUID, UUID, INTEGER, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION transfer_swag_lead(UUID, UUID, UUID, BOOLEAN, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION swag_lead_actor(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION swag_lead_resolve_target(UUID, BOOLEAN, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION create_swag_lead(UUID, JSONB, UUID, BOOLEAN, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION update_swag_lead(UUID, UUID, INTEGER, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION transfer_swag_lead(UUID, UUID, UUID, BOOLEAN, TEXT, INTEGER) TO service_role;

COMMIT;


-- ===========================================================================
-- VERIFICATION (run after)
-- ===========================================================================
-- SELECT relname, relrowsecurity FROM pg_class
--  WHERE relname IN ('swag_leads','swag_lead_events');                       -- both true
-- SELECT count(*) FROM pg_policies WHERE tablename LIKE 'swag_lead%';         -- 0
-- SELECT first_name, can_manage_swag_leads FROM salespeople
--  WHERE can_manage_swag_leads;                                               -- Tonja, Faith
-- SELECT has_function_privilege('anon',
--   'transfer_swag_lead(uuid,uuid,uuid,boolean,text,integer)', 'execute');   -- false
-- ===========================================================================
