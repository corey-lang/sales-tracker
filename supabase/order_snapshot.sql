-- ===========================================================================
-- order_snapshot — cached Cogent orders rollup (Orders Sync Cron V1).
-- ===========================================================================
-- WHAT THIS IS
--   A SINGLE-ROW cache of the computed month-to-date orders rollup
--   (getMonthlyOrders → company + per-AE items + order pace + unmapped). A
--   background cron (/api/cron/orders-sync) refreshes it every 15 minutes
--   during business hours; the AE Home Orders card and the Admin orders screen
--   READ this cache instead of calling Cogent live on every page load.
--
-- WHY A SINGLETON
--   The rollup is a single object for the whole company. `id BOOLEAN PRIMARY
--   KEY DEFAULT TRUE CHECK (id)` allows exactly one row (id = true), so writers
--   UPSERT on `id` and readers fetch that one row. No growth, no cleanup job.
--
-- `payload`        the full MonthlyOrders JSON (verbatim, server-shaped).
-- `refreshed_at`   the LAST SUCCESSFUL refresh time — only written on a
--                  successful sync, so it is a true freshness signal the UI
--                  shows as "Last updated".
-- `duration_ms`    how long the upstream sync took (observability).
--
-- ACCESS MODEL
--   RLS ENABLED with NO policy — server-only. The cron + manual-refresh routes
--   (service role) write it; the AE/admin read routes (service role) read it.
--   The anon key has zero access. Same posture as ae_tasks /
--   cogent_territory_mappings.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, ALTER ... ADD COLUMN IF NOT EXISTS,
-- CREATE OR REPLACE FUNCTION, ENABLE ROW LEVEL SECURITY, and the REVOKE/GRANT
-- are all re-runnable. No seed data. See supabase/README.md for migration order.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS order_snapshot (
  -- Singleton guard: only the row with id = true can exist.
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  payload JSONB NOT NULL,
  -- When THIS sync run began. Used by the overwrite guard so a slower run that
  -- started earlier can't clobber a newer run's snapshot.
  started_at TIMESTAMPTZ,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  duration_ms INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add started_at if the table predates this column (CREATE TABLE IF NOT EXISTS
-- above is a no-op on an already-applied table).
ALTER TABLE order_snapshot ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

ALTER TABLE order_snapshot ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Overwrite-safe writer. Upserts the singleton row ONLY when this run started
-- at-or-after the run currently stored (started_at guard), so overlapping
-- cron/manual syncs can't let an older run overwrite a newer snapshot. Returns
-- true when it wrote, false when it was skipped as stale. Service-role only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_order_snapshot(
  p_payload JSONB,
  p_started_at TIMESTAMPTZ,
  p_refreshed_at TIMESTAMPTZ,
  p_duration_ms INTEGER
) RETURNS BOOLEAN AS $$
DECLARE
  affected INTEGER;
BEGIN
  INSERT INTO order_snapshot (id, payload, started_at, refreshed_at, duration_ms, updated_at)
  VALUES (TRUE, p_payload, p_started_at, p_refreshed_at, p_duration_ms, NOW())
  ON CONFLICT (id) DO UPDATE
    SET payload = EXCLUDED.payload,
        started_at = EXCLUDED.started_at,
        refreshed_at = EXCLUDED.refreshed_at,
        duration_ms = EXCLUDED.duration_ms,
        updated_at = NOW()
    WHERE order_snapshot.started_at IS NULL
       OR order_snapshot.started_at <= EXCLUDED.started_at;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION upsert_order_snapshot(JSONB, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION upsert_order_snapshot(JSONB, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION upsert_order_snapshot(JSONB, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) TO service_role;
