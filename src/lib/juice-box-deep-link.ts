// Juice Box deep-link parsing.
//
// Two query params are understood on /juice-box:
//   ?channel=<general|product_help|social_media_hub>  — open this tab
//   ?message=<uuid>                                   — jump to this post
//
// They combine three ways, and the difference matters:
//
//   channel only          → open that tab, normal initial landing.
//   channel + message     → open that tab and jump. No lookup needed; this is
//                           the shape our own push notifications produce, and
//                           it stays the cheap path.
//   message only ("bare") → the channel is UNKNOWN. Guessing General would
//                           make a Product Help / Social Media Hub link fail
//                           silently: the feed would page back through
//                           General's history and never find the post. The
//                           caller must resolve the channel first via
//                           GET /api/team-messages/:id/channel (authenticated),
//                           then mount that channel's feed.
//
// `channel` is deliberately reported as null when absent OR unrecognized, so a
// mistyped tab name behaves like "not specified" (→ resolve, or fall back to
// General) rather than silently opening the wrong feed.
//
// Pure module — no DOM, no React. Exported separately from the page so the
// combination rules can be unit-tested.

import {
  isJuiceBoxChannel,
  type JuiceBoxChannel,
} from "@/lib/team-messages";

/** RFC 4122 form — mirrors the server-side check in the lookup route, so an
 *  obviously-malformed id never costs a round trip. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type JuiceBoxDeepLink = {
  /** A recognized channel from the URL, else null (absent or unknown). */
  channel: JuiceBoxChannel | null;
  /** A well-formed message id from the URL, else null. */
  messageId: string | null;
  /** True when a channel lookup is required before mounting a feed: we have a
   *  message to jump to but no channel to look for it in. */
  needsChannelLookup: boolean;
};

/**
 * Parses a `location.search` string (with or without the leading "?").
 * Never throws — a malformed query string yields the empty result.
 */
export function parseJuiceBoxDeepLink(search: string): JuiceBoxDeepLink {
  let channel: JuiceBoxChannel | null = null;
  let messageId: string | null = null;

  try {
    const params = new URLSearchParams(search);
    const rawChannel = params.get("channel");
    if (isJuiceBoxChannel(rawChannel)) channel = rawChannel;

    const rawMessage = params.get("message");
    if (rawMessage && UUID_RE.test(rawMessage.trim())) {
      messageId = rawMessage.trim();
    }
  } catch {
    // Unparseable query string — fall through to the empty result.
  }

  return {
    channel,
    messageId,
    needsChannelLookup: messageId !== null && channel === null,
  };
}
