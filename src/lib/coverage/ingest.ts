/**
 * Coverage Intelligence — brochure fetch + content hashing (Phase 2).
 *
 * Server-only. Fetches a registered brochure's source URL, computes the SHA-256
 * of the exact bytes, and reconciles that against `plan_brochures.file_hash`:
 *   - hash absent  → backfill it (the DB freeze trigger permits NULL→value once)
 *   - hash present → verify; a mismatch is REJECTED (the source changed under us)
 * This is the integrity gate: extraction only proceeds on bytes whose hash we've
 * recorded, so every extracted fact is provably tied to a specific file.
 */

import { createHash } from "crypto";

import { getServerSupabase } from "@/lib/supabase/server";
import { ApiError } from "@/lib/server/auth";
import type { Brochure } from "./types";
import { assertSafeBrochureUrl } from "./url-safety";

/** Hard cap so a giant/hostile URL can't exhaust memory. */
const MAX_BYTES = 30 * 1024 * 1024; // 30 MB
const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;

/** Content types we accept for a brochure. Anything else (text/html error
 *  pages, JSON, etc.) is rejected before we parse. A missing content type is
 *  tolerated — the PDF magic-byte check in the route is the real gate. */
const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "application/octet-stream",
  "binary/octet-stream",
]);

export type FetchedBrochure = {
  bytes: Uint8Array;
  sha256: string;
  contentType: string;
};

/**
 * Fetches the source URL and returns its bytes + SHA-256 + content type.
 *
 * SSRF-hardened: the initial URL and EVERY redirect hop are validated (https +
 * host allowlist + DNS/IP safety) via assertSafeBrochureUrl, redirects are
 * followed MANUALLY up to MAX_REDIRECTS (never `redirect: "follow"`), and the
 * content type is checked before the body is read. Full URLs (which may carry
 * query-string tokens) are never logged — only the hostname.
 */
export async function fetchBrochureBytes(
  sourceUrl: string,
): Promise<FetchedBrochure> {
  let currentUrl = await assertSafeBrochureUrl(sourceUrl);
  let res: Response | null = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let r: Response;
    try {
      r = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: "manual", // we validate each hop ourselves
        headers: { Accept: "application/pdf,application/octet-stream" },
      });
    } catch (err) {
      console.warn(
        `[coverage] brochure fetch failed host=${currentUrl.hostname} err=${String(err)}`,
      );
      throw new ApiError(
        502,
        "Could not fetch the brochure from its source URL.",
      );
    } finally {
      clearTimeout(timer);
    }

    if (r.status >= 300 && r.status < 400) {
      if (hop === MAX_REDIRECTS) {
        throw new ApiError(502, "The brochure source redirected too many times.");
      }
      const location = r.headers.get("location");
      if (!location) {
        throw new ApiError(502, "The brochure source returned an invalid redirect.");
      }
      let nextUrl: string;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch {
        throw new ApiError(502, "The brochure source returned an invalid redirect.");
      }
      // Re-validate the redirect target (https + allowlist + DNS/IP).
      currentUrl = await assertSafeBrochureUrl(nextUrl);
      continue;
    }

    res = r;
    break;
  }

  if (!res) {
    throw new ApiError(502, "The brochure source redirected too many times.");
  }
  if (!res.ok) {
    console.warn(
      `[coverage] brochure fetch non-2xx host=${currentUrl.hostname} status=${res.status}`,
    );
    throw new ApiError(502, "The brochure source URL returned an error.");
  }

  const contentType = (res.headers.get("content-type") ?? "")
    .toLowerCase()
    .split(";")[0]
    .trim();
  if (contentType && !ALLOWED_CONTENT_TYPES.has(contentType)) {
    console.warn(
      `[coverage] brochure unexpected content-type host=${currentUrl.hostname} type=${contentType}`,
    );
    throw new ApiError(415, "The brochure source did not return a PDF.");
  }

  const buf = await res.arrayBuffer();
  if (buf.byteLength === 0) {
    throw new ApiError(502, "The brochure source returned an empty file.");
  }
  if (buf.byteLength > MAX_BYTES) {
    throw new ApiError(413, "The brochure file is too large to process.");
  }

  const bytes = new Uint8Array(buf);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256, contentType };
}

export type HashAction = "backfilled" | "verified";

/**
 * Reconciles the computed hash against the stored one.
 *   - stored differs  → ApiError(409) (mismatch; do not extract)
 *   - stored equals   → "verified"
 *   - stored is null  → backfill it, return "backfilled"
 */
export async function reconcileFileHash(
  brochure: Brochure,
  computedHash: string,
): Promise<HashAction> {
  if (brochure.fileHash && brochure.fileHash !== computedHash) {
    throw new ApiError(
      409,
      "The fetched file does not match this brochure's recorded file hash. Register a new brochure version instead of changing the source.",
    );
  }
  if (brochure.fileHash === computedHash) {
    return "verified";
  }

  // Backfill (file_hash IS NULL guard keeps it a true one-time set and dodges
  // the freeze trigger, which only blocks changing an already-set hash).
  const supabase = getServerSupabase();
  const res = await supabase
    .from("plan_brochures")
    .update({ file_hash: computedHash })
    .eq("id", brochure.id)
    .is("file_hash", null);

  if (res.error) {
    console.warn(
      `[coverage] file_hash backfill failed id=${brochure.id} code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    throw new ApiError(500, "Could not record the brochure file hash.");
  }
  return "backfilled";
}
