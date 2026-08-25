-- ===========================================================================
-- Juice Box channels — General / Product Help / Social Media Hub.
-- ===========================================================================
-- WHAT THIS IS
--   Splits the single Juice Box feed into three channels. Purely ADDITIVE —
--   nothing existing is altered, renamed, or dropped:
--
--     1. team_messages.channel  TEXT NOT NULL DEFAULT 'general'  (+ CHECK)
--     2. idx_team_messages_live_channel_created_at  (new partial index)
--     3. team_message_channel_reads  (NEW table: per-channel read markers,
--        keyed (salesperson_id, channel), backfilled from the legacy table)
--     4. juice_box_mark_channel_read() / juice_box_mark_legacy_read()
--        (NEW RPCs: ATOMIC, MONOTONIC mark-read — a marker can never move
--        backwards, enforced inside Postgres)
--     5. juice_box_conversation_moves (NEW audit table) +
--        juice_box_move_conversation() (NEW RPC: admin "Move conversation" —
--        moves a whole reply tree between channels in ONE transaction and
--        records the move)
--     6. Triggers that make a split thread IMPOSSIBLE at the database level:
--        a reply INSERT takes the conversation root's row lock and re-reads the
--        authoritative channel under it, so reply creation and a move can never
--        pass one another
--
--   Channel ids are stable strings, kept in lockstep with
--   `JUICE_BOX_CHANNELS` in src/lib/team-messages.ts:
--     'general'           — team discussion, updates, announcements, wins
--     'product_help'      — coverage, pricing, plans, service, objections
--     'social_media_hub'  — post ideas, captions, content requests, examples
--
-- EXPAND-AND-MIGRATE (why there is a NEW table instead of an altered one)
--   An earlier draft moved `team_message_reads`'s unique key from
--   (salesperson_id) to (salesperson_id, channel). That created a rollout trap:
--   the currently deployed app upserts read markers with
--   `onConflict: "salesperson_id"`, which STOPS WORKING the moment that index
--   moves — so applying the migration first broke the live app, and deploying
--   the app first failed for lack of the column. There was no safe order.
--
--   This version expands instead. `team_message_reads` is left completely
--   untouched — same columns, same single-column unique index, same trigger,
--   same grants — so the deployed bundle and any stale browser tab keep
--   marking reads exactly as before. The channel-aware code writes to the NEW
--   table. Either order of (migrate, deploy) is safe:
--     * migration first → old app keeps using the legacy table; the new table
--       simply sits unused until the deploy.
--     * deploy first    → not required, but see the note under BACKWARD
--       COMPATIBILITY for what the new bundle needs.
--
--   RETIREMENT: `team_message_reads` may be dropped only in a SEPARATE future
--   cleanup migration, once no old client can still be running (all sessions
--   on the channel-aware bundle) and after confirming nothing else reads it.
--   Do not fold that drop into this file — its whole purpose is to keep the
--   old path alive during the overlap.
--
-- BACKWARD COMPATIBILITY of team_messages.channel
--   * `ADD COLUMN ... NOT NULL DEFAULT 'general'` is a catalog-only change in
--     Postgres 11+: existing rows backfill to General with no table rewrite,
--     no row touched, nothing deleted or recreated.
--   * The OLD app never sends a channel on insert — the DEFAULT supplies
--     'general', so its posts keep landing in the feed the team already sees.
--   * The OLD app's SELECT lists explicit columns and never asks for `channel`,
--     so its reads are unaffected; its realtime payloads simply carry one extra
--     field, which its client types ignore.
--   * Therefore the column is safe to apply at any time, before or after the
--     deploy, with the old bundle running.
--   * The app normalizes a null/unknown channel to 'general' on read
--     (`normalizeChannel`), so a cached client blob or an in-flight realtime
--     payload from before this migration can never render as "no channel".
--
--   The NEW bundle does require this migration (it selects `channel` and reads
--   the new table), so the recommended order is: apply this migration, then
--   deploy. Applying it early is harmless.
--
-- REALTIME / RLS / GRANTS
--   `team_messages` keeps RLS on with its anon SELECT policy (required for
--   Realtime) and stays in the `supabase_realtime` publication — the new
--   column rides along in the payload. The new reads table mirrors
--   `team_message_reads` exactly: RLS ENABLED with NO policy (server-only via
--   the service-role routes; anon has zero access), NOT published to realtime
--   (nobody should see another user's read state), and the same
--   `updated_at` trigger pattern.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP-then-ADD for CHECK constraints,
-- CREATE TABLE/INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION, DROP TRIGGER
-- IF EXISTS + CREATE TRIGGER, and an ON CONFLICT DO NOTHING backfill that
-- neither duplicates nor overwrites on a re-run.
-- See supabase/README.md for migration order.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1) team_messages.channel
-- ---------------------------------------------------------------------------

ALTER TABLE team_messages
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'general';

-- Closed value set. DROP-then-ADD is the idempotent pattern for CHECK
-- constraints (there is no IF NOT EXISTS form). The server also validates the
-- value with a zod enum before insert; this is the database-level backstop so
-- no path — including a hand-written SQL insert — can create a fourth channel
-- the UI has no tab for.
ALTER TABLE team_messages
  DROP CONSTRAINT IF EXISTS team_messages_channel_allowed;
ALTER TABLE team_messages
  ADD CONSTRAINT team_messages_channel_allowed
  CHECK (channel IN ('general', 'product_help', 'social_media_hub'));

-- Hot read path is now per channel:
--   WHERE is_deleted = false AND channel = $1 ORDER BY created_at DESC LIMIT n
-- Partial (live rows only) + channel-leading so the feed and the per-channel
-- unread counts both index-scan. The older
-- idx_team_messages_live_created_at index is intentionally KEPT: the
-- cross-channel search path still orders by created_at without a channel
-- predicate, and the old bundle's feed query has no channel predicate either.
CREATE INDEX IF NOT EXISTS idx_team_messages_live_channel_created_at
  ON team_messages(channel, created_at DESC)
  WHERE is_deleted = false;

-- ---------------------------------------------------------------------------
-- 2) team_message_channel_reads — per-channel read markers (NEW table)
-- ---------------------------------------------------------------------------
-- One row per (salesperson_id, channel). Mirrors team_message_reads' shape and
-- security posture; the only difference is the channel dimension in the key.

CREATE TABLE IF NOT EXISTS team_message_channel_reads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- TEXT mirrors team_messages.salesperson_id / team_message_reads
  -- .salesperson_id (see team_messages.sql for the rationale: keeps records
  -- readable even if a salespeople row is removed). Holds the UUID string
  -- from salespeople.id at write time.
  salesperson_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Named CHECK added separately (not inline) so re-running this file re-asserts
-- it even on a database where the table already existed.
ALTER TABLE team_message_channel_reads
  DROP CONSTRAINT IF EXISTS team_message_channel_reads_channel_allowed;
ALTER TABLE team_message_channel_reads
  ADD CONSTRAINT team_message_channel_reads_channel_allowed
  CHECK (channel IN ('general', 'product_help', 'social_media_hub'));

-- One marker per person PER CHANNEL. Also drives ON CONFLICT for both the
-- backfill below and the monotonic `juice_box_mark_channel_read` RPC in
-- section 4 (the app never upserts this table directly).
CREATE UNIQUE INDEX IF NOT EXISTS uq_team_message_channel_reads_person_channel
  ON team_message_channel_reads(salesperson_id, channel);

-- No separate salesperson_id index: every read path supplies the full key or
-- filters by salesperson_id alone, which the leading column of the unique
-- index above already serves. An extra index would only slow writes — same
-- reasoning as team_message_reads.sql.

-- updated_at maintenance — same lightweight per-table pattern as
-- team_message_reads.sql / ae_tasks.sql. Server routes also write updated_at
-- on upsert; the trigger guarantees correctness if anything else ever updates
-- a row directly.
CREATE OR REPLACE FUNCTION set_team_message_channel_reads_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_team_message_channel_reads_updated_at
  ON team_message_channel_reads;
CREATE TRIGGER trg_team_message_channel_reads_updated_at
  BEFORE UPDATE ON team_message_channel_reads
  FOR EACH ROW
  EXECUTE FUNCTION set_team_message_channel_reads_updated_at();

-- Server-only access, identical to team_message_reads: RLS on, NO policy.
-- The service-role key (server routes) bypasses RLS; anon is locked out. Read
-- state is per-user, so no client ever needs to subscribe to it — which is
-- also why this table is deliberately NOT added to supabase_realtime.
ALTER TABLE team_message_channel_reads ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 3) Backfill: every legacy marker becomes that person's GENERAL marker
-- ---------------------------------------------------------------------------
-- The legacy table's single marker always meant "the Juice Box feed", which is
-- now General — so copying it across preserves each person's unread state
-- exactly, and the two NEW channels correctly start with no marker at all
-- (which the app reads as "land at the latest message, no NEW MESSAGES divider
-- above old content").
--
-- IDEMPOTENT + NON-DESTRUCTIVE, in that order of importance:
--   * ON CONFLICT DO NOTHING means a re-run inserts nothing and, crucially,
--     never overwrites a General marker the channel-aware app has since
--     advanced. Re-running after a week of use is a no-op, not a rewind.
--   * The legacy rows are only READ. Nothing is updated or deleted there.
--
-- The to_regclass guard keeps this file re-runnable after the future cleanup
-- migration eventually drops the legacy table: with the table gone, the copy
-- is skipped instead of failing.
DO $$
BEGIN
  IF to_regclass('public.team_message_reads') IS NOT NULL THEN
    INSERT INTO team_message_channel_reads (
      salesperson_id, channel, last_read_at, updated_at
    )
    SELECT salesperson_id, 'general', last_read_at, updated_at
    FROM team_message_reads
    ON CONFLICT (salesperson_id, channel) DO NOTHING;
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- 4) Atomic, MONOTONIC mark-read RPCs
-- ---------------------------------------------------------------------------
-- WHY THESE EXIST — the race they close
--   Mark-read used to be an unconditional upsert with an app-generated
--   timestamp:
--
--     request A stamps T1, request B stamps a later T2, but the two writes
--     reach Postgres in the reverse order → T2 lands first, then T1
--     OVERWRITES it.
--
--   The marker moves BACKWARD, and already-read posts come back as unread: a
--   stale NEW MESSAGES divider and an initial scroll into old history. Two
--   taps, a retry, a double-mounted effect, or one slow request are enough —
--   and General's later-of-two resolver does not excuse it, because both
--   sources can regress the same way.
--
--   Any fix that compares in JavaScript (or reads, compares, then writes) has
--   the same race between the check and the write. So the rule is enforced by
--   the DATABASE, in ONE statement:
--
--     last_read_at = GREATEST(existing.last_read_at, incoming.last_read_at)
--
--   With that, a late older write is a no-op on the value: an out-of-order
--   arrival can never lower the marker, no matter how the requests interleave.
--
-- TIMESTAMP SOURCE
--   Generated INSIDE Postgres (`now()`), not supplied by the caller. That
--   removes the application clock, request latency, and serverless cold starts
--   from the ordering question entirely — there is no caller-provided value
--   left to be stale. `now()` is transaction-start time, which is the
--   CONSERVATIVE choice (never later than the commit), so the marker cannot
--   claim to have seen a message the reader had not yet received.
--
--   GREATEST is still required: concurrent transactions each get their own
--   `now()` and can still commit in either order.
--
-- RETURN VALUE
--   Each function RETURNS the PERSISTED `last_read_at` (via RETURNING), so the
--   API answers with what the database actually holds — never with an incoming
--   timestamp the database rejected as older.
--
-- SECURITY
--   * SECURITY INVOKER (explicit, not merely the default): the function runs
--     with the CALLER's privileges. Both tables are RLS-enabled with NO policy,
--     so only the service-role key — i.e. our own server routes — can write
--     through them. SECURITY DEFINER is deliberately NOT used: it would let a
--     lower-privileged role (anon/authenticated) write read markers for ANY
--     salesperson_id, which is exactly the privilege-escalation path we must
--     not create.
--   * `SET search_path = pg_catalog, public` pins name resolution, so a
--     mutable session search_path cannot shadow a table or operator the body
--     depends on. Objects are schema-qualified as well.
--   * EXECUTE is REVOKED from PUBLIC / anon / authenticated (Postgres grants
--     EXECUTE to PUBLIC by default — that default is the whole reason for the
--     revoke) and GRANTED only to service_role.
--   * Identity is NOT verifiable inside the function; it has no session
--     context. `p_salesperson_id` is therefore trusted to be server-controlled,
--     which the EXECUTE grant enforces: the only caller is
--     POST /api/team-messages/reads/me, which passes the id from the verified
--     session token and never from the request body.
--   * The channel is validated in the function AND constrained by the table
--     CHECK, so a fourth channel cannot be created through this path.
--
-- TRANSACTIONS / FAILURE BEHAVIOUR
--   These are TWO separate functions, called as two separate statements, so
--   they run in two separate transactions. That separation is the point: the
--   channel write is authoritative and commits on its own, and a failure of the
--   General legacy mirror (second call) can neither roll it back nor fail the
--   request. The route logs a mirror failure and returns success with the
--   authoritative timestamp. Non-General channels never call the legacy
--   function at all.
--
-- Idempotent: CREATE OR REPLACE FUNCTION (which also preserves existing
-- grants), followed by explicit REVOKE/GRANT that are safe to re-assert.
-- ---------------------------------------------------------------------------

-- 4a) Channel-specific marker — the authoritative write.
CREATE OR REPLACE FUNCTION public.juice_box_mark_channel_read(
  p_salesperson_id TEXT,
  p_channel TEXT
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_persisted TIMESTAMPTZ;
BEGIN
  IF p_salesperson_id IS NULL OR btrim(p_salesperson_id) = '' THEN
    RAISE EXCEPTION 'juice_box_mark_channel_read: salesperson_id is required';
  END IF;
  IF p_channel IS NULL
     OR p_channel NOT IN ('general', 'product_help', 'social_media_hub') THEN
    RAISE EXCEPTION
      'juice_box_mark_channel_read: unknown channel %', p_channel;
  END IF;

  -- ONE statement: insert when absent, otherwise keep the LATER of the two.
  -- The update runs even when GREATEST resolves to the existing value; that
  -- keeps RETURNING single-statement (a WHERE-filtered DO UPDATE returns no
  -- row) and refreshes updated_at to record the attempt.
  INSERT INTO public.team_message_channel_reads AS t (
    salesperson_id, channel, last_read_at, updated_at
  )
  VALUES (p_salesperson_id, p_channel, now(), now())
  ON CONFLICT (salesperson_id, channel) DO UPDATE
    SET last_read_at = GREATEST(t.last_read_at, EXCLUDED.last_read_at),
        updated_at = now()
  RETURNING t.last_read_at INTO v_persisted;

  RETURN v_persisted;
END;
$fn$;

REVOKE ALL ON FUNCTION public.juice_box_mark_channel_read(TEXT, TEXT)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.juice_box_mark_channel_read(TEXT, TEXT)
  FROM anon;
REVOKE ALL ON FUNCTION public.juice_box_mark_channel_read(TEXT, TEXT)
  FROM authenticated;
GRANT EXECUTE ON FUNCTION public.juice_box_mark_channel_read(TEXT, TEXT)
  TO service_role;

-- 4b) Legacy global marker — the General-only, best-effort mirror.
--     Same monotonic rule so the compatibility write cannot regress either.
--     Retire this together with the legacy table (and the mirror call in
--     src/app/api/team-messages/reads/me/route.ts) in the future cleanup
--     migration.
CREATE OR REPLACE FUNCTION public.juice_box_mark_legacy_read(
  p_salesperson_id TEXT
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_persisted TIMESTAMPTZ;
BEGIN
  IF p_salesperson_id IS NULL OR btrim(p_salesperson_id) = '' THEN
    RAISE EXCEPTION 'juice_box_mark_legacy_read: salesperson_id is required';
  END IF;

  INSERT INTO public.team_message_reads AS t (
    salesperson_id, last_read_at, updated_at
  )
  VALUES (p_salesperson_id, now(), now())
  ON CONFLICT (salesperson_id) DO UPDATE
    SET last_read_at = GREATEST(t.last_read_at, EXCLUDED.last_read_at),
        updated_at = now()
  RETURNING t.last_read_at INTO v_persisted;

  RETURN v_persisted;
END;
$fn$;

REVOKE ALL ON FUNCTION public.juice_box_mark_legacy_read(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.juice_box_mark_legacy_read(TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.juice_box_mark_legacy_read(TEXT)
  FROM authenticated;
GRANT EXECUTE ON FUNCTION public.juice_box_mark_legacy_read(TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 5) Admin "Move conversation" — audit table + atomic move RPC
-- ---------------------------------------------------------------------------
-- WHAT THIS IS
--   An admin can move a whole Juice Box CONVERSATION (a root post plus every
--   reply beneath it, to any depth) from one channel to another — a Product
--   Help question posted in General, say. The move is one transaction: either
--   the entire thread lands in the destination and an audit row is written, or
--   nothing changes at all.
--
-- WHY THE WHOLE THREAD, ALWAYS
--   Replies are chained by `team_messages.reply_to_message_id`, and a reply can
--   itself be replied to, so a conversation is a TREE of arbitrary depth. If a
--   reply were left behind, it would sit in a channel without its parent — the
--   quoted block would point at a post the reader cannot reach, and the server's
--   reply guard (a reply must live in its parent's channel) would be violated
--   by our own admin tool. So the RPC resolves the ROOT from whatever message
--   the admin clicked (walking UP the chain) and then moves the root's entire
--   descendant tree (walking DOWN, recursively).
--
-- WHAT IS PRESERVED
--   Everything except `channel`. The UPDATE touches that single column, so
--   author, body, `created_at`, reply pointers, media/attachments, mentions and
--   `is_deleted` are untouched — a soft-deleted member of the thread moves
--   WITH it and stays soft-deleted, so the thread can never be split by a
--   moderation action. Reactions live in `team_message_reactions` keyed by
--   `message_id` and are therefore carried along implicitly. Nothing is
--   inserted or deleted, so no duplicate posts and no new push notification
--   (push only fires from the app's INSERT path).
--
-- CONCURRENCY
--   The root row is locked FOR UPDATE first, then the whole tree, ordered by
--   id. Two admins moving the same conversation therefore serialize on the root
--   lock: the first wins, and the second finds the thread already in its
--   destination (JB001) or in a different source than it read (JB002) — an
--   error, never a half-moved thread. After the UPDATE the tree is re-derived
--   and re-checked; if a reply was inserted into the old channel by a
--   concurrent transaction that committed in between, the function RAISEs and
--   the whole move rolls back rather than leaving a straggler.
--
-- ERROR CODES (the route maps these to HTTP statuses)
--   P0002  conversation not found / not visible          → 404
--   JB001  already in the destination channel            → 409
--   JB002  thread spans channels (unexpected split)      → 409
--   JB003  a straggler appeared mid-move (rolled back)   → 409
--   JB004  invalid destination channel                   → 400
--   JB005  missing acting administrator                   → 400
--
-- AUTHORIZATION
--   The function does NOT and CANNOT authorize the caller — it has no session
--   context. `p_actor_salesperson_id` is recorded, not trusted: EXECUTE is
--   granted to `service_role` ONLY, so the sole caller is
--   POST /api/team-messages/:id/move, which runs `requireAdmin` and passes the
--   id from the verified session token. Same model as the mark-read RPCs, and
--   the reason SECURITY DEFINER is again avoided.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, DROP-then-ADD constraints,
-- CREATE OR REPLACE FUNCTION, re-assertable REVOKE/GRANT.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS juice_box_conversation_moves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The conversation's ROOT post. No FK, deliberately — same rationale as
  -- team_messages.reply_to_message_id (juice_box_pass4_conversations.sql): an
  -- audit record must survive whatever later happens to the message it
  -- describes, and a cascade would erase moderation history.
  root_message_id UUID NOT NULL,
  from_channel TEXT NOT NULL,
  to_channel TEXT NOT NULL,
  -- TEXT with no FK mirrors team_messages.salesperson_id / team_message_reads:
  -- the record stays readable even if the salespeople row is later removed.
  moved_by_salesperson_id TEXT NOT NULL,
  -- How many messages the move actually touched (root + descendants).
  message_count INTEGER NOT NULL,
  moved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE juice_box_conversation_moves
  DROP CONSTRAINT IF EXISTS juice_box_conversation_moves_channels_allowed;
ALTER TABLE juice_box_conversation_moves
  ADD CONSTRAINT juice_box_conversation_moves_channels_allowed
  CHECK (
    from_channel IN ('general', 'product_help', 'social_media_hub')
    AND to_channel IN ('general', 'product_help', 'social_media_hub')
    AND from_channel <> to_channel
  );

ALTER TABLE juice_box_conversation_moves
  DROP CONSTRAINT IF EXISTS juice_box_conversation_moves_count_positive;
ALTER TABLE juice_box_conversation_moves
  ADD CONSTRAINT juice_box_conversation_moves_count_positive
  CHECK (message_count > 0);

-- "What happened to this conversation?" and "what moved recently?".
CREATE INDEX IF NOT EXISTS idx_juice_box_conversation_moves_root
  ON juice_box_conversation_moves(root_message_id, moved_at DESC);
CREATE INDEX IF NOT EXISTS idx_juice_box_conversation_moves_recent
  ON juice_box_conversation_moves(moved_at DESC);

-- Server-only, and stricter than the message tables: RLS ON with NO policy, so
-- the anon key cannot read moderation history at all. Deliberately NOT added to
-- supabase_realtime — no client subscribes to audit rows.
ALTER TABLE juice_box_conversation_moves ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.juice_box_move_conversation(
  p_message_id UUID,
  p_to_channel TEXT,
  p_actor_salesperson_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_root_id UUID;
  v_next_id UUID;
  v_parent_id UUID;
  v_is_deleted BOOLEAN;
  v_depth INTEGER := 0;
  v_ids UUID[];
  v_count INTEGER;
  v_distinct INTEGER;
  v_from_channel TEXT;
  v_moved_at TIMESTAMPTZ;
BEGIN
  IF p_to_channel IS NULL
     OR p_to_channel NOT IN ('general', 'product_help', 'social_media_hub') THEN
    RAISE EXCEPTION 'juice_box_move_conversation: unknown channel %', p_to_channel
      USING ERRCODE = 'JB004';
  END IF;
  IF p_actor_salesperson_id IS NULL OR btrim(p_actor_salesperson_id) = '' THEN
    RAISE EXCEPTION 'juice_box_move_conversation: acting administrator is required'
      USING ERRCODE = 'JB005';
  END IF;

  -- The clicked message must exist and be visible. A soft-deleted target is
  -- treated as absent (the admin could not have seen it), while soft-deleted
  -- ANCESTORS/DESCENDANTS are still moved with the thread — see the header.
  SELECT reply_to_message_id, is_deleted
    INTO v_parent_id, v_is_deleted
  FROM public.team_messages
  WHERE id = p_message_id;
  IF NOT FOUND OR v_is_deleted THEN
    RAISE EXCEPTION 'juice_box_move_conversation: conversation not found'
      USING ERRCODE = 'P0002';
  END IF;

  -- Walk UP to the root, so moving from a reply moves the whole conversation.
  -- Bounded depth guards against a cycle; a dangling parent pointer (no FK
  -- exists) makes the highest reachable ancestor the effective root.
  v_root_id := p_message_id;
  v_next_id := v_parent_id;
  WHILE v_next_id IS NOT NULL AND v_depth < 100 LOOP
    SELECT id, reply_to_message_id
      INTO v_root_id, v_next_id
    FROM public.team_messages
    WHERE id = v_next_id;
    EXIT WHEN NOT FOUND;
    v_depth := v_depth + 1;
  END LOOP;

  -- Serialize competing moves of the SAME conversation on the root row.
  PERFORM 1 FROM public.team_messages WHERE id = v_root_id FOR UPDATE;

  -- The whole tree: root + descendants at any depth. UNION (not UNION ALL)
  -- terminates even if the reply graph ever contained a cycle.
  WITH RECURSIVE thread AS (
    SELECT id FROM public.team_messages WHERE id = v_root_id
    UNION
    SELECT m.id
    FROM public.team_messages m
    JOIN thread t ON m.reply_to_message_id = t.id
  )
  SELECT array_agg(id ORDER BY id) INTO v_ids FROM thread;

  -- Lock every member in a deterministic order (by id) so two concurrent moves
  -- of overlapping threads cannot deadlock.
  PERFORM 1
  FROM public.team_messages
  WHERE id = ANY(v_ids)
  ORDER BY id
  FOR UPDATE;

  -- Re-read UNDER the lock: this is the state the move is actually based on.
  SELECT count(*), count(DISTINCT channel), min(channel)
    INTO v_count, v_distinct, v_from_channel
  FROM public.team_messages
  WHERE id = ANY(v_ids);

  IF v_count IS NULL OR v_count = 0 THEN
    RAISE EXCEPTION 'juice_box_move_conversation: conversation not found'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_distinct > 1 THEN
    RAISE EXCEPTION
      'juice_box_move_conversation: conversation spans multiple channels'
      USING ERRCODE = 'JB002';
  END IF;
  IF v_from_channel = p_to_channel THEN
    RAISE EXCEPTION
      'juice_box_move_conversation: already in channel %', p_to_channel
      USING ERRCODE = 'JB001';
  END IF;

  -- The move itself: ONE column, every member of the thread.
  UPDATE public.team_messages
  SET channel = p_to_channel
  WHERE id = ANY(v_ids);

  -- Re-derive the tree and confirm nothing was left behind — a reply inserted
  -- by a transaction that committed between the CTE and the UPDATE would show
  -- up here. RAISE rolls the whole move (and the audit row) back.
  IF EXISTS (
    WITH RECURSIVE thread AS (
      SELECT id, channel FROM public.team_messages WHERE id = v_root_id
      UNION
      SELECT m.id, m.channel
      FROM public.team_messages m
      JOIN thread t ON m.reply_to_message_id = t.id
    )
    SELECT 1 FROM thread WHERE channel <> p_to_channel
  ) THEN
    RAISE EXCEPTION
      'juice_box_move_conversation: conversation changed during the move'
      USING ERRCODE = 'JB003';
  END IF;

  -- Audit row, same transaction: no successful move without a record, and no
  -- record without a successful move.
  INSERT INTO public.juice_box_conversation_moves (
    root_message_id, from_channel, to_channel,
    moved_by_salesperson_id, message_count
  )
  VALUES (
    v_root_id, v_from_channel, p_to_channel,
    p_actor_salesperson_id, v_count
  )
  RETURNING moved_at INTO v_moved_at;

  RETURN jsonb_build_object(
    'root_message_id', v_root_id,
    'from_channel', v_from_channel,
    'to_channel', p_to_channel,
    'message_count', v_count,
    'moved_at', v_moved_at
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.juice_box_move_conversation(UUID, TEXT, TEXT)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.juice_box_move_conversation(UUID, TEXT, TEXT)
  FROM anon;
REVOKE ALL ON FUNCTION public.juice_box_move_conversation(UUID, TEXT, TEXT)
  FROM authenticated;
GRANT EXECUTE ON FUNCTION public.juice_box_move_conversation(UUID, TEXT, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 6) Thread-integrity triggers — reply creation is serialized against moves
-- ---------------------------------------------------------------------------
-- THE RACE THIS CLOSES
--   The application derives a reply's channel from the parent it READ, then
--   INSERTs. Those are two separate database operations, so a move can slip
--   between them:
--
--     T1  reply request reads parent  → channel = general
--     T2  move locks the thread, sets channel = product_help, audits, COMMITS
--     T3  reply request INSERTs with the stale general → THREAD SPLIT
--
--   No amount of application-side checking fixes this: the check and the write
--   are different statements. The guarantee has to be held by a lock that lives
--   inside the inserting transaction.
--
-- HOW IT IS CLOSED
--   A BEFORE INSERT trigger on every reply (`reply_to_message_id IS NOT NULL`):
--     1. resolves the conversation ROOT by walking up the reply chain;
--     2. takes `SELECT … FOR UPDATE` on that ROOT row — the serialization
--        point, held until the reply's transaction ends;
--     3. reads the root's channel FROM THAT LOCKED READ, i.e. only after any
--        in-flight move has finished;
--     4. RAISEs (JB010) if the reply's channel differs.
--
-- WHY `FOR UPDATE` AND NOT `FOR KEY SHARE`
--   Row-lock conflicts in Postgres:
--     FOR KEY SHARE      conflicts ONLY with FOR UPDATE.
--     FOR NO KEY UPDATE  conflicts with FOR UPDATE / FOR NO KEY UPDATE / SHARE.
--     FOR UPDATE         conflicts with everything.
--   A plain `UPDATE … SET channel = …` changes no key column, so it takes
--   FOR NO KEY UPDATE — which does NOT conflict with FOR KEY SHARE. A
--   KEY SHARE lock here would therefore sail straight past a bare channel
--   UPDATE and the race would survive. `FOR UPDATE` conflicts with BOTH the
--   move RPC's explicit `FOR UPDATE` and any bare non-key UPDATE, so the
--   guarantee does not depend on how the move happens to be written.
--   Cost: two replies to the same conversation serialize for the microseconds
--   it takes to re-read one row. That is the correct trade.
--
-- BOTH ORDERINGS ARE SAFE
--   * Reply wins the lock → the move blocks. The move takes the root lock
--     BEFORE it collects the tree (see section 5), so once it proceeds its
--     recursive CTE runs on a fresh READ COMMITTED snapshot and INCLUDES the
--     just-committed reply. Nothing is left behind.
--   * Move wins the lock → the reply blocks. When it resumes, its
--     `FOR UPDATE` re-evaluates and returns the POST-MOVE row version, so the
--     stale channel is rejected (JB010) and no partial row is written — a
--     BEFORE INSERT trigger that raises means the INSERT never happens.
--
-- NO DEADLOCK
--   Both paths take the ROOT row first, and the reply path holds nothing else
--   (its own row does not exist yet). The move then walks descendants in id
--   order. There is no cycle to form under any supported operation.
--
-- OLD DEPLOYED APPLICATION
--   It inserts replies without a channel, so the column DEFAULT 'general'
--   applies. Replying to a General conversation therefore still works exactly
--   as before. Replying to a conversation an admin has MOVED is refused rather
--   than allowed to split the thread — the correct outcome for a client that
--   has no concept of channels, and one it already surfaces as a failed post.
--
-- TWO MORE GUARDS ON DIRECT UPDATE PATHS
--   * `reply_to_message_id` is made immutable (JB012). Re-parenting a message
--     would silently move it between conversations and defeat every check here.
--   * A DEFERRED CONSTRAINT trigger re-asserts, AT COMMIT, that any
--     conversation whose channel changed has exactly ONE channel across its
--     root and every descendant (JB013). It fires for ROOTS as well as replies,
--     so raw SQL that updates only a root — leaving its replies behind — is
--     rolled back too, as is the reply-only version. Deferring is what makes it
--     safe for the move: a single multi-row `UPDATE` visits rows in an
--     unspecified order, so an immediate check could see one row updated before
--     another and fail a perfectly good move. At commit the whole thread is
--     consistent, so the move passes.
--
-- ERROR CODES
--   JB010  reply channel does not match the conversation (stale read / move)
--   JB011  reply parent or root missing, or the chain is cyclic
--   JB012  attempt to change reply_to_message_id
--   JB013  a conversation ended the transaction spanning channels (root-only or
--          reply-only raw channel update)
--
-- Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS/CREATE.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.juice_box_enforce_reply_channel()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_root_id UUID;
  v_next_id UUID;
  v_depth INTEGER := 0;
  v_root_channel TEXT;
BEGIN
  IF NEW.reply_to_message_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Walk up to the root. Unlocked reads are sound here: reply_to_message_id is
  -- immutable (see juice_box_forbid_reply_pointer_change), so the SHAPE of the
  -- tree cannot shift under us. Only `channel` can move, and that is exactly
  -- what the lock below is for.
  v_root_id := NEW.reply_to_message_id;
  LOOP
    SELECT reply_to_message_id INTO v_next_id
    FROM public.team_messages
    WHERE id = v_root_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'juice_box: reply parent % does not exist', v_root_id
        USING ERRCODE = 'JB011';
    END IF;
    EXIT WHEN v_next_id IS NULL;
    v_root_id := v_next_id;
    v_depth := v_depth + 1;
    IF v_depth >= 100 THEN
      RAISE EXCEPTION
        'juice_box: reply chain for % is too deep or cyclic', NEW.id
        USING ERRCODE = 'JB011';
    END IF;
  END LOOP;

  -- ── THE SERIALIZATION POINT ──────────────────────────────────────────────
  -- FOR UPDATE conflicts with the move RPC's root lock AND with a bare
  -- non-key channel UPDATE, so this blocks while a move of this conversation
  -- is in flight. In READ COMMITTED the row is re-evaluated after the wait, so
  -- v_root_channel is the POST-move value — never the stale one the
  -- application read a moment ago. The lock is held until this transaction
  -- ends, so a move cannot start and finish underneath the INSERT either.
  SELECT channel INTO v_root_channel
  FROM public.team_messages
  WHERE id = v_root_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'juice_box: conversation root % does not exist', v_root_id
      USING ERRCODE = 'JB011';
  END IF;

  IF NEW.channel IS DISTINCT FROM v_root_channel THEN
    RAISE EXCEPTION
      'juice_box: reply channel % does not match conversation channel %',
      NEW.channel, v_root_channel
      USING ERRCODE = 'JB010';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_team_messages_reply_channel ON team_messages;
CREATE TRIGGER trg_team_messages_reply_channel
  BEFORE INSERT ON team_messages
  FOR EACH ROW
  WHEN (NEW.reply_to_message_id IS NOT NULL)
  EXECUTE FUNCTION public.juice_box_enforce_reply_channel();

-- Re-parenting a message would move it between conversations behind every
-- other check's back. No application path does it; this makes it impossible.
CREATE OR REPLACE FUNCTION public.juice_box_forbid_reply_pointer_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  RAISE EXCEPTION
    'juice_box: reply_to_message_id is immutable (message %)', OLD.id
    USING ERRCODE = 'JB012';
END;
$fn$;

DROP TRIGGER IF EXISTS trg_team_messages_reply_pointer_immutable ON team_messages;
CREATE TRIGGER trg_team_messages_reply_pointer_immutable
  BEFORE UPDATE ON team_messages
  FOR EACH ROW
  WHEN (NEW.reply_to_message_id IS DISTINCT FROM OLD.reply_to_message_id)
  EXECUTE FUNCTION public.juice_box_forbid_reply_pointer_change();

-- Deferred WHOLE-CONVERSATION check, validated at COMMIT.
--
-- WHAT IT COVERS (widened from replies-only)
--   Any row whose `channel` changes — root or reply. It resolves that row's
--   conversation and asserts the root plus every descendant share exactly ONE
--   channel. That closes the last raw-SQL gap: an earlier version only fired
--   for rows with a parent, so a privileged
--     UPDATE team_messages SET channel = … WHERE id = <a root>
--   could strand the root's replies in the old channel. Now that fails and
--   rolls back, as does the reply-only version of the same mistake.
--
-- WHY DEFERRED (and why that is what makes it safe for the move)
--   A single multi-row `UPDATE` visits rows in an unspecified order, so an
--   IMMEDIATE check would sometimes see a reply updated before its root — or a
--   root before its replies — and fail a perfectly legitimate move. Deferring
--   to COMMIT means the whole thread is judged on its FINAL state: the move RPC
--   passes because every member agrees by then, while any partial update fails.
--   The check therefore never depends on row update order.
--
-- SCOPE AND COST
--   The WHEN clause fires it ONLY when `channel` actually changes, so posting,
--   replying, reacting and soft-deleting never pay for it. A move of an N-row
--   thread runs N recursive descendant queries at commit, each over that one
--   thread — trivial for a team chat, and bounded by thread size rather than by
--   feed history. Several conversations updated in one transaction are each
--   validated independently (the trigger is per row, and each row resolves its
--   own root). No locks are taken: at commit the transaction already holds row
--   locks on everything it changed and these are snapshot reads, so the check
--   adds no deadlock surface.
--
-- ERROR CODES
--   JB013  the conversation ended the transaction spanning channels.
--   JB011  the reply chain is cyclic or deeper than the supported limit.
--          A vanished ancestor is skipped rather than raised — nothing
--          hard-deletes messages, and refusing an unrelated transaction over an
--          unjudgeable row would be worse than letting the write paths' own
--          JB011 handle it.
CREATE OR REPLACE FUNCTION public.juice_box_assert_conversation_single_channel()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_root_id UUID;
  v_next_id UUID;
  v_depth INTEGER := 0;
  v_distinct INTEGER;
BEGIN
  -- Resolve this row's conversation root. A root is its own conversation.
  v_root_id := NEW.id;
  v_next_id := NEW.reply_to_message_id;
  WHILE v_next_id IS NOT NULL LOOP
    SELECT id, reply_to_message_id
      INTO v_root_id, v_next_id
    FROM public.team_messages
    WHERE id = v_next_id;
    -- Unjudgeable: an ancestor is gone. Leave it to the write paths' JB011.
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    v_depth := v_depth + 1;
    IF v_depth >= 100 THEN
      RAISE EXCEPTION
        'juice_box: reply chain for % is too deep or cyclic', NEW.id
        USING ERRCODE = 'JB011';
    END IF;
  END LOOP;

  -- Root + every descendant must agree on one channel. UNION (not UNION ALL)
  -- terminates even on a cyclic reply graph.
  WITH RECURSIVE thread AS (
    SELECT id, channel FROM public.team_messages WHERE id = v_root_id
    UNION
    SELECT m.id, m.channel
    FROM public.team_messages m
    JOIN thread t ON m.reply_to_message_id = t.id
  )
  SELECT count(DISTINCT channel) INTO v_distinct FROM thread;

  IF v_distinct > 1 THEN
    RAISE EXCEPTION
      'juice_box: conversation % spans multiple channels after this transaction',
      v_root_id
      USING ERRCODE = 'JB013';
  END IF;

  RETURN NULL;
END;
$fn$;

-- Replaces the earlier replies-only trigger/function, so a database that got
-- the previous version of this file converges cleanly.
DROP TRIGGER IF EXISTS trg_team_messages_reply_channel_settled ON team_messages;
DROP FUNCTION IF EXISTS public.juice_box_assert_reply_channel_matches_root();

DROP TRIGGER IF EXISTS trg_team_messages_conversation_channel_settled
  ON team_messages;
CREATE CONSTRAINT TRIGGER trg_team_messages_conversation_channel_settled
  AFTER UPDATE ON team_messages
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.channel IS DISTINCT FROM OLD.channel)
  EXECUTE FUNCTION public.juice_box_assert_conversation_single_channel();

-- ===========================================================================
-- VERIFICATION (run after the migration)
-- ===========================================================================
-- -- Messages: column present, defaulted, backfilled, nothing lost:
-- SELECT channel, COUNT(*) FROM team_messages GROUP BY channel ORDER BY channel;
--   -- expect every pre-existing post under 'general' and no NULLs
-- SELECT COUNT(*) FROM team_messages WHERE channel IS NULL;   -- expect 0
-- SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_deleted) AS deleted
-- FROM team_messages;   -- compare against the count noted before running
--
-- -- Legacy read table UNCHANGED (this is what keeps the old app working):
-- SELECT indexname FROM pg_indexes
-- WHERE tablename = 'team_message_reads' ORDER BY indexname;
--   -- expect uq_team_message_reads_salesperson to STILL be present
--
-- -- Backfill is 1:1 with the legacy table:
-- SELECT
--   (SELECT COUNT(*) FROM team_message_reads) AS legacy_rows,
--   (SELECT COUNT(*) FROM team_message_channel_reads WHERE channel = 'general')
--     AS general_rows;
--   -- expect the two to match
--
-- SELECT l.salesperson_id, l.last_read_at AS legacy, c.last_read_at AS copied
-- FROM team_message_reads l
-- LEFT JOIN team_message_channel_reads c
--   ON c.salesperson_id = l.salesperson_id AND c.channel = 'general'
-- WHERE c.salesperson_id IS NULL;
--   -- expect 0 rows (every legacy marker was copied)
--
-- -- New table posture matches the legacy one:
-- SELECT tablename, rowsecurity FROM pg_tables
-- WHERE tablename = 'team_message_channel_reads';        -- expect true
-- SELECT COUNT(*) FROM pg_policies
-- WHERE tablename = 'team_message_channel_reads';        -- expect 0
-- SELECT COUNT(*) FROM pg_publication_tables
-- WHERE pubname = 'supabase_realtime'
--   AND tablename = 'team_message_channel_reads';        -- expect 0
--
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
-- WHERE conname IN (
--   'team_messages_channel_allowed',
--   'team_message_channel_reads_channel_allowed'
-- );
--   -- expect two CHECK (channel IN ('general','product_help','social_media_hub'))
--
-- -- Mark-read RPCs exist with the right security posture:
-- SELECT p.proname, p.prosecdef AS security_definer, p.proconfig
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public'
--   AND p.proname IN ('juice_box_mark_channel_read', 'juice_box_mark_legacy_read');
--   -- expect security_definer = false and proconfig containing
--   -- search_path=pg_catalog, public
--
-- SELECT proname, pg_get_functiondef(oid) FROM pg_proc
-- WHERE proname = 'juice_box_mark_channel_read';
--   -- expect GREATEST(t.last_read_at, EXCLUDED.last_read_at) in the body
--
-- -- EXECUTE is service_role-only:
-- SELECT proname,
--   has_function_privilege('anon',          oid, 'EXECUTE') AS anon_exec,
--   has_function_privilege('authenticated', oid, 'EXECUTE') AS auth_exec,
--   has_function_privilege('service_role',  oid, 'EXECUTE') AS service_exec
-- FROM pg_proc
-- WHERE proname IN ('juice_box_mark_channel_read', 'juice_box_mark_legacy_read');
--   -- expect false, false, true
--
-- -- MONOTONICITY, proven against the real database (run as service_role):
-- SELECT public.juice_box_mark_channel_read('test-person', 'product_help');
--   -- note the returned timestamp T
-- UPDATE team_message_channel_reads SET last_read_at = now() + interval '1 hour'
-- WHERE salesperson_id = 'test-person' AND channel = 'product_help';
-- SELECT public.juice_box_mark_channel_read('test-person', 'product_help');
--   -- expect the FUTURE timestamp back (not now()) — the marker did not move
--   -- backwards, which is the whole point of GREATEST.
-- DELETE FROM team_message_channel_reads WHERE salesperson_id = 'test-person';
--
-- SELECT public.juice_box_mark_channel_read('test-person', 'marketing');
--   -- expect ERROR: unknown channel marketing
--
-- -- MOVE CONVERSATION — audit table + RPC posture:
-- SELECT tablename, rowsecurity FROM pg_tables
-- WHERE tablename = 'juice_box_conversation_moves';        -- expect true
-- SELECT COUNT(*) FROM pg_policies
-- WHERE tablename = 'juice_box_conversation_moves';        -- expect 0
-- SELECT COUNT(*) FROM pg_publication_tables
-- WHERE pubname = 'supabase_realtime'
--   AND tablename = 'juice_box_conversation_moves';        -- expect 0
--
-- SELECT p.proname, p.prosecdef AS security_definer, p.proconfig
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public' AND p.proname = 'juice_box_move_conversation';
--   -- expect security_definer = false, search_path pinned
--
-- SELECT
--   has_function_privilege('anon',          oid, 'EXECUTE') AS anon_exec,
--   has_function_privilege('authenticated', oid, 'EXECUTE') AS auth_exec,
--   has_function_privilege('service_role',  oid, 'EXECUTE') AS service_exec
-- FROM pg_proc WHERE proname = 'juice_box_move_conversation';
--   -- expect false, false, true
--
-- ---------------------------------------------------------------------------
-- MOVE CONVERSATION — behaviour, on a DISPOSABLE BRANCH ONLY.
-- These statements INSERT and MOVE rows. Never run them against production.
-- Wrap the whole block in BEGIN; … ROLLBACK; to leave no trace.
-- ---------------------------------------------------------------------------
-- BEGIN;
-- -- A nested thread: root → reply → nested reply, all in General.
-- INSERT INTO team_messages (id, channel, salesperson_id, salesperson_name, message)
-- VALUES ('00000000-0000-4000-8000-00000000r001'::uuid, 'general', 'probe', 'Probe', 'root')
-- RETURNING id;
-- INSERT INTO team_messages (id, channel, salesperson_id, salesperson_name, message, reply_to_message_id)
-- VALUES ('00000000-0000-4000-8000-00000000r002'::uuid, 'general', 'probe', 'Probe', 'reply',
--         '00000000-0000-4000-8000-00000000r001'::uuid);
-- INSERT INTO team_messages (id, channel, salesperson_id, salesperson_name, message, reply_to_message_id)
-- VALUES ('00000000-0000-4000-8000-00000000r003'::uuid, 'general', 'probe', 'Probe', 'nested',
--         '00000000-0000-4000-8000-00000000r002'::uuid);
--
-- -- Move from the NESTED reply: must resolve the root and move all three.
-- SELECT public.juice_box_move_conversation(
--   '00000000-0000-4000-8000-00000000r003'::uuid, 'product_help', 'probe-admin');
--   -- expect {"root_message_id":"…r001","from_channel":"general",
--   --         "to_channel":"product_help","message_count":3,"moved_at":…}
--
-- SELECT id, channel FROM team_messages
-- WHERE id::text LIKE '00000000-0000-4000-8000-00000000r%' ORDER BY id;
--   -- expect ALL THREE on product_help — no reply left in general
--
-- SELECT root_message_id, from_channel, to_channel, message_count,
--        moved_by_salesperson_id
-- FROM juice_box_conversation_moves ORDER BY moved_at DESC LIMIT 1;
--   -- expect exactly one row matching the move above
--
-- -- Rejections (each RAISEs; none writes an audit row):
-- SELECT public.juice_box_move_conversation(
--   '00000000-0000-4000-8000-00000000r001'::uuid, 'product_help', 'probe-admin');
--   -- expect ERROR JB001 (already in that channel)
-- SELECT public.juice_box_move_conversation(
--   '00000000-0000-4000-8000-00000000r001'::uuid, 'marketing', 'probe-admin');
--   -- expect ERROR JB004 (unknown channel)
-- SELECT public.juice_box_move_conversation(
--   gen_random_uuid(), 'general', 'probe-admin');
--   -- expect ERROR P0002 (not found)
-- SELECT public.juice_box_move_conversation(
--   '00000000-0000-4000-8000-00000000r001'::uuid, 'general', '');
--   -- expect ERROR JB005 (missing administrator)
--
-- SELECT COUNT(*) FROM juice_box_conversation_moves;
--   -- expect 1 — the four failures above added nothing
--
-- -- Rollback proof: a failing move leaves the channel untouched. Force a
-- -- failure by splitting the thread by hand first.
-- UPDATE team_messages SET channel = 'social_media_hub'
-- WHERE id = '00000000-0000-4000-8000-00000000r003'::uuid;
-- SELECT public.juice_box_move_conversation(
--   '00000000-0000-4000-8000-00000000r001'::uuid, 'general', 'probe-admin');
--   -- expect ERROR JB002 (spans channels)
-- SELECT id, channel FROM team_messages
-- WHERE id::text LIKE '00000000-0000-4000-8000-00000000r%' ORDER BY id;
--   -- expect the pre-error channels — nothing changed
-- ROLLBACK;
--
-- ---------------------------------------------------------------------------
-- THREAD SERIALIZATION — TWO-SESSION CONCURRENCY TEST.
-- DISPOSABLE SUPABASE BRANCH / LOCAL POSTGRES ONLY. Never production.
--
-- This is the ONE property the JavaScript tests cannot prove: that reply
-- creation and a conversation move genuinely block each other. It needs two
-- concurrent connections (two psql windows, or two SQL-editor tabs that each
-- hold their own transaction).
--
-- SETUP (session A, committed so both sessions can see it)
--   INSERT INTO team_messages (id, channel, salesperson_id, salesperson_name, message)
--   VALUES ('11111111-1111-4111-8111-111111111111', 'general', 'probe', 'Probe', 'root');
--
-- ── CASE 1: reply wins the lock; the move waits and then INCLUDES the reply ──
--
--   A: BEGIN;
--   A: INSERT INTO team_messages
--        (id, channel, salesperson_id, salesperson_name, message, reply_to_message_id)
--      VALUES ('22222222-2222-4222-8222-222222222222', 'general', 'probe', 'Probe',
--              'reply', '11111111-1111-4111-8111-111111111111');
--      -- succeeds; the BEFORE INSERT trigger now holds FOR UPDATE on the root.
--      -- DO NOT COMMIT YET.
--
--   B: BEGIN;
--   B: SELECT public.juice_box_move_conversation(
--        '11111111-1111-4111-8111-111111111111', 'product_help', 'probe-admin');
--      -- EXPECT: B BLOCKS here (it wants the root's FOR UPDATE). Leave it hanging.
--
--   A: COMMIT;
--      -- EXPECT: B immediately returns, and its result says message_count = 2 —
--      -- the move collected the tree AFTER acquiring the lock, so it saw the
--      -- reply that had just committed.
--   B: COMMIT;
--
--   -- Verify no split:
--   SELECT id, channel FROM team_messages
--   WHERE id IN ('11111111-1111-4111-8111-111111111111',
--                '22222222-2222-4222-8222-222222222222');
--     -- EXPECT: both rows on product_help.
--
-- ── CASE 2: move wins the lock; the stale reply waits and is then REJECTED ──
--   (Reset first: UPDATE team_messages SET channel = 'general'
--                 WHERE id IN ('1111…','2222…');)
--
--   A: BEGIN;
--   A: SELECT public.juice_box_move_conversation(
--        '11111111-1111-4111-8111-111111111111', 'social_media_hub', 'probe-admin');
--      -- succeeds; A holds the root + descendant locks. DO NOT COMMIT YET.
--
--   B: BEGIN;
--   B: INSERT INTO team_messages
--        (id, channel, salesperson_id, salesperson_name, message, reply_to_message_id)
--      VALUES ('33333333-3333-4333-8333-333333333333', 'general', 'probe', 'Probe',
--              'stale reply', '11111111-1111-4111-8111-111111111111');
--      -- EXPECT: B BLOCKS in the trigger's SELECT … FOR UPDATE.
--      --   This is THE REVIEWED RACE: B validated 'general' before A moved,
--      --   and is attempting its INSERT after.
--
--   A: COMMIT;
--      -- EXPECT: B immediately fails with SQLSTATE JB010,
--      --   'reply channel general does not match conversation channel
--      --    social_media_hub'. The FOR UPDATE re-read returned the POST-move
--      --   value, not the one B had read.
--   B: ROLLBACK;   -- (B is already aborted; this just closes it.)
--
--   -- Verify no partial row and no split:
--   SELECT count(*) FROM team_messages
--   WHERE id = '33333333-3333-4333-8333-333333333333';   -- EXPECT 0
--   SELECT DISTINCT channel FROM team_messages
--   WHERE id IN ('1111…','2222…');                        -- EXPECT one row
--
--   -- And the same reply SUCCEEDS once it names the new channel:
--   INSERT INTO team_messages
--     (id, channel, salesperson_id, salesperson_name, message, reply_to_message_id)
--   VALUES ('44444444-4444-4444-8444-444444444444', 'social_media_hub', 'probe',
--           'Probe', 'correct reply', '11111111-1111-4111-8111-111111111111');
--     -- EXPECT: succeeds.
--
-- ── CASE 3: the OLD client's channel-less reply cannot split a moved thread ──
--   INSERT INTO team_messages
--     (salesperson_id, salesperson_name, message, reply_to_message_id)
--   VALUES ('probe', 'Probe', 'old client reply',
--           '11111111-1111-4111-8111-111111111111');
--     -- The column DEFAULT supplies 'general' while the conversation is on
--     -- social_media_hub → EXPECT SQLSTATE JB010, no row inserted.
--
-- ── CASE 4: direct-update guards ──
--   UPDATE team_messages SET reply_to_message_id = NULL
--   WHERE id = '22222222-2222-4222-8222-222222222222';     -- EXPECT JB012
--
--   UPDATE team_messages SET channel = 'general'
--   WHERE id = '22222222-2222-4222-8222-222222222222';     -- a reply only
--     -- EXPECT JB013 at COMMIT (deferred), and the row unchanged.
--
--   -- THE LOW FINDING: raw update of the ROOT only, leaving replies behind.
--   BEGIN;
--   UPDATE team_messages SET channel = 'product_help'
--   WHERE id = '11111111-1111-4111-8111-111111111111';     -- a root only
--   COMMIT;
--     -- EXPECT JB013 at COMMIT and a full rollback: the root did NOT move and
--     -- its replies were not stranded.
--   SELECT DISTINCT channel FROM team_messages
--   WHERE id IN ('1111…','2222…');                          -- EXPECT one row
--
--   -- A ROOT-ONLY CONVERSATION (no replies) may still be updated directly:
--   INSERT INTO team_messages (id, channel, salesperson_id, salesperson_name, message)
--   VALUES ('55555555-5555-4555-8555-555555555555', 'general', 'probe', 'Probe', 'lone');
--   UPDATE team_messages SET channel = 'product_help'
--   WHERE id = '55555555-5555-4555-8555-555555555555';
--     -- EXPECT: succeeds (its "thread" is one row, so it has one channel).
--
--   -- TWO CONVERSATIONS IN ONE TRANSACTION are judged independently:
--   BEGIN;
--   SELECT public.juice_box_move_conversation(
--     '11111111-1111-4111-8111-111111111111', 'product_help', 'probe-admin');
--   UPDATE team_messages SET channel = 'general'
--   WHERE id = '22222222-2222-4222-8222-222222222222';     -- breaks thread 1
--   COMMIT;
--     -- EXPECT JB013: the good move is rolled back with the bad update, which
--     -- is the correct all-or-nothing outcome for one transaction.
--
--   -- …while the multi-row move still passes, because the deferred check runs
--   -- once the whole thread is consistent:
--   SELECT public.juice_box_move_conversation(
--     '11111111-1111-4111-8111-111111111111', 'general', 'probe-admin');
--     -- EXPECT: succeeds.
--
-- ── CASE 5: no deadlock under the supported operations ──
--   Run CASE 1 and CASE 2 in a loop from two sessions (or with pgbench -c 2).
--   EXPECT: every attempt either succeeds or fails with JB010/JB001 — never
--   SQLSTATE 40P01 (deadlock_detected). Both paths take the ROOT row first and
--   the reply path holds nothing else, so no cycle can form.
--
-- CLEANUP
--   DELETE FROM juice_box_conversation_moves WHERE moved_by_salesperson_id = 'probe-admin';
--   DELETE FROM team_messages WHERE salesperson_id = 'probe';
--   (Both are plain deletes on probe rows only — safe on a disposable branch,
--   and the reason every probe row is tagged salesperson_id = 'probe'.)
-- ---------------------------------------------------------------------------
--
-- -- Feed index is used:
-- EXPLAIN SELECT id FROM team_messages
-- WHERE is_deleted = false AND channel = 'general'
-- ORDER BY created_at DESC LIMIT 50;
--   -- expect idx_team_messages_live_channel_created_at
-- ===========================================================================
