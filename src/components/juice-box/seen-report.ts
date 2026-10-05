"use client";

import { useCallback, useEffect, useRef } from "react";

import { apiFetch } from "@/lib/api-client";
import {
  isReached,
  SEEN_DWELL_MS,
  SEEN_THRESHOLDS,
  SEEN_REPORT_MAX_IDS,
} from "@/lib/juice-box-seen";

// Reports which posts a person's screen actually showed, so "Seen by X of Y" rests
// on evidence rather than on the channel read marker (which is stamped past posts
// that were never loaded — see lib/juice-box-seen.ts).
//
// A post counts once it has been on screen (≥ half visible, tab in the foreground)
// for an UNBROKEN SEEN_DWELL_MS. Backgrounding the tab cancels every running
// dwell; returning to the foreground starts a fresh one for whatever is still on
// screen, so hidden time never counts toward the dwell. Reports are batched, each
// post is reported at most once per page load, and a failed report is simply
// retried the next time the post is reached. Nothing here touches the read marker
// or the unread UI.
//
// The signal is the signed-in browser's own report; the server binds it to the
// authenticated user (see /api/team-messages/seen/report) and does not try to
// prove the browser was honest.

const FLUSH_MS = 1000;

type Sender = (ids: string[]) => Promise<boolean>;

export type SeenReporter = {
  /** The post is on screen enough to count (or has just been so). */
  visible(id: string): void;
  /** The post left the screen / dropped below the threshold. */
  hidden(id: string): void;
  /** The tab left the foreground: every running dwell is cancelled. */
  background(): void;
  /** The tab is back: posts still on screen start a FRESH dwell. */
  foreground(): void;
  dispose(): void;
};

/**
 * The timing/batching rules, with the network and the page-visibility check
 * injected so they can be tested directly.
 */
export function createSeenReporter(opts: {
  send: Sender;
  isForeground?: () => boolean;
  dwellMs?: number;
  flushMs?: number;
}): SeenReporter {
  const dwellMs = opts.dwellMs ?? SEEN_DWELL_MS;
  const flushMs = opts.flushMs ?? FLUSH_MS;
  const isForeground = opts.isForeground ?? (() => true);

  const dwelling = new Map<string, ReturnType<typeof setTimeout>>();
  const onScreen = new Set<string>(); // currently qualifying, whether or not a dwell is running
  const queued = new Set<string>();
  const done = new Set<string>(); // queued or already reported this page load
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = async () => {
    flushTimer = null;
    const ids = [...queued];
    queued.clear();
    for (let i = 0; i < ids.length; i += SEEN_REPORT_MAX_IDS) {
      const batch = ids.slice(i, i + SEEN_REPORT_MAX_IDS);
      let ok = false;
      try {
        ok = await opts.send(batch);
      } catch {
        ok = false;
      }
      // Not recorded: forget it, so reaching the post again retries.
      if (!ok) for (const id of batch) done.delete(id);
    }
  };

  const schedule = () => {
    if (flushTimer === null) flushTimer = setTimeout(() => void flush(), flushMs);
  };

  const startDwell = (id: string) => {
    dwelling.set(
      id,
      setTimeout(() => {
        dwelling.delete(id);
        // Defensive: background() cancels this timer, so a firing timer means the tab
        // stayed foregrounded for the whole dwell.
        if (!isForeground() || done.has(id)) return;
        done.add(id);
        queued.add(id);
        schedule();
      }, dwellMs),
    );
  };

  const cancelDwell = (id: string) => {
    const t = dwelling.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      dwelling.delete(id);
    }
  };

  return {
    visible(id) {
      onScreen.add(id);
      if (done.has(id) || dwelling.has(id) || !isForeground()) return;
      startDwell(id);
    },
    hidden(id) {
      onScreen.delete(id);
      cancelDwell(id);
    },
    background() {
      for (const id of [...dwelling.keys()]) cancelDwell(id);
    },
    foreground() {
      if (!isForeground()) return;
      for (const id of onScreen) {
        if (!done.has(id) && !dwelling.has(id)) startDwell(id);
      }
    },
    dispose() {
      for (const t of dwelling.values()) clearTimeout(t);
      dwelling.clear();
      onScreen.clear();
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = null;
    },
  };
}

// One reporter + one observer for the whole page.
let shared: {
  reporter: SeenReporter;
  observer: IntersectionObserver;
  ids: WeakMap<Element, string>;
} | null = null;

function getShared() {
  if (shared) return shared;
  const reporter = createSeenReporter({
    send: async (ids) => {
      const res = await apiFetch("/api/team-messages/seen/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      return res.ok;
    },
    isForeground: () => document.visibilityState === "visible",
  });
  const ids = new WeakMap<Element, string>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id = ids.get(entry.target);
        if (!id) continue;
        if (isReached(entry, window.innerHeight)) reporter.visible(id);
        else reporter.hidden(id);
      }
    },
    { threshold: SEEN_THRESHOLDS },
  );
  // The existing visibility mechanism: leaving the foreground resets every dwell,
  // returning starts a fresh one for what is still on screen.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reporter.foreground();
    else reporter.background();
  });
  shared = { reporter, observer, ids };
  return shared;
}

/**
 * Ref callback for a post's root element: reports the post once it has really been
 * on screen. Safe where IntersectionObserver is missing (nothing is reported — and
 * so nothing is claimed).
 */
export function useSeenReport(messageId: string): (el: Element | null) => void {
  const current = useRef<Element | null>(null);

  useEffect(
    () => () => {
      if (current.current && shared) {
        shared.observer.unobserve(current.current);
        shared.reporter.hidden(messageId);
      }
    },
    [messageId],
  );

  return useCallback(
    (el: Element | null) => {
      if (typeof IntersectionObserver === "undefined") return;
      if (current.current && current.current !== el && shared) {
        shared.observer.unobserve(current.current);
        shared.reporter.hidden(messageId);
      }
      current.current = el;
      if (!el) return;
      const s = getShared();
      s.ids.set(el, messageId);
      s.observer.observe(el);
    },
    [messageId],
  );
}
