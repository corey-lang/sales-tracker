"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { apiFetch } from "@/lib/api-client";
import { supabase } from "@/lib/supabase/client";
import { useSalesperson } from "@/lib/use-salesperson";
import {
  TEAM_MESSAGES_TABLE,
  TEAM_MESSAGES_UNREAD_CHANNEL,
  type TeamMessage,
  type TeamMessageUnreadSummary,
} from "@/lib/team-messages";

// Single source of truth for Juice Box unread state across the app.
//
// WHY GLOBAL
//   The bottom-nav badge and the /juice-box page both need to agree on
//   "current user's last_read_at" and "current unread count". The nav
//   exists on every authed page, so the state belongs above the page
//   layer — sitting in a Client provider mounted in the root layout.
//
// WHAT IT DOES
//   - On mount (when the caller is signed in), fetches the unread
//     summary from /api/team-messages/unread.
//   - Subscribes to postgres_changes on `team_messages` so:
//       * teammate INSERTs   -> increment count
//       * own INSERTs        -> ignored (we mark read on self-post)
//       * deletions (UPDATE  -> is_deleted = true) -> refetch (cheaper than
//         tracking which messages were unread on the client)
//   - Exposes `markAllRead()` so the /juice-box page can flip the count
//     to 0 and advance the local `lastReadAt` once the user has actually
//     seen the latest posts.
//
// SIGNED-OUT USERS
//   For signed-out callers the provider is a no-op. The hook returns
//   zeroes so consumers don't need to special-case the unauthenticated
//   path. Juice Box is otherwise open to every signed-in salesperson;
//   `eligible` below is simply "do we have a session yet".

type JuiceBoxUnreadContextValue = {
  /** Latest known unread count. Defaults to 0 until the first fetch. */
  unreadCount: number;
  /** Server-confirmed last_read_at for the current user. null until known. */
  lastReadAt: string | null;
  /** True once the bootstrap fetch resolves at least once; lets consumers
   *  avoid flashing "no unread" before the real number arrives. */
  loaded: boolean;
  /** Marks everything up to now as read. Idempotent; safe to spam. */
  markAllRead: () => Promise<void>;
};

const noop = async () => undefined;

const Context = createContext<JuiceBoxUnreadContextValue>({
  unreadCount: 0,
  lastReadAt: null,
  loaded: false,
  markAllRead: noop,
});

export function JuiceBoxUnreadProvider({ children }: { children: ReactNode }) {
  const { salesperson, loaded: salespersonLoaded } = useSalesperson();
  const userId = salesperson?.id ?? null;
  const eligible = userId !== null;

  // Raw state — what the server told us. Derived display values below zero
  // these out for ineligible users without needing to setState on transition.
  const [rawUnreadCount, setRawUnreadCount] = useState(0);
  const [rawLastReadAt, setRawLastReadAt] = useState<string | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);

  // Refs read from inside the realtime callback so it can stay defined
  // once per subscription cycle without restarting on every state change.
  // Updated in effects (not during render) to satisfy react-hooks/refs.
  const userIdRef = useRef<string | null>(null);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);
  const lastReadAtRef = useRef<string | null>(null);
  useEffect(() => {
    lastReadAtRef.current = rawLastReadAt;
  }, [rawLastReadAt]);

  // Bootstrap fetch: only runs for an eligible signed-in user. The early
  // returns intentionally do NOT setState — display values below derive
  // zeros from `eligible` directly, so there's nothing to reset.
  useEffect(() => {
    if (!salespersonLoaded) return;
    if (!eligible || !userId) return;

    let cancelled = false;
    apiFetch("/api/team-messages/unread")
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as
          | TeamMessageUnreadSummary
          | { error?: string }
          | null;
        if (cancelled) return;
        if (!res.ok || !body || "error" in body) return;
        const summary = body as TeamMessageUnreadSummary;
        setRawUnreadCount(summary.count);
        setRawLastReadAt(summary.last_read_at);
      })
      .catch(() => {
        // Network errors fall through — badge stays at its prior value.
      })
      .finally(() => {
        if (!cancelled) setBootstrapped(true);
      });

    return () => {
      cancelled = true;
    };
  }, [eligible, salespersonLoaded, userId]);

  // Public values derive from raw state gated on eligibility — that way
  // becoming ineligible (sign-out, role change) flips the badge to 0
  // without an effect-driven reset.
  const unreadCount = eligible ? rawUnreadCount : 0;
  const lastReadAt = eligible ? rawLastReadAt : null;
  const loaded = !eligible ? salespersonLoaded : bootstrapped;

  // Realtime: keep the count current between bootstraps.
  useEffect(() => {
    if (!eligible || !userId) return;

    let cancelled = false;
    const refetch = () => {
      apiFetch("/api/team-messages/unread")
        .then(async (res) => {
          const body = (await res.json().catch(() => null)) as
            | TeamMessageUnreadSummary
            | null;
          if (cancelled || !res.ok || !body) return;
          setRawUnreadCount(body.count);
          setRawLastReadAt(body.last_read_at);
        })
        .catch(() => undefined);
    };

    const channel = supabase
      .channel(TEAM_MESSAGES_UNREAD_CHANNEL)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: TEAM_MESSAGES_TABLE },
        (payload) => {
          const row = payload.new as TeamMessage;
          if (row.is_deleted) return;
          if (row.salesperson_id === userIdRef.current) return;
          // Skip if the row predates the user's marker — possible only on
          // bizarre clock skew, but the guard makes the count truthful.
          const marker = lastReadAtRef.current;
          if (marker && row.created_at <= marker) return;
          setRawUnreadCount((c) => c + 1);
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: TEAM_MESSAGES_TABLE },
        (payload) => {
          const row = payload.new as TeamMessage;
          // A delete (is_deleted flipped to true) might remove an unread
          // row OR a read one — we can't tell from the payload, so refetch.
          if (row.is_deleted) refetch();
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [eligible, userId]);

  // Mirror the unread count onto the home-screen / dock app badge via
  // the W3C Badging API. Supported on iOS 16.4+ standalone PWAs, macOS
  // Safari, and most Chromium-based browsers; absent on older iOS, in
  // Firefox today, and in browser tabs (iOS only badges installed Home
  // Screen apps). Feature-detected so unsupported platforms silently
  // no-op. Signed-out users get the badge cleared explicitly so a
  // prior session's badge doesn't linger on the icon. Errors are
  // swallowed because the API can reject on transient OS conditions
  // and the badge is best-effort.
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const nav = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (!eligible) {
      if (typeof nav.clearAppBadge === "function") {
        nav.clearAppBadge().catch(() => undefined);
      }
      return;
    }
    if (unreadCount > 0) {
      if (typeof nav.setAppBadge === "function") {
        nav.setAppBadge(unreadCount).catch(() => undefined);
      }
    } else if (typeof nav.clearAppBadge === "function") {
      nav.clearAppBadge().catch(() => undefined);
    }
  }, [eligible, unreadCount]);

  // Reads current `unreadCount` inside markAllRead without forcing the
  // callback identity to change every time the count moves.
  const unreadCountRef = useRef(unreadCount);
  useEffect(() => {
    unreadCountRef.current = unreadCount;
  }, [unreadCount]);

  // `bootstrapped` mirror — gates the unread-count short-circuit so the
  // very first markAllRead call after page open cannot be skipped just
  // because the bootstrap fetch hasn't populated rawUnreadCount yet.
  const bootstrappedRef = useRef(bootstrapped);
  useEffect(() => {
    bootstrappedRef.current = bootstrapped;
  }, [bootstrapped]);

  const markAllRead = useCallback(async () => {
    if (!eligible) return;
    // Already empty — no point round-tripping. Only valid AFTER bootstrap
    // has settled; before that, rawUnreadCount is the initial 0 default,
    // which would silently swallow the first mark-read on a fresh open.
    if (bootstrappedRef.current && unreadCountRef.current === 0) return;
    // Optimistic: drop the badge immediately so the UI feels live.
    setRawUnreadCount(0);
    try {
      const res = await apiFetch("/api/team-messages/reads/me", {
        method: "POST",
      });
      if (!res.ok) return;
      const body = (await res.json().catch(() => null)) as {
        last_read_at?: string;
      } | null;
      if (body?.last_read_at) {
        setRawLastReadAt(body.last_read_at);
      }
    } catch {
      // Network error: leave the optimistic 0 in place. The next bootstrap
      // (e.g., next page load) will reconcile against the server.
    }
  }, [eligible]);

  return (
    <Context.Provider
      value={{ unreadCount, lastReadAt, loaded, markAllRead }}
    >
      {children}
    </Context.Provider>
  );
}

export function useJuiceBoxUnread(): JuiceBoxUnreadContextValue {
  return useContext(Context);
}
