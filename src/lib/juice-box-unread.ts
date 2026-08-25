// Pure unread/divider math for the Juice Box feed.
//
// WHY THIS MODULE EXISTS
//   These four rules decide where the NEW MESSAGES divider sits, where the
//   feed lands on open, and what the tabs + nav badge show. They used to live
//   inline in src/app/juice-box/page.tsx, where they could only be verified by
//   hand. With three channels each running its own divider and initial scroll,
//   the "null read receipt lands at the LATEST message" fix in particular
//   needs to hold per channel — so the rules moved here, unchanged, where they
//   can be tested directly.
//
// Pure module — no React, no DOM. Safe to import from server or client.

import type {
  JuiceBoxChannel,
  TeamMessageChannelUnread,
} from "@/lib/team-messages";
import { JUICE_BOX_CHANNEL_IDS } from "@/lib/team-messages";

/**
 * True when ISO timestamp `iso` is strictly NEWER than `thanIso`, compared
 * NUMERICALLY (Date.parse) rather than lexicographically. This is robust to
 * format differences between the server-issued read marker (always `…Z`, ms
 * precision) and Postgres `timestamptz` serialization (which can use a
 * `+00:00` offset and/or microseconds) — a raw string `>` could otherwise
 * mis-order equal instants across those formats.
 *
 * Fails SAFE: any unparseable value returns false. A malformed MESSAGE
 * timestamp is therefore never treated as "after the read marker" (never
 * falsely shown as unread), and a malformed MARKER treats nothing as after it
 * (→ no bogus unread block, the feed reads as caught-up).
 */
export function isNewerThan(iso: string, thanIso: string): boolean {
  const a = Date.parse(iso);
  const b = Date.parse(thanIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return a > b;
}

/**
 * The later of two read markers, or null when neither is usable.
 *
 * Used to resolve GENERAL's effective marker during the channels rollout,
 * where two markers exist for the same feed: the channel-specific row in
 * `team_message_channel_reads` and the legacy global row in
 * `team_message_reads` that the pre-channels bundle still advances. Taking the
 * later of the two means a General post the user has already read can never
 * come back as unread, whichever client marked it.
 *
 * FAILS SAFE, in the same direction as `isNewerThan`: an unparseable value is
 * ignored in favour of the parseable one, and when neither parses the result is
 * null — which the divider/landing rules read as "no receipt", i.e. land at the
 * latest message and show no divider above old content. A malformed timestamp
 * therefore degrades to the same behaviour as a brand-new channel, never to a
 * bogus unread block.
 *
 * Equal instants (including the same instant serialized differently, e.g.
 * `…+00:00` vs `…Z`) resolve to the FIRST argument, so callers can pass the
 * canonical/preferred source first.
 */
export function laterTimestamp(
  a: string | null | undefined,
  b: string | null | undefined,
): string | null {
  const aMs = typeof a === "string" ? Date.parse(a) : Number.NaN;
  const bMs = typeof b === "string" ? Date.parse(b) : Number.NaN;
  const aOk = !Number.isNaN(aMs);
  const bOk = !Number.isNaN(bMs);
  if (aOk && bOk) return bMs > aMs ? (b as string) : (a as string);
  if (aOk) return a as string;
  if (bOk) return b as string;
  return null;
}

/** The minimum a message needs to take part in this math. */
export type UnreadCandidate = { id: string; created_at: string };

/**
 * Index of the first message newer than `anchor`, or -1 for "no divider".
 *
 * Returns -1 when the anchor is `undefined` (not yet synced) or `null` (the
 * user has NO read receipt for this channel). That null case is the reported
 * bug this guard exists for: a "NEW MESSAGES" banner above the ENTIRE feed —
 * including week-old posts — is noise, not a boundary. The divider only earns
 * its place BETWEEN read and unread, which requires a real anchor.
 */
export function dividerIndexFor(
  messages: readonly UnreadCandidate[],
  anchor: string | null | undefined,
): number {
  if (messages.length === 0) return -1;
  if (anchor === undefined || anchor === null) return -1;
  return messages.findIndex((m) => isNewerThan(m.created_at, anchor));
}

/**
 * Where the feed should land on its one-shot initial scroll.
 *
 *   { kind: "first-unread" } — the user is returning to a channel with new
 *     posts since their marker; land at the start of that unread block.
 *   { kind: "latest" }       — land at the newest message, like opening any
 *     chat app.
 *   null                     — not enough information yet; the caller waits
 *     for the next data tick rather than scrolling anywhere.
 *
 * "latest" is deliberately chosen — not "first unread" — when:
 *   * the user has NO read receipt for this channel (`lastReadAt === null`).
 *     Every existing teammate is in exactly this position for the two NEW
 *     channels, and every brand-new user is for all three. Treating null as
 *     "everything is unread" would throw them to the top of week-old history.
 *   * everything is already read, or
 *   * the first unread IS the newest message — the two targets collapse, and
 *     landing at latest is what also triggers mark-read.
 */
export function initialLandingTarget(input: {
  messages: readonly UnreadCandidate[];
  /** This channel's marker. null = no read receipt for this channel. */
  lastReadAt: string | null;
  /** True once the unread bootstrap has resolved at least once. */
  unreadLoaded: boolean;
}): { kind: "first-unread" | "latest"; messageId: string } | null {
  const { messages, lastReadAt, unreadLoaded } = input;
  if (messages.length === 0) return null;
  if (!unreadLoaded) return null;

  const latest = { kind: "latest" as const, messageId: messages[messages.length - 1].id };
  if (lastReadAt === null) return latest;

  const idx = messages.findIndex((m) => isNewerThan(m.created_at, lastReadAt));
  // No unread at all, or the only unread IS the latest message.
  if (idx < 0 || idx >= messages.length - 1) return latest;
  return { kind: "first-unread", messageId: messages[idx].id };
}

/** Zeroed per-channel unread map — the shape both the provider and the
 *  /unread route build on, so a missing channel is never `undefined`. */
export function emptyChannelUnread(): Record<
  JuiceBoxChannel,
  TeamMessageChannelUnread
> {
  return {
    general: { count: 0, last_read_at: null },
    product_help: { count: 0, last_read_at: null },
    social_media_hub: { count: 0, last_read_at: null },
  };
}

/**
 * Combined unread across every channel — what the bottom-nav Juice Box badge
 * shows. Sums the known channels only (iterating JUICE_BOX_CHANNEL_IDS rather
 * than Object.values) so a stray key in a payload from a future/older build
 * can't inflate the badge. Negative or non-finite counts are floored at 0.
 */
export function combinedUnreadCount(
  channels: Partial<Record<JuiceBoxChannel, TeamMessageChannelUnread>>,
): number {
  let total = 0;
  for (const id of JUICE_BOX_CHANNEL_IDS) {
    const raw = channels[id]?.count ?? 0;
    if (!Number.isFinite(raw) || raw <= 0) continue;
    total += Math.floor(raw);
  }
  return total;
}
