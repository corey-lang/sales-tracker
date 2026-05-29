-- ===========================================================================
-- cogent_territory_mappings — Cogent sales-territory → AE (salesperson) map.
-- ===========================================================================
-- WHAT THIS IS
--   Cogent's Orders API reports orders grouped by `salesTerritoryName`
--   (e.g. "UT Salt Lake", "PHX East"). The AE Orders tile aggregates those
--   territories up to a single Account Executive. This table is that mapping.
--
-- WHY A TABLE (not a column on salespeople)
--   The relationship is NOT 1:1. Kennedy owns TWO Cogent territories
--   ("UT Salt Lake" + "UT North"), and more AEs may pick up multiple
--   territories over time. A single `cogent_territory` column on salespeople
--   could not represent that, so the mapping lives here: one row per
--   territory, many rows allowed per salesperson.
--
-- ACCESS MODEL
--   RLS is ENABLED with NO policy, so the browser anon key has zero access.
--   The mapping is read only by the service-role server library
--   (src/lib/server/cogent.ts) behind the admin-gated
--   /api/cogent/orders-summary route. No client-side reader exists, so
--   locking it down up front breaks nothing — same posture as ae_tasks.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
-- DROP TRIGGER IF EXISTS, ENABLE ROW LEVEL SECURITY, and the seed's
-- ON CONFLICT DO NOTHING are all re-runnable.
-- See supabase/README.md for migration order.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS cogent_territory_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The exact `salesTerritoryName` string Cogent returns. UNIQUE so a
  -- territory can map to at most one AE (the inverse — one AE, many
  -- territories — is what makes the table necessary).
  sales_territory_name TEXT NOT NULL UNIQUE,
  salesperson_id UUID NOT NULL REFERENCES salespeople(id) ON DELETE CASCADE,
  -- Soft-disable a mapping without deleting it (e.g. a territory is
  -- temporarily unstaffed). The aggregation library only honours
  -- active = true rows; everything else falls through to
  -- "unmappedTerritories" so it's visible, not silently dropped.
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- sales_territory_name is already indexed by the UNIQUE constraint above
-- (Postgres backs UNIQUE with a btree index), so no separate index is
-- created for it — that would be a redundant duplicate.

-- Hot path: the aggregator loads all active mappings, then joins by
-- salesperson to roll territories up to an AE.
CREATE INDEX IF NOT EXISTS idx_cogent_territory_mappings_salesperson
  ON cogent_territory_mappings(salesperson_id);

-- Partial index for the active-only scan the aggregator performs.
CREATE INDEX IF NOT EXISTS idx_cogent_territory_mappings_active
  ON cogent_territory_mappings(active)
  WHERE active = TRUE;

-- updated_at maintenance. The project has no shared trigger (see CLAUDE.md);
-- this mirrors the small self-contained trigger in ae_tasks.sql.
CREATE OR REPLACE FUNCTION set_cogent_territory_mappings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cogent_territory_mappings_updated_at
  ON cogent_territory_mappings;
CREATE TRIGGER trg_cogent_territory_mappings_updated_at
  BEFORE UPDATE ON cogent_territory_mappings
  FOR EACH ROW
  EXECUTE FUNCTION set_cogent_territory_mappings_updated_at();

-- Server-only access: RLS on, no policy. The service-role key (server routes)
-- bypasses RLS; the anon key is fully locked out.
ALTER TABLE cogent_territory_mappings ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Seed: territory → AE, resolved by salespeople.first_name.
-- ---------------------------------------------------------------------------
-- first_name is CITEXT, so the join is case-insensitive ("carli" = "Carli").
--
-- This is a JOIN, not a per-row INSERT: if a salesperson is missing from the
-- salespeople table, that VALUES row simply produces no JOIN match and is
-- skipped — the migration NEVER FAILS on a missing person. After running,
-- compare the row count below against the seeded territories (12 here + the
-- NV Mesquite upsert that follows = 13); any territory whose
-- AE wasn't found will be absent and must be inserted manually once the
-- salesperson exists, e.g.:
--
--   INSERT INTO cogent_territory_mappings (sales_territory_name, salesperson_id)
--   SELECT 'PHX West', id FROM salespeople WHERE first_name = 'Vivian';
--
-- ON CONFLICT (sales_territory_name) DO NOTHING keeps the seed idempotent and
-- never clobbers a mapping an admin later edited by hand.
INSERT INTO cogent_territory_mappings (sales_territory_name, salesperson_id)
SELECT m.territory, s.id
FROM (
  VALUES
    ('UT Central',    'Carli'),
    ('UT Salt Lake',  'Kennedy'),
    ('UT North',      'Kennedy'),
    ('UT South',      'Heather'),
    ('PHX East',      'Camille'),
    ('PHX North',     'Lia'),
    ('PHX West',      'Vivian'),
    ('DFW East',      'Hilary'),
    ('DFW West',      'James'),
    ('San Antonio',   'Shannon'),
    ('Austin',        'Chanel'),
    ('NV Las Vegas',  'Jocelyn')
) AS m(territory, first_name)
JOIN salespeople s ON s.first_name = m.first_name
ON CONFLICT (sales_territory_name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- NV Mesquite → Heather (corrective upsert).
-- ---------------------------------------------------------------------------
-- "NV Mesquite" surfaced under unmappedTerritories in the orders summary, so
-- it must map to Heather. Unlike the seed above (DO NOTHING), this is an
-- UPSERT with DO UPDATE: if the territory already exists — mapped to someone
-- else or soft-disabled — its row is corrected to Heather and re-activated
-- rather than left stale or duplicated. The UNIQUE on sales_territory_name
-- guarantees a single row. Idempotent: re-running re-points it to the same
-- AE. No-ops (skips) only if Heather isn't in salespeople yet.
INSERT INTO cogent_territory_mappings (sales_territory_name, salesperson_id, active)
SELECT 'NV Mesquite', s.id, TRUE
FROM salespeople s
WHERE s.first_name = 'Heather'
ON CONFLICT (sales_territory_name) DO UPDATE
  SET salesperson_id = EXCLUDED.salesperson_id,
      active = TRUE,
      updated_at = NOW();

-- Verify which territories landed (and which AEs were missing). Optional:
--   SELECT m.sales_territory_name, s.first_name
--   FROM cogent_territory_mappings m
--   JOIN salespeople s ON s.id = m.salesperson_id
--   ORDER BY m.sales_territory_name;
