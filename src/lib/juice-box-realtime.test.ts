/**
 * Tests for the realtime move-reconciliation rules.
 *
 * THE MEDIUM FINDING THIS PINS
 *   An admin "Move conversation" UPDATEs every message in a thread, and
 *   Postgres Realtime does not guarantee those events arrive in tree order. The
 *   feed used to insert each arriving row on its own, so a reply's event landing
 *   before its root's rendered a parentless card — a visible orphan.
 *
 *   Now a channel-changing UPDATE is a SIGNAL: departures are applied
 *   immediately (they are certainly gone), arrivals are never rendered from the
 *   event, and the channel is rebuilt from the authoritative API. These tests
 *   drive every event order the database could produce.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const { classifyRealtimeUpdate, collectLoadedThread, createReconcileScheduler } =
  await import("@/lib/juice-box-realtime");

const ROOT = "root-1";
const REPLY = "reply-1";
const NESTED = "nested-1";

const rootRow = (channel: string) => ({
  id: ROOT,
  channel,
  reply_to_message_id: null,
});
const replyRow = (channel: string, id = REPLY, parent = ROOT) => ({
  id,
  channel,
  reply_to_message_id: parent,
});

describe("classifyRealtimeUpdate — destination side of a move", () => {
  it("does NOT render an arriving REPLY, even if it lands first", () => {
    // The exact orphan scenario: the reply's event beats its root's, and the
    // root is not on screen yet.
    const plan = classifyRealtimeUpdate({
      row: replyRow("product_help"),
      activeChannel: "product_help",
      isLoaded: false,
    });
    expect(plan.kind).toBe("reconcile");
    expect(plan.reconcile).toBe(true);
  });

  it("does NOT render an arriving ROOT either — it reconciles", () => {
    // Rendering the root alone would be safe, but the rest of the thread still
    // has to come from somewhere, and one refetch covers both.
    const plan = classifyRealtimeUpdate({
      row: rootRow("product_help"),
      activeChannel: "product_help",
      isLoaded: false,
    });
    expect(plan.kind).toBe("reconcile");
  });

  it("reconciles for every event of the burst, in any order", () => {
    // Root first, then replies…
    const rootFirst = [
      rootRow("product_help"),
      replyRow("product_help"),
      replyRow("product_help", NESTED, REPLY),
    ].map((row) =>
      classifyRealtimeUpdate({ row, activeChannel: "product_help", isLoaded: false }),
    );
    // …and the reverse: nested reply first, root last.
    const rootLast = [
      replyRow("product_help", NESTED, REPLY),
      replyRow("product_help"),
      rootRow("product_help"),
    ].map((row) =>
      classifyRealtimeUpdate({ row, activeChannel: "product_help", isLoaded: false }),
    );
    for (const plan of [...rootFirst, ...rootLast]) {
      expect(plan.kind).toBe("reconcile");
      expect(plan.reconcile).toBe(true);
    }
    // No ordering produces a render, so no ordering can show an orphan.
    expect([...rootFirst, ...rootLast].some((p) => p.kind === "apply")).toBe(
      false,
    );
  });
});

describe("classifyRealtimeUpdate — source side of a move", () => {
  it("drops a departing ROOT with its descendants and names the destination", () => {
    const plan = classifyRealtimeUpdate({
      row: rootRow("product_help"),
      activeChannel: "general",
      isLoaded: true,
    });
    expect(plan).toEqual({
      kind: "drop-conversation",
      toChannel: "product_help",
      reconcile: true,
    });
  });

  it("drops a departing REPLY quietly (its root carries the banner)", () => {
    const plan = classifyRealtimeUpdate({
      row: replyRow("product_help"),
      activeChannel: "general",
      isLoaded: true,
    });
    expect(plan).toEqual({
      kind: "drop-message",
      toChannel: "product_help",
      reconcile: true,
    });
  });

  it("still drops a descendant whose event arrives AFTER the root's removal", () => {
    // The root is already gone, so the descendant is no longer "loaded" — the
    // plan must still remove it from the source rather than treat it as an
    // arrival to render.
    const plan = classifyRealtimeUpdate({
      row: replyRow("product_help", NESTED, REPLY),
      activeChannel: "general",
      isLoaded: false,
    });
    expect(plan.kind).toBe("drop-message");
    expect(plan.reconcile).toBe(true);
  });

  it("treats a legacy null channel as General", () => {
    // A pre-migration row read from an old client's payload.
    expect(
      classifyRealtimeUpdate({
        row: { id: ROOT, channel: null, reply_to_message_id: null },
        activeChannel: "general",
        isLoaded: true,
      }).kind,
    ).toBe("apply");
    expect(
      classifyRealtimeUpdate({
        row: { id: ROOT, channel: null, reply_to_message_id: null },
        activeChannel: "product_help",
        isLoaded: true,
      }).kind,
    ).toBe("drop-conversation");
  });
});

describe("classifyRealtimeUpdate — ordinary events are unaffected", () => {
  it("applies an edit to a row already on screen", () => {
    const plan = classifyRealtimeUpdate({
      row: rootRow("general"),
      activeChannel: "general",
      isLoaded: true,
    });
    expect(plan).toEqual({ kind: "apply", reconcile: false });
  });

  it("deletes a soft-deleted row without reconciling", () => {
    const plan = classifyRealtimeUpdate({
      row: { ...rootRow("general"), is_deleted: true },
      activeChannel: "general",
      isLoaded: true,
    });
    expect(plan).toEqual({ kind: "delete", reconcile: false });
  });

  it("deletes regardless of channel (id-based, so it is always safe)", () => {
    const plan = classifyRealtimeUpdate({
      row: { ...rootRow("product_help"), is_deleted: true },
      activeChannel: "general",
      isLoaded: false,
    });
    expect(plan.kind).toBe("delete");
  });
});

describe("createReconcileScheduler — one bounded refetch per burst", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("collapses a whole multi-row move into ONE run", () => {
    const run = vi.fn();
    const s = createReconcileScheduler({ delayMs: 400, run });
    // A 25-message thread → 25 events.
    for (let i = 0; i < 25; i += 1) s.schedule();
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("allows a later, separate burst to run again", () => {
    const run = vi.fn();
    const s = createReconcileScheduler({ delayMs: 400, run });
    s.schedule();
    vi.advanceTimersByTime(400);
    s.schedule();
    vi.advanceTimersByTime(400);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("reports pending state while a run is queued", () => {
    const s = createReconcileScheduler({ delayMs: 400, run: vi.fn() });
    expect(s.pending).toBe(false);
    s.schedule();
    expect(s.pending).toBe(true);
    vi.advanceTimersByTime(400);
    expect(s.pending).toBe(false);
  });

  it("cancel() drops a pending run — a tab switch reconciles nothing", () => {
    const run = vi.fn();
    const s = createReconcileScheduler({ delayMs: 400, run });
    s.schedule();
    s.cancel(); // unmount: the user switched channels
    vi.advanceTimersByTime(2000);
    expect(run).not.toHaveBeenCalled();
  });

  it("invalidates an in-flight response so it cannot write to the wrong feed", () => {
    const s = createReconcileScheduler({ delayMs: 400, run: vi.fn() });
    // A fetch starts…
    const captured = s.generation();
    expect(s.isCurrent(captured)).toBe(true);
    // …the user switches tabs while it is in flight…
    s.cancel();
    // …and the late response is rejected.
    expect(s.isCurrent(captured)).toBe(false);
  });

  it("rejects a response that lost a race with a newer reconciliation", () => {
    const s = createReconcileScheduler({ delayMs: 400, run: vi.fn() });
    const first = s.generation();
    s.cancel(); // a newer cycle begins
    const second = s.generation();
    expect(s.isCurrent(first)).toBe(false);
    expect(s.isCurrent(second)).toBe(true);
  });
});

describe("end-to-end: a move produces no orphan and no leftovers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  /**
   * Drives a feed model with the REAL classifier + scheduler through a burst of
   * move events in a given order. `loaded` is what the feed shows.
   */
  function simulate(opts: {
    activeChannel: "general" | "product_help";
    loaded: string[];
    events: Array<{ id: string; channel: string; parent: string | null }>;
    /** What the authoritative refetch returns for the active channel. */
    serverWindow: string[];
  }) {
    const loaded = new Set(opts.loaded);
    const movedAway = new Set<string>();
    let refetches = 0;
    const scheduler = createReconcileScheduler({
      delayMs: 400,
      run: () => {
        refetches += 1;
        // The reconcile replaces the window with server truth, minus anything
        // known to have moved away.
        loaded.clear();
        for (const id of opts.serverWindow) {
          if (!movedAway.has(id)) loaded.add(id);
        }
      },
    });

    const rendered: string[] = [];
    for (const e of opts.events) {
      const plan = classifyRealtimeUpdate({
        row: { id: e.id, channel: e.channel, reply_to_message_id: e.parent },
        activeChannel: opts.activeChannel,
        isLoaded: loaded.has(e.id),
      });
      if (plan.kind === "apply") rendered.push(e.id);
      if (plan.kind === "drop-conversation" || plan.kind === "drop-message") {
        movedAway.add(e.id);
        loaded.delete(e.id);
      }
      if (plan.reconcile) scheduler.schedule();
    }
    vi.advanceTimersByTime(400);
    return { loaded: [...loaded].sort(), refetches, rendered };
  }

  const MOVE_EVENTS_REPLY_FIRST = [
    { id: NESTED, channel: "product_help", parent: REPLY },
    { id: REPLY, channel: "product_help", parent: ROOT },
    { id: ROOT, channel: "product_help", parent: null },
  ];

  it("destination: renders nothing mid-burst, then shows the whole thread", () => {
    const out = simulate({
      activeChannel: "product_help",
      loaded: ["other"],
      events: MOVE_EVENTS_REPLY_FIRST,
      serverWindow: ["other", ROOT, REPLY, NESTED],
    });
    // Not one row was rendered from the events — so no orphan was ever visible.
    expect(out.rendered).toEqual([]);
    // ONE refetch for the whole burst.
    expect(out.refetches).toBe(1);
    // And afterwards the full thread is present.
    expect(out.loaded).toEqual([NESTED, ROOT, REPLY, "other"].sort());
  });

  it("source: removes the whole thread and keeps it out after reconciling", () => {
    const out = simulate({
      activeChannel: "general",
      loaded: [ROOT, REPLY, NESTED, "other"],
      events: MOVE_EVENTS_REPLY_FIRST,
      // A pre-move snapshot still listing the thread — the stale response the
      // finding warns about.
      serverWindow: ["other", ROOT, REPLY, NESTED],
    });
    expect(out.refetches).toBe(1);
    // The moved conversation cannot be resurrected by that stale window.
    expect(out.loaded).toEqual(["other"]);
  });

  it("source: root event last still leaves nothing behind", () => {
    const out = simulate({
      activeChannel: "general",
      loaded: [ROOT, REPLY, NESTED],
      events: [
        { id: REPLY, channel: "product_help", parent: ROOT },
        { id: NESTED, channel: "product_help", parent: REPLY },
        { id: ROOT, channel: "product_help", parent: null },
      ],
      serverWindow: [],
    });
    expect(out.loaded).toEqual([]);
    expect(out.refetches).toBe(1);
  });
});

describe("collectLoadedThread — the set a move removes", () => {
  // root → reply → nested → deep, plus a second, unrelated conversation.
  const DEEP = "deep-1";
  const OTHER_ROOT = "other-root";
  const OTHER_REPLY = "other-reply";
  const LOADED = [
    { id: ROOT, reply_to_message_id: null },
    { id: REPLY, reply_to_message_id: ROOT },
    { id: NESTED, reply_to_message_id: REPLY },
    { id: DEEP, reply_to_message_id: NESTED },
    { id: OTHER_ROOT, reply_to_message_id: null },
    { id: OTHER_REPLY, reply_to_message_id: OTHER_ROOT },
  ];

  it("includes the root and every descendant, to any depth", () => {
    expect([...collectLoadedThread(LOADED, ROOT)].sort()).toEqual(
      [ROOT, REPLY, NESTED, DEEP].sort(),
    );
  });

  it("never includes an unrelated conversation", () => {
    const thread = collectLoadedThread(LOADED, ROOT);
    expect(thread.has(OTHER_ROOT)).toBe(false);
    expect(thread.has(OTHER_REPLY)).toBe(false);
  });

  it("works from a mid-thread id (a descendant's event arriving first)", () => {
    expect([...collectLoadedThread(LOADED, REPLY)].sort()).toEqual(
      [REPLY, NESTED, DEEP].sort(),
    );
    expect([...collectLoadedThread(LOADED, NESTED)].sort()).toEqual(
      [NESTED, DEEP].sort(),
    );
  });

  it("is order-independent (descendants listed before their parents)", () => {
    const reversed = [...LOADED].reverse();
    expect([...collectLoadedThread(reversed, ROOT)].sort()).toEqual(
      [ROOT, REPLY, NESTED, DEEP].sort(),
    );
  });

  it("returns just the id for a root with no replies, or an unloaded id", () => {
    expect([...collectLoadedThread(LOADED, OTHER_ROOT)]).toEqual([
      OTHER_ROOT,
      OTHER_REPLY,
    ]);
    expect([...collectLoadedThread([], ROOT)]).toEqual([ROOT]);
    expect([...collectLoadedThread(LOADED, "never-loaded")]).toEqual([
      "never-loaded",
    ]);
  });
});

describe("the reply composer closes when its target is moved away", () => {
  const DEEP = "deep-1";
  const OTHER_ROOT = "other-root";
  const LOADED = [
    { id: ROOT, reply_to_message_id: null },
    { id: REPLY, reply_to_message_id: ROOT },
    { id: NESTED, reply_to_message_id: REPLY },
    { id: DEEP, reply_to_message_id: NESTED },
    { id: OTHER_ROOT, reply_to_message_id: null },
  ];

  /**
   * Mirrors the feed's drop path: classify the event, collect the complete
   * removed-id set, and close the composer only if its target is in it.
   * Returns the composer target afterwards (null = closed).
   */
  function applyMoveEvents(opts: {
    composerTarget: string | null;
    activeChannel: "general" | "product_help";
    /** Move events, in arrival order. */
    events: Array<{ id: string; parent: string | null }>;
    toChannel?: "product_help" | "social_media_hub";
  }) {
    let composer = opts.composerTarget;
    const loaded = [...LOADED];
    const removed = new Set<string>();
    let notices = 0;

    for (const e of opts.events) {
      const plan = classifyRealtimeUpdate({
        row: {
          id: e.id,
          channel: opts.toChannel ?? "product_help",
          reply_to_message_id: e.parent,
        },
        activeChannel: opts.activeChannel,
        isLoaded: loaded.some((m) => m.id === e.id) && !removed.has(e.id),
      });
      if (plan.kind !== "drop-conversation" && plan.kind !== "drop-message") {
        continue;
      }
      // The complete removed set — root, direct replies and nested descendants.
      const doomed = collectLoadedThread(loaded, e.id);
      for (const id of doomed) removed.add(id);
      if (composer !== null && doomed.has(composer)) composer = null;
      if (plan.kind === "drop-conversation") notices += 1;
    }
    return { composer, removed: [...removed].sort(), notices };
  }

  it("closes a composer targeting the ROOT", () => {
    const out = applyMoveEvents({
      composerTarget: ROOT,
      activeChannel: "general",
      events: [{ id: ROOT, parent: null }],
    });
    expect(out.composer).toBeNull();
  });

  it("closes a composer targeting a DIRECT reply", () => {
    const out = applyMoveEvents({
      composerTarget: REPLY,
      activeChannel: "general",
      events: [{ id: ROOT, parent: null }],
    });
    expect(out.composer).toBeNull();
  });

  it("closes a composer targeting a DEEPLY NESTED reply — the reported bug", () => {
    // The root's event is the only one that has arrived, and the composer is
    // three levels down. The old root/direct-child check left this open.
    const out = applyMoveEvents({
      composerTarget: DEEP,
      activeChannel: "general",
      events: [{ id: ROOT, parent: null }],
    });
    expect(out.composer).toBeNull();
    expect(out.removed).toEqual([DEEP, NESTED, REPLY, ROOT].sort());
  });

  it("leaves a composer on an UNRELATED conversation open", () => {
    const out = applyMoveEvents({
      composerTarget: OTHER_ROOT,
      activeChannel: "general",
      events: [{ id: ROOT, parent: null }],
    });
    expect(out.composer).toBe(OTHER_ROOT);
    expect(out.removed).not.toContain(OTHER_ROOT);
  });

  it("closes it when the ROOT event arrives first", () => {
    const out = applyMoveEvents({
      composerTarget: NESTED,
      activeChannel: "general",
      events: [
        { id: ROOT, parent: null },
        { id: REPLY, parent: ROOT },
        { id: NESTED, parent: REPLY },
        { id: DEEP, parent: NESTED },
      ],
    });
    expect(out.composer).toBeNull();
  });

  it("closes it when a DESCENDANT event arrives first", () => {
    const out = applyMoveEvents({
      composerTarget: DEEP,
      activeChannel: "general",
      events: [
        { id: NESTED, parent: REPLY },
        { id: DEEP, parent: NESTED },
        { id: REPLY, parent: ROOT },
        { id: ROOT, parent: null },
      ],
    });
    expect(out.composer).toBeNull();
  });

  it("closes it in arbitrary event order", () => {
    for (const order of [
      [REPLY, DEEP, ROOT, NESTED],
      [DEEP, ROOT, NESTED, REPLY],
      [NESTED, ROOT, DEEP, REPLY],
    ]) {
      const parentOf: Record<string, string | null> = {
        [ROOT]: null,
        [REPLY]: ROOT,
        [NESTED]: REPLY,
        [DEEP]: NESTED,
      };
      const out = applyMoveEvents({
        composerTarget: DEEP,
        activeChannel: "general",
        events: order.map((id) => ({ id, parent: parentOf[id] })),
      });
      expect(out.composer).toBeNull();
    }
  });

  it("a burst of events cannot corrupt composer state", () => {
    // Already-closed stays closed; an unrelated target survives every event.
    const closed = applyMoveEvents({
      composerTarget: NESTED,
      activeChannel: "general",
      events: [
        { id: ROOT, parent: null },
        { id: REPLY, parent: ROOT },
        { id: NESTED, parent: REPLY },
        { id: DEEP, parent: NESTED },
        { id: ROOT, parent: null }, // duplicate delivery
      ],
    });
    expect(closed.composer).toBeNull();

    const unrelated = applyMoveEvents({
      composerTarget: OTHER_ROOT,
      activeChannel: "general",
      events: [
        { id: ROOT, parent: null },
        { id: REPLY, parent: ROOT },
        { id: NESTED, parent: REPLY },
        { id: DEEP, parent: NESTED },
      ],
    });
    expect(unrelated.composer).toBe(OTHER_ROOT);
  });

  it("only the ROOT event raises the moved banner", () => {
    const out = applyMoveEvents({
      composerTarget: null,
      activeChannel: "general",
      events: [
        { id: NESTED, parent: REPLY },
        { id: REPLY, parent: ROOT },
        { id: ROOT, parent: null },
      ],
    });
    // One banner for the conversation, not one per reply.
    expect(out.notices).toBe(1);
  });

  it("a destination-side burst never closes a composer", () => {
    // Arrivals reconcile; they are not drops, so nothing is removed and no
    // composer is touched. (And the feed is keyed by channel, so a tab switch
    // unmounts its composer with it — a reconciliation can never reach into
    // another channel's state.)
    const out = applyMoveEvents({
      composerTarget: OTHER_ROOT,
      activeChannel: "product_help",
      events: [
        { id: ROOT, parent: null },
        { id: REPLY, parent: ROOT },
      ],
      toChannel: "product_help",
    });
    expect(out.composer).toBe(OTHER_ROOT);
    expect(out.removed).toEqual([]);
  });
});
