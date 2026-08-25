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
  normalizeChannel,
  TEAM_MESSAGES_TABLE,
  TEAM_MESSAGES_UNREAD_CHANNEL,
  type JuiceBoxChannel,
  type TeamMessage,
  type TeamMessageChannelUnread,
  type TeamMessageUnreadSummary,
} from "@/lib/team-messages";
import {
  combinedUnreadCount,
  emptyChannelUnread,
} from "@/lib/juice-box-unread";

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
//       * teammate INSERTs   -> increment THAT ROW'S channel count
//       * own INSERTs        -> ignored (we mark read on self-post)
//       * deletions (UPDATE  -> is_deleted = true) -> refetch (cheaper than
//         tracking which messages were unread on the client)
//   - Exposes `markChannelRead(channel)` so the /juice-box page can flip one
//     channel's count to 0 and advance that channel's `lastReadAt` once the
//     user has actually seen its latest posts.
//
// PER-CHANNEL STATE, ONE BADGE
//   Unread state is tracked per channel (General / Product Help / Social Media
//   Hub) because each channel owns its own NEW MESSAGES divider, initial
//   scroll, and tab badge. The bottom-nav badge shows the COMBINED total, so a
//   Product Help post still pulls the user into Juice Box.
//
//   Marking one channel read never touches another: markChannelRead zeroes
//   only that channel locally, and the POST it sends upserts only that
//   channel's (salesperson_id, channel) row server-side.
//
// SIGNED-OUT USERS
//   For signed-out callers the provider is a no-op. The hook returns
//   zeroes so consumers don't need to special-case the unauthenticated
//   path. Juice Box is otherwise open to every signed-in salesperson;
//   `eligible` below is simply "do we have a session yet".

type JuiceBoxUnreadContextValue = {
  /** COMBINED unread across every channel — what the nav badge shows.
   *  Defaults to 0 until the first fetch. */
  unreadCount: number;
  /** Per-channel unread counts + read markers. Always has all three keys. */
  channels: Record<JuiceBoxChannel, TeamMessageChannelUnread>;
  /** True once the bootstrap fetch resolves at least once; lets consumers
   *  avoid flashing "no unread" before the real number arrives. */
  loaded: boolean;
  /** Marks everything in ONE channel up to now as read. Idempotent; safe to
   *  spam. Other channels are untouched. */
  markChannelRead: (channel: JuiceBoxChannel) => Promise<void>;
};

const noop = async () => undefined;

const Context = createContext<JuiceBoxUnreadContextValue>({
  unreadCount: 0,
  channels: emptyChannelUnread(),
  loaded: false,
  markChannelRead: noop,
});

/** Stable object for the signed-out case so consumers don't see a new
 *  identity on every render. */
const EMPTY_CHANNELS = emptyChannelUnread();

/** Reads the per-channel block out of an /unread payload, tolerating a
 *  response from an older deployment that has no `channels` key (in which
 *  case its flat count/marker are attributed to General). */
function channelsFromSummary(
  summary: TeamMessageUnreadSummary,
): Record<JuiceBoxChannel, TeamMessageChannelUnread> {
  const next = emptyChannelUnread();
  if (summary.channels) {
    for (const key of Object.keys(next) as JuiceBoxChannel[]) {
      const slice = summary.channels[key];
      if (slice) {
        next[key] = {
          count: Number(slice.count) || 0,
          last_read_at: slice.last_read_at ?? null,
        };
      }
    }
    return next;
  }
  next.general = {
    count: Number(summary.count) || 0,
    last_read_at: summary.last_read_at ?? null,
  };
  return next;
}

export function JuiceBoxUnreadProvider({ children }: { children: ReactNode }) {
  const { salesperson, loaded: salespersonLoaded } = useSalesperson();
  const userId = salesperson?.id ?? null;
  const eligible = userId !== null;

  // Raw state — what the server told us, per channel. Derived display values
  // below zero these out for ineligible users without needing to setState on
  // transition.
  const [rawChannels, setRawChannels] = useState<
    Record<JuiceBoxChannel, TeamMessageChannelUnread>
  >(() => emptyChannelUnread());
  const [bootstrapped, setBootstrapped] = useState(false);

  // Refs read from inside the realtime callback so it can stay defined
  // once per subscription cycle without restarting on every state change.
  // Updated in effects (not during render) to satisfy react-hooks/refs.
  const userIdRef = useRef<string | null>(null);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);
  const channelsRef = useRef<Record<JuiceBoxChannel, TeamMessageChannelUnread>>(
    emptyChannelUnread(),
  );
  useEffect(() => {
    channelsRef.current = rawChannels;
  }, [rawChannels]);

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
        setRawChannels(channelsFromSummary(summary));
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
  const channels = eligible ? rawChannels : EMPTY_CHANNELS;
  const unreadCount = eligible ? combinedUnreadCount(rawChannels) : 0;
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
          setRawChannels(channelsFromSummary(body));
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
          // Attribute the increment to the row's OWN channel — a Product Help
          // post must not light up the General tab. A payload from before the
          // channel column existed normalizes to General.
          const rowChannel = normalizeChannel(row.channel);
          // Skip if the row predates that channel's marker — possible only on
          // bizarre clock skew, but the guard makes the count truthful.
          const marker = channelsRef.current[rowChannel]?.last_read_at ?? null;
          if (marker && row.created_at <= marker) return;
          setRawChannels((prev) => ({
            ...prev,
            [rowChannel]: {
              count: (prev[rowChannel]?.count ?? 0) + 1,
              last_read_at: prev[rowChannel]?.last_read_at ?? null,
            },
          }));
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

  // Reads current per-channel counts inside markChannelRead without forcing
  // the callback identity to change every time a count moves.
  const countsRef = useRef(channels);
  useEffect(() => {
    countsRef.current = channels;
  }, [channels]);

  // `bootstrapped` mirror — gates the unread-count short-circuit so the
  // very first markAllRead call after page open cannot be skipped just
  // because the bootstrap fetch hasn't populated rawUnreadCount yet.
  const bootstrappedRef = useRef(bootstrapped);
  useEffect(() => {
    bootstrappedRef.current = bootstrapped;
  }, [bootstrapped]);

  const markChannelRead = useCallback(
    async (channel: JuiceBoxChannel) => {
      if (!eligible) return;
      // Already empty — no point round-tripping. Only valid AFTER bootstrap
      // has settled; before that, the count is the initial 0 default, which
      // would silently swallow the first mark-read on a fresh open.
      if (
        bootstrappedRef.current &&
        (countsRef.current[channel]?.count ?? 0) === 0
      ) {
        return;
      }
      // Optimistic: drop THIS channel's badge immediately so the UI feels
      // live. Other channels keep their counts.
      setRawChannels((prev) => ({
        ...prev,
        [channel]: {
          count: 0,
          last_read_at: prev[channel]?.last_read_at ?? null,
        },
      }));
      try {
        const res = await apiFetch("/api/team-messages/reads/me", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel }),
        });
        if (!res.ok) return;
        const body = (await res.json().catch(() => null)) as {
          channel?: string;
          last_read_at?: string;
        } | null;
        if (body?.last_read_at) {
          // Trust the channel the SERVER says it stamped (it echoes it back),
          // so a mismatched optimistic guess can't advance the wrong marker.
          const stamped = normalizeChannel(body.channel ?? channel);
          setRawChannels((prev) => ({
            ...prev,
            [stamped]: {
              count: prev[stamped]?.count ?? 0,
              last_read_at: body.last_read_at ?? null,
            },
          }));
        }
      } catch {
        // Network error: leave the optimistic 0 in place. The next bootstrap
        // (e.g., next page load) will reconcile against the server.
      }
    },
    [eligible],
  );

  return (
    <Context.Provider
      value={{ unreadCount, channels, loaded, markChannelRead }}
    >
      {children}
    </Context.Provider>
  );
}

export function useJuiceBoxUnread(): JuiceBoxUnreadContextValue {
  return useContext(Context);
}
