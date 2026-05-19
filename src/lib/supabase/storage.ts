import type { SupabaseClient } from "@supabase/supabase-js";

// Business card image storage helpers.
//
// The `business-card-scans` bucket is currently PUBLIC: images are referenced
// by a stable public URL (`image_url`). These helpers add the building blocks
// for moving to a PRIVATE bucket with signed URLs later, without flipping that
// switch now:
//
//   - `storagePathFromPublicUrl()` extracts the stable object path from a
//     public URL, so we can persist `storage_path` even for cards uploaded
//     before that column existed.
//   - `createSignedScanUrl()` mints a short-lived signed URL from a stored
//     path. Unused by the live flow today — it is ready for the private-bucket
//     migration (see supabase/README.md).
//
// See the storage section of supabase/README.md for the full private-bucket
// migration plan.

/** The Supabase Storage bucket holding business card scan images. */
export const BUSINESS_CARD_BUCKET = "business-card-scans";

/** Marker that separates the bucket from the object path in a public URL. */
const PUBLIC_URL_MARKER = `/${BUSINESS_CARD_BUCKET}/`;

/**
 * Extracts the Storage object path from a `business-card-scans` public URL.
 *
 * A public URL looks like
 *   https://<project>.supabase.co/storage/v1/object/public/business-card-scans/<path>
 * and the object path is everything after the bucket segment (query string,
 * if any, stripped). Returns null when the URL is not a business-card-scans
 * public URL.
 */
export function storagePathFromPublicUrl(url: string): string | null {
  if (typeof url !== "string") return null;
  const idx = url.indexOf(PUBLIC_URL_MARKER);
  if (idx === -1) return null;
  const raw = url.slice(idx + PUBLIC_URL_MARKER.length).split(/[?#]/)[0];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    // Malformed percent-encoding — fall back to the raw value rather than
    // throwing; the path is metadata, not a security boundary.
    return raw;
  }
}

/**
 * Sanitizes a user-supplied filename into a safe `<base>.<ext>` form for use
 * in a Storage object path: lowercased, non-alphanumerics collapsed to dashes,
 * length-capped, with a fallback base/extension. Shared by the business card
 * scanners so every uploaded image path is predictable.
 */
export function sanitizeFilename(name: string): string {
  const dot = name.lastIndexOf(".");
  const base =
    (dot === -1 ? name : name.slice(0, dot))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "card";
  const ext =
    dot === -1
      ? "jpg"
      : name
          .slice(dot + 1)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
          .slice(0, 5) || "jpg";
  return `${base}.${ext}`;
}

/** Default lifetime for a signed business-card image URL (1 hour). */
export const SIGNED_URL_TTL_SECONDS = 60 * 60;

/**
 * Mints a short-lived signed URL for a stored business card image.
 *
 * Requires a service-role Supabase client (see `getServerSupabase`). Returns
 * null if the path is empty or Supabase declines to sign it. NOT wired into
 * the live flow yet — prepared for the private-bucket migration.
 */
export async function createSignedScanUrl(
  supabase: SupabaseClient,
  storagePath: string,
  expiresIn: number = SIGNED_URL_TTL_SECONDS,
): Promise<string | null> {
  const path = storagePath?.trim();
  if (!path) return null;
  const { data, error } = await supabase.storage
    .from(BUSINESS_CARD_BUCKET)
    .createSignedUrl(path, expiresIn);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}
