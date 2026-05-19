-- Business card scan image orientation.
--
-- Some cards were photographed sideways/upside-down. This adds a per-scan
-- display rotation so reviewers can straighten the image in the Verification
-- Center. It is DISPLAY METADATA ONLY — the uploaded image file in Storage is
-- never altered. Valid values are 0, 90, 180, 270 (degrees clockwise); the
-- value is enforced by POST /api/business-card/update-rotation.
--
-- Additive and idempotent: ADD COLUMN IF NOT EXISTS, safe to re-run.

ALTER TABLE business_card_scans
  ADD COLUMN IF NOT EXISTS image_rotation_degrees INTEGER NOT NULL DEFAULT 0;
