import { describe, expect, it } from "vitest";
import { goldListEmailHref, goldListPhoneHref } from "./gold-list-contact";

describe("Gold List contact links", () => {
  it.each([
    ["303-555-0147", "tel:303-555-0147"],
    [" +1 (303) 555-0147 ext. 2214 ", "tel:+1(303)555-0147;ext=2214"],
    ["+44 20 7946 0958", "tel:+442079460958"],
    ["3035550147 x12", "tel:3035550147;ext=12"],
    ["3035550147 extension 12", "tel:3035550147;ext=12"],
  ])("formats %s without changing the destination", (value, href) => {
    expect(goldListPhoneHref(value)).toBe(href);
  });

  it.each([
    ["dana@example.com", "mailto:dana@example.com"],
    ["dana+sales@example.com", "mailto:dana%2Bsales@example.com"],
    ["sales#team@example.com", "mailto:sales%23team@example.com"],
    ["sales?team@example.com", "mailto:sales%3Fteam@example.com"],
  ])("preserves the email recipient %s", (value, href) => {
    expect(goldListEmailHref(value)).toBe(href);
  });
});
