-- ===========================================================================
-- Cleanup: remove ONLY business card TEST data before the live AE rollout.
-- ===========================================================================
--
-- Scope: this script touches the business card workflow tables ONLY:
--   - business_card_scans
--   - business_card_contacts
--   - business_card_export_batches
-- It never touches activity_entries, salespeople, weekly_goals, the gold
-- list, or anything else — leaderboard / scoring data is left untouched.
--
-- Safety model:
--   * A scan is test data ONLY when business_card_scans.is_test_data = true.
--   * A contact is test data ONLY when it is linked (via scan_id) to a test
--     scan. Contacts with a NULL scan_id, or linked to a real scan, are kept.
--   * An export batch is deleted ONLY when it is "clearly test-related":
--     it has at least one test contact AND no real (non-test) contact.
--   * Real AE scans/contacts/batches are NEVER deleted by this script.
--
-- HOW TO USE:
--   1. Run PART A (preview) and PART B (storage preview) first. They are pure
--      SELECTs — they delete nothing. Confirm the row counts look right.
--   2. Only then run PART C (the transaction with the deletes).
--   3. PART B explains the (manual, optional) storage image cleanup — this
--      script does NOT delete storage objects automatically.
-- ===========================================================================


-- ===========================================================================
-- PART A — PREVIEW: what WILL be deleted (SELECT only, deletes nothing)
-- ===========================================================================

-- A1. Test scans that will be deleted.
SELECT 'business_card_scans (test)' AS table_name, COUNT(*) AS rows_to_delete
FROM business_card_scans
WHERE is_test_data = true;

-- A2. The actual test scan rows, for eyeballing.
SELECT id, salesperson_id, salesperson_name, image_url, status,
       extraction_status, verification_status, created_at
FROM business_card_scans
WHERE is_test_data = true
ORDER BY created_at;

-- A3. Contacts that will be deleted — only those linked to a test scan.
SELECT 'business_card_contacts (linked to test scans)' AS table_name,
       COUNT(*) AS rows_to_delete
FROM business_card_contacts
WHERE scan_id IN (
  SELECT id FROM business_card_scans WHERE is_test_data = true
);

-- A4. The actual test-linked contact rows.
SELECT c.id, c.scan_id, c.salesperson_name, c.full_name, c.company,
       c.verification_status, c.exported_at, c.created_at
FROM business_card_contacts c
WHERE c.scan_id IN (
  SELECT id FROM business_card_scans WHERE is_test_data = true
)
ORDER BY c.created_at;

-- A5. Export batches that will be deleted — "clearly test-related" only:
--     has >= 1 test contact AND 0 real contacts. Batches that exported any
--     real AE contact (including "export all" runs) are NOT listed here.
SELECT b.id, b.salesperson_name, b.contact_count, b.exported_by, b.created_at
FROM business_card_export_batches b
WHERE EXISTS (
        SELECT 1
        FROM business_card_contacts c
        JOIN business_card_scans s ON s.id = c.scan_id
        WHERE c.export_batch_id = b.id
          AND s.is_test_data = true
      )
  AND NOT EXISTS (
        SELECT 1
        FROM business_card_contacts c2
        JOIN business_card_scans s2 ON s2.id = c2.scan_id
        WHERE c2.export_batch_id = b.id
          AND s2.is_test_data = false
      )
ORDER BY b.created_at;

-- A6. SANITY CHECK — this should ALWAYS return 0. If it returns more than 0,
--     do NOT run PART C: a real scan is somehow flagged is_test_data = true.
SELECT COUNT(*) AS real_scans_wrongly_flagged_test
FROM business_card_scans
WHERE is_test_data = true
  AND salesperson_name IS NOT NULL
  AND lower(trim(salesperson_name)) <> 'test';


-- ===========================================================================
-- PART B — STORAGE IMAGE CLEANUP (preview + manual guidance, no auto-delete)
-- ===========================================================================
-- business_card_scans has no separate storage-path column; it stores the
-- public image_url. The object path inside the 'business-card-scans' bucket
-- is everything after '/business-card-scans/' in that URL.
--
-- B1. Preview the storage object paths for test images. Review this list
--     before removing any files.
SELECT id,
       salesperson_id,
       image_url,
       regexp_replace(image_url, '^.*/business-card-scans/', '')
         AS storage_object_path
FROM business_card_scans
WHERE is_test_data = true
ORDER BY created_at;

-- B2. (OPTIONAL) Preview the matching rows in Supabase Storage. This is a
--     SELECT only — it deletes nothing. Confirm every row is a test image.
-- SELECT name, bucket_id, created_at
-- FROM storage.objects
-- WHERE bucket_id = 'business-card-scans'
--   AND name IN (
--     SELECT regexp_replace(image_url, '^.*/business-card-scans/', '')
--     FROM business_card_scans
--     WHERE is_test_data = true
--   );
--
-- To actually remove the confirmed test images, use the Supabase Storage UI
-- (Storage > business-card-scans) or the Storage API with the exact paths
-- from B1. Do NOT delete storage objects blindly — only paths confirmed by
-- B1/B2 above. Real AE card images must remain in the bucket.


-- ===========================================================================
-- PART C — DELETES (run ONLY after reviewing PART A and confirming A6 = 0)
-- ===========================================================================
-- Wrapped in a transaction so a mismatch rolls the whole cleanup back.
-- The UPDATE steps null out foreign-key references INTO the test contacts so
-- the deletes cannot fail on FK constraints or hit unintended cascades. They
-- only ever set already-doomed links to NULL — no real record is removed.

BEGIN;

-- C1. Null out scan -> contact references that point at a test contact, so
--     deleting those contacts cannot violate the scans' FK constraints.
UPDATE business_card_scans
SET verified_contact_id = NULL
WHERE verified_contact_id IN (
  SELECT id FROM business_card_contacts
  WHERE scan_id IN (
    SELECT id FROM business_card_scans WHERE is_test_data = true
  )
);

UPDATE business_card_scans
SET duplicate_of_contact_id = NULL
WHERE duplicate_of_contact_id IN (
  SELECT id FROM business_card_contacts
  WHERE scan_id IN (
    SELECT id FROM business_card_scans WHERE is_test_data = true
  )
);

-- C2. Null out contact -> contact self-references that point at a test
--     contact (duplicate links), for the same FK-safety reason.
UPDATE business_card_contacts
SET duplicate_of_contact_id = NULL
WHERE duplicate_of_contact_id IN (
  SELECT id FROM business_card_contacts
  WHERE scan_id IN (
    SELECT id FROM business_card_scans WHERE is_test_data = true
  )
);

-- C3. Delete the clearly test-related export batches (same rule as A5).
--     Runs before C4 because it relies on the contact -> scan linkage.
DELETE FROM business_card_export_batches b
WHERE EXISTS (
        SELECT 1
        FROM business_card_contacts c
        JOIN business_card_scans s ON s.id = c.scan_id
        WHERE c.export_batch_id = b.id
          AND s.is_test_data = true
      )
  AND NOT EXISTS (
        SELECT 1
        FROM business_card_contacts c2
        JOIN business_card_scans s2 ON s2.id = c2.scan_id
        WHERE c2.export_batch_id = b.id
          AND s2.is_test_data = false
      );

-- C4. Delete contacts linked to test scans. Contacts with a NULL scan_id or
--     linked to a real scan are NOT touched.
DELETE FROM business_card_contacts
WHERE scan_id IN (
  SELECT id FROM business_card_scans WHERE is_test_data = true
);

-- C5. Delete the test scans themselves.
DELETE FROM business_card_scans
WHERE is_test_data = true;

-- Review the affected counts above, then COMMIT. Use ROLLBACK instead if
-- anything looks wrong.
COMMIT;

-- ===========================================================================
-- POST-CLEANUP VERIFICATION (run after COMMIT — all three should be 0)
-- ===========================================================================
-- SELECT COUNT(*) AS remaining_test_scans
-- FROM business_card_scans WHERE is_test_data = true;
--
-- SELECT COUNT(*) AS orphaned_contacts_from_test_scans
-- FROM business_card_contacts c
-- WHERE c.scan_id IS NOT NULL
--   AND NOT EXISTS (SELECT 1 FROM business_card_scans s WHERE s.id = c.scan_id);
