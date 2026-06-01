-- ===========================================================================
-- working_day_adjustments — admin-managed reductions to an AE's available
-- working days for a given week (holidays, PTO, conferences, company events).
-- ===========================================================================
-- WHAT THIS IS
--   The app assumes every AE has 5 available working days (Mon-Fri) per week.
--   This table lets an admin mark specific calendar days as unavailable —
--   either for EVERYONE (a company holiday) or for ONE AE (PTO, travel).
--
--   It does NOT change weekly goals. Weekly goals stay exactly as set; only
--   the PACE / "expected by now" math reads available days, so an AE on
--   approved time off isn't shown as "behind" for a day they're out, and the
--   per-day expectation (weekly goal ÷ available days) scales up.
--
-- SCOPE INVARIANT
--   * applies_to_all = TRUE  → salesperson_id IS NULL  (global / holiday)
--   * applies_to_all = FALSE → salesperson_id IS NOT NULL (individual)
--   Enforced by the CHECK constraint below.
--
-- DAY VALUE
--   day_value = 1.0  → a full day off (the only thing the admin UI creates today).
--   day_value = 0.5  → a half day (schema + pace math support it; no UI yet).
--   CHECK keeps it in (0, 1].
--
-- ACCESS MODEL
--   RLS ENABLED with NO policy — fully SERVER-ONLY (mirrors ae_tasks.sql).
--   The anon/authenticated keys have ZERO access: clients can neither read
--   nor write. Individual PTO rows can carry private context (reason/note),
--   so they must never be exposed to other AEs through a direct client read.
--   ALL access flows through service-role server routes that verify the
--   caller:
--     * Admin management + admin reports → /api/admin/* (requireAdmin)
--     * An AE's OWN available-days/pace → returned (own row only) by the
--       server-side leaderboard/scorecard helpers; the raw rows never cross
--       the wire.
--   The service-role key bypasses RLS; the anon key is locked out entirely.
--
-- HISTORICAL ACCURACY
--   Rows are dated. Pace for any past week is recomputed from the rows whose
--   adjustment_date falls in that Mon-Fri window, so viewing an old week later
--   stays accurate — deleting a future adjustment never rewrites history that
--   already happened, and the computation is pure given the stored rows.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
-- DROP TRIGGER/POLICY IF EXISTS, ENABLE RLS are all re-runnable.
-- See supabase/README.md for migration order.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS working_day_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  adjustment_date DATE NOT NULL,
  -- NULL for a global (applies_to_all) adjustment; the AE's id otherwise.
  salesperson_id UUID REFERENCES salespeople(id) ON DELETE CASCADE,
  applies_to_all BOOLEAN NOT NULL DEFAULT FALSE,
  -- 1.0 = full day off, 0.5 = half day (future). Always a reduction.
  day_value NUMERIC(2,1) NOT NULL DEFAULT 1.0
    CHECK (day_value > 0 AND day_value <= 1),
  reason TEXT NOT NULL,
  note TEXT,
  -- The admin who created it (display/audit). SET NULL if that admin is
  -- ever removed so the adjustment row survives.
  created_by UUID REFERENCES salespeople(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Scope invariant: global ⇔ no salesperson; individual ⇔ has salesperson.
  CONSTRAINT working_day_adjustments_scope CHECK (
    (applies_to_all = TRUE AND salesperson_id IS NULL)
    OR (applies_to_all = FALSE AND salesperson_id IS NOT NULL)
  )
);

-- Hot path: pace/available-day computation queries a Mon-Fri date range.
CREATE INDEX IF NOT EXISTS idx_working_day_adjustments_date
  ON working_day_adjustments(adjustment_date);

-- Per-AE lookups (individual adjustments).
CREATE INDEX IF NOT EXISTS idx_working_day_adjustments_salesperson
  ON working_day_adjustments(salesperson_id)
  WHERE salesperson_id IS NOT NULL;

-- No duplicate adjustment for the same day + scope. Two partial uniques:
-- one global row per day, one individual row per (day, AE).
CREATE UNIQUE INDEX IF NOT EXISTS idx_working_day_adjustments_global_day
  ON working_day_adjustments(adjustment_date)
  WHERE applies_to_all = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_working_day_adjustments_individual_day
  ON working_day_adjustments(adjustment_date, salesperson_id)
  WHERE applies_to_all = FALSE;

-- updated_at maintenance. The project has no shared trigger (see CLAUDE.md);
-- this mirrors the small self-contained trigger in ae_tasks.sql.
CREATE OR REPLACE FUNCTION set_working_day_adjustments_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_working_day_adjustments_updated_at
  ON working_day_adjustments;
CREATE TRIGGER trg_working_day_adjustments_updated_at
  BEFORE UPDATE ON working_day_adjustments
  FOR EACH ROW
  EXECUTE FUNCTION set_working_day_adjustments_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: SERVER-ONLY. Enabled with NO policy so the anon/authenticated keys get
-- nothing (no SELECT, no writes). Individual PTO rows can hold private context,
-- so no client ever reads this table directly — all access is via service-role
-- server routes that verify the caller. Mirrors ae_tasks.sql.
--
-- The earlier staged version of this migration shipped an anon SELECT policy;
-- the DROP POLICY + REVOKE below make re-running idempotent and also clean up
-- any database where that policy/grant already landed.
-- ---------------------------------------------------------------------------
ALTER TABLE working_day_adjustments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "working_day_adjustments anon select"
  ON working_day_adjustments;

REVOKE ALL ON working_day_adjustments FROM anon;
REVOKE ALL ON working_day_adjustments FROM authenticated;
