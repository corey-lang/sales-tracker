/**
 * Tests for Juice Box deep-link parsing.
 *
 * The rule that matters: a link naming a MESSAGE but no CHANNEL must report
 * `needsChannelLookup`, because defaulting to General would make a link to a
 * Product Help / Social Media Hub post fail silently (the feed would page back
 * through General's history and never find it).
 */

import { describe, expect, it } from "vitest";

import { parseJuiceBoxDeepLink } from "@/lib/juice-box-deep-link";

const MSG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("parseJuiceBoxDeepLink", () => {
  it("reads a channel-only link", () => {
    expect(parseJuiceBoxDeepLink("?channel=product_help")).toEqual({
      channel: "product_help",
      messageId: null,
      needsChannelLookup: false,
    });
  });

  it("reads channel + message without needing a lookup (push-notification shape)", () => {
    expect(
      parseJuiceBoxDeepLink(`?channel=social_media_hub&message=${MSG}`),
    ).toEqual({
      channel: "social_media_hub",
      messageId: MSG,
      needsChannelLookup: false,
    });
  });

  it("flags a BARE message link for channel lookup", () => {
    expect(parseJuiceBoxDeepLink(`?message=${MSG}`)).toEqual({
      channel: null,
      messageId: MSG,
      needsChannelLookup: true,
    });
  });

  it("treats an UNKNOWN channel as not specified", () => {
    // A mistyped tab must not silently open the wrong feed; with a message
    // present we resolve it properly instead.
    expect(parseJuiceBoxDeepLink(`?channel=marketing&message=${MSG}`)).toEqual({
      channel: null,
      messageId: MSG,
      needsChannelLookup: true,
    });
    expect(parseJuiceBoxDeepLink("?channel=General")).toEqual({
      channel: null,
      messageId: null,
      needsChannelLookup: false,
    });
  });

  it("ignores a malformed message id (no pointless round trip)", () => {
    for (const bad of ["not-a-uuid", "123", "", "  "]) {
      expect(
        parseJuiceBoxDeepLink(`?message=${encodeURIComponent(bad)}`),
      ).toEqual({
        channel: null,
        messageId: null,
        needsChannelLookup: false,
      });
    }
  });

  it("accepts a query string with or without the leading '?'", () => {
    expect(parseJuiceBoxDeepLink(`message=${MSG}`).messageId).toBe(MSG);
    expect(parseJuiceBoxDeepLink(`?message=${MSG}`).messageId).toBe(MSG);
  });

  it("returns the empty result for no query string", () => {
    expect(parseJuiceBoxDeepLink("")).toEqual({
      channel: null,
      messageId: null,
      needsChannelLookup: false,
    });
  });

  it("tolerates junk without throwing", () => {
    expect(() => parseJuiceBoxDeepLink("?%%%&&&=")).not.toThrow();
    expect(parseJuiceBoxDeepLink("?%%%&&&=").needsChannelLookup).toBe(false);
  });

  it("trims surrounding whitespace on the id", () => {
    expect(parseJuiceBoxDeepLink(`?message=  ${MSG}  `).messageId).toBe(MSG);
  });
});
