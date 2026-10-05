import { describe, expect, it } from "vitest";

import {
  isReached,
  SEEN_THRESHOLDS,
  seenLabel,
  seenResultFor,
  type AudienceMember,
  type ReceiptIndex,
  type ViewportEntry,
} from "@/lib/juice-box-seen";

// NOTE: this file used to pin `markerCoversPost` — "seen = the channel read marker is at/after
// the post". That rule is gone ON PURPOSE: the marker is stamped with now() on landing at the
// newest post, which also passes every older, never-loaded post (and any post created mid-load),
// so it can't prove a person reached a specific post. "Seen" is now an explicit receipt; the
// equivalent guarantees are asserted below and in api/team-messages/seen.test.ts.

describe("seenResultFor — seen means a receipt (or authorship), never a timestamp comparison", () => {
  const person = (id: string, name: string, joined: string | null = "2026-01-01T00:00:00Z"): AudienceMember => ({ id, name, joined_at: joined });
  const audience = [person("a", "Zed"), person("b", "amy"), person("c", "Bo"), person("d", "Late", "2026-03-01T00:00:00Z")];
  const post = { id: "p", created_at: "2026-02-01T12:00:00Z", salesperson_id: "c" };
  const receipts: ReceiptIndex = new Map([["p", new Set(["a"])], ["other", new Set(["b"])]]);

  it("splits, sorts case-insensitively, counts the author as seen, skips people who joined later", () => {
    const r = seenResultFor(post, audience, receipts);
    expect(r.seen.map((p) => p.name)).toEqual(["Bo", "Zed"]);
    expect(r.not_seen.map((p) => p.name)).toEqual(["amy"]); // a receipt on ANOTHER post doesn't count; "Late" isn't in the audience
  });

  it("no receipts at all → only the author has seen it", () => {
    const r = seenResultFor(post, audience, new Map());
    expect(r.seen.map((p) => p.name)).toEqual(["Bo"]);
    expect(r.not_seen).toHaveLength(2);
  });

  it("an author who is not in the audience (inactive/test) contributes nothing", () => {
    const r = seenResultFor({ ...post, salesperson_id: "ghost" }, audience, receipts);
    expect(r.seen.length + r.not_seen.length).toBe(3);
  });

  it("a receipt from someone outside the audience is ignored", () => {
    const r = seenResultFor(post, audience, new Map([["p", new Set(["a", "stranger", "d"])]]));
    expect(r.seen.map((p) => p.name)).toEqual(["Bo", "Zed"]);
  });

  it("the label", () => {
    expect(seenLabel({ seen: 8, total: 11 })).toBe("Seen by 8 of 11");
  });
});

describe("isReached — what counts as on screen", () => {
  const entry = (over: Partial<ViewportEntry>): ViewportEntry => ({
    isIntersecting: true, intersectionRatio: 1, intersectionRect: { height: 100 }, rootBounds: { height: 800 }, ...over,
  });

  it("at least half the post visible", () => {
    expect(isReached(entry({ intersectionRatio: 0.5 }), 800)).toBe(true);
    expect(isReached(entry({ intersectionRatio: 0.49 }), 800)).toBe(false);
  });

  it("a post taller than the screen counts once its visible part fills half the viewport", () => {
    expect(isReached(entry({ intersectionRatio: 0.2, intersectionRect: { height: 400 } }), 800)).toBe(true);
    expect(isReached(entry({ intersectionRatio: 0.2, intersectionRect: { height: 399 } }), 800)).toBe(false);
  });

  it("not intersecting is never reached; a missing root falls back to the window height", () => {
    expect(isReached(entry({ isIntersecting: false, intersectionRatio: 0 }), 800)).toBe(false);
    expect(isReached(entry({ intersectionRatio: 0.2, intersectionRect: { height: 500 }, rootBounds: null }), 800)).toBe(true);
  });
});

describe("tall posts can actually qualify (IntersectionObserver only re-evaluates at threshold crossings)", () => {
  /**
   * Scrolls a post of height H past a viewport of height V one pixel at a time and replays
   * IntersectionObserver's rule: a callback fires when the number of thresholds at or below the
   * visible ratio changes (or visibility starts/stops). Returns whether ANY callback's entry
   * satisfies `isReached` — i.e. whether the post would ever be reported.
   */
  function everQualifies(postHeight: number, viewport: number, thresholds: readonly number[]): boolean {
    let lastIndex = -1; // "not intersecting" initially
    for (let top = viewport; top > -postHeight; top -= 1) {
      const visible = Math.max(0, Math.min(top + postHeight, viewport) - Math.max(top, 0));
      const intersecting = visible > 0;
      const ratio = visible / postHeight;
      const index = intersecting ? thresholds.filter((t) => t <= ratio).length : -1;
      if (index === lastIndex) continue;
      lastIndex = index;
      const entry: ViewportEntry = {
        isIntersecting: intersecting,
        intersectionRatio: ratio,
        intersectionRect: { height: visible },
        rootBounds: { height: viewport },
      };
      if (isReached(entry, viewport)) return true;
    }
    return false;
  }
  const V = 800;

  it("the previous thresholds MISSED a post a few screens tall — the undercount being fixed", () => {
    const old = [0, 0.25, 0.5, 0.75, 1];
    expect(everQualifies(400, V, old)).toBe(true); // short post: fine either way
    expect(everQualifies(1600, V, old)).toBe(true); // 2 screens: ratio 0.5 reachable
    expect(everQualifies(8000, V, old)).toBe(false); // 10 screens: ratio never passes 0.1
  });

  it("the current thresholds catch posts from tiny to 25 screens tall", () => {
    for (const H of [60, 400, 799, 800, 801, 1600, 2400, 8000, 16_000, 20_000]) {
      expect(everQualifies(H, V, SEEN_THRESHOLDS), `post ${H}px in an ${V}px viewport`).toBe(true);
    }
  });

  it("…and still rejects a post that is only grazed (a sliver at the edge never counts)", () => {
    // Only the first 100px of a 8,000px post ever enters the viewport (it is revealed and then scrolled back).
    const sliverEntry: ViewportEntry = { isIntersecting: true, intersectionRatio: 0.0125, intersectionRect: { height: 100 }, rootBounds: { height: V } };
    expect(isReached(sliverEntry, V)).toBe(false);
  });

  it("threshold list: 0 to 1 in 0.02 steps, sorted, no duplicates", () => {
    expect(SEEN_THRESHOLDS[0]).toBe(0);
    expect(SEEN_THRESHOLDS.at(-1)).toBe(1);
    expect(SEEN_THRESHOLDS).toHaveLength(51);
    expect([...SEEN_THRESHOLDS].sort((a, b) => a - b)).toEqual(SEEN_THRESHOLDS);
    expect(new Set(SEEN_THRESHOLDS).size).toBe(51);
  });
});
