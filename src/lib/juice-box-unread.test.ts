/**
 * Unit tests for the Juice Box unread/divider rules.
 *
 * The behaviour that matters most here is the one that was recently fixed and
 * must survive the move to three channels: a NULL read receipt lands the reader
 * at the LATEST message and shows no NEW MESSAGES divider above old content.
 * With channels, every existing teammate has a null receipt for the two NEW
 * channels — so this is no longer an edge case, it is the common case.
 */

import { describe, expect, it } from "vitest";

import {
  combinedUnreadCount,
  dividerIndexFor,
  emptyChannelUnread,
  initialLandingTarget,
  isNewerThan,
  laterTimestamp,
} from "@/lib/juice-box-unread";

/** oldest → newest, the order the feed holds messages in. */
const MESSAGES = [
  { id: "m1", created_at: "2026-08-01T10:00:00.000Z" },
  { id: "m2", created_at: "2026-08-05T10:00:00.000Z" },
  { id: "m3", created_at: "2026-08-20T10:00:00.000Z" },
  { id: "m4", created_at: "2026-08-25T10:00:00.000Z" },
];

describe("isNewerThan", () => {
  it("compares instants numerically across timestamp formats", () => {
    // Same instant, different serializations (server marker vs Postgres).
    expect(isNewerThan("2026-08-05T10:00:00+00:00", "2026-08-05T10:00:00.000Z")).toBe(
      false,
    );
    expect(isNewerThan("2026-08-05T10:00:00.001Z", "2026-08-05T10:00:00+00:00")).toBe(
      true,
    );
  });

  it("fails safe on unparseable input", () => {
    expect(isNewerThan("nonsense", "2026-08-05T10:00:00.000Z")).toBe(false);
    expect(isNewerThan("2026-08-05T10:00:00.000Z", "nonsense")).toBe(false);
  });
});

describe("dividerIndexFor", () => {
  it("puts the divider at the first message after the marker", () => {
    expect(dividerIndexFor(MESSAGES, "2026-08-05T10:00:00.000Z")).toBe(2);
  });

  it("returns -1 when a null receipt would put it above the whole feed", () => {
    // THE REGRESSION GUARD: null must not mean "everything is new".
    expect(dividerIndexFor(MESSAGES, null)).toBe(-1);
  });

  it("returns -1 before the marker has synced", () => {
    expect(dividerIndexFor(MESSAGES, undefined)).toBe(-1);
  });

  it("returns -1 when everything is already read", () => {
    expect(dividerIndexFor(MESSAGES, "2026-08-26T10:00:00.000Z")).toBe(-1);
  });

  it("returns -1 for an empty channel", () => {
    expect(dividerIndexFor([], "2026-08-05T10:00:00.000Z")).toBe(-1);
  });
});

describe("initialLandingTarget", () => {
  it("lands at the LATEST when the channel has no read receipt", () => {
    // Every existing teammate is in exactly this state for Product Help and
    // Social Media Hub on day one.
    expect(
      initialLandingTarget({
        messages: MESSAGES,
        lastReadAt: null,
        unreadLoaded: true,
      }),
    ).toEqual({ kind: "latest", messageId: "m4" });
  });

  it("lands at the first unread when there is a real boundary", () => {
    expect(
      initialLandingTarget({
        messages: MESSAGES,
        lastReadAt: "2026-08-05T10:00:00.000Z",
        unreadLoaded: true,
      }),
    ).toEqual({ kind: "first-unread", messageId: "m3" });
  });

  it("lands at the latest when everything is read", () => {
    expect(
      initialLandingTarget({
        messages: MESSAGES,
        lastReadAt: "2026-08-26T10:00:00.000Z",
        unreadLoaded: true,
      }),
    ).toEqual({ kind: "latest", messageId: "m4" });
  });

  it("lands at the latest when the only unread IS the latest", () => {
    // The two targets collapse; landing at latest also triggers mark-read.
    expect(
      initialLandingTarget({
        messages: MESSAGES,
        lastReadAt: "2026-08-21T10:00:00.000Z",
        unreadLoaded: true,
      }),
    ).toEqual({ kind: "latest", messageId: "m4" });
  });

  it("waits (null) until the unread bootstrap has resolved", () => {
    expect(
      initialLandingTarget({
        messages: MESSAGES,
        lastReadAt: null,
        unreadLoaded: false,
      }),
    ).toBeNull();
  });

  it("waits (null) on an empty channel", () => {
    expect(
      initialLandingTarget({ messages: [], lastReadAt: null, unreadLoaded: true }),
    ).toBeNull();
  });

  it("treats each channel independently", () => {
    // Same feed contents, different markers → different landings. This is the
    // whole point of per-channel read state.
    const general = initialLandingTarget({
      messages: MESSAGES,
      lastReadAt: "2026-08-05T10:00:00.000Z",
      unreadLoaded: true,
    });
    const productHelp = initialLandingTarget({
      messages: MESSAGES,
      lastReadAt: null,
      unreadLoaded: true,
    });
    expect(general).toEqual({ kind: "first-unread", messageId: "m3" });
    expect(productHelp).toEqual({ kind: "latest", messageId: "m4" });
  });
});

describe("combinedUnreadCount", () => {
  it("sums every channel for the nav badge", () => {
    expect(
      combinedUnreadCount({
        general: { count: 3, last_read_at: null },
        product_help: { count: 4, last_read_at: null },
        social_media_hub: { count: 1, last_read_at: null },
      }),
    ).toBe(8);
  });

  it("is 0 for a fresh/empty state", () => {
    expect(combinedUnreadCount(emptyChannelUnread())).toBe(0);
    expect(combinedUnreadCount({})).toBe(0);
  });

  it("counts only the known channels and ignores junk values", () => {
    expect(
      combinedUnreadCount({
        general: { count: 2, last_read_at: null },
        // @ts-expect-error — deliberately unknown key from a future/older build
        marketing: { count: 99, last_read_at: null },
        product_help: { count: Number.NaN, last_read_at: null },
        social_media_hub: { count: -5, last_read_at: null },
      }),
    ).toBe(2);
  });
});

describe("emptyChannelUnread", () => {
  it("always has all three channels so a lookup is never undefined", () => {
    expect(Object.keys(emptyChannelUnread()).sort()).toEqual([
      "general",
      "product_help",
      "social_media_hub",
    ]);
  });

  it("returns a fresh object each call (no shared mutation)", () => {
    const a = emptyChannelUnread();
    a.general.count = 5;
    expect(emptyChannelUnread().general.count).toBe(0);
  });
});

describe("laterTimestamp (General's effective marker during the rollout)", () => {
  const EARLIER = "2026-08-24T09:00:00.000Z";
  const LATER = "2026-08-24T18:00:00.000Z";

  it("picks the new marker when it is later", () => {
    expect(laterTimestamp(LATER, EARLIER)).toBe(LATER);
  });

  it("picks the legacy marker when it is later", () => {
    // The rollout bug: the old bundle advanced the legacy marker after the
    // migration copied it, so the legacy value is ahead.
    expect(laterTimestamp(EARLIER, LATER)).toBe(LATER);
  });

  it("returns the only marker that exists", () => {
    expect(laterTimestamp(LATER, null)).toBe(LATER);
    expect(laterTimestamp(null, LATER)).toBe(LATER);
    expect(laterTimestamp(LATER, undefined)).toBe(LATER);
    expect(laterTimestamp(undefined, LATER)).toBe(LATER);
  });

  it("returns null when neither exists (preserves land-at-latest)", () => {
    expect(laterTimestamp(null, null)).toBeNull();
    expect(laterTimestamp(undefined, undefined)).toBeNull();
    expect(laterTimestamp(null, undefined)).toBeNull();
  });

  it("keeps the first argument on equal instants, including mixed formats", () => {
    expect(laterTimestamp(LATER, LATER)).toBe(LATER);
    // Same instant, different serialization — must not flip to the legacy copy.
    expect(
      laterTimestamp("2026-08-24T18:00:00.000Z", "2026-08-24T18:00:00+00:00"),
    ).toBe("2026-08-24T18:00:00.000Z");
  });

  it("ignores a malformed value in favour of the parseable one", () => {
    expect(laterTimestamp("not-a-date", LATER)).toBe(LATER);
    expect(laterTimestamp(LATER, "not-a-date")).toBe(LATER);
    expect(laterTimestamp("", LATER)).toBe(LATER);
  });

  it("returns null when both values are malformed (fails safe)", () => {
    // Degrades to "no receipt" — land at latest, no divider — never to a bogus
    // unread block. Same direction as isNewerThan's fail-safe.
    expect(laterTimestamp("garbage", "also-garbage")).toBeNull();
    expect(dividerIndexFor(MESSAGES, laterTimestamp("x", "y"))).toBe(-1);
    expect(
      initialLandingTarget({
        messages: MESSAGES,
        lastReadAt: laterTimestamp("x", "y"),
        unreadLoaded: true,
      }),
    ).toEqual({ kind: "latest", messageId: "m4" });
  });

  it("feeds the divider rules the later marker", () => {
    // m3 (Aug 20) and m4 (Aug 25) exist. New marker says Aug 1, legacy says
    // Aug 20 → only m4 is unread, so the divider sits at index 3, not 2.
    const effective = laterTimestamp(
      "2026-08-01T10:00:00.000Z",
      "2026-08-20T10:00:00.000Z",
    );
    expect(dividerIndexFor(MESSAGES, effective)).toBe(3);
  });
});
