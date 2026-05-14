-- Phase 5 of the business card scanner: AI extraction fields.
-- Adds raw OCR + extracted contact fields + extraction_status to
-- business_card_scans. Still test-account only — rows in this table only
-- exist for the Test rep (Phase 3 intake gating), and the extraction route
-- additionally rejects any row with is_test_data = false.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS lets this file be re-run safely.

ALTER TABLE business_card_scans
  ADD COLUMN IF NOT EXISTS raw_ocr_text TEXT,
  ADD COLUMN IF NOT EXISTS extracted_first_name TEXT,
  ADD COLUMN IF NOT EXISTS extracted_last_name TEXT,
  ADD COLUMN IF NOT EXISTS extracted_full_name TEXT,
  ADD COLUMN IF NOT EXISTS extracted_company TEXT,
  ADD COLUMN IF NOT EXISTS extracted_title TEXT,
  ADD COLUMN IF NOT EXISTS extracted_email TEXT,
  ADD COLUMN IF NOT EXISTS extracted_phone TEXT,
  ADD COLUMN IF NOT EXISTS extracted_website TEXT,
  ADD COLUMN IF NOT EXISTS extracted_address TEXT,
  ADD COLUMN IF NOT EXISTS extracted_contact_type TEXT,
  ADD COLUMN IF NOT EXISTS ai_confidence NUMERIC,
  ADD COLUMN IF NOT EXISTS ai_notes TEXT,
  ADD COLUMN IF NOT EXISTS extraction_status TEXT DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS extraction_error TEXT,
  ADD COLUMN IF NOT EXISTS extracted_at TIMESTAMPTZ;
