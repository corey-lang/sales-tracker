"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { X } from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import {
  SEEN_SUMMARY_MAX_IDS,
  seenLabel,
  type SeenDetail,
  type SeenSummariesResponse,
  type SeenSummary,
} from "@/lib/juice-box-seen";
import { useLivePermissions } from "@/lib/use-live-permissions";

import { Card, CardContent } from "@/components/ui/card";

// Juice Box "Seen by X of Y".
//
// Shown ONLY to people the server says may see it (admins + the
// can_view_juice_box_seen grant). For everyone else the whole feature is absent —
// no line, no request — which is also the least cluttered option. That visibility
// is chrome: /api/team-messages/seen* re-checks every request and returns 403
// with no data to anyone else.
//
// Structure: <SeenByProvider> sits around a channel's feed, batches ONE request
// for the loaded posts (never one per post), keeps the counts fresh, and owns the
// "Who has seen this" sheet. A post card renders <SeenByLine messageId=…/>, which
// reads from context and renders nothing when there is nothing to show.

type SeenByContextValue = {
  summaryFor: (messageId: string) => SeenSummary | undefined;
  open: (messageId: string) => void;
};

export const SeenByContext = createContext<SeenByContextValue | null>(null);

/** Refresh cadence while the feed is on screen (people read in the background). */
const REFRESH_MS = 60_000;

/** Whether the viewer may see it — remembered for the page's life so switching
 *  channel tabs doesn't blank the indicators while permissions reload. */
let capabilityMemo: boolean | null = null;

export function SeenByProvider({
  messageIds,
  children,
}: {
  /** Ids of the posts currently loaded in this channel's feed. */
  messageIds: readonly string[];
  children: ReactNode;
}) {
  const { permissions, loaded } = useLivePermissions();
  // The server said 403 to a request: this person isn't allowed after all.
  const [refused, setRefused] = useState(false);
  const granted = loaded
    ? permissions?.can_view_juice_box_seen === true
    : capabilityMemo === true;
  const enabled = granted && !refused;
  useEffect(() => {
    if (loaded) capabilityMemo = permissions?.can_view_juice_box_seen === true;
  }, [loaded, permissions]);

  const [summaries, setSummaries] = useState<Record<string, SeenSummary>>({});
  const [openId, setOpenId] = useState<string | null>(null);

  // Stable key: the fetch re-runs when the SET of loaded posts changes, not on
  // every render or reaction.
  const idsKey = useMemo(() => [...messageIds].sort().join(","), [messageIds]);
  const idsRef = useRef<string[]>([]);
  useEffect(() => {
    idsRef.current = idsKey ? idsKey.split(",") : [];
  }, [idsKey]);

  const refresh = useCallback(async () => {
    const ids = idsRef.current;
    if (ids.length === 0) return;
    try {
      // One request per 200 posts — a feed page is 50, so in practice one.
      const merged: Record<string, SeenSummary> = {};
      for (let i = 0; i < ids.length; i += SEEN_SUMMARY_MAX_IDS) {
        const chunk = ids.slice(i, i + SEEN_SUMMARY_MAX_IDS);
        const res = await apiFetch(
          `/api/team-messages/seen?ids=${encodeURIComponent(chunk.join(","))}`,
        );
        if (!res.ok) {
          // 403 means this person isn't allowed after all: drop the feature.
          if (res.status === 403) setRefused(true);
          return;
        }
        const body = (await res.json()) as SeenSummariesResponse;
        Object.assign(merged, body.posts);
      }
      setSummaries((prev) => ({ ...prev, ...merged }));
    } catch {
      // Network blip: keep what we have; the next tick retries.
    }
  }, []);

  useEffect(() => {
    if (!enabled || !idsKey) return;
    const t = setTimeout(() => void refresh(), 300); // collapse bursts of inbound posts
    return () => clearTimeout(t);
  }, [enabled, idsKey, refresh]);

  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [enabled, refresh]);

  const value = useMemo<SeenByContextValue | null>(
    () =>
      enabled
        ? { summaryFor: (id) => summaries[id], open: (id) => setOpenId(id) }
        : null,
    [enabled, summaries],
  );

  return (
    <SeenByContext.Provider value={value}>
      {children}
      {enabled && openId ? (
        <SeenBySheet messageId={openId} onClose={() => setOpenId(null)} />
      ) : null}
    </SeenByContext.Provider>
  );
}

/** The subtle "👁 Seen by 8 of 11" line under a post. Renders nothing unless allowed. */
export function SeenByLine({ messageId }: { messageId: string }) {
  const ctx = useContext(SeenByContext);
  const summary = ctx?.summaryFor(messageId);
  if (!ctx || !summary || summary.total <= 0) return null;
  return (
    <button
      type="button"
      onClick={() => ctx.open(messageId)}
      aria-label={`${seenLabel(summary)}. Show who has seen this.`}
      className="block min-h-6 rounded-md py-1 pl-[2.625rem] pr-2 text-left text-[11px] text-muted-foreground/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <span aria-hidden="true">👁 </span>
      {seenLabel(summary)}
    </button>
  );
}

type SheetState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; detail: SeenDetail };

function SeenBySheet({
  messageId,
  onClose,
}: {
  messageId: string;
  onClose: () => void;
}) {
  const [state, setState] = useState<SheetState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/team-messages/${messageId}/seen`);
        if (cancelled) return;
        if (!res.ok) {
          setState({
            status: "error",
            message:
              res.status === 404
                ? "That post is no longer available."
                : "Couldn't load this right now.",
          });
          return;
        }
        setState({ status: "ready", detail: (await res.json()) as SeenDetail });
      } catch {
        if (!cancelled) setState({ status: "error", message: "Couldn't load this right now." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="seen-by-title"
      className="fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center"
      style={{
        paddingTop: "calc(0.75rem + env(safe-area-inset-top))",
        paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))",
      }}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm focus:outline-none"
      />
      <Card
        size="sm"
        className="relative max-h-[80vh] w-full max-w-xs overflow-y-auto animate-in fade-in-0 zoom-in-95 duration-150"
      >
        <CardContent className="space-y-3 px-3 py-2.5">
          <header className="flex items-center justify-between gap-2">
            <h2 id="seen-by-title" className="text-sm font-semibold">
              Who has seen this
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-1 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </header>
          {state.status === "loading" ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : state.status === "error" ? (
            <p role="alert" className="text-xs text-destructive">
              {state.message}
            </p>
          ) : (
            <SeenByLists detail={state.detail} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** The two lists. Pure and presentational, so it renders in tests. */
export function SeenByLists({ detail }: { detail: SeenDetail }) {
  return (
    <div className="space-y-3">
      <section aria-label="Seen">
        <h3 className="mb-1 text-xs font-semibold text-muted-foreground">
          Seen — {detail.seen_people.length}
        </h3>
        {detail.seen_people.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">No one yet.</p>
        ) : (
          <ul className="space-y-0.5">
            {detail.seen_people.map((p) => (
              <li key={p.id} className="flex items-center gap-2 px-1 py-0.5 text-sm">
                <span aria-hidden="true">🟢</span>
                <span className="min-w-0 truncate">{p.name}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Not seen">
        <h3 className="mb-1 text-xs font-semibold text-muted-foreground">
          Not seen — {detail.not_seen_people.length}
        </h3>
        {detail.not_seen_people.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">Everyone has seen this.</p>
        ) : (
          <ul className="space-y-0.5">
            {detail.not_seen_people.map((p) => (
              <li key={p.id} className="flex items-center gap-2 px-1 py-0.5 text-sm">
                <span aria-hidden="true">⚪</span>
                <span className="min-w-0 truncate">{p.name}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
