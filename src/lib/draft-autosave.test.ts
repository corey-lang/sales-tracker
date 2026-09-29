import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DraftAutosave,
  DraftConflictError,
  DraftLockedError,
  DraftSaveError,
  completeDraft,
} from "@/lib/draft-autosave";

// The 1:1 draft autosave coordinator: serialized per-field saves, fields that
// survive their component unmounting, and a Complete flow that locks, drains
// everything, and unlocks intact on failure.

/** A save function whose calls resolve/reject only when the test says so. */
function controlledSaver() {
  const calls: Array<{
    value: string;
    resolve: () => void;
    reject: (e?: unknown) => void;
  }> = [];
  const persisted: string[] = [];
  const save = vi.fn(
    (value: string, revision: number) =>
      new Promise<number>((resolve, reject) => {
        calls.push({
          value,
          resolve: () => {
            persisted.push(value);
            resolve(revision + 1);
          },
          reject: (e) => reject(e ?? new Error("network")),
        });
      }),
  );
  return { save, calls, persisted };
}

/** A save that resolves immediately and records what the "server" holds. */
function instantSaver() {
  const server: string[] = [];
  return {
    server,
    save: vi.fn(async (v: string, revision: number) => {
      server.push(v);
      return revision + 1;
    }),
  };
}

/** Drains pending microtasks (setTimeout is faked in these tests). */
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("DraftAutosave fields", () => {
  it("debounces typing into one save of the latest value", async () => {
    const d = new DraftAutosave(1000);
    const { save, server } = instantSaver();
    d.ensure("wins", "", save);
    d.set("wins", "C");
    d.set("wins", "Cl");
    d.set("wins", "Closed ABC");
    await vi.advanceTimersByTimeAsync(1000);
    expect(server).toEqual(["Closed ABC"]);
    expect(d.get("wins")).toMatchObject({ value: "Closed ABC", saved: "Closed ABC", status: "saved" });
  });

  it("serializes saves so an older response can't overwrite newer text", async () => {
    const d = new DraftAutosave(1000);
    const s = controlledSaver();
    d.ensure("notes", "", s.save);

    d.set("notes", "first");
    const f1 = d.flush("notes"); // request #1 in flight
    await tick();
    d.set("notes", "first second"); // typed while #1 is in flight
    const f2 = d.flush("notes");
    await tick();
    expect(s.calls.map((c) => c.value)).toEqual(["first"]); // #2 waits for #1

    s.calls[0].resolve(); // the OLD response lands
    await tick();
    expect(d.get("notes")?.value).toBe("first second"); // not reverted
    expect(s.calls.map((c) => c.value)).toEqual(["first", "first second"]);
    s.calls[1].resolve();
    expect(await f1).toBe(true);
    expect(await f2).toBe(true);
    expect(s.persisted).toEqual(["first", "first second"]); // server ends newest
    expect(d.get("notes")).toMatchObject({ saved: "first second", status: "saved" });
  });

  it("keeps a field's value and pending save after its component goes away", async () => {
    const d = new DraftAutosave(1000);
    const { save, server } = instantSaver();
    d.ensure("note:sarah", "", save);
    d.set("note:sarah", "Push the Compass deck");
    // The card collapses: the component simply stops rendering. A re-mount
    // with the (stale) server value must not clobber the unsaved edit.
    d.ensure("note:sarah", "", save);
    expect(d.get("note:sarah")?.value).toBe("Push the Compass deck");
    await vi.advanceTimersByTimeAsync(1000);
    expect(server).toEqual(["Push the Compass deck"]);
  });

  it("marks a failed save and retries it on the next flush", async () => {
    const d = new DraftAutosave(1000);
    const s = controlledSaver();
    d.ensure("wins", "", s.save);
    d.set("wins", "x");
    const first = d.flush("wins");
    await tick();
    s.calls[0].reject();
    expect(await first).toBe(false);
    expect(d.get("wins")).toMatchObject({ value: "x", saved: "", status: "failed" });
    expect(d.isDirty()).toBe(true);

    const retry = d.flush("wins");
    await tick();
    s.calls[1].resolve();
    expect(await retry).toBe(true);
    expect(d.isDirty()).toBe(false);
  });
});

describe("completeDraft (Complete 1:1)", () => {
  it("saves text typed a moment ago BEFORE completing (dirty field + immediate Complete)", async () => {
    const d = new DraftAutosave(1000);
    const order: string[] = [];
    d.ensure("coaching_notes", "", async (v, r) => {
      order.push(`save:${v}`);
      return r + 1;
    });
    d.set("coaching_notes", "Remember the Q4 plan"); // debounce still pending
    await completeDraft(d, async () => void order.push("complete"));
    expect(order).toEqual(["save:Remember the Q4 plan", "complete"]);
  });

  it("waits for an in-flight save, then sends newer text, then completes", async () => {
    const d = new DraftAutosave(1000);
    const s = controlledSaver();
    const complete = vi.fn(async () => "record");
    d.ensure("wins", "", s.save);
    d.set("wins", "v1");
    void d.flush("wins");
    await tick();
    d.set("wins", "v1 v2");

    const done = completeDraft(d, complete);
    await tick();
    expect(d.locked).toBe(true);
    expect(d.set("wins", "typed during completion")).toBe(false); // locked
    expect(complete).not.toHaveBeenCalled();

    s.calls[0].resolve();
    await tick();
    expect(s.calls.map((c) => c.value)).toEqual(["v1", "v1 v2"]);
    expect(complete).not.toHaveBeenCalled();
    s.calls[1].resolve();
    expect(await done).toBe("record");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(s.persisted.at(-1)).toBe("v1 v2");
    expect(d.locked).toBe(true); // stays locked once completed
  });

  it("includes a collapsed Gold List note that was edited just before Complete", async () => {
    const d = new DraftAutosave(1000);
    const saved = new Map<string, string>();
    const saver = (key: string) => async (v: string, r: number) => {
      saved.set(key, v);
      return r + 1;
    };
    d.ensure("note:a", "", saver("note:a"));
    d.ensure("note:b", "", saver("note:b"));
    d.set("note:a", "Edited, then card collapsed");
    // (nothing is unregistered when the card unmounts)
    let completedWith: Map<string, string> | null = null;
    await completeDraft(d, async () => {
      completedWith = new Map(saved);
    });
    expect(completedWith!.get("note:a")).toBe("Edited, then card collapsed");
    expect(completedWith!.has("note:b")).toBe(false); // untouched field: no save
  });

  it("awaits an in-flight meeting mutation, and refuses new ones while completing", async () => {
    const d = new DraftAutosave(1000);
    let finish!: () => void;
    const toggle = d.mutate(() => new Promise<void>((r) => (finish = r)));
    const complete = vi.fn(async () => undefined);
    const done = completeDraft(d, complete);
    await tick();
    await expect(d.mutate(async () => "late")).rejects.toBeInstanceOf(DraftLockedError);
    expect(complete).not.toHaveBeenCalled();
    finish();
    await toggle;
    await done;
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("does not complete when a field won't save — unlocks with text intact for retry", async () => {
    const d = new DraftAutosave(1000);
    let fail = true;
    const server: string[] = [];
    d.ensure("wins", "", async (v, r) => {
      if (fail) throw new Error("offline");
      server.push(v);
      return r + 1;
    });
    d.set("wins", "Big win");
    const complete = vi.fn(async () => "ok");

    await expect(completeDraft(d, complete)).rejects.toBeInstanceOf(DraftSaveError);
    expect(complete).not.toHaveBeenCalled();
    expect(d.locked).toBe(false);
    expect(d.get("wins")).toMatchObject({ value: "Big win", status: "failed" });

    fail = false;
    expect(await completeDraft(d, complete)).toBe("ok");
    expect(server).toEqual(["Big win"]);
  });

  it("unlocks with everything intact when the completion request fails, then retries", async () => {
    const d = new DraftAutosave(1000);
    const { save, server } = instantSaver();
    d.ensure("wins", "", save);
    d.set("wins", "Kept");
    const complete = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValueOnce("record");

    await expect(completeDraft(d, complete)).rejects.toThrow("503");
    expect(d.locked).toBe(false);
    expect(d.get("wins")).toMatchObject({ value: "Kept", saved: "Kept" });
    expect(d.set("wins", "Kept + more")).toBe(true); // editable again

    expect(await completeDraft(d, complete)).toBe("record");
    expect(server).toEqual(["Kept", "Kept + more"]);
  });

  it("blocks completion if a tracked mutation failed while flushing", async () => {
    const d = new DraftAutosave(1000);
    let fail!: () => void;
    const m = d.mutate(() => new Promise<void>((_, rej) => (fail = () => rej(new Error("x")))));
    m.catch(() => undefined);
    const complete = vi.fn(async () => undefined);
    const done = completeDraft(d, complete);
    fail();
    await expect(done).rejects.toBeInstanceOf(DraftSaveError);
    expect(complete).not.toHaveBeenCalled();
    expect(d.locked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-tab optimistic concurrency
// ---------------------------------------------------------------------------

/**
 * A fake server field with compare-and-set on its revision — the same rule
 * the PATCH / PUT routes enforce — shared by two "tabs".
 */
function fakeServerField(initial = "", revision = 0) {
  const state = { value: initial, revision };
  const save = async (value: string, expected: number): Promise<number> => {
    if (expected !== state.revision) {
      throw new DraftConflictError(state.value, state.revision);
    }
    state.value = value;
    state.revision += 1;
    return state.revision;
  };
  return { state, save };
}

describe("DraftAutosave cross-tab conflicts", () => {
  it("sends the revision it is based on, advancing it after each save", async () => {
    const server = fakeServerField("", 0);
    const d = new DraftAutosave(1000);
    d.ensure("wins", "", server.save, 0);
    d.set("wins", "one");
    await d.flush("wins");
    d.set("wins", "one two");
    await d.flush("wins");
    expect(server.state).toEqual({ value: "one two", revision: 2 });
    expect(d.get("wins")).toMatchObject({ revision: 2, status: "saved" });
  });

  it("a stale tab can't overwrite newer text — it keeps its own text and shows theirs", async () => {
    const server = fakeServerField("", 0);
    const tabA = new DraftAutosave(1000);
    const tabB = new DraftAutosave(1000);
    tabA.ensure("wins", "", server.save, 0);
    tabB.ensure("wins", "", server.save, 0);

    tabA.set("wins", "Newer, from tab A");
    expect(await tabA.flush("wins")).toBe(true);

    tabB.set("wins", "Older view, from tab B");
    expect(await tabB.flush("wins")).toBe(false);
    expect(server.state).toEqual({ value: "Newer, from tab A", revision: 1 }); // not overwritten
    expect(tabB.get("wins")).toMatchObject({
      value: "Older view, from tab B", // user text kept
      status: "conflict",
      conflict: { value: "Newer, from tab A", revision: 1 },
    });
    expect(tabB.isDirty()).toBe(true);

    // Further typing stays local; no stale save goes out.
    tabB.set("wins", "Older view, from tab B (edited)");
    await vi.advanceTimersByTimeAsync(5000);
    expect(server.state.value).toBe("Newer, from tab A");
  });

  it("blocks Complete while a field is in conflict, without discarding text", async () => {
    const server = fakeServerField("theirs", 3);
    const d = new DraftAutosave(1000);
    d.ensure("notes", "", server.save, 0); // stale revision
    d.set("notes", "mine");
    const complete = vi.fn(async () => "record");
    await expect(completeDraft(d, complete)).rejects.toBeInstanceOf(DraftSaveError);
    expect(complete).not.toHaveBeenCalled();
    expect(d.locked).toBe(false);
    expect(d.get("notes")).toMatchObject({ value: "mine", status: "conflict" });
  });

  it("'Keep mine' re-saves on top of the newer revision; then Complete proceeds", async () => {
    const server = fakeServerField("theirs", 3);
    const d = new DraftAutosave(1000);
    d.ensure("notes", "", server.save, 0);
    d.set("notes", "mine");
    await d.flush("notes");
    expect(await d.resolveConflict("notes", "mine")).toBe(true);
    expect(server.state).toEqual({ value: "mine", revision: 4 });
    expect(d.get("notes")).toMatchObject({ value: "mine", saved: "mine", revision: 4, conflict: null });
    await expect(completeDraft(d, async () => "ok")).resolves.toBe("ok");
  });

  it("'Use theirs' adopts the newer text without sending anything", async () => {
    const server = fakeServerField("theirs", 3);
    const save = vi.fn(server.save);
    const d = new DraftAutosave(1000);
    d.ensure("notes", "", save, 0);
    d.set("notes", "mine");
    await d.flush("notes");
    expect(await d.resolveConflict("notes", "theirs")).toBe(true);
    expect(d.get("notes")).toMatchObject({ value: "theirs", saved: "theirs", revision: 3, status: "idle" });
    expect(d.isDirty()).toBe(false);
    expect(save).toHaveBeenCalledTimes(1); // only the refused attempt
    expect(server.state).toEqual({ value: "theirs", revision: 3 });
  });

  it("different fields never conflict with each other", async () => {
    const wins = fakeServerField("", 0);
    const notes = fakeServerField("", 0);
    const tabA = new DraftAutosave(1000);
    const tabB = new DraftAutosave(1000);
    for (const tab of [tabA, tabB]) {
      tab.ensure("wins", "", wins.save, 0);
      tab.ensure("notes", "", notes.save, 0);
    }
    tabA.set("wins", "A's wins");
    tabB.set("notes", "B's notes");
    expect(await tabA.flush("wins")).toBe(true);
    expect(await tabB.flush("notes")).toBe(true);
    expect([wins.state.value, notes.state.value]).toEqual(["A's wins", "B's notes"]);
  });

  it("waits for an in-flight legacy commitment toggle before completing", async () => {
    const d = new DraftAutosave(1000);
    const order: string[] = [];
    let land!: () => void;
    const toggle = d.mutate(
      () =>
        new Promise<void>((r) => {
          land = () => {
            order.push("legacy toggle landed");
            r();
          };
        }),
    );
    const done = completeDraft(d, async () => void order.push("complete"));
    await tick();
    expect(order).toEqual([]); // completion is waiting on the toggle
    await expect(d.mutate(async () => "another toggle")).rejects.toBeInstanceOf(DraftLockedError);
    land();
    await toggle;
    await done;
    expect(order).toEqual(["legacy toggle landed", "complete"]);
  });
});
