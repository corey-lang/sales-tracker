/**
 * URL detection — used by the Juice Box link-preview MVP. Pure, no I/O,
 * importable from both client and server.
 *
 * We detect only http(s) URLs. Bare-domain detection (e.g. "example.com")
 * is intentionally out of scope: too easy to false-positive on words with
 * dots ("...end of sentence.Then…") and too many edge cases for the small
 * value-add. If the user wants a preview, they paste a URL with a scheme.
 *
 * EXAMPLES (also serve as a hand-walkable spec — there is no test runner
 * configured in this repo, so these are the behavior contract):
 *
 *   "see https://example.com."
 *     -> "https://example.com"             (trailing period stripped)
 *
 *   "see https://example.com!"
 *     -> "https://example.com"             (trailing ! stripped)
 *
 *   "see (https://example.com)"
 *     -> "https://example.com"             (wrapper `)` from prose stripped
 *                                          because it has no matching `(`
 *                                          inside the URL)
 *
 *   "https://en.wikipedia.org/wiki/V_(disambiguation)"
 *     -> "https://en.wikipedia.org/wiki/V_(disambiguation)"
 *                                          (balanced `(`/`)` preserved)
 *
 *   "see (https://en.wikipedia.org/wiki/V_(disambiguation))"
 *     -> "https://en.wikipedia.org/wiki/V_(disambiguation)"
 *                                          (one unbalanced trailing `)`
 *                                          from prose stripped; inner pair
 *                                          stays balanced)
 *
 *   "check https://example.com, then https://other.com"
 *     -> "https://example.com"             (first URL; trailing `,` stripped)
 */

/**
 * Greedy run of non-whitespace, non-quote, non-`<>` characters after the
 * scheme. We intentionally allow `(` and `)` inside the match and let
 * the balance pass below decide whether a trailing `)` is part of the
 * URL (Wikipedia-style) or sentence punctuation ("(https://x.com)").
 */
const URL_REGEX = /\bhttps?:\/\/[^\s<>"'`]+/i;

/**
 * Characters that follow URLs in prose and are never part of the URL.
 * `)` is deliberately omitted — balance logic below handles it so
 * legitimately-trailing parens in URL paths are preserved.
 */
const TRAILING_SENTENCE_PUNCT = /[\s.,;:!?'"`\]>]$/;

/**
 * Returns the first http(s) URL in `text`, with surrounding punctuation
 * trimmed, or null if none is found. Returns null for empty / non-string
 * input so callers can pass `message.message` directly.
 */
export function extractFirstUrl(text: unknown): string | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const match = text.match(URL_REGEX);
  if (!match) return null;

  let url = match[0];

  // Step 1: peel sentence punctuation (everything except `)`) off the
  // right edge, one char at a time, until none remains.
  while (url.length > 0 && TRAILING_SENTENCE_PUNCT.test(url)) {
    url = url.slice(0, -1);
  }

  // Step 2: peel UNBALANCED trailing `)`. A trailing `)` is treated as
  // wrapper punctuation only when the URL has more `)` than `(`. This
  // preserves URLs like
  //   https://en.wikipedia.org/wiki/V_(disambiguation)
  // while still cleaning up
  //   (https://example.com)  ->  https://example.com
  while (url.endsWith(")")) {
    let opens = 0;
    let closes = 0;
    for (let i = 0; i < url.length; i++) {
      const ch = url.charCodeAt(i);
      if (ch === 0x28 /* ( */) opens++;
      else if (ch === 0x29 /* ) */) closes++;
    }
    if (closes <= opens) break;
    url = url.slice(0, -1);
    // After peeling a `)`, sentence punctuation may now be exposed
    // (e.g. "...example.com)."). Re-run the cheap right-edge sweep.
    while (url.length > 0 && TRAILING_SENTENCE_PUNCT.test(url)) {
      url = url.slice(0, -1);
    }
  }

  return url.length > 0 ? url : null;
}
