import { randomUUID } from "crypto";

import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import { badRequest, handleApiError, parseBody } from "@/lib/server/auth";
import { requireJuiceBoxAccess } from "@/lib/server/juice-box";
import {
  JUICE_BOX_MEDIA_BUCKET,
  MEDIA_ALLOWED_IMAGE_MIME_TYPES,
  MEDIA_MAX_FILE_SIZE_BYTES,
} from "@/lib/team-messages";

// Juice Box — mint a signed upload URL for an image attachment.
//
//   POST /api/juice-box/media/sign-upload
//   body: { content_type, size }
//   ->   { upload_url, token, path, public_url, max_size, content_type }
//
// FLOW
//   1. Client validates file locally, then POSTs here with the file's
//      content_type and byte size.
//   2. Server (this route) gates on requireJuiceBoxAccess, validates
//      content_type / size against the bucket's published policy, and
//      mints a one-time signed upload URL scoped to a single object path
//      under <salesperson_id>/<uuid>.<ext>.
//   3. Client uploads the file with
//        supabase.storage.from(BUCKET).uploadToSignedUrl(path, token, file)
//      (or via PUT to the upload_url — both paths are equivalent).
//   4. Client POSTs /api/team-messages with media_url=public_url, plus the
//      remaining media_* fields (dimensions read client-side, alt text,
//      etc.). That route re-validates the URL belongs to our bucket.
//
// SECURITY
//   * Auth: admin OR test only (requireJuiceBoxAccess). Regular AEs get
//     403. Identity comes from the signed session — the route never
//     accepts a salesperson_id in the body.
//   * Content type whitelist enforced in two places: this route AND the
//     bucket's allowed_mime_types. Either rejection blocks an upload.
//   * Size cap enforced in this route AND the bucket's file_size_limit.
//   * Path scoped per-user (`<salesperson_id>/...`) so the signed URL
//     cannot be used to overwrite someone else's object.
//   * Object id is a random UUID — clients can't predict or collide.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SignSchema = z.object({
  content_type: z.string().min(1).max(128),
  size: z.number().int().positive(),
});

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export async function POST(req: Request) {
  try {
    const me = await requireJuiceBoxAccess(req);
    const body = await parseBody(req, SignSchema);

    if (!(MEDIA_ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(body.content_type)) {
      throw badRequest(
        `Unsupported file type. Allowed: ${MEDIA_ALLOWED_IMAGE_MIME_TYPES.join(", ")}.`,
      );
    }
    if (body.size > MEDIA_MAX_FILE_SIZE_BYTES) {
      const mb = Math.round(MEDIA_MAX_FILE_SIZE_BYTES / (1024 * 1024));
      throw badRequest(`File too large. Max ${mb} MB.`);
    }

    const ext = EXT_BY_MIME[body.content_type];
    const path = `${me.id}/${randomUUID()}.${ext}`;

    const supabase = getServerSupabase();
    const signed = await supabase
      .storage
      .from(JUICE_BOX_MEDIA_BUCKET)
      .createSignedUploadUrl(path);

    if (signed.error || !signed.data) {
      throw new Error(
        signed.error?.message ?? "Failed to create upload URL.",
      );
    }

    const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!baseUrl) {
      // Should never happen — server.ts already guards getServerSupabase,
      // so reaching here means an env-var drift.
      throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL.");
    }
    const publicUrl =
      `${baseUrl.replace(/\/$/, "")}/storage/v1/object/public/` +
      `${JUICE_BOX_MEDIA_BUCKET}/${path}`;

    return Response.json({
      upload_url: signed.data.signedUrl,
      token: signed.data.token,
      path,
      public_url: publicUrl,
      // Echoed back so the client can pin its outbound POST headers to
      // the same content-type the server validated.
      content_type: body.content_type,
      max_size: MEDIA_MAX_FILE_SIZE_BYTES,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
