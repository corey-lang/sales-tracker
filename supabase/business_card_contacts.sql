-- Build 3: Verified Business Card Contacts.
-- Creates the permanent verified-contacts layer that the Verification Center
-- and a future CRM CSV export read from.
--
-- This migration is ADDITIVE ONLY. It never deletes scans or business card
-- images: business_card_contacts is a new table, and the columns added to
-- business_card_scans only record where a scan sits in the verification
-- workflow and which contact (if any) was derived from it.
--
-- Idempotent: every statement uses IF NOT EXISTS / CREATE OR REPLACE /
-- DROP ... IF EXISTS so this file can be re-run safely.

-- ---------------------------------------------------------------------------
-- 1. business_card_contacts — the verified contact layer
-- ---------------------------------------------------------------------------
-- One row per verified (auto-approved or admin-approved) contact derived from
-- a scan. scan_id links back to the originating scan, which is kept forever.
-- Column order mirrors the future CSV export so the export query stays simple.

CREATE TABLE IF NOT EXISTS business_card_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id UUID REFERENCES business_card_scans(id),
  salesperson_id UUID,
  salesperson_name TEXT,
  contact_bucket TEXT NOT NULL,
  contact_type_raw TEXT,
  first_name TEXT,
  last_name TEXT,
  full_name TEXT,
  company TEXT,
  title TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  address TEXT,
  image_path TEXT,
  image_url TEXT,
  ai_confidence NUMERIC,
  verification_status TEXT NOT NULL DEFAULT 'needs_review',
  duplicate_status TEXT NOT NULL DEFAULT 'unchecked',
  duplicate_of_contact_id UUID REFERENCES business_card_contacts(id),
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  rejected_by TEXT,
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bcc_scan_id
  ON business_card_contacts(scan_id);
CREATE INDEX IF NOT EXISTS idx_bcc_salesperson_id
  ON business_card_contacts(salesperson_id);
CREATE INDEX IF NOT EXISTS idx_bcc_salesperson_name
  ON business_card_contacts(salesperson_name);
CREATE INDEX IF NOT EXISTS idx_bcc_contact_bucket
  ON business_card_contacts(contact_bucket);
CREATE INDEX IF NOT EXISTS idx_bcc_email
  ON business_card_contacts(email);
CREATE INDEX IF NOT EXISTS idx_bcc_phone
  ON business_card_contacts(phone);
CREATE INDEX IF NOT EXISTS idx_bcc_verification_status
  ON business_card_contacts(verification_status);
CREATE INDEX IF NOT EXISTS idx_bcc_duplicate_status
  ON business_card_contacts(duplicate_status);

-- updated_at trigger. The project has no shared updated_at trigger pattern yet
-- (activity_entries.updated_at exists but is never refreshed — see CLAUDE.md),
-- so this defines a small self-contained trigger scoped to this table only.
CREATE OR REPLACE FUNCTION set_business_card_contacts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_business_card_contacts_updated_at
  ON business_card_contacts;
CREATE TRIGGER trg_business_card_contacts_updated_at
  BEFORE UPDATE ON business_card_contacts
  FOR EACH ROW
  EXECUTE FUNCTION set_business_card_contacts_updated_at();

-- ---------------------------------------------------------------------------
-- 2. business_card_scans — verification workflow columns
-- ---------------------------------------------------------------------------
-- Additive only. Existing scan rows keep every column and value they had;
-- these new columns simply track verification state. verified_contact_id is
-- a backlink to the contact created from the scan (nullable until verified).
-- rejection_reason stores why an admin rejected a scan.
--
-- duplicate_of_contact_id (Build 5) records WHICH existing contact a scan was
-- detected to duplicate, so the Verification Center can load that contact and
-- show a side-by-side comparison. duplicate_notes still holds the readable
-- explanation; this column adds a structured, joinable link. Nullable: a scan
-- only has it once duplicate detection finds a match.

ALTER TABLE business_card_scans
  ADD COLUMN IF NOT EXISTS verification_status TEXT DEFAULT 'needs_review',
  ADD COLUMN IF NOT EXISTS verified_contact_id UUID
    REFERENCES business_card_contacts(id),
  ADD COLUMN IF NOT EXISTS duplicate_status TEXT DEFAULT 'unchecked',
  ADD COLUMN IF NOT EXISTS duplicate_notes TEXT,
  ADD COLUMN IF NOT EXISTS duplicate_of_contact_id UUID
    REFERENCES business_card_contacts(id),
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_business_card_scans_verification_status
  ON business_card_scans(verification_status);
CREATE INDEX IF NOT EXISTS idx_business_card_scans_duplicate_status
  ON business_card_scans(duplicate_status);
CREATE INDEX IF NOT EXISTS idx_business_card_scans_duplicate_of_contact_id
  ON business_card_scans(duplicate_of_contact_id);

-- ---------------------------------------------------------------------------
-- 3. business_card_contacts — CRM export tracking columns (Build 6)
-- ---------------------------------------------------------------------------
-- Additive only. These columns record WHEN a contact was exported to CRM CSV,
-- WHICH export batch it belonged to, and WHO ran the export. They let the
-- export route skip already-exported contacts by default. Exporting only ever
-- stamps these columns — it never deletes a contact. A NULL exported_at means
-- "not yet exported".

ALTER TABLE business_card_contacts
  ADD COLUMN IF NOT EXISTS exported_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS export_batch_id UUID,
  ADD COLUMN IF NOT EXISTS exported_by TEXT;

CREATE INDEX IF NOT EXISTS idx_bcc_exported_at
  ON business_card_contacts(exported_at);
CREATE INDEX IF NOT EXISTS idx_bcc_export_batch_id
  ON business_card_contacts(export_batch_id);

-- ---------------------------------------------------------------------------
-- 4. business_card_export_batches — CRM export history (Build 6)
-- ---------------------------------------------------------------------------
-- One row per CSV export run. Records which AE was exported (null = all AEs),
-- how many contacts the batch contained, and who ran it. Contacts point back
-- via business_card_contacts.export_batch_id. This is an append-only history
-- table — nothing here is ever deleted.

CREATE TABLE IF NOT EXISTS business_card_export_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salesperson_id UUID,
  salesperson_name TEXT,
  contact_count INTEGER NOT NULL DEFAULT 0,
  exported_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bceb_salesperson_id
  ON business_card_export_batches(salesperson_id);
CREATE INDEX IF NOT EXISTS idx_bceb_salesperson_name
  ON business_card_export_batches(salesperson_name);
CREATE INDEX IF NOT EXISTS idx_bceb_created_at
  ON business_card_export_batches(created_at);
