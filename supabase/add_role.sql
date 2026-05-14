-- One-off migration: add a `role` column to `salespeople` and seed values.
-- Coexists with the existing `is_admin` boolean — role is the source of truth
-- for new permission checks (assistant access), is_admin is still used by
-- existing leaderboard / admin-page queries.
--
-- Safe to re-run: every statement is idempotent.

ALTER TABLE salespeople
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'ae'
    CHECK (role IN ('admin', 'assistant', 'ae'));

-- Corey + Ryan are admins.
UPDATE salespeople SET role = 'admin'
  WHERE first_name IN ('Corey', 'Ryan');

-- Tonja is the assistant. Insert if missing; if she already exists, just
-- correct her role. first_name is CITEXT so case doesn't matter.
INSERT INTO salespeople (first_name, role)
VALUES ('Tonja', 'assistant')
ON CONFLICT (first_name) DO UPDATE SET role = 'assistant';

-- Belt-and-suspenders: anyone not Corey/Ryan/Tonja is an AE.
UPDATE salespeople SET role = 'ae'
  WHERE first_name NOT IN ('Corey', 'Ryan', 'Tonja');
