import type { ReactNode } from "react";

import { findAllUrls } from "@/lib/url-detection";

/**
 * Renders message text with http(s) URLs converted to clickable <a>
 * tags. Non-URL spans are emitted as plain strings, so a parent that
 * uses `whitespace-pre-wrap` (the Juice Box message body) still keeps
 * its newlines and indentation intact.
 *
 * Trimming logic comes from findAllUrls — trailing prose punctuation
 * (period, comma, wrapper paren, etc.) is stripped from the `href` but
 * remains as plain text in the surrounding string, so the visible body
 * reads identically to the source message.
 *
 * Anchors open in a new tab with `noopener noreferrer nofollow` —
 * matches the rel set used by LinkPreviewCard for consistency.
 */
export function AutoLinkText({ text }: { text: string }) {
  const matches = findAllUrls(text);
  if (matches.length === 0) return <>{text}</>;

  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (m.start > cursor) {
      // Plain string children are valid React nodes and don't need keys.
      nodes.push(text.slice(cursor, m.start));
    }
    nodes.push(
      <a
        key={`url-${i}`}
        href={m.url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        // break-all so a long no-space URL wraps inside the message
        // bubble instead of pushing the column wider on narrow viewports.
        className="break-all text-primary underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
      >
        {m.url}
      </a>,
    );
    cursor = m.end;
  }
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return <>{nodes}</>;
}
