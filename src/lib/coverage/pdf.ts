/**
 * Coverage Intelligence — PDF text extraction (Phase 2).
 *
 * Server-only. Turns fetched brochure bytes into per-PAGE plain text so every
 * extracted fact can carry an accurate `source_page`. Uses `unpdf` (a
 * serverless-friendly pdf.js build). Extracts text only — no interpretation.
 */

import { extractText, getDocumentProxy } from "unpdf";

/** True when the bytes start with the `%PDF-` magic header. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d // -
  );
}

/**
 * Extracts one string per page from a PDF. Index 0 = page 1, so the caller's
 * `source_page` is `index + 1`. A page with no embedded text layer (e.g. a
 * scanned image) yields an empty/whitespace string — surfaced, never invented.
 */
export async function extractPdfPages(bytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  // mergePages:false → text is string[] (one entry per page).
  const pages = Array.isArray(text) ? text : [text];
  return pages.map((p) => (typeof p === "string" ? p : ""));
}
