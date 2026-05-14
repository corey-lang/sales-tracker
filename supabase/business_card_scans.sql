-- Phase 3 of the business card scanner: real scan intake (test account only).
-- Creates the intake table + Supabase Storage bucket + the storage policies the
-- browser client needs to upload and read images with the anon key.
--
-- Idempotent: every statement uses IF NOT EXISTS / ON CONFLICT / DO blocks so
-- this file can be re-run safely.

-- ---------------------------------------------------------------------------
-- 1. Intake table
-- ---------------------------------------------------------------------------
-- Mirrors the rest of the schema in not enabling RLS — the anon key already
-- has full read/write on every other table (see CLAUDE.md "Open questions").
-- is_test_data defaults TRUE because Phase 3 is gated to the Test account
-- only; AE/admin rows must never land here.

CREATE TABLE IF NOT EXISTS business_card_scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  salesperson_id UUID NOT NULL REFERENCES salespeople(id) ON DELETE CASCADE,
  salesperson_name TEXT,
  image_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  is_test_data BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_business_card_scans_salesperson
  ON business_card_scans(salesperson_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. Storage bucket
-- ---------------------------------------------------------------------------
-- Public-read so the admin/test review UI can render <img> tags with the
-- stored URL without needing signed-URL plumbing. Writes still require the
-- anon-insert policy below.

INSERT INTO storage.buckets (id, name, public)
VALUES ('business-card-scans', 'business-card-scans', true)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Storage policies
-- ---------------------------------------------------------------------------
-- storage.objects has RLS on by default. Without these policies the browser
-- upload (using the anon key) will 403.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'business-card-scans anon insert'
  ) THEN
    CREATE POLICY "business-card-scans anon insert"
      ON storage.objects FOR INSERT TO anon
      WITH CHECK (bucket_id = 'business-card-scans');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'business-card-scans anon select'
  ) THEN
    CREATE POLICY "business-card-scans anon select"
      ON storage.objects FOR SELECT TO anon
      USING (bucket_id = 'business-card-scans');
  END IF;
END$$;
