"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  List as ListIcon,
  Loader2,
  Locate,
  Map as MapIcon,
  MapPin,
  Plus,
  Search,
  X,
} from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { useSalesperson } from "@/lib/use-salesperson";
import { useLivePermissions } from "@/lib/use-live-permissions";
import { useScrollToTop } from "@/lib/use-scroll-to-top";
import { formatActivityStamp } from "@/lib/dates";
import { cn } from "@/lib/utils";
import {
  NEARBY_DEFAULT_RADIUS,
  NEARBY_RADIUS_OPTIONS,
  type NearbyOfficeItem,
  type NearbyRadius,
  type OfficeListItem,
  type OfficeRow,
} from "@/lib/offices";
import {
  GEOCODE_DEBOUNCE_MS,
  GEOCODE_MIN_QUERY_LENGTH,
  type GeocodeResult,
} from "@/lib/geocode";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { BottomNav, BOTTOM_NAV_SPACER } from "@/components/bottom-nav";

// ---------------------------------------------------------------------------
// /offices — consolidated Map + List office surface.
//
// Combines what were two pages (/offices = searchable sandbox list,
// /offices/nearby = geo + map) into ONE destination with a top-level
// view toggle. AEs think of "offices" as a single feature, not two
// tools — splitting them across URLs made the workflow feel
// fragmented (one extra tap to get from list → map, and a redundant
// "I'm Here" tap after that).
//
// Layout, top → bottom:
//   1. Header (Back + Test pill)
//   2. Sandbox banner
//   3. Title "Offices"
//   4. View toggle [📍 Map | List] — defaults to Map
//   5a. (Map) — auto-locate on entry, radius pills, the Leaflet map
//        with branded pins; pin popups carry Directions / Log Visit /
//        Open.
//   5b. (List) — search input, full sandbox list sorted visited-first.
//   6. BottomNav (kept visible so the office workflow doesn't feel
//      like a separate mini-app)
//
// AUTO-LOCATE
//   The Map view requests the user's location automatically on mount
//   when the location state is "idle." No "I'm Here" tap needed for
//   the common case (AE opens the app, taps Offices, expects to see
//   the map populate). The button is preserved as "Refresh Location"
//   so the user can re-fetch their fix (or retry after a permission
//   denial / unavailability).
//
// ACCESS
//   Same gate as the prior pages — `is_test === true` salesperson +
//   not juice_box_only. Server routes (`/api/offices`,
//   `/api/offices/nearby`, `/api/offices/[id]`) enforce the same
//   contract independently.
//
// /offices/nearby
//   Deprecated URL. A small redirect page at /offices/nearby/page.tsx
//   bounces deep links to /offices so the unified surface is
//   reachable from anywhere the old URL used to land.
// ---------------------------------------------------------------------------

// Leaflet touches `window` at module load — load the map component
// lazily AND with SSR disabled. The placeholder height matches the
// real map wrapper's `h-[calc(100dvh-23rem)] min-h-[300px]` so the
// layout doesn't jump when the chunk arrives. The dvh-based height
// keeps the map above the translucent BottomNav so map tiles never
// bleed through the nav's backdrop — see nearby-offices-map.tsx
// for the math.
const NearbyOfficesMap = dynamic(
  () => import("@/components/nearby-offices-map"),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[calc(100dvh-23rem)] min-h-[300px] items-center justify-center rounded-lg border border-border bg-muted/20">
        <p className="text-sm text-muted-foreground">Loading map…</p>
      </div>
    ),
  },
);

type ViewMode = "map" | "list";

// ---- Map data --------------------------------------------------------------

type NearbyResponse = {
  nearby: NearbyOfficeItem[];
  total_in_range: number;
  truncated: boolean;
  radius_miles: NearbyRadius;
  searched_at: { lat: number; lng: number };
};
type VisitResponse = {
  visit: { id: string; office_id: string; visited_at: string };
};
type ApiErrorShape = { error?: string };

/**
 * Geolocation state machine.
 *   * idle        — pre-request (briefly visible before auto-locate fires).
 *   * asking      — geolocation request in flight; show "Locating…".
 *   * unsupported — browser has no geolocation API.
 *   * denied      — user blocked location; show how-to-enable hint.
 *   * unavailable — geo errored (timeout / position unavailable / OS off).
 *   * ready       — fix in hand; we have lat/lng.
 */
type LocationState =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "unsupported" }
  | { kind: "denied" }
  | { kind: "unavailable"; reason: string }
  | { kind: "ready"; lat: number; lng: number; takenAt: number };

type MapFetchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | {
      kind: "ready";
      results: NearbyOfficeItem[];
      totalInRange: number;
      truncated: boolean;
      radius: NearbyRadius;
    };

// ---- List data -------------------------------------------------------------

type ListResponse = {
  offices: OfficeListItem[];
  total_matched: number;
  truncated: boolean;
};
type ListState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | {
      kind: "ready";
      items: OfficeListItem[];
      totalMatched: number;
      truncated: boolean;
    };

const SEARCH_DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCityState(item: OfficeListItem | NearbyOfficeItem): string {
  const cityState = [item.city, item.state].filter(Boolean).join(", ");
  const parts = [cityState, item.zip].filter((s) => s && s.length > 0);
  return parts.join(" ");
}

/**
 * Plain-language status line for a successful location fix.
 *
 * Replaces the prior "(Got fix Today 2:38pm)" technical-sounding
 * sub-line with the spec's preferred copy:
 *   * < 60 s old → "Using your location. Updated just now."
 *   * older      → "Using your location from 2:38 PM."
 *
 * Uses `toLocaleTimeString` with `hour: "numeric", minute: "2-digit"`
 * to produce the user's locale-appropriate 12-hour clock on most
 * devices ("2:38 PM" in en-US) while still rendering correctly for
 * 24-hour locales.
 *
 * Note: the message is computed at render time and doesn't auto-tick
 * — a fix that was "just now" 5 minutes ago will still read that way
 * until the next state change. Accepted MVP behavior: the user can
 * tap "Refresh Location" to get a fresh fix + fresh copy.
 */
function formatLocationStatus(takenAt: number): string {
  const ageMs = Date.now() - takenAt;
  if (ageMs < 60_000) return "Using your location. Updated just now.";
  const time = new Date(takenAt).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `Using your location from ${time}.`;
}

/** YYYY-MM-DD → "Jun 5, 2026" — local-TZ safe. */
function formatDueDate(value: string | null): string | null {
  if (!value) return null;
  const [yStr, mStr, dStr] = value.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OfficesPage() {
  const router = useRouter();
  const { salesperson, loaded: sessionLoaded } = useSalesperson();
  const { loaded: permsLoaded } = useLivePermissions();
  useScrollToTop();

  // ---- Access gate ------------------------------------------------------
  const accessReady = sessionLoaded && permsLoaded;
  const canView =
    !!salesperson &&
    salesperson.role !== "juice_box_only" &&
    salesperson.is_test === true;

  useEffect(() => {
    if (!accessReady) return;
    if (!salesperson) {
      router.replace("/");
      return;
    }
    if (salesperson.role === "juice_box_only") {
      router.replace("/juice-box");
      return;
    }
    if (!canView) {
      router.replace("/dashboard");
    }
  }, [accessReady, salesperson, canView, router]);

  // ---- View mode (Map default, per product direction) ----------------------
  const [viewMode, setViewMode] = useState<ViewMode>("map");

  // ---- Add Office modal state ---------------------------------------------
  // Opens the modal sheet from the header "Add Office" button. The
  // modal owns its own form state; the page only tracks open/close
  // and provides the "fresh office created" callback that refetches
  // the List view (so the new row shows up immediately even if the
  // user is currently on Map).
  const [addOfficeOpen, setAddOfficeOpen] = useState(false);
  const [listRefreshKey, setListRefreshKey] = useState(0);
  const handleOfficeCreated = useCallback((office: OfficeRow) => {
    // Bump the refresh key so the List view's data effect re-runs
    // (it's keyed on this value). The user navigates away to the
    // detail page below, so this refetch is for the next time they
    // return — when they back out, the catalog already has the new
    // row visible without an extra load.
    setListRefreshKey((n) => n + 1);
    // Pre-select List as the active view for the eventual return to
    // /offices. Map view is the default; landing back on Map after
    // adding a coords-less office would hide it, which is confusing.
    // Switching to List ahead of the navigation means a Back tap
    // lands the AE on the surface where their new office actually
    // appears.
    setViewMode("list");
    setAddOfficeOpen(false);
    // Product decision: navigate straight to the new office's detail
    // page so the AE can immediately log a visit, set a next action,
    // or edit notes. The modal copy tells the user this is what
    // happens AND that the new office is also already in their
    // List, so the redirect feels intentional rather than surprising.
    router.push(`/offices/${office.id}`);
  }, [router]);

  // ===========================================================================
  // MAP VIEW state
  // ===========================================================================
  const [radius, setRadius] = useState<NearbyRadius>(NEARBY_DEFAULT_RADIUS);
  const [location, setLocation] = useState<LocationState>({ kind: "idle" });
  const [mapFetchState, setMapFetchState] = useState<MapFetchState>({
    kind: "idle",
  });

  const requestLocation = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setLocation({ kind: "unsupported" });
      return;
    }
    setLocation({ kind: "asking" });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation({
          kind: "ready",
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          takenAt: Date.now(),
        });
      },
      (err) => {
        if (err.code === 1) {
          setLocation({ kind: "denied" });
        } else if (err.code === 2 || err.code === 3) {
          setLocation({
            kind: "unavailable",
            reason:
              err.code === 3
                ? "Location request timed out."
                : "Your location is currently unavailable.",
          });
        } else {
          setLocation({
            kind: "unavailable",
            reason: "Couldn't get your location.",
          });
        }
      },
      { enableHighAccuracy: false, maximumAge: 60_000, timeout: 10_000 },
    );
  }, []);

  // Auto-locate when entering the Map view with no fix yet. Trigger
  // also fires on first mount (Map is the default view) and on a
  // List → Map toggle if the user has never granted location.
  // Errors / denials / unsupported all preserve their state and
  // surface the "Refresh Location" button so the user can retry
  // without leaving the page.
  useEffect(() => {
    if (!accessReady || !canView) return;
    if (viewMode !== "map") return;
    if (location.kind !== "idle") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    requestLocation();
  }, [accessReady, canView, viewMode, location.kind, requestLocation]);

  const fetchNearby = useCallback(
    async (lat: number, lng: number, r: NearbyRadius): Promise<void> => {
      setMapFetchState({ kind: "loading" });
      try {
        const res = await apiFetch(
          `/api/offices/nearby?lat=${lat}&lng=${lng}&radius=${r}`,
        );
        const data = (await res.json().catch(() => null)) as
          | (NearbyResponse & ApiErrorShape)
          | null;
        if (!res.ok || !data?.nearby) {
          setMapFetchState({
            kind: "error",
            error: data?.error ?? `Could not load nearby offices (${res.status}).`,
          });
          return;
        }
        setMapFetchState({
          kind: "ready",
          results: data.nearby,
          totalInRange: data.total_in_range,
          truncated: data.truncated,
          radius: data.radius_miles,
        });
      } catch {
        setMapFetchState({
          kind: "error",
          error: "Network error while loading nearby offices.",
        });
      }
    },
    [],
  );

  // Re-fetch when location or radius changes (while on Map view).
  useEffect(() => {
    if (viewMode !== "map") return;
    if (location.kind !== "ready") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchNearby(location.lat, location.lng, radius);
  }, [viewMode, location, radius, fetchNearby]);

  // ---- Per-card Log Visit state (shared with map popups) ----------------
  const [loggingId, setLoggingId] = useState<string | null>(null);
  const [logErrorById, setLogErrorById] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [logNoticeById, setLogNoticeById] = useState<Map<string, string>>(
    () => new Map(),
  );
  const noticeTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  useEffect(() => {
    const timers = noticeTimersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const handleLogVisit = useCallback(
    async (officeId: string) => {
      if (loggingId) return;
      setLoggingId(officeId);
      setLogErrorById((m) => {
        const next = new Map(m);
        next.delete(officeId);
        return next;
      });
      try {
        const res = await apiFetch(`/api/offices/${officeId}/visits`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Empty body → server defaults visited_at to NOW() + note to NULL.
          body: JSON.stringify({}),
        });
        const data = (await res.json().catch(() => null)) as
          | (VisitResponse & ApiErrorShape)
          | null;
        if (!res.ok || !data?.visit) {
          setLogErrorById((m) => {
            const next = new Map(m);
            next.set(
              officeId,
              data?.error ?? `Could not log visit (${res.status}).`,
            );
            return next;
          });
          return;
        }
        const visitedAt = data.visit.visited_at;
        // Update the in-memory Map view result so the pin popup
        // shows the fresh "Last visit" immediately. We deliberately
        // do NOT re-sort the nearby array — the user's mental model
        // is "what's around me," not "what I haven't seen recently."
        setMapFetchState((current) => {
          if (current.kind !== "ready") return current;
          return {
            ...current,
            results: current.results.map((r) =>
              r.id === officeId ? { ...r, last_visit_at: visitedAt } : r,
            ),
          };
        });
        setLogNoticeById((m) => {
          const next = new Map(m);
          next.set(officeId, "Visit logged.");
          return next;
        });
        const prevTimer = noticeTimersRef.current.get(officeId);
        if (prevTimer) clearTimeout(prevTimer);
        const t = setTimeout(() => {
          setLogNoticeById((m) => {
            const next = new Map(m);
            next.delete(officeId);
            return next;
          });
          noticeTimersRef.current.delete(officeId);
        }, 2500);
        noticeTimersRef.current.set(officeId, t);
      } catch {
        setLogErrorById((m) => {
          const next = new Map(m);
          next.set(officeId, "Network error while logging this visit.");
          return next;
        });
      } finally {
        setLoggingId(null);
      }
    },
    [loggingId],
  );

  // ===========================================================================
  // LIST VIEW state
  // ===========================================================================
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [listState, setListState] = useState<ListState>({ kind: "idle" });

  // Debounce the search term.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  // Lazily fetch list data only when needed. Triggers:
  //   * The user has the List view open AND it hasn't loaded yet.
  //   * The debounced search term changes while List is open.
  //   * A new office was created (Add Office modal bumped
  //     `listRefreshKey`) — refetch so the new row appears.
  //
  // Skipping the fetch while on Map view keeps the page lean — no
  // need to pull the full sandbox until the user actually asks for
  // it. `cancelled` guards against a stale response landing after
  // the user types fast.
  useEffect(() => {
    if (!accessReady || !canView) return;
    if (viewMode !== "list") return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setListState({ kind: "loading" });
    const url = debouncedQuery
      ? `/api/offices?q=${encodeURIComponent(debouncedQuery)}`
      : "/api/offices";
    void apiFetch(url)
      .then(async (res) => {
        if (cancelled) return;
        const data = (await res.json().catch(() => null)) as
          | (ListResponse & ApiErrorShape)
          | null;
        if (!res.ok || !data?.offices) {
          setListState({
            kind: "error",
            error: data?.error ?? `Could not load offices (${res.status}).`,
          });
          return;
        }
        setListState({
          kind: "ready",
          items: data.offices,
          totalMatched: data.total_matched ?? data.offices.length,
          truncated: data.truncated === true,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setListState({
          kind: "error",
          error: "Network error while loading offices.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [accessReady, canView, viewMode, debouncedQuery, listRefreshKey]);

  const listCountLabel = useMemo(() => {
    if (listState.kind !== "ready") return null;
    if (listState.totalMatched === 0) return null;
    if (listState.totalMatched <= listState.items.length) {
      return `${listState.items.length} office${
        listState.items.length === 1 ? "" : "s"
      }`;
    }
    return `Showing ${listState.items.length} of ${listState.totalMatched}${
      listState.truncated ? "+" : ""
    }`;
  }, [listState]);

  // ---- Render guards ----------------------------------------------------
  if (!accessReady || !salesperson || !canView) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  return (
    <>
      <main
        className={`pwa-safe-top mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-3 p-4 ${BOTTOM_NAV_SPACER}`}
      >
        {/* Header — Back + Test pill (consistent with other office surfaces). */}
        <header className="flex flex-wrap items-center justify-between gap-2">
          <Link
            href="/dashboard"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            Back
          </Link>
          <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 ring-1 ring-inset ring-amber-500/25 dark:text-amber-400">
            Test
          </span>
        </header>

        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
              Offices
            </h1>
            <p className="text-xs text-muted-foreground">
              Sandbox office surface — visible only to the test account.
            </p>
          </div>
          {/* Add Office — view-mode-agnostic action that opens the
              manual-add modal. Surfacing it in the header keeps it
              one tap away from both Map and List without competing
              with view-specific controls (radius pills, search). */}
          <Button
            type="button"
            size="sm"
            onClick={() => setAddOfficeOpen(true)}
          >
            <Plus aria-hidden="true" className="size-4" />
            Add Office
          </Button>
        </div>

        {/* Sandbox banner. */}
        <div
          role="note"
          className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <p className="leading-snug">
            Map uses your device location to find offices in your sandbox.
            Your location stays on your device — only lat/lng + radius
            are sent to the server.
          </p>
        </div>

        {/* View toggle — single source of truth for the unified office
            experience. Map default per product direction (AEs think
            geographically). List remains a peer for deep scanning +
            search across the full sandbox. */}
        <div
          role="radiogroup"
          aria-label="View"
          className="inline-flex w-fit rounded-full border border-border bg-muted/30 p-0.5"
        >
          {(
            [
              { value: "map", label: "Map", Icon: MapIcon },
              { value: "list", label: "List", Icon: ListIcon },
            ] as const
          ).map(({ value, label, Icon }) => {
            const active = viewMode === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setViewMode(value)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon aria-hidden="true" className="size-3.5" />
                {label}
              </button>
            );
          })}
        </div>

        {viewMode === "map" ? (
          <MapViewSection
            radius={radius}
            setRadius={setRadius}
            location={location}
            mapFetchState={mapFetchState}
            onRequestLocation={requestLocation}
            loggingId={loggingId}
            logErrorById={logErrorById}
            logNoticeById={logNoticeById}
            onLogVisit={handleLogVisit}
          />
        ) : (
          <ListViewSection
            query={query}
            setQuery={setQuery}
            debouncedQuery={debouncedQuery}
            listState={listState}
            countLabel={listCountLabel}
          />
        )}
      </main>
      <BottomNav salesperson={salesperson} />
      {addOfficeOpen && (
        <AddOfficeModal
          onCreated={handleOfficeCreated}
          onClose={() => setAddOfficeOpen(false)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// MapViewSection — radius + location + map
// ---------------------------------------------------------------------------
function MapViewSection({
  radius,
  setRadius,
  location,
  mapFetchState,
  onRequestLocation,
  loggingId,
  logErrorById,
  logNoticeById,
  onLogVisit,
}: {
  radius: NearbyRadius;
  setRadius: (r: NearbyRadius) => void;
  location: LocationState;
  mapFetchState: MapFetchState;
  onRequestLocation: () => void;
  loggingId: string | null;
  logErrorById: Map<string, string>;
  logNoticeById: Map<string, string>;
  onLogVisit: (officeId: string) => void;
}) {
  return (
    <>
      {/* Radius pills — closed set, server enforces the same list. */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Radius
        </span>
        <div
          role="radiogroup"
          aria-label="Search radius in miles"
          className="inline-flex rounded-full border border-border bg-muted/30 p-0.5"
        >
          {NEARBY_RADIUS_OPTIONS.map((opt) => {
            const active = radius === opt;
            return (
              <button
                key={opt}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setRadius(opt)}
                disabled={mapFetchState.kind === "loading"}
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-semibold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {opt} mi
              </button>
            );
          })}
        </div>
      </div>

      {/* Location banner — covers every state of the location machine,
          including the auto-locate path's "Locating…" transition. */}
      <LocationBanner location={location} onRequest={onRequestLocation} />

      {location.kind === "ready" && mapFetchState.kind === "loading" && (
        <p className="px-1 text-sm text-muted-foreground">
          Looking for offices within {radius} miles…
        </p>
      )}

      {location.kind === "ready" && mapFetchState.kind === "error" && (
        <Card>
          <CardContent>
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {mapFetchState.error}
            </p>
          </CardContent>
        </Card>
      )}

      {location.kind === "ready" &&
        mapFetchState.kind === "ready" &&
        mapFetchState.results.length === 0 && (
          <Card>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                No offices within {mapFetchState.radius} miles. Try a wider
                radius, switch to the List view, or import more offices
                from /office-imports. Offices without coordinates
                aren&apos;t included on the map.
              </p>
            </CardContent>
          </Card>
        )}

      {location.kind === "ready" &&
        mapFetchState.kind === "ready" &&
        mapFetchState.results.length > 0 && (
          <>
            <p className="px-0.5 text-xs text-muted-foreground">
              {mapFetchState.results.length === 1
                ? "1 office nearby"
                : `${mapFetchState.results.length} offices nearby`}
              {mapFetchState.truncated && (
                <span className="text-amber-700 dark:text-amber-400">
                  {" "}
                  · showing closest {mapFetchState.results.length} of{" "}
                  {mapFetchState.totalInRange}
                </span>
              )}
            </p>
            <NearbyOfficesMap
              center={{ lat: location.lat, lng: location.lng }}
              items={mapFetchState.results}
              radius={mapFetchState.radius}
              loggingId={loggingId}
              logNoticeById={logNoticeById}
              logErrorById={logErrorById}
              isLogDisabled={(officeId) =>
                loggingId !== null && loggingId !== officeId
              }
              onLogVisit={onLogVisit}
            />
          </>
        )}
    </>
  );
}

// ---------------------------------------------------------------------------
// LocationBanner — owns every UI branch of the LocationState union.
// ---------------------------------------------------------------------------
//
// Behavior per spec:
//   * No "I'm Here" CTA — auto-locate handles the idle case.
//   * "Refresh Location" button is the single CTA, visible when
//     location is `ready`, `denied`, or `unavailable` (not `idle`
//     because auto-locate is firing, not `asking` because a request
//     is already in flight, not `unsupported` because no button can
//     fix that case).
//
function LocationBanner({
  location,
  onRequest,
}: {
  location: LocationState;
  onRequest: () => void;
}) {
  if (location.kind === "idle" || location.kind === "asking") {
    return (
      <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
        Locating you…
      </p>
    );
  }

  if (location.kind === "unsupported") {
    return (
      <div
        role="alert"
        className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
      >
        Your browser doesn&apos;t support location. Open this page in
        Safari or Chrome on your phone.
      </div>
    );
  }

  if (location.kind === "denied") {
    return (
      <div
        role="alert"
        className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
      >
        <p className="font-medium">Location permission denied.</p>
        <p className="mt-1 text-xs">
          Enable it in your browser settings (Safari → Settings →
          Location, or the location icon in your address bar on
          desktop) and tap Refresh Location.
        </p>
        <div className="mt-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onRequest}
          >
            <Locate aria-hidden="true" className="size-4" />
            Refresh Location
          </Button>
        </div>
      </div>
    );
  }

  if (location.kind === "unavailable") {
    return (
      <div
        role="alert"
        className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300"
      >
        <p className="font-medium">{location.reason}</p>
        <p className="mt-1 text-xs">
          Make sure location is on at the OS level, then tap Refresh
          Location.
        </p>
        <div className="mt-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onRequest}
          >
            <Locate aria-hidden="true" className="size-4" />
            Refresh Location
          </Button>
        </div>
      </div>
    );
  }

  // location.kind === "ready"
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">
      <span className="text-muted-foreground">
        {formatLocationStatus(location.takenAt)}
      </span>
      <Button type="button" size="sm" variant="outline" onClick={onRequest}>
        <Locate aria-hidden="true" className="size-3.5" />
        Refresh Location
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ListViewSection — searchable full-sandbox list
// ---------------------------------------------------------------------------
//
// Mirrors the prior /offices behavior verbatim — same search input,
// same /api/offices payload, same card layout, same destination
// (/offices/[id]). No log visit / directions on the cards: those are
// reachable via the office detail page, and surfacing them on every
// list row was over-busy in earlier reviews.
//
function ListViewSection({
  query,
  setQuery,
  debouncedQuery,
  listState,
  countLabel,
}: {
  query: string;
  setQuery: (q: string) => void;
  debouncedQuery: string;
  listState: ListState;
  countLabel: string | null;
}) {
  return (
    <>
      {/* Search box — name / city / zip. */}
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, city, or zip"
          aria-label="Search offices"
          className="h-10 pl-8 pr-9"
          inputMode="search"
          autoComplete="off"
          enterKeyHint="search"
        />
        {query.length > 0 && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        )}
      </div>

      {countLabel && listState.kind === "ready" && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{countLabel}</span>
          {listState.truncated && (
            <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
              <AlertTriangle aria-hidden="true" className="size-3" />
              Refine your search to see more
            </span>
          )}
        </div>
      )}

      {(listState.kind === "loading" || listState.kind === "idle") && (
        <p className="px-1 text-sm text-muted-foreground">Loading offices…</p>
      )}

      {listState.kind === "error" && (
        <Card>
          <CardContent>
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {listState.error}
            </p>
          </CardContent>
        </Card>
      )}

      {listState.kind === "ready" && listState.items.length === 0 && (
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {debouncedQuery.length > 0
                ? `No offices match "${debouncedQuery}". Try a different search.`
                : "No offices in your sandbox yet. Import some via Office Imports."}
            </p>
          </CardContent>
        </Card>
      )}

      {listState.kind === "ready" && listState.items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {listState.items.map((item) => {
            const cityState = formatCityState(item);
            return (
              <li key={item.id}>
                <Link
                  href={`/offices/${item.id}`}
                  className="group block rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10 transition-colors hover:bg-muted/50"
                >
                  <div className="flex items-start gap-3 p-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p className="truncate text-base font-semibold leading-snug">
                          {item.name}
                        </p>
                        <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground tabular-nums">
                          {item.visit_count === 0
                            ? "Never visited"
                            : `${item.visit_count} visit${item.visit_count === 1 ? "" : "s"}`}
                        </span>
                      </div>

                      {(item.street || cityState) && (
                        <div className="flex items-start gap-1 text-xs text-muted-foreground">
                          <MapPin
                            aria-hidden="true"
                            className="mt-0.5 size-3 shrink-0"
                          />
                          <div className="min-w-0">
                            {item.street && (
                              <p className="truncate">{item.street}</p>
                            )}
                            {cityState && (
                              <p className="truncate">{cityState}</p>
                            )}
                          </div>
                        </div>
                      )}

                      <div className="space-y-0.5">
                        {item.last_visit_at && (
                          <p className="text-[11px] text-muted-foreground">
                            Last visit{" "}
                            <span className="font-medium text-foreground/80">
                              {formatActivityStamp(item.last_visit_at)}
                            </span>
                          </p>
                        )}
                        {item.next_action && (
                          <p className="line-clamp-2 text-xs">
                            <span className="font-medium text-foreground/80">
                              Next:
                            </span>{" "}
                            {item.next_action}
                            {(() => {
                              const due = formatDueDate(
                                item.next_action_due_date,
                              );
                              return due ? (
                                <span className="text-muted-foreground">
                                  {" "}
                                  · due {due}
                                </span>
                              ) : null;
                            })()}
                          </p>
                        )}
                      </div>
                    </div>

                    <ChevronRight
                      aria-hidden="true"
                      className="mt-1 size-4 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground"
                    />
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// AddOfficeModal — manual-add form
// ---------------------------------------------------------------------------
//
// Mobile-first bottom sheet (centers on sm+) for the AE Add Office
// flow. Required: name + address. Optional: phone, email, notes,
// next action. No geocoding — the office appears in List
// immediately but is excluded from the Map until coordinates exist;
// the modal calls that out so the AE isn't surprised.
//
// Backdrop click or the X closes the modal (matching the juice-box
// modal pattern). Escape also closes. The form is intentionally
// straightforward — title + textarea / inputs + Save / Cancel; no
// multi-step wizard, no client-side geocoding, no contact CRM.
// ---------------------------------------------------------------------------
function AddOfficeModal({
  onCreated,
  onClose,
}: {
  onCreated: (office: OfficeRow) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  // Populated when the AE picks a geocoded suggestion from the
  // address autocomplete. Cleared on any manual edit to the address
  // field — typed text no longer matches the picked location, so
  // shipping its coords would be wrong.
  const [picked, setPicked] = useState<GeocodeResult | null>(null);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Microtask defer so iOS reliably opens the keyboard on first
    // paint (mirrors the juice-box ReplyModal pattern).
    const id = window.setTimeout(() => nameRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [saving, onClose]);

  const trimmedName = name.trim();
  const trimmedAddress = address.trim();
  const canSubmit =
    trimmedName.length > 0 && trimmedAddress.length > 0 && !saving;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      // Build the request body. Required fields go through their
      // trimmed values. Optional text fields are only added when
      // the user filled them in (empty strings would normalize to
      // NULL server-side but explicitly omitting reads cleaner in
      // network logs).
      //
      // When a geocoded suggestion was picked, the structured
      // address components + lat/lng come from the result. The
      // user's address text is still authoritative for `street`
      // (it's what they SAW + chose to save). City/state/zip and
      // coords come from the upstream geocode for the rest of the
      // structured columns — those are the parts that make the
      // office map-eligible immediately.
      type CreatePayload = {
        name: string;
        street: string;
        city?: string;
        state?: string;
        zip?: string;
        latitude?: number;
        longitude?: number;
        office_phone?: string;
        office_email?: string;
        office_notes?: string;
        next_action?: string;
      };
      const body: CreatePayload = {
        name: trimmedName,
        street: trimmedAddress,
      };
      if (picked) {
        if (picked.city) body.city = picked.city;
        if (picked.state) body.state = picked.state;
        if (picked.zip) body.zip = picked.zip;
        body.latitude = picked.latitude;
        body.longitude = picked.longitude;
      }
      if (phone.trim()) body.office_phone = phone.trim();
      if (email.trim()) body.office_email = email.trim();
      if (notes.trim()) body.office_notes = notes.trim();
      if (nextAction.trim()) body.next_action = nextAction.trim();

      const res = await apiFetch("/api/offices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => null)) as
        | { office?: OfficeRow; error?: string }
        | null;
      if (!res.ok || !data?.office) {
        // 409 is the dedupe-collision shape; show the server's
        // friendly text directly. Other failures fall back to the
        // sanitized generic message.
        setError(data?.error ?? `Could not add office (${res.status}).`);
        return;
      }
      onCreated(data.office);
    } catch {
      setError("Network error while adding this office.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-office-title"
      // z-50 sits above the bottom nav (z-40); matches the juice-box
      // modal pattern. viewport-fit=cover puts content above the
      // notch on standalone iPhones via the safe-area envelopes.
      className="fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center"
      style={{
        paddingTop: "calc(0.75rem + env(safe-area-inset-top))",
        paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))",
      }}
    >
      <button
        type="button"
        aria-label="Cancel"
        onClick={() => {
          if (!saving) onClose();
        }}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm focus:outline-none"
      />
      <Card
        size="sm"
        className="relative w-full max-w-md overflow-hidden animate-in fade-in-0 zoom-in-95 duration-150"
      >
        <CardContent className="space-y-3 px-4 py-3">
          <header className="flex items-start justify-between gap-2">
            <h2
              id="add-office-title"
              className="text-base font-semibold"
            >
              Add Office
            </h2>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              aria-label="Close"
              className="-mr-1 -mt-0.5 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </header>
          <p className="text-xs text-muted-foreground">
            Required: name + address. Start typing an address to pick
            a real location — that captures the coordinates so the
            office appears on the Map right away. Manual entry is fine
            too; manual addresses may not appear on the Map until
            coordinates are added. After saving, you&apos;ll open the
            new office detail page; the office will also appear in
            your List right away.
          </p>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1">
              <label
                htmlFor="add-office-name"
                className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                Name <span className="text-destructive">*</span>
              </label>
              <Input
                id="add-office-name"
                ref={nameRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Smith & Co Realty"
                disabled={saving}
                maxLength={200}
                required
              />
            </div>
            <div className="space-y-1">
              <label
                htmlFor="add-office-address"
                className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                Address <span className="text-destructive">*</span>
              </label>
              <AddressAutocomplete
                value={address}
                onChange={(v) => {
                  setAddress(v);
                  // Manual edits invalidate any previously locked
                  // geocode pick — the typed text no longer matches
                  // the original lat/lng, so we drop the coords.
                  // The AE can either re-pick from the suggestions
                  // or proceed with a coords-less manual address.
                  if (picked) setPicked(null);
                }}
                onPick={(result) => {
                  setAddress(result.formatted);
                  setPicked(result);
                }}
                disabled={saving}
                inputId="add-office-address"
                placeholder="e.g. 12 Main St, Orem, UT 84057"
              />
              {picked && (
                <p className="inline-flex items-center gap-1 text-[11px] text-green-600 dark:text-green-400">
                  <CheckCircle2 aria-hidden="true" className="size-3" />
                  Coordinates captured — this office will show on the
                  Map right away.
                </p>
              )}
              {!picked && address.trim().length > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Manual addresses may not appear on the Map until
                  coordinates are added.
                </p>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label
                  htmlFor="add-office-phone"
                  className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
                >
                  Phone (optional)
                </label>
                <Input
                  id="add-office-phone"
                  type="tel"
                  inputMode="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="e.g. (801) 555-1234"
                  disabled={saving}
                  maxLength={64}
                />
              </div>
              <div className="space-y-1">
                <label
                  htmlFor="add-office-email"
                  className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
                >
                  Email (optional)
                </label>
                <Input
                  id="add-office-email"
                  type="email"
                  inputMode="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="e.g. front@office.com"
                  disabled={saving}
                  maxLength={254}
                />
              </div>
            </div>
            <div className="space-y-1">
              <label
                htmlFor="add-office-notes"
                className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                Office notes (optional)
              </label>
              <textarea
                id="add-office-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Broker is Sarah · Office meetings Tuesdays at 10am"
                disabled={saving}
                rows={2}
                className="w-full min-h-[64px] rounded-md border border-input bg-background p-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>
            <div className="space-y-1">
              <label
                htmlFor="add-office-next-action"
                className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                Next action (optional)
              </label>
              <Input
                id="add-office-next-action"
                value={nextAction}
                onChange={(e) => setNextAction(e.target.value)}
                placeholder="e.g. Drop off donuts next Friday"
                disabled={saving}
                maxLength={2000}
              />
            </div>
            {error && (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onClose}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!canSubmit}>
                {saving ? "Adding…" : "Add Office"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AddressAutocomplete — typeahead backed by /api/geocode/search
// ---------------------------------------------------------------------------
//
// Behavior contract:
//   * `value` is the input's current text.
//   * `onChange(v)` fires on every keystroke / paste.
//   * `onPick(result)` fires when the user taps a suggestion.
//     Callers should update `value` to `result.formatted` AND stash
//     the lat/lng + structured address parts from the result.
//   * Manual typing AFTER a pick is the caller's responsibility to
//     handle (clear the stashed coords). This component doesn't
//     track the picked state internally.
//
// Suggestion fetch:
//   * Debounced by GEOCODE_DEBOUNCE_MS (500 ms) to stay under
//     Nominatim's ~1 req/s policy.
//   * Skipped when value < GEOCODE_MIN_QUERY_LENGTH (4 chars).
//   * Cancellable: a fresh keystroke invalidates the in-flight
//     request so a slow first query can't overwrite a faster
//     later one.
//
// Dropdown:
//   * Opens on focus and on every typed change.
//   * Closes on outside-tap (mousedown/touchstart on the document),
//     Escape, or after a suggestion is picked.
//   * Renders "Searching…" while loading, "No matches" when empty,
//     "Couldn't load suggestions." on error.
// ---------------------------------------------------------------------------
function AddressAutocomplete({
  value,
  onChange,
  onPick,
  disabled,
  inputId,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onPick: (result: GeocodeResult) => void;
  disabled?: boolean;
  inputId?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<GeocodeResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [debouncedValue, setDebouncedValue] = useState(value);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Local debounce — runs once whenever `value` changes, then
  // `debouncedValue` updates GEOCODE_DEBOUNCE_MS after the user
  // stops typing.
  useEffect(() => {
    const t = window.setTimeout(
      () => setDebouncedValue(value),
      GEOCODE_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(t);
  }, [value]);

  // Fetch suggestions whenever the debounced value crosses the
  // min-length gate. The `cancelled` flag guards against a slow
  // first request landing on top of a faster later one when the
  // user types fast.
  useEffect(() => {
    const trimmed = debouncedValue.trim();
    if (trimmed.length < GEOCODE_MIN_QUERY_LENGTH) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSuggestions([]);
      setLoading(false);
      setHasError(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setHasError(false);
    void apiFetch(`/api/geocode/search?q=${encodeURIComponent(trimmed)}`)
      .then(async (res) => {
        if (cancelled) return;
        const data = (await res.json().catch(() => null)) as
          | { results?: GeocodeResult[] }
          | null;
        if (!res.ok) {
          setHasError(true);
          setSuggestions([]);
          return;
        }
        setSuggestions(Array.isArray(data?.results) ? data.results : []);
      })
      .catch(() => {
        if (cancelled) return;
        setHasError(true);
        setSuggestions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedValue]);

  // Outside-tap + Escape close the dropdown. Only bound while open
  // so the document listener isn't always active.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent | TouchEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer, { passive: true });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const shouldShowDropdown =
    open &&
    (loading || hasError || suggestions.length > 0 ||
      debouncedValue.trim().length >= GEOCODE_MIN_QUERY_LENGTH);

  return (
    <div ref={wrapRef} className="relative">
      <Input
        id={inputId}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          if (value.trim().length >= GEOCODE_MIN_QUERY_LENGTH) {
            setOpen(true);
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={500}
        required
        autoComplete="off"
        // iOS Safari shows its own autofill bar above the keyboard
        // by default — `off` here lets the AE rely on the dropdown
        // instead of Safari's autofill (which usually doesn't have
        // address suggestions anyway).
      />
      {shouldShowDropdown && (
        <div
          role="listbox"
          aria-label="Address suggestions"
          // Sits inside the modal's z-50 stacking context; no
          // explicit z-index needed beyond the small bump to clear
          // the input's focus ring.
          className="absolute left-0 right-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
        >
          {loading && (
            <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              Searching…
            </p>
          )}
          {!loading && hasError && (
            <p className="px-3 py-2 text-xs text-destructive">
              Couldn&apos;t load suggestions. Try again or enter the
              address manually.
            </p>
          )}
          {!loading && !hasError && suggestions.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              No matches. You can still enter the address manually.
            </p>
          )}
          {!loading &&
            !hasError &&
            suggestions.map((s, i) => (
              <button
                key={`${s.latitude},${s.longitude},${i}`}
                type="button"
                role="option"
                aria-selected="false"
                onClick={() => {
                  onPick(s);
                  setOpen(false);
                }}
                className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
              >
                <MapPin
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1">{s.formatted}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
