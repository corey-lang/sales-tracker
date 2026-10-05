/**
 * The client's evidence rules for "reached this post": held on screen for the dwell,
 * tab in the foreground, reported in batches, at most once, retried only if the
 * server didn't record it. (The server side is in api/team-messages/seen.test.ts.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const { createSeenReporter } = await import("@/components/juice-box/seen-report");

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const make = (over: { ok?: boolean; foreground?: () => boolean } = {}) => {
  const sent: string[][] = [];
  const reporter = createSeenReporter({
    send: async (ids) => {
      sent.push(ids);
      return over.ok ?? true;
    },
    isForeground: over.foreground,
    dwellMs: 500,
    flushMs: 1000,
  });
  return { sent, reporter };
};

describe("the dwell", () => {
  it("a post that stays on screen is reported after the dwell + one flush — not before", async () => {
    const { sent, reporter } = make();
    reporter.visible("a");
    await vi.advanceTimersByTimeAsync(499);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(2); // dwell done, batch scheduled
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toEqual([["a"]]);
  });

  it("a post that scrolls past before the dwell is NEVER reported", async () => {
    const { sent, reporter } = make();
    reporter.visible("a");
    await vi.advanceTimersByTimeAsync(300);
    reporter.hidden("a");
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual([]);
  });

  it("a tab that is backgrounded for the whole dwell reports nothing", async () => {
    const tab = { foreground: true };
    const { sent, reporter } = make({ foreground: () => tab.foreground });
    reporter.visible("a");
    tab.foreground = false;
    reporter.background();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual([]);
  });
});

describe("hidden time never counts toward the dwell (regression: foreground check only at the end)", () => {
  // Timeline (dwell = 500ms): visible at 0 → backgrounded at 100 → foregrounded at 450.
  // The OLD code started its timer at 0 and, firing at 500, saw a foregrounded tab and
  // reported — crediting 100ms of real foreground time plus 350ms of hidden time.
  function backgroundThenReturn() {
    const tab = { foreground: true };
    const made = make({ foreground: () => tab.foreground });
    return {
      ...made,
      async run(afterReturn: () => Promise<void> | void) {
        made.reporter.visible("a");
        await vi.advanceTimersByTimeAsync(100);
        tab.foreground = false;
        made.reporter.background();
        await vi.advanceTimersByTimeAsync(350); // hidden: t = 450
        tab.foreground = true;
        made.reporter.foreground();
        await afterReturn();
      },
    };
  }

  it("visible → dwell starts → background → wait → foreground → still NOT seen (the post then scrolls away)", async () => {
    const t = backgroundThenReturn();
    await t.run(async () => {
      await vi.advanceTimersByTimeAsync(100); // t = 550: past the old timer's 500, 100ms into the fresh dwell
      t.reporter.hidden("a");
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.sent).toEqual([]);
  });

  it("…and nothing is reported at the moment the old timer would have fired", async () => {
    const t = backgroundThenReturn();
    await t.run(async () => {
      await vi.advanceTimersByTimeAsync(1100); // old code: queued at 500, sent by 1500 (= 450 + 1050)
    });
    expect(t.sent).toEqual([]);
  });

  it("then visible again for a FULL foreground dwell → seen", async () => {
    const t = backgroundThenReturn();
    await t.run(async () => {
      await vi.advanceTimersByTimeAsync(100);
      t.reporter.hidden("a");
    });
    expect(t.sent).toEqual([]);
    t.reporter.visible("a");
    await vi.advanceTimersByTimeAsync(499);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.sent).toEqual([["a"]]);
  });

  it("a post that simply STAYS on screen through the return earns a fresh full dwell and is then seen", async () => {
    const t = backgroundThenReturn();
    await t.run(async () => {
      await vi.advanceTimersByTimeAsync(499); // 1ms short of a fresh dwell
    });
    expect(t.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); // dwell completes…
    await vi.advanceTimersByTimeAsync(1000); // …and the batch flushes
    expect(t.sent).toEqual([["a"]]);
  });

  it("posts that become visible while the tab is in the background start no dwell until it returns", async () => {
    const tab = { foreground: false };
    const { sent, reporter } = make({ foreground: () => tab.foreground });
    reporter.visible("a");
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual([]);
    tab.foreground = true;
    reporter.foreground();
    await vi.advanceTimersByTimeAsync(499);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1 + 1000);
    expect(sent).toEqual([["a"]]);
  });

  it("repeated background/foreground flicker never accumulates: each return restarts the 500ms from zero", async () => {
    const tab = { foreground: true };
    const { sent, reporter } = make({ foreground: () => tab.foreground });
    reporter.visible("a");
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(400); // never a full dwell in one go
      tab.foreground = false;
      reporter.background();
      tab.foreground = true;
      reporter.foreground();
    }
    await vi.advanceTimersByTimeAsync(300);
    expect(sent).toEqual([]);
  });
});

describe("batching", () => {
  it("posts reached together go in ONE request; each post is reported once", async () => {
    const { sent, reporter } = make();
    for (const id of ["a", "b", "c"]) reporter.visible(id);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toEqual([["a", "b", "c"]]);
    reporter.visible("a"); // scrolled back over it
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toHaveLength(1);
  });

  it("more than 100 are split into requests of at most 100", async () => {
    const { sent, reporter } = make();
    for (let i = 0; i < 230; i++) reporter.visible(`p${i}`);
    await vi.advanceTimersByTimeAsync(3000);
    expect(sent.map((b) => b.length)).toEqual([100, 100, 30]);
  });

  it("a failed report is retried the next time the post is reached — and only then", async () => {
    const { sent, reporter } = make({ ok: false });
    reporter.visible("a");
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toEqual([["a"]]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toHaveLength(1); // no retry storm
    reporter.hidden("a");
    reporter.visible("a");
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toHaveLength(2);
  });
});
