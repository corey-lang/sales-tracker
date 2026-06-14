-- ===========================================================================
-- replace_activity_week — atomic Sun-Sat activity-week total replacement.
-- ===========================================================================
-- WHAT THIS IS
--   The AE "Edit activity week" card (src/components/edit-week-card.tsx) lets a
--   rep overwrite a whole Sunday-Saturday ACTIVITY week's totals. The
--   replacement is two operations:
--     1. UPSERT the week total onto the activity week's SUNDAY entry_date row.
--     2. DELETE that rep's other rows in (Sunday, Saturday] (Mon..Sat).
--   Done as separate client calls, a failure between them could leave the week
--   DOUBLE-COUNTED (Sunday total written, stale Mon..Sat rows not yet cleared).
--   This function performs both in ONE transaction (a plpgsql function body is
--   atomic), so no partial double-count state is ever observable.
--
-- BUSINESS MODEL (unchanged by this migration)
--   Activity week = Sunday-Saturday; Sunday starts it, Saturday closes it.
--   Activity totals/progress/pacing numerators read the Sun-Sat window. PTO /
--   holiday / available-day TARGET adjustment stays on the Mon-Fri working-day
--   logic elsewhere. This function only moves the existing upsert+delete into a
--   single transaction — it does not change which dates count.
--
-- ACCESS MODEL
--   SECURITY INVOKER (default): runs with the CALLER's privileges. The card
--   calls this with the browser anon key, which already holds INSERT/UPDATE/
--   DELETE on activity_entries (the closed-team model — same access the prior
--   two-call path used). No privilege escalation; no SECURITY DEFINER.
--
-- SAFETY
--   * Writes/deletes are scoped to p_salesperson_id — never another AE.
--   * Deletes are bounded to (p_week_start, p_week_end] — never another week.
--   * The delete runs AFTER the Sunday upsert, in the SAME transaction, so the
--     Sunday replacement and the Mon..Sat clear commit together or not at all.
--   * Validates the window is exactly a 7-day Sun..Sat span before touching data.
--
-- Idempotent: ALTER ... ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE FUNCTION +
-- the REVOKE/GRANT are all re-runnable. No seed data. See supabase/README.md.
-- ===========================================================================

-- Reconcile a drifted column: `activity_entries.presentations` is written by the
-- app (it is part of ACTIVITIES) but was never in a migration. Ensure it exists
-- before the function references it, so this file is safe on a fresh database.
ALTER TABLE activity_entries ADD COLUMN IF NOT EXISTS presentations INT DEFAULT 0;

CREATE OR REPLACE FUNCTION replace_activity_week(
  p_salesperson_id UUID,
  p_week_start DATE,   -- Sunday of the selected activity week
  p_week_end DATE,     -- Saturday of the selected activity week
  p_values JSONB       -- { office_visits, service_requests, ... } weekly totals
) RETURNS activity_entries AS $$
DECLARE
  result activity_entries;
BEGIN
  -- The window must be exactly Sunday .. Sunday+6 (Saturday).
  IF p_week_end <> p_week_start + 6 THEN
    RAISE EXCEPTION
      'replace_activity_week: p_week_end (%) must equal p_week_start (%) + 6 days',
      p_week_end, p_week_start;
  END IF;
  -- p_week_start must be a Sunday. Postgres EXTRACT(DOW) returns 0 for Sunday.
  IF EXTRACT(DOW FROM p_week_start) <> 0 THEN
    RAISE EXCEPTION
      'replace_activity_week: p_week_start (%) must be a Sunday', p_week_start;
  END IF;

  -- 1. Write the whole-week total onto the activity week's Sunday row. Missing
  --    keys default to 0. Preserves updated_at behavior (set to NOW() on every
  --    write, matching the prior client upsert which stamped updated_at).
  INSERT INTO activity_entries (
    salesperson_id, entry_date,
    office_visits, service_requests, ones_scheduled, ones_held,
    presentations, impressions, team_meetings, gold_list_touches,
    updated_at
  ) VALUES (
    p_salesperson_id, p_week_start,
    COALESCE((p_values->>'office_visits')::int, 0),
    COALESCE((p_values->>'service_requests')::int, 0),
    COALESCE((p_values->>'ones_scheduled')::int, 0),
    COALESCE((p_values->>'ones_held')::int, 0),
    COALESCE((p_values->>'presentations')::int, 0),
    COALESCE((p_values->>'impressions')::int, 0),
    COALESCE((p_values->>'team_meetings')::int, 0),
    COALESCE((p_values->>'gold_list_touches')::int, 0),
    NOW()
  )
  ON CONFLICT (salesperson_id, entry_date) DO UPDATE
    SET office_visits = EXCLUDED.office_visits,
        service_requests = EXCLUDED.service_requests,
        ones_scheduled = EXCLUDED.ones_scheduled,
        ones_held = EXCLUDED.ones_held,
        presentations = EXCLUDED.presentations,
        impressions = EXCLUDED.impressions,
        team_meetings = EXCLUDED.team_meetings,
        gold_list_touches = EXCLUDED.gold_list_touches,
        updated_at = NOW()
  RETURNING * INTO result;

  -- 2. Clear the rest of the Sun..Sat week (Mon..Sat) so the week sums to
  --    exactly the entered total — no double count. Same transaction as the
  --    upsert above; scoped to this salesperson and this week only. (Any
  --    gold_list_touches_log rows on the cleared entries cascade-delete via
  --    their FK, exactly as the prior client-side delete behaved.)
  DELETE FROM activity_entries
  WHERE salesperson_id = p_salesperson_id
    AND entry_date > p_week_start
    AND entry_date <= p_week_end;

  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Callable from the browser anon client (same as the prior direct table writes).
REVOKE ALL ON FUNCTION replace_activity_week(UUID, DATE, DATE, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION replace_activity_week(UUID, DATE, DATE, JSONB)
  TO anon, authenticated, service_role;
