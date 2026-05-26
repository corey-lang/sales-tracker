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

/** Single-match regex used by extractFirstUrl. */
const URL_REGEX = /\bhttps?:\/\/[^\s<>"'`]+/i;

/**
 * Source + flags for the global scanner. We construct a fresh RegExp per
 * call site to avoid sharing `lastIndex` between concurrent callers.
 */
const URL_REGEX_GLOBAL_SOURCE = "\\bhttps?:\\/\\/[^\\s<>\"'`]+";
const URL_REGEX_GLOBAL_FLAGS = "gi";

/**
 * Characters that follow URLs in prose and are never part of the URL.
 * `)` is deliberately omitted — balance logic below handles it so
 * legitimately-trailing parens in URL paths are preserved.
 */
const TRAILING_SENTENCE_PUNCT = /[\s.,;:!?'"`\]>]$/;

/**
 * Trims surrounding punctuation off a candidate URL match. Two passes:
 *   1. Peel sentence punctuation (everything except `)`).
 *   2. Peel UNBALANCED trailing `)` — a `)` that has no matching `(`
 *      inside the URL. Each peel re-runs step 1 so "x.com)." → "x.com".
 *
 * Pure, no I/O. Exported as `extractFirstUrl` / `findAllUrls` below.
 */
function trimUrlPunct(raw: string): string {
  let url = raw;
  while (url.length > 0 && TRAILING_SENTENCE_PUNCT.test(url)) {
    url = url.slice(0, -1);
  }
  while (url.endsWith(")")) {
    let opens = 0;
    let closes = 0;
    for (let i = 0; i < url.length; i++) {
      const c = url.charCodeAt(i);
      if (c === 0x28 /* ( */) opens++;
      else if (c === 0x29 /* ) */) closes++;
    }
    if (closes <= opens) break;
    url = url.slice(0, -1);
    while (url.length > 0 && TRAILING_SENTENCE_PUNCT.test(url)) {
      url = url.slice(0, -1);
    }
  }
  return url;
}

/**
 * Returns the first http(s) URL in `text`, with surrounding punctuation
 * trimmed, or null if none is found. Returns null for empty / non-string
 * input so callers can pass `message.message` directly.
 */
export function extractFirstUrl(text: unknown): string | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const match = text.match(URL_REGEX);
  if (!match) return null;
  const trimmed = trimUrlPunct(match[0]);
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * A single URL match: the trimmed URL plus the character offsets in the
 * original text. `start` is the index of the first URL char; `end` is
 * one past the last char of the trimmed URL (so any trailing prose
 * punctuation that was stripped lives at indexes `[end, originalEnd]`).
 */
export type UrlMatch = { url: string; start: number; end: number };

/**
 * Returns every http(s) URL in `text` in order, with surrounding
 * punctuation trimmed off each href. The caller can splice the original
 * text around these offsets — for example, the AutoLinkText component
 * uses `(start, end]` to wrap the URL substring in an <a> while the
 * non-URL spans stay as plain text (so any trailing punctuation stripped
 * from the href is preserved verbatim in the visible message body).
 */
export function findAllUrls(text: unknown): UrlMatch[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const out: UrlMatch[] = [];
  // Fresh RegExp per call so we don't share lastIndex across callers.
  const re = new RegExp(URL_REGEX_GLOBAL_SOURCE, URL_REGEX_GLOBAL_FLAGS);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const trimmed = trimUrlPunct(m[0]);
    if (trimmed.length > 0) {
      out.push({
        url: trimmed,
        start: m.index,
        end: m.index + trimmed.length,
      });
    }
    // Defensive: prevent an infinite loop on a zero-length match.
    // Our regex requires "http(s)://" so this shouldn't fire, but
    // future edits to the pattern shouldn't be able to wedge the loop.
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return out;
}
