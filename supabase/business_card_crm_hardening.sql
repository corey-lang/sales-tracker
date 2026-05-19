-- Business card CRM hardening — prep for the "Save to phone contacts" feature.
--
-- Strengthens the scan pipeline so scanned cards are safer and future-proof for
-- CRM use, WITHOUT changing the existing upload -> AI extraction -> review ->
-- export flow:
--
--   1. storage_path           — the stable Supabase Storage object path, so the
--                               app no longer depends only on the public
--                               image_url (which breaks if the bucket is
--                               renamed or made private).
--   2. normalized_email /     — lowercase-trimmed email + digits-only phone,
--      normalized_phone         persisted for reliable duplicate detection.
--   3. raw_extraction_json /  — the raw AI response (pre-normalization) plus the
--      extraction_model         model name, so extractions stay auditable and
--                               re-derivable. (ai_confidence already stores the
--                               extraction confidence — no new column needed.)
--   4. updated_at + trigger   — scan rows are mutated repeatedly by the
--                               verification workflow; this records when.
--
-- This migration is ADDITIVE ONLY. It never drops or renames a column, never
-- deletes a scan/contact/image, and keeps image_url intact for backward
-- compatibility. Existing rows are backfilled in place.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
-- CREATE OR REPLACE FUNCTION / DROP TRIGGER IF EXISTS so it can be re-run.

-- ---------------------------------------------------------------------------
-- 1. business_card_scans — new columns
-- ---------------------------------------------------------------------------

ALTER TABLE business_card_scans
  ADD COLUMN IF NOT EXISTS storage_path TEXT,
  ADD COLUMN IF NOT EXISTS normalized_email TEXT,
  ADD COLUMN IF NOT EXISTS normalized_phone TEXT,
  ADD COLUMN IF NOT EXISTS raw_extraction_json JSONB,
  ADD COLUMN IF NOT EXISTS extraction_model TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_business_card_scans_storage_path
  ON business_card_scans(storage_path);
CREATE INDEX IF NOT EXISTS idx_business_card_scans_normalized_email
  ON business_card_scans(normalized_email);
CREATE INDEX IF NOT EXISTS idx_business_card_scans_normalized_phone
  ON business_card_scans(normalized_phone);

-- ---------------------------------------------------------------------------
-- 2. business_card_scans — updated_at trigger
-- ---------------------------------------------------------------------------
-- Mirrors the per-table trigger pattern already used by business_card_contacts
-- (the project has no shared updated_at trigger). Scoped to this table only.

CREATE OR REPLACE FUNCTION set_business_card_scans_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_business_card_scans_updated_at
  ON business_card_scans;
CREATE TRIGGER trg_business_card_scans_updated_at
  BEFORE UPDATE ON business_card_scans
  FOR EACH ROW
  EXECUTE FUNCTION set_business_card_scans_updated_at();

-- ---------------------------------------------------------------------------
-- 3. business_card_contacts — new columns
-- ---------------------------------------------------------------------------
-- storage_path is copied from the originating scan when a contact is created
-- (image_path already existed but was always NULL; it is now populated with
-- the same value so the legacy column is no longer dead).

ALTER TABLE business_card_contacts
  ADD COLUMN IF NOT EXISTS storage_path TEXT,
  ADD COLUMN IF NOT EXISTS normalized_email TEXT,
  ADD COLUMN IF NOT EXISTS normalized_phone TEXT;

CREATE INDEX IF NOT EXISTS idx_bcc_storage_path
  ON business_card_contacts(storage_path);
CREATE INDEX IF NOT EXISTS idx_bcc_normalized_email
  ON business_card_contacts(normalized_email);
CREATE INDEX IF NOT EXISTS idx_bcc_normalized_phone
  ON business_card_contacts(normalized_phone);

-- ---------------------------------------------------------------------------
-- 4. Backfill existing rows
-- ---------------------------------------------------------------------------
-- All backfills are guarded by `WHERE <col> IS NULL` so re-running is a no-op
-- and so they never overwrite a value written by the application.

-- 4a. scans.storage_path — derive from the public image_url. The public URL is
--     ".../object/public/business-card-scans/<path>"; everything after the
--     bucket segment is the object path.
UPDATE business_card_scans
SET storage_path = substring(image_url FROM '/business-card-scans/(.+)$')
WHERE storage_path IS NULL
  AND image_url LIKE '%/business-card-scans/%';

-- 4b. scans.normalized_email / normalized_phone — from the extracted values.
UPDATE business_card_scans
SET normalized_email = lower(btrim(extracted_email))
WHERE normalized_email IS NULL
  AND extracted_email IS NOT NULL
  AND btrim(extracted_email) <> '';

UPDATE business_card_scans
SET normalized_phone = NULLIF(regexp_replace(extracted_phone, '\D', '', 'g'), '')
WHERE normalized_phone IS NULL
  AND extracted_phone IS NOT NULL;

-- 4c. contacts.normalized_email / normalized_phone — from the stored values.
UPDATE business_card_contacts
SET normalized_email = lower(btrim(email))
WHERE normalized_email IS NULL
  AND email IS NOT NULL
  AND btrim(email) <> '';

UPDATE business_card_contacts
SET normalized_phone = NULLIF(regexp_replace(phone, '\D', '', 'g'), '')
WHERE normalized_phone IS NULL
  AND phone IS NOT NULL;

-- 4d. contacts.storage_path — copy from the originating scan. Also populate the
--     legacy image_path column with the same value so it is no longer dead.
UPDATE business_card_contacts c
SET storage_path = s.storage_path
FROM business_card_scans s
WHERE c.scan_id = s.id
  AND c.storage_path IS NULL
  AND s.storage_path IS NOT NULL;

UPDATE business_card_contacts
SET image_path = storage_path
WHERE image_path IS NULL
  AND storage_path IS NOT NULL;
