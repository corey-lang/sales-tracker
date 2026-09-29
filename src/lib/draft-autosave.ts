/**
 * DraftAutosave — the single owner of every autosaving field in a 1:1 draft.
 *
 * WHY A COORDINATOR (and not per-textarea saves)
 *   Completing a 1:1 must capture EVERYTHING typed, including a Gold List
 *   discussion note whose card was just collapsed. So the draft's text does
 *   not live in React components: each field's current value, last-saved
 *   value, saver, and in-flight save live here, keyed by a stable field key.
 *   Components only display and edit through it. Unmounting a component
 *   (collapsing a card) changes nothing — there is deliberately no
 *   "unregister", and correctness never depends on a save fired on unmount.
 *
 * GUARANTEES
 *   * Per-field saves are SERIALIZED: at most one request per field is in
 *     flight; when it finishes, the newest value is sent if it changed. The
 *     server response is never written back into the field, so an older
 *     response can't overwrite newer text.
 *   * `lock()` (entered by Complete 1:1) makes `set()` and `mutate()` refuse,
 *     so nothing changes while completion is running.
 *   * `flushAll()` cancels debounce timers, drains every dirty / in-flight
 *     field (mounted or not), and awaits every tracked non-text mutation
 *     (e.g. a commitment toggle), resolving true only if all of it saved.
 *   * `completeDraft()` = lock → flushAll → complete; on any failure it
 *     unlocks with every value intact so the user can retry.
 *   * Cross-tab safety: every save carries the field's last known REVISION.
 *     If another tab/device saved newer text first, the server refuses the
 *     save (DraftConflictError) and the field enters "conflict": the user's
 *     text stays on screen, nothing is re-sent, and they choose "keep mine"
 *     (re-save on top of the newer revision) or "use theirs". Completion is
 *     blocked while any field is in conflict.
 *
 * Framework-free (a tiny subscribe/snapshot store for useSyncExternalStore),
 * so the rules above are unit-tested directly.
 */

export type FieldStatus = "idle" | "saving" | "saved" | "failed" | "conflict";

export type FieldSnapshot = Readonly<{
  value: string;
  saved: string;
  status: FieldStatus;
  /** Server revision `saved` corresponds to. */
  revision: number;
  /** The newer server copy, while status === "conflict". */
  conflict: Readonly<{ value: string; revision: number }> | null;
}>;

/**
 * Persists `value` on top of `revision`, resolving to the NEW revision. Must
 * throw DraftConflictError when the server has a newer revision.
 */
export type FieldSaver = (value: string, revision: number) => Promise<number>;

/** Thrown by a saver when the server refused a stale revision. */
export class DraftConflictError extends Error {
  constructor(
    readonly serverValue: string,
    readonly serverRevision: number,
  ) {
    super("This was changed in another tab or device.");
    this.name = "DraftConflictError";
  }
}

type Field = {
  snapshot: FieldSnapshot;
  save: FieldSaver | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Tail of this field's serialized save chain. */
  chain: Promise<boolean>;
};

export class DraftSaveError extends Error {
  constructor(
    message = "Some notes didn't save or were changed elsewhere. Resolve them, then complete the 1:1.",
  ) {
    super(message);
    this.name = "DraftSaveError";
  }
}

export class DraftLockedError extends Error {
  constructor() {
    super("This 1:1 is being completed.");
    this.name = "DraftLockedError";
  }
}

export class DraftAutosave {
  private fields = new Map<string, Field>();
  private pending = new Set<Promise<unknown>>();
  private failedMutations = 0;
  private listeners = new Set<() => void>();
  private lockedFlag = false;
  private version = 0;

  constructor(private readonly debounceMs = 1200) {}

  // ---- store plumbing (useSyncExternalStore) --------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Changes whenever anything observable changes. */
  getVersion = (): number => this.version;

  private emit() {
    this.version += 1;
    for (const l of this.listeners) l();
  }

  private patch(key: string, next: Partial<FieldSnapshot>) {
    const f = this.fields.get(key)!;
    f.snapshot = { ...f.snapshot, ...next };
    this.emit();
  }

  // ---- fields ---------------------------------------------------------------

  /**
   * Declares a field. The server value seeds it only the FIRST time; after
   * that the coordinator's value wins (it may hold unsaved edits, e.g. for a
   * card that was collapsed and re-opened). The saver is always refreshed so
   * it closes over current props.
   */
  ensure(key: string, initial: string, save: FieldSaver, revision = 0): void {
    const existing = this.fields.get(key);
    if (existing) {
      existing.save = save;
      return;
    }
    this.fields.set(key, {
      snapshot: { value: initial, saved: initial, status: "idle", revision, conflict: null },
      save,
      timer: null,
      chain: Promise.resolve(true),
    });
  }

  get(key: string): FieldSnapshot | undefined {
    return this.fields.get(key)?.snapshot;
  }

  get locked(): boolean {
    return this.lockedFlag;
  }

  /** Edits a field. Refused (false) while locked. */
  set(key: string, value: string): boolean {
    const f = this.fields.get(key);
    if (!f || this.lockedFlag) return false;
    if (f.snapshot.status === "conflict") {
      // Keep typing locally; nothing is sent until the conflict is resolved.
      this.patch(key, { value });
      return true;
    }
    if (f.timer) clearTimeout(f.timer);
    f.timer = setTimeout(() => {
      f.timer = null;
      void this.flush(key);
    }, this.debounceMs);
    this.patch(key, {
      value,
      status: f.snapshot.status === "saving" ? "saving" : "idle",
    });
    return true;
  }

  /** Saves `key` now (after any in-flight save for it). */
  flush(key: string): Promise<boolean> {
    const f = this.fields.get(key);
    if (!f) return Promise.resolve(true);
    if (f.timer) {
      clearTimeout(f.timer);
      f.timer = null;
    }
    f.chain = f.chain.then(() => this.drain(key));
    return f.chain;
  }

  private async drain(key: string): Promise<boolean> {
    const f = this.fields.get(key)!;
    while (f.snapshot.value !== f.snapshot.saved) {
      if (f.snapshot.status === "conflict") return false;
      if (!f.save) return false;
      const sending = f.snapshot.value;
      this.patch(key, { status: "saving" });
      let revision: number;
      try {
        revision = await f.save(sending, f.snapshot.revision);
      } catch (err) {
        if (err instanceof DraftConflictError) {
          this.patch(key, {
            status: "conflict",
            conflict: { value: err.serverValue, revision: err.serverRevision },
          });
        } else {
          this.patch(key, { status: "failed" });
        }
        return false;
      }
      // Record only what was actually sent — newer typing stays dirty and the
      // loop sends it next. Never adopt a server echo as the field value.
      this.patch(key, { saved: sending, revision });
    }
    this.patch(key, { status: "saved" });
    return true;
  }

  /**
   * Resolves a conflict:
   *   * "mine"   — re-save the text on screen on top of the newer revision
   *                (deliberately replacing the other tab's text);
   *   * "theirs" — adopt the newer server text (the on-screen text is
   *                replaced; callers should keep a copy if they want it).
   */
  resolveConflict(key: string, choice: "mine" | "theirs"): Promise<boolean> {
    const f = this.fields.get(key);
    const c = f?.snapshot.conflict;
    if (!f || !c || this.lockedFlag) return Promise.resolve(false);
    if (choice === "theirs") {
      this.patch(key, {
        value: c.value,
        saved: c.value,
        revision: c.revision,
        conflict: null,
        status: "idle",
      });
      return Promise.resolve(true);
    }
    // Base the next save on the newer revision; `saved` = their text, so the
    // on-screen text is dirty and gets sent.
    this.patch(key, { saved: c.value, revision: c.revision, conflict: null, status: "idle" });
    return this.flush(key);
  }

  /** Clears a lingering "saved" badge back to idle. */
  settle(key: string): void {
    const f = this.fields.get(key);
    if (f && f.snapshot.status === "saved") this.patch(key, { status: "idle" });
  }

  /** True when any field has unsaved text or a save/mutation is running. */
  isDirty(): boolean {
    if (this.pending.size > 0) return true;
    for (const f of this.fields.values()) {
      if (
        f.snapshot.value !== f.snapshot.saved ||
        f.snapshot.status === "saving" ||
        f.snapshot.status === "conflict"
      )
        return true;
    }
    return false;
  }

  // ---- non-text meeting mutations ---------------------------------------------

  /**
   * Runs a meeting-scoped mutation (add/toggle a commitment, a Gold List
   * action…) so completion can await it. Refused while locked.
   */
  async mutate<T>(fn: () => Promise<T>): Promise<T> {
    if (this.lockedFlag) throw new DraftLockedError();
    const p = fn();
    this.pending.add(p);
    this.emit();
    try {
      return await p;
    } catch (err) {
      this.failedMutations += 1;
      throw err;
    } finally {
      this.pending.delete(p);
      this.emit();
    }
  }

  // ---- completion -------------------------------------------------------------

  lock(): void {
    this.lockedFlag = true;
    this.emit();
  }

  unlock(): void {
    this.lockedFlag = false;
    this.emit();
  }

  /**
   * Saves every dirty or in-flight field — including fields whose component
   * is not mounted — and waits for tracked mutations. True only if all of it
   * is durably saved.
   */
  async flushAll(): Promise<boolean> {
    const mutationsFailedBefore = this.failedMutations;
    await Promise.allSettled([...this.pending]);
    const results = await Promise.all([...this.fields.keys()].map((k) => this.flush(k)));
    return results.every(Boolean) && this.failedMutations === mutationsFailedBefore;
  }
}

/**
 * Complete-1:1 orchestration: lock the draft, durably save everything, then
 * run `complete`. On success the draft stays locked (the meeting is frozen).
 * On any failure — a field that won't save, or the completion request itself
 * — the draft unlocks with every value intact, ready to retry.
 */
export async function completeDraft<T>(
  draft: DraftAutosave,
  complete: () => Promise<T>,
): Promise<T> {
  draft.lock();
  try {
    if (!(await draft.flushAll())) throw new DraftSaveError();
    return await complete();
  } catch (err) {
    draft.unlock();
    throw err;
  }
}
