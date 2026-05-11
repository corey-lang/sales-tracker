CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE salespeople (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name CITEXT NOT NULL UNIQUE,
  location TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE weekly_goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_from DATE NOT NULL,
  office_visits INT DEFAULT 0,
  service_requests INT DEFAULT 0,
  ones_scheduled INT DEFAULT 0,
  ones_held INT DEFAULT 0,
  impressions INT DEFAULT 0,
  team_meetings INT DEFAULT 0,
  gold_list_touches INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE activity_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salesperson_id UUID NOT NULL REFERENCES salespeople(id) ON DELETE CASCADE,
  entry_date DATE NOT NULL,
  office_visits INT DEFAULT 0,
  service_requests INT DEFAULT 0,
  ones_scheduled INT DEFAULT 0,
  ones_held INT DEFAULT 0,
  impressions INT DEFAULT 0,
  team_meetings INT DEFAULT 0,
  gold_list_touches INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(salesperson_id, entry_date)
);

CREATE TABLE gold_list_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salesperson_id UUID NOT NULL REFERENCES salespeople(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE gold_list_touches_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_entry_id UUID NOT NULL REFERENCES activity_entries(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES gold_list_targets(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(activity_entry_id, target_id)
);

CREATE INDEX idx_activity_entries_salesperson_date ON activity_entries(salesperson_id, entry_date DESC);
CREATE INDEX idx_gold_list_targets_salesperson ON gold_list_targets(salesperson_id) WHERE active = true;
