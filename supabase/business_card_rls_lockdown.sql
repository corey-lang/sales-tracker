-- ===========================================================================
-- Business card tables — remove anon READ access (Phase 0, STAGED).
-- ===========================================================================
-- WHAT THIS DOES
--   business_card_rls.sql enabled RLS on the business-card tables and granted
--   the browser anon key SELECT on business_card_scans + business_card_contacts
--   so the Verification Center could read them directly. As of Phase 0 that
--   data is served by a reviewer-guarded route instead:
--       GET /api/business-card/verification   (service-role key)
--
--   This migration drops the anon SELECT policies. With RLS still enabled and
--   no policy, the anon key can no longer read these tables AT ALL — every
--   read goes through the service-role server routes. Scanned-card PII (names,
--   emails, phones, OCR text) is then unreachable from the browser.
--
-- PREREQUISITE — APPLY ONLY AFTER DEPLOYING THE RELEASE THAT ADDS
--   GET /api/business-card/verification. Before that release the Verification
--   Center reads these tables directly with the anon key; dropping the
--   policies first would break it. See supabase/README.md.
--
--   The business-card-scans STORAGE bucket policies are NOT touched — card
--   images keep rendering from their public URLs.
--
-- Idempotent: DROP POLICY IF EXISTS is safe to re-run.
-- ===========================================================================

DROP POLICY IF EXISTS "business_card_scans anon select"
  ON business_card_scans;

DROP POLICY IF EXISTS "business_card_contacts anon select"
  ON business_card_contacts;

-- VERIFICATION (run after; service role bypasses RLS):
--   SELECT tablename, policyname, cmd, roles
--   FROM pg_policies
--   WHERE tablename IN ('business_card_scans', 'business_card_contacts')
--   ORDER BY tablename;
--   -- expect ZERO rows: RLS on, no policies, anon fully locked out.
