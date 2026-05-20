-- ===========================================================================
-- Juice Box Pass 6 — Web Push subscriptions.
-- ===========================================================================
-- WHAT THIS IS
--   One row per browser/device that has opted into Juice Box push
--   notifications. Each row is the full PushSubscription tuple plus the
--   owning salesperson — enough for the server to sign and send a VAPID
--   push without round-tripping to anywhere else.
--
-- ACCESS MODEL
--   * RLS is ENABLED with NO policies. Subscriptions are private and the
--     anon key has zero access; all reads/writes go through the
--     /api/juice-box/push/* routes using the SERVICE-ROLE key. Identity
--     is verified against the salespeople row by the signed session.
--   * The table is NOT published to supabase_realtime — no client needs
--     to subscribe to subscription changes.
--
-- ROLLOUT GATE
--   The current Juice Box rollout is admin + test only. Both the
--   subscribe API and the fan-out logic call requireJuiceBoxAccess /
--   re-check role, so a regular AE who happens to insert a row by other
--   means still won't receive notifications.
--
-- Idempotent: re-runnable.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- TEXT mirrors team_messages.salesperson_id / team_message_reads.salesperson_id.
  -- See team_messages.sql for the readable-historical-records rationale.
  salesperson_id TEXT NOT NULL,
  -- The PushSubscription.endpoint URL the push service assigned. Unique
  -- per (device, browser, origin) — uniqueness is enforced below so a
  -- re-subscribe from the same device upserts cleanly.
  endpoint TEXT NOT NULL,
  -- The encrypted-content keys the Web Push protocol uses to encrypt
  -- the payload for this subscription.
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  -- Optional debug context (which device / browser opted in).
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Endpoint is the natural identity from the push service. Re-subscribe
-- from the same device returns the same endpoint, so we upsert on this.
CREATE UNIQUE INDEX IF NOT EXISTS uq_push_subscriptions_endpoint
  ON push_subscriptions(endpoint);

-- Lookup by salesperson — used during fan-out to filter sender, and by
-- any future "unsubscribe all my devices" flow.
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_salesperson
  ON push_subscriptions(salesperson_id);

-- updated_at maintenance — matches the pattern used by ae_tasks,
-- team_message_reads, business_card_contacts.
CREATE OR REPLACE FUNCTION set_push_subscriptions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_push_subscriptions_updated_at ON push_subscriptions;
CREATE TRIGGER trg_push_subscriptions_updated_at
  BEFORE UPDATE ON push_subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION set_push_subscriptions_updated_at();

-- Service-role-only access. RLS on, no anon policy.
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- ===========================================================================
-- VERIFICATION
-- ===========================================================================
-- SELECT tablename, rowsecurity FROM pg_tables
-- WHERE tablename = 'push_subscriptions';
--   -- expect rowsecurity = true
--
-- SELECT count(*) FROM pg_policies WHERE tablename = 'push_subscriptions';
--   -- expect 0 (no anon policies)
--
-- SELECT indexname FROM pg_indexes WHERE tablename = 'push_subscriptions';
--   -- expect: push_subscriptions_pkey,
--   --         uq_push_subscriptions_endpoint,
--   --         idx_push_subscriptions_salesperson
--
-- SELECT tablename FROM pg_publication_tables
-- WHERE pubname = 'supabase_realtime' AND tablename = 'push_subscriptions';
--   -- expect 0 rows (intentionally NOT in the realtime publication)
