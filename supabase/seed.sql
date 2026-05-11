-- Test data: one salesperson + one weekly goals row.
-- Safe to re-run: ON CONFLICT DO NOTHING keeps existing rows.
-- first_name is CITEXT, so "Test" / "test" / "TEST" all collide.

INSERT INTO salespeople (first_name, location) VALUES
  ('Test',   'HQ'),
  ('Alex',   'HQ'),
  ('Jordan', 'HQ')
ON CONFLICT (first_name) DO NOTHING;

-- Daily goals (table is named weekly_goals for legacy reasons; values are daily).
-- effective_from is unique-per-row-by-itself here; if you re-seed, this will
-- silently do nothing because there's no conflict key, so adjust manually if
-- you want to change goals after the first run.
INSERT INTO weekly_goals (
  effective_from,
  office_visits,
  service_requests,
  ones_scheduled,
  ones_held,
  impressions,
  team_meetings,
  gold_list_touches
)
SELECT
  CURRENT_DATE,
  25,  -- office_visits
  5,   -- service_requests
  2,   -- ones_scheduled
  1,   -- ones_held
  150, -- impressions
  4,   -- team_meetings
  25   -- gold_list_touches
WHERE NOT EXISTS (SELECT 1 FROM weekly_goals);
