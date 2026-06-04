-- ===========================================================================
-- order_today_baseline — start-of-day MTD totals that power Today Orders.
-- ===========================================================================
-- WHY THIS EXISTS
--   SalesReport6 month-to-date aggregate totals are RELIABLE (they match the
--   production monthly numbers we trust), but its same-day slice is NOT — a
--   [2026-06-04, 2026-06-04] request was observed returning rows bucketed under
--   2026-06-02. The report groups into period buckets, not order events, so the
--   same-day window cannot power operational Today Orders.
--
--   Instead, Today Orders are a DELTA against a per-day baseline:
--       Today Orders = current MTD total − start-of-day MTD baseline   (≥ 0)
--   One row per America/Denver calendar date. The FIRST sync of a MT day
--   creates that day's baseline from the then-current MTD totals (so Today = 0
--   at first sync); later syncs read it and report the delta. A new MT date
--   creates a new row, so Today resets to 0 at the first sync of the new day.
--
-- COLUMNS
--   baseline_date   America/Denver YYYY-MM-DD (PRIMARY KEY → exactly one row
--                   per MT day; the date boundary/rollover is Mountain Time,
--                   anchored app-side via currentMonthWindow/todayInAppTimezone).
--   company_total   company MTD order total captured at the baseline. Retained
--                   for auditing; the displayed company Today is the SUM of the
--                   clamped per-AE deltas (see orders.ts applyTodayBaselineDeltas).
--   ae_totals       JSONB { salespersonId: mtdOrderTotal } at the baseline. An
--                   AE absent here is treated as baseline 0 by the reader.
--   territory_totals JSONB { salesTerritoryName: mtdOrderTotal } at the baseline.
--                   Additive — feeds ONLY the admin By-Territory view's Today
--                   (same delta formula); the AE/company Today never use it.
--   created_at / updated_at  audit. Rows are WRITE-ONCE — the app creates the
--                   baseline with INSERT … ON CONFLICT DO NOTHING and never
--                   updates it — so updated_at == created_at in practice.
--
-- ACCESS MODEL
--   RLS ENABLED with NO policy — server-only. The cron + manual-refresh routes
--   (service role) write/read it; the anon key has zero access. Same posture as
--   order_snapshot / cogent_territory_mappings.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, ALTER … ADD COLUMN IF NOT EXISTS, and
-- ENABLE ROW LEVEL SECURITY are all re-runnable. No seed data. See
-- supabase/README.md for migration order.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS order_today_baseline (
  baseline_date DATE PRIMARY KEY,
  company_total INTEGER NOT NULL,
  ae_totals JSONB NOT NULL DEFAULT '{}'::jsonb,
  territory_totals JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Re-runnable column adds for tables that predate any column above.
ALTER TABLE order_today_baseline ADD COLUMN IF NOT EXISTS company_total INTEGER;
ALTER TABLE order_today_baseline ADD COLUMN IF NOT EXISTS ae_totals JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE order_today_baseline ADD COLUMN IF NOT EXISTS territory_totals JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE order_today_baseline ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE order_today_baseline ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE order_today_baseline ENABLE ROW LEVEL SECURITY;
