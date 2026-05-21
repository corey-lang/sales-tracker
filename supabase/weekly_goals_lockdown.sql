-- ===========================================================================
-- weekly_goals — lockdown + uniqueness (admin-only mutations via server).
-- ===========================================================================
-- WHAT THIS DOES
--   1. Consolidates any existing duplicate goal rows per scope+date,
--      keeping the most-recently-created row as canonical.
--   2. Adds two partial UNIQUE indexes so duplicates cannot recur:
--        * per-AE goals:  UNIQUE(salesperson_id, effective_from)
--                         WHERE salesperson_id IS NOT NULL
--        * global goals:  UNIQUE(effective_from)
--                         WHERE salesperson_id IS NULL
--      (Two partial indexes are needed because Postgres treats NULL
--      values as distinct in a normal UNIQUE index, so a single
--      `UNIQUE(salesperson_id, effective_from)` wouldn't catch
--      global-default duplicates.)
--   3. Locks the table down so the anon key can READ but NOT
--      INSERT/UPDATE/DELETE. Admins manage goals exclusively through
--      `/api/admin/goals*` (and `/api/admin/coaching/[ae_id]/next-week-goals`),
--      which run with the service-role key and bypass RLS.
--
-- WHY THIS REPLACES `weekly_goals_rls.sql` + `_rollback.sql`
--   The original `weekly_goals_rls.sql` simply enabled RLS with no
--   policies; that broke every client-side read (goals.ts /
--   today-totals-card.tsx / my-week-card.tsx / daily-entry-form.tsx /
--   admin/totals-card.tsx / admin/maintenance-card.tsx). It was
--   reverted by `_rollback.sql`. This migration instead keeps SELECT
--   open for anon (the reads are legitimate per-AE and per-team-default
--   targets) while denying mutations.
--
-- READS THAT STAY ON THE ANON KEY (legitimate, low-risk):
--   * `src/lib/goals.ts` (fetchActiveGoalFor / fetchActiveGoalForScope)
--   * `src/components/today-totals-card.tsx`
--   * `src/components/my-week-card.tsx`
--   * `src/components/daily-entry-form.tsx`
--   * `src/components/admin/totals-card.tsx`
--   * `src/components/admin/maintenance-card.tsx`
--   * `src/components/admin/goals-card.tsx` (reads only — writes moved
--     to /api/admin/goals*)
--
-- WRITES NOW BEHIND SERVER ROUTES (admin-gated):
--   * POST   /api/admin/goals               — insert OR update by scope+date
--   * DELETE /api/admin/goals/[id]          — delete a historic row
--   * PUT    /api/admin/coaching/[ae_id]/next-week-goals — already gated
--
-- Idempotent: safe to re-run.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1) Consolidate duplicate (scope, effective_from) rows BEFORE adding
--    the unique indexes — otherwise the index creation would fail on
--    any upgraded DB that has duplicates from the old "every save is
--    an INSERT" workflow.
--
--    Survivor per group = the most recently created row. Older
--    duplicates are deleted (not archived — the goals table has no
--    archive lifecycle and the survivor carries the latest values).
-- ---------------------------------------------------------------------------

WITH ranked AS (
  SELECT id,
         salesperson_id,
         effective_from,
         ROW_NUMBER() OVER (
           PARTITION BY COALESCE(salesperson_id::text, '__global__'),
                        effective_from
           ORDER BY created_at DESC NULLS LAST, id DESC
         ) AS rn
    FROM weekly_goals
)
DELETE FROM weekly_goals g
 USING ranked r
 WHERE g.id = r.id
   AND r.rn > 1;


-- ---------------------------------------------------------------------------
-- 2) Partial UNIQUE indexes so duplicates cannot recur.
--
--    Per-AE: one row per (salesperson_id, effective_from).
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS idx_weekly_goals_per_ae_effective
  ON weekly_goals(salesperson_id, effective_from)
  WHERE salesperson_id IS NOT NULL;

-- Global default: one row per effective_from when salesperson_id IS NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_weekly_goals_global_effective
  ON weekly_goals(effective_from)
  WHERE salesperson_id IS NULL;


-- ---------------------------------------------------------------------------
-- 3) RLS lockdown — read-only for anon.
--
--    ENABLE RLS, then add ONE permissive SELECT policy. With no
--    INSERT/UPDATE/DELETE policies, those operations fall through to
--    "no policy matches" and PostgREST returns a 401/permission error.
--    Service-role bypasses RLS, so the admin server routes continue to
--    work normally.
--
--    Belt-and-suspenders: also REVOKE the write GRANTs from anon and
--    authenticated, so even if RLS were ever disabled by accident the
--    table-level GRANT layer still denies writes.
-- ---------------------------------------------------------------------------

ALTER TABLE weekly_goals ENABLE ROW LEVEL SECURITY;

-- Drop-and-recreate so the policy text always reflects what's in this file.
DROP POLICY IF EXISTS "weekly_goals anon select" ON weekly_goals;
CREATE POLICY "weekly_goals anon select"
  ON weekly_goals
  FOR SELECT
  TO anon, authenticated
  USING (true);

REVOKE INSERT, UPDATE, DELETE ON weekly_goals FROM anon;
REVOKE INSERT, UPDATE, DELETE ON weekly_goals FROM authenticated;

-- SELECT GRANTs are unchanged — the reads listed in the header still
-- need to work.
GRANT SELECT ON weekly_goals TO anon;
GRANT SELECT ON weekly_goals TO authenticated;


-- ===========================================================================
-- VERIFICATION (run after the migration)
-- ===========================================================================
-- SELECT COALESCE(salesperson_id::text, '__global__'), effective_from, COUNT(*)
--   FROM weekly_goals
--  GROUP BY 1, 2 HAVING COUNT(*) > 1;
--   -- expect 0 rows.
--
-- SELECT indexname FROM pg_indexes
--  WHERE tablename = 'weekly_goals'
--    AND indexname IN ('idx_weekly_goals_per_ae_effective',
--                      'idx_weekly_goals_global_effective');
--   -- expect 2 rows.
--
-- SELECT rowsecurity FROM pg_tables WHERE tablename = 'weekly_goals';
--   -- expect true.
--
-- SELECT policyname, cmd FROM pg_policies WHERE tablename = 'weekly_goals';
--   -- expect 1 policy: "weekly_goals anon select" / SELECT.
--
-- -- Manual smoke test from a browser console (anon key):
-- --   supabase.from('weekly_goals').insert({ effective_from: '2099-01-01' })
-- --   -> expect "new row violates row-level security policy" (or similar).
