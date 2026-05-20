-- ===========================================================================
-- Juice Box Pass 5 — media posts (image uploads + GIPHY GIFs).
-- ===========================================================================
-- WHAT THIS IS
--   * Adds nullable media_* columns to team_messages so a post can carry
--     an attached image (Supabase Storage) or GIF (GIPHY URL) alongside
--     or instead of text.
--   * Provisions the `juice-box-media` storage bucket as PUBLIC-READ with
--     server-side-only writes (anon key has SELECT only; uploads go
--     through signed upload URLs minted by service-role).
--   * Caps bucket-level file size to 10 MB and restricts MIME types to
--     image/jpeg, image/png, image/webp, image/gif.
--
-- ACCESS MODEL
--   * team_messages stays as before — RLS enabled, anon SELECT only,
--     writes through /api/team-messages with service-role.
--   * The juice-box-media bucket is PUBLIC for reads so the supabase-js
--     client can render images via plain <img src="https://…/object/public/…">
--     without per-request signed URLs (matches business-card-scans
--     posture — see CLAUDE.md "Storage bucket privacy").
--   * NO anon insert/update/delete on storage.objects for this bucket.
--     The signed-upload route mints scoped one-time URLs server-side
--     under the Juice Box gate; clients can only upload to paths the
--     server explicitly authorized.
--
-- TEXT REQUIREMENT
--   `message` stays NOT NULL but becomes effectively optional in the
--   API: an empty string is permitted when a media field is attached.
--   The CHECK below enforces that media_type / media_url are paired
--   (both present or both absent).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS +
-- ADD CONSTRAINT, INSERT ON CONFLICT, guarded policy creation.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1) Media columns on team_messages
-- ---------------------------------------------------------------------------

ALTER TABLE team_messages
  ADD COLUMN IF NOT EXISTS media_type        TEXT,
  ADD COLUMN IF NOT EXISTS media_url         TEXT,
  ADD COLUMN IF NOT EXISTS media_thumb_url   TEXT,
  ADD COLUMN IF NOT EXISTS media_width       INTEGER,
  ADD COLUMN IF NOT EXISTS media_height      INTEGER,
  ADD COLUMN IF NOT EXISTS media_alt         TEXT,
  ADD COLUMN IF NOT EXISTS media_provider    TEXT,
  -- Storage object path (e.g. "<salesperson_id>/<uuid>.jpg") for
  -- image uploads. Not used by GIF posts. Tracked separately from
  -- media_url so a future cleanup job can delete the object without
  -- parsing the public URL.
  ADD COLUMN IF NOT EXISTS media_storage_path TEXT;

-- media_type whitelist. Two values today; matches MediaType in
-- src/lib/team-messages.ts.
ALTER TABLE team_messages
  DROP CONSTRAINT IF EXISTS team_messages_media_type_allowed;
ALTER TABLE team_messages
  ADD CONSTRAINT team_messages_media_type_allowed
  CHECK (media_type IS NULL OR media_type IN ('image', 'gif'));

-- media_type and media_url must be paired: either both null (text-only
-- post) or both set (post with media). Prevents inconsistent rows from a
-- buggy writer.
ALTER TABLE team_messages
  DROP CONSTRAINT IF EXISTS team_messages_media_url_paired;
ALTER TABLE team_messages
  ADD CONSTRAINT team_messages_media_url_paired
  CHECK (
    (media_type IS NULL AND media_url IS NULL)
    OR (media_type IS NOT NULL AND media_url IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- 2) Storage bucket — juice-box-media
-- ---------------------------------------------------------------------------
-- Public read, 10 MB limit, image MIME types only. Idempotent: INSERT ON
-- CONFLICT keeps the row in sync with this file on rerun.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'juice-box-media',
  'juice-box-media',
  true,
  10485760, -- 10 MB
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']::text[]
)
ON CONFLICT (id) DO UPDATE SET
  public             = EXCLUDED.public,
  file_size_limit    = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Storage policies. Anon SELECT only — the bucket is public-read, but we
-- explicitly enumerate the policy so the schema is self-documenting.
-- INSERT/UPDATE/DELETE are deliberately NOT granted to anon; the
-- service-role bypasses RLS for the signed-upload route.

DROP POLICY IF EXISTS "juice_box_media anon select" ON storage.objects;
CREATE POLICY "juice_box_media anon select"
  ON storage.objects FOR SELECT TO anon
  USING (bucket_id = 'juice-box-media');

-- ===========================================================================
-- VERIFICATION
-- ===========================================================================
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'team_messages'
--   AND column_name LIKE 'media_%';
--   -- expect 8 rows (the new columns above).
--
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
-- WHERE conrelid = 'team_messages'::regclass
--   AND conname LIKE 'team_messages_media_%';
--   -- expect: team_messages_media_type_allowed,
--   --        team_messages_media_url_paired
--
-- SELECT id, public, file_size_limit, allowed_mime_types
-- FROM storage.buckets WHERE id = 'juice-box-media';
--   -- expect public=true, file_size_limit=10485760,
--   --        allowed_mime_types={image/jpeg,image/png,image/webp,image/gif}
--
-- SELECT policyname, cmd, roles FROM pg_policies
-- WHERE schemaname='storage' AND tablename='objects'
--   AND policyname = 'juice_box_media anon select';
--   -- expect one row: SELECT / {anon}
