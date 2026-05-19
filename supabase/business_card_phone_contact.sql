-- "Scan & Add to Phone Contacts" — the AE phone-contact flow.
--
-- A second, AE-facing path alongside the existing admin/Tonja review flow: an
-- AE scans a card, verifies/edits the extracted fields, saves the contact, and
-- adds it to their phone via a vCard. This migration adds the columns that
-- path needs on business_card_contacts.
--
-- This migration is ADDITIVE ONLY. It does not touch the admin flow, the
-- verification workflow columns, the CSV export columns, or any scan data.
-- Existing rows keep every value; the new columns default to NULL.
--
--   notes                     — free-text notes the AE adds on the review
--                               screen; also written into the vCard NOTE.
--   verified_by_ae_at         — set when an AE saves a contact through the
--                               phone-contact review screen.
--   phone_contact_exported_at — set when the AE generates the vCard ("Add to
--                               Phone Contacts"). NULL = never exported.
--   contact_save_mode         — 'phone_contact' for rows created by the AE
--                               phone-contact flow; NULL for the admin flow.
--                               This is what keeps the two paths separable —
--                               the admin CSV export filters on
--                               verification_status and never sees these rows.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS so this
-- file can be re-run safely.

ALTER TABLE business_card_contacts
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS verified_by_ae_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS phone_contact_exported_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS contact_save_mode TEXT;

-- The AE flow looks up its row by (scan_id, contact_save_mode); idx_bcc_scan_id
-- already covers scan_id, this index covers filtering / reporting by mode.
CREATE INDEX IF NOT EXISTS idx_bcc_contact_save_mode
  ON business_card_contacts(contact_save_mode);
