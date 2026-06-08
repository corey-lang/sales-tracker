"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  CalendarCheck,
  ChevronRight,
  List as ListIcon,
  Locate,
  Map as MapIcon,
  MapPin,
  Plus,
  Route as RouteIcon,
  Search,
  Spline,
  Users,
  X,
} from "lucide-react";

import { apiFetch } from "@/lib/api-client";
import { useSalesperson } from "@/lib/use-salesperson";
import { useLivePermissions } from "@/lib/use-live-permissions";
import { useScrollToTop } from "@/lib/use-scroll-to-top";
import { formatActivityStamp } from "@/lib/dates";
import { cn } from "@/lib/utils";
import {
  MAX_ROUTE_STOPS,
  NEARBY_DEFAULT_RADIUS,
  NEARBY_RADIUS_OPTIONS,
  OFFICE_VISIT_FILTERS,
  buildOfficeRouteUrl,
  officeMatchesDaysSince,
  officeMatchesVisitFilter,
  type CheckinItem,
  type CheckinRange,
  type CheckinScope,
  type CheckinsResponse,
  type NearbyOfficeItem,
  type NearbyRadius,
  type OfficeListItem,
  type OfficeRow,
  type OfficeVisitFilter,
} from "@/lib/offices";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { BottomNav, BOTTOM_NAV_SPACER } from "@/components/bottom-nav";
import {
  EMPTY_OFFICE_FORM_VALUES,
  OfficeFormModal,
  type OfficeFormPayload,
  type OfficeFormSubmitResult,
} from "@/components/office-form-modal";
import {
  LogVisitModal,
  type LogVisitModalResult,
} from "@/components/log-visit-modal";

// ---------------------------------------------------------------------------
// /offices — consolidated Map + List office surface.
//
// Combines what were two pages (/offices = searchable office list,
// /offices/nearby = geo + map) into ONE destination with a top-level
// view toggle. AEs think of "offices" as a single feature, not two
// tools — splitting them across URLs made the workflow feel
// fragmented (one extra tap to get from list → map, and a redundant
// "I'm Here" tap after that).
//
// Layout, top → bottom:
//   1. Header (Back + Test pill — test account only)
//   2. Sandbox banner — test account only
//   3. Title "Offices"
//   4. View toggle [📍 Map | List] — defaults to Map
//   5a. (Map) — auto-locate on entry, radius pills, the Leaflet map
//        with branded pins; pin popups carry Directions / Log Visit /
//        Open.
//   5b. (List) — search input, full per-AE office list sorted
//        visited-first.
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
//   Every AE passes (real AEs operate in environment="production";
//   the test account operates in environment="test"). juice_box_only
//   is redirected. Server routes (`/api/offices`,
//   `/api/offices/nearby`, `/api/offices/[id]`) enforce ownership
//   (`salesperson_id = me.id`) and per-caller env independently.
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

type ViewMode = "map" | "list" | "checkins";

/** Map visit-recency filter union: the closed presets plus the custom
 *  "days since last check-in" mode that reveals a number input. Kept
 *  local to the page so the shared `OfficeVisitFilter` type stays the
 *  closed preset set the chip list + count helper iterate over. */
type MapVisitFilter = OfficeVisitFilter | "custom";

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
    !!salesperson && salesperson.role !== "juice_box_only";

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
  // Opens the shared OfficeFormModal (mode="add") from the header
  // "Add Office" button. The page collects state, posts, and on
  // success bumps a `listRefreshKey` so the List view's data effect
  // re-runs — the new row appears the next time the user lands on
  // /offices via the Back navigation from the detail page.
  const [addOfficeOpen, setAddOfficeOpen] = useState(false);
  const [listRefreshKey, setListRefreshKey] = useState(0);

  /** Submit handler the OfficeFormModal calls in add mode. POSTs
   *  /api/offices with the form payload, handles dedupe 409s, and
   *  on success navigates to the new office detail page. Returns
   *  `{ ok: true }` so the modal closes; `{ ok: false, error }`
   *  keeps it open with the error shown inline. */
  const handleAddSubmit = useCallback(
    async (data: OfficeFormPayload): Promise<OfficeFormSubmitResult> => {
      type AddPayload = {
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
      const body: AddPayload = {
        name: data.name,
        street: data.address,
      };
      if (data.picked) {
        if (data.picked.city) body.city = data.picked.city;
        if (data.picked.state) body.state = data.picked.state;
        if (data.picked.zip) body.zip = data.picked.zip;
        body.latitude = data.picked.latitude;
        body.longitude = data.picked.longitude;
      }
      if (data.phone) body.office_phone = data.phone;
      if (data.email) body.office_email = data.email;
      if (data.notes) body.office_notes = data.notes;
      if (data.nextAction) body.next_action = data.nextAction;

      try {
        const res = await apiFetch("/api/offices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await res.json().catch(() => null)) as
          | { office?: OfficeRow; error?: string }
          | null;
        if (!res.ok || !json?.office) {
          return {
            ok: false,
            error: json?.error ?? `Could not add office (${res.status}).`,
          };
        }
        // Bump the refresh key so the next List paint includes the
        // new row. Pre-select List for the eventual Back-tap from
        // the detail page — Map would hide a coords-less office.
        setListRefreshKey((n) => n + 1);
        setViewMode("list");
        // Product decision: navigate straight to the new office's
        // detail page so the AE can immediately log a visit or set
        // a next action. The modal copy primes the user for this.
        router.push(`/offices/${json.office.id}`);
        return { ok: true };
      } catch {
        return {
          ok: false,
          error: "Network error while adding this office.",
        };
      }
    },
    [router],
  );

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

  // ---- "Log Visit + Note" modal (Map flow) ------------------------------
  // The map pin's "Log + note" action opens this modal at page level
  // (rendered as a sibling of the map so it isn't trapped inside a
  // Leaflet popup). On success the modal hands back the new visited_at
  // (+ optional next action) and we patch the in-memory map result so
  // the pin reflects the fresh "last visit" / next action immediately.
  const [noteModalOffice, setNoteModalOffice] = useState<{
    id: string;
    name: string;
  } | null>(null);

  /** Sets the auto-clearing "Visit logged." pill on a pin and schedules
   *  its removal. Shared by the quick-log and note-modal paths. */
  const flashLogNotice = useCallback((officeId: string) => {
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
  }, []);

  const handleNoteModalLogged = useCallback(
    (officeId: string, result: LogVisitModalResult) => {
      setMapFetchState((current) => {
        if (current.kind !== "ready") return current;
        return {
          ...current,
          results: current.results.map((r) =>
            r.id === officeId
              ? {
                  ...r,
                  last_visit_at: result.visitedAt,
                  ...(result.nextAction !== undefined
                    ? { next_action: result.nextAction }
                    : {}),
                }
              : r,
          ),
        };
      });
      flashLogNotice(officeId);
    },
    [flashLogNotice],
  );

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
  // need to pull the AE's full office set until the user actually
  // asks for it. `cancelled` guards against a stale response landing
  // after the user types fast.
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
        {/* Header — Back + Test pill (test account only). */}
        <header className="flex flex-wrap items-center justify-between gap-2">
          <Link
            href="/dashboard"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            Back
          </Link>
          {salesperson.is_test === true && (
            <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 ring-1 ring-inset ring-amber-500/25 dark:text-amber-400">
              Test
            </span>
          )}
        </header>

        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
              Offices
            </h1>
            {salesperson.is_test === true && (
              <p className="text-xs text-muted-foreground">
                Sandbox office surface — visible only to the test account.
              </p>
            )}
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

        {/* Sandbox banner — test account only. */}
        {salesperson.is_test === true && (
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
        )}

        {/* View toggle — single source of truth for the unified office
            experience. Map default per product direction (AEs think
            geographically). List remains a peer for deep scanning +
            search across the AE's full office set. */}
        <div
          role="radiogroup"
          aria-label="View"
          className="inline-flex w-fit rounded-full border border-border bg-muted/30 p-0.5"
        >
          {(
            [
              { value: "map", label: "Map", Icon: MapIcon },
              { value: "list", label: "List", Icon: ListIcon },
              { value: "checkins", label: "Check-ins", Icon: CalendarCheck },
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
            onLogVisitWithNote={setNoteModalOffice}
          />
        ) : viewMode === "list" ? (
          <ListViewSection
            query={query}
            setQuery={setQuery}
            debouncedQuery={debouncedQuery}
            listState={listState}
            countLabel={listCountLabel}
          />
        ) : (
          <CheckinsViewSection isAdmin={salesperson.role === "admin"} />
        )}
      </main>
      <BottomNav salesperson={salesperson} />
      {addOfficeOpen && (
        <OfficeFormModal
          mode="add"
          initialValues={EMPTY_OFFICE_FORM_VALUES}
          onSubmit={handleAddSubmit}
          onClose={() => setAddOfficeOpen(false)}
        />
      )}
      {noteModalOffice && (
        <LogVisitModal
          officeId={noteModalOffice.id}
          officeName={noteModalOffice.name}
          onClose={() => setNoteModalOffice(null)}
          onLogged={(result) =>
            handleNoteModalLogged(noteModalOffice.id, result)
          }
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
  onLogVisitWithNote,
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
  onLogVisitWithNote: (office: { id: string; name: string }) => void;
}) {
  // ---- Filter + route-selection state (Lasso Route V1) -------------------
  const [visitFilter, setVisitFilter] = useState<MapVisitFilter>("all");
  // Custom "days since last check-in" threshold. Stored as the raw input
  // string so the field can be briefly empty while typing; parsed to a
  // non-negative integer (or null when blank/invalid) for filtering.
  const [customDaysInput, setCustomDaysInput] = useState("45");
  // Activating the Custom chip focuses (and selects) the day input so the
  // user can type a threshold immediately — making it feel like a primary
  // action rather than a hidden one. On iOS the keyboard may not open
  // without a direct gesture, but the field still reads as activated.
  const customInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (visitFilter !== "custom") return;
    customInputRef.current?.focus();
    customInputRef.current?.select();
  }, [visitFilter]);
  const [lassoActive, setLassoActive] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [routeError, setRouteError] = useState<string | null>(null);

  const results =
    mapFetchState.kind === "ready" ? mapFetchState.results : EMPTY_RESULTS;
  // "now" for the 30/60/90-day windows. Date.now() can't be called during
  // render, so it's synced into state from an effect and refreshed per data
  // load. The default "all" filter ignores it, so the initial 0 never
  // mis-renders.
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNowMs(Date.now());
  }, [results]);
  // Parsed custom threshold: a non-negative integer, or null when the
  // input is blank/invalid (in which case the custom filter shows all
  // rather than hiding everything).
  const customDays = useMemo(() => {
    const trimmed = customDaysInput.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }, [customDaysInput]);
  const filtered = useMemo(
    () =>
      results.filter((o) => {
        if (visitFilter === "custom") {
          if (customDays === null) return true;
          return officeMatchesDaysSince(o.last_visit_at, customDays, nowMs);
        }
        return officeMatchesVisitFilter(o.last_visit_at, visitFilter, nowMs);
      }),
    [results, visitFilter, customDays, nowMs],
  );
  // The selection only ever counts/uses offices that are currently visible,
  // so a hidden (filtered-out) pin can never end up in a route.
  const visibleSelected = useMemo(
    () => filtered.filter((o) => selectedIds.has(o.id)),
    [filtered, selectedIds],
  );

  const changeFilter = useCallback((next: MapVisitFilter) => {
    // Switching filters clears the selection so the lassoed set always
    // matches the active filter's visible pins.
    setVisitFilter(next);
    setSelectedIds(new Set());
    setRouteError(null);
  }, []);
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setRouteError(null);
  }, []);
  const lassoSelect = useCallback((ids: string[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    setRouteError(null);
  }, []);
  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setRouteError(null);
  }, []);
  const createRoute = useCallback(() => {
    // Over the limit is NOT an error: route the FIRST MAX_ROUTE_STOPS offices
    // (in the current selection order). The minimum-2 requirement still
    // surfaces as a friendly error via buildOfficeRouteUrl.
    const stops = visibleSelected.slice(0, MAX_ROUTE_STOPS);
    const res = buildOfficeRouteUrl(
      stops.map((o) => ({ latitude: o.latitude, longitude: o.longitude })),
    );
    if (res.error) {
      setRouteError(res.error);
      return;
    }
    setRouteError(null);
    window.open(res.url, "_blank", "noopener,noreferrer");
  }, [visibleSelected]);

  const hasResults =
    location.kind === "ready" &&
    mapFetchState.kind === "ready" &&
    results.length > 0;

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

      {/* Visit-recency filter chips — operate on the AE's own mapped
          offices. Custom is promoted to the second slot (right after All)
          and reveals a connected inline day input when active, so
          stale-office filtering reads as a primary workflow rather than a
          hidden advanced option. */}
      {hasResults && (
        <div className="space-y-1.5">
          <div
            role="radiogroup"
            aria-label="Visit filter"
            className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-0.5"
          >
            {OFFICE_VISIT_FILTERS.map((f, i) => {
              const active = visitFilter === f.key;
              const customActive = visitFilter === "custom";
              return (
                <Fragment key={f.key}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => changeFilter(f.key)}
                    className={cn(
                      "shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                      active
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {f.label}
                  </button>
                  {/* Inject Custom (and its inline input) right after "All"
                      so it sits near the start of the row on mobile. */}
                  {i === 0 && (
                    <>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={customActive}
                        onClick={() => changeFilter("custom")}
                        className={cn(
                          "shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                          customActive
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground hover:text-foreground",
                        )}
                      >
                        Custom
                      </button>
                      {customActive && (
                        // Connected day input — primary-tinted pill ties it
                        // to the active Custom chip. shrink-0 keeps it on the
                        // same scrollable row, adjacent to Custom.
                        <div className="flex shrink-0 items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 py-1 pl-2 pr-2.5 text-xs font-medium text-foreground dark:bg-primary/15">
                          <input
                            ref={customInputRef}
                            id="custom-days"
                            type="number"
                            inputMode="numeric"
                            min={0}
                            value={customDaysInput}
                            onChange={(e) => setCustomDaysInput(e.target.value)}
                            aria-label="Days since last check-in"
                            // text-base on mobile (≥16px) prevents iOS Safari
                            // tap-to-zoom; md:text-sm keeps the desktop sizing.
                            className="h-8 w-12 rounded-md border border-input bg-background px-1.5 text-center text-base tabular-nums shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 md:text-sm"
                          />
                          <span className="text-muted-foreground">days</span>
                        </div>
                      )}
                    </>
                  )}
                </Fragment>
              );
            })}
          </div>

          {/* Compact hint under the row — guides input when blank and spells
              out the "includes never-visited" nuance the chips can't. */}
          {visitFilter === "custom" && (
            <p className="px-1 text-[11px] text-muted-foreground">
              {customDays === null
                ? "Enter a number of days to find stale offices."
                : `Not visited in ${customDays}+ days · includes never-visited.`}
            </p>
          )}
        </div>
      )}

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

      {hasResults && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
            <p className="text-xs text-muted-foreground">
              {filterCountLabel(filtered.length, visitFilter, customDays)}
              {mapFetchState.kind === "ready" && mapFetchState.truncated && (
                <span className="text-amber-700 dark:text-amber-400">
                  {" "}
                  · closest {results.length} of {mapFetchState.totalInRange}
                </span>
              )}
            </p>
            <button
              type="button"
              onClick={() => setLassoActive((v) => !v)}
              aria-pressed={lassoActive}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-colors",
                lassoActive
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              <Spline aria-hidden="true" className="size-3.5" />
              {lassoActive ? "Done" : "Lasso"}
            </button>
          </div>

          {lassoActive && (
            <p className="px-0.5 text-xs text-primary">
              Draw around offices to select them.
            </p>
          )}

          {filtered.length === 0 ? (
            <Card>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  No offices match this filter in range. Try “All” or a wider
                  radius.
                </p>
              </CardContent>
            </Card>
          ) : (
            <NearbyOfficesMap
              center={{ lat: location.lat, lng: location.lng }}
              items={filtered}
              radius={mapFetchState.kind === "ready" ? mapFetchState.radius : radius}
              loggingId={loggingId}
              logNoticeById={logNoticeById}
              logErrorById={logErrorById}
              isLogDisabled={(officeId) =>
                loggingId !== null && loggingId !== officeId
              }
              onLogVisit={onLogVisit}
              onLogVisitWithNote={onLogVisitWithNote}
              lassoActive={lassoActive}
              selectedIds={selectedIds}
              onLassoSelect={lassoSelect}
              onToggleSelect={toggleSelect}
            />
          )}
        </>
      )}

      {/* Selection sheet — floats above the bottom nav once offices are
          chosen, so Create Route is reachable right after drawing. */}
      {visibleSelected.length > 0 && (
        <div className="fixed inset-x-0 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-30 px-4">
          <div className="mx-auto max-w-2xl">
            <Card className="border-primary/30 shadow-lg">
              <CardContent className="space-y-3 py-3">
                {/* 1. Header */}
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold">
                    {visibleSelected.length}{" "}
                    {visibleSelected.length === 1 ? "office" : "offices"}{" "}
                    selected
                  </p>
                  <button
                    type="button"
                    onClick={clearSelection}
                    className="text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    Clear selection
                  </button>
                </div>

                {/* 2. Route Limit — reads like a notification, not body text. */}
                {visibleSelected.length > MAX_ROUTE_STOPS && (
                  <div
                    role="alert"
                    className="flex gap-2.5 rounded-lg border border-amber-500/50 bg-amber-50 px-3 py-2.5 dark:border-amber-500/30 dark:bg-amber-950/30"
                  >
                    <AlertTriangle
                      aria-hidden="true"
                      className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
                    />
                    <div className="space-y-0.5">
                      <p className="text-sm font-bold text-amber-900 dark:text-amber-200">
                        Route Limit
                      </p>
                      <p className="text-xs text-amber-800 dark:text-amber-200/80">
                        Google Maps supports up to {MAX_ROUTE_STOPS} stops per
                        route.
                      </p>
                      <p className="text-xs text-amber-800 dark:text-amber-200/80">
                        We&apos;ll create a route using the first{" "}
                        {MAX_ROUTE_STOPS} offices.
                      </p>
                      <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
                        {visibleSelected.length - MAX_ROUTE_STOPS}{" "}
                        {visibleSelected.length - MAX_ROUTE_STOPS === 1
                          ? "office"
                          : "offices"}{" "}
                        will be left out of this route.
                      </p>
                    </div>
                  </div>
                )}

                {/* 3. Selected Offices label + scroll discovery */}
                <div className="space-y-0.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Selected Offices
                  </p>
                  {visibleSelected.length > SCROLL_HINT_THRESHOLD && (
                    <p className="text-[11px] text-muted-foreground">
                      Scroll to review all {visibleSelected.length} offices
                    </p>
                  )}
                </div>

                {/* 4. Scrollable list with a subtle bottom fade hinting at
                    more content below. */}
                <div className="relative">
                  <ul className="max-h-28 space-y-1 overflow-y-auto pr-0.5">
                    {visibleSelected.map((o) => (
                      <li
                        key={o.id}
                        className="flex items-center justify-between gap-2 text-sm"
                      >
                        <span className="min-w-0 truncate">{o.name}</span>
                        <button
                          type="button"
                          aria-label={`Remove ${o.name}`}
                          onClick={() => toggleSelect(o.id)}
                          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
                        >
                          <X aria-hidden="true" className="size-4" />
                        </button>
                      </li>
                    ))}
                  </ul>
                  {visibleSelected.length > SCROLL_HINT_THRESHOLD && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-card to-transparent" />
                  )}
                </div>

                {/* 5. Min-2 / route error */}
                {routeError && (
                  <p role="alert" className="text-xs text-destructive">
                    {routeError}
                  </p>
                )}

                {/* 6. Action */}
                <Button
                  type="button"
                  size="sm"
                  className="w-full"
                  onClick={createRoute}
                >
                  <RouteIcon aria-hidden="true" className="size-4" />
                  Create route
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}

/** Stable empty array so `results` keeps a constant identity while the map
 *  is loading — avoids re-running the visit filter every render. */
const EMPTY_RESULTS: NearbyOfficeItem[] = [];

/** Above this many selected offices the list (max-h-28 ≈ 5 rows) scrolls, so
 *  we show the "scroll to review" hint + bottom fade. */
const SCROLL_HINT_THRESHOLD = 5;

/** "42 offices" / "18 not visited in 60 days" / "6 never visited" /
 *  "9 not visited in 14 days" (custom). */
function filterCountLabel(
  count: number,
  filter: MapVisitFilter,
  customDays: number | null,
): string {
  const noun = count === 1 ? "office" : "offices";
  switch (filter) {
    case "never":
      return `${count} never visited`;
    case "30":
    case "60":
    case "90":
      return `${count} not visited in ${filter} days`;
    case "custom":
      return customDays !== null
        ? `${count} not visited in ${customDays} days`
        : `${count} ${noun}`;
    default:
      return `${count} ${noun}`;
  }
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
// ListViewSection — searchable full per-AE office list
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
                : "No offices yet. Add one or ask an admin to import them via Office Imports."}
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
// CheckinsViewSection — "Today's Check-ins" feed
// ---------------------------------------------------------------------------
//
// A date-windowed list of office check-ins (the office_visits log),
// defaulting to Today. Range chips: Today / Yesterday / Last 7 days /
// Custom (from–to date pickers). Admins additionally get a Mine | Team
// toggle; the Team scope returns every AE's check-ins (the server
// enforces admin-only for team independently, so a non-admin never
// reaches it even if the toggle were forced).
//
// Each row shows the office name, the timestamp, the AE who logged it
// (Team scope), a note preview, and taps through to the office detail
// page. Non-admins only ever see their own check-ins — matching the
// rest of the per-AE office surface.
// ---------------------------------------------------------------------------

type CheckinsFetchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | {
      kind: "ready";
      items: CheckinItem[];
      truncated: boolean;
      scope: CheckinScope;
    };

const CHECKIN_RANGES: { key: CheckinRange; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "Last 7 days" },
  { key: "custom", label: "Custom" },
];

function CheckinsViewSection({ isAdmin }: { isAdmin: boolean }) {
  const [range, setRange] = useState<CheckinRange>("today");
  const [scope, setScope] = useState<CheckinScope>("mine");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [state, setState] = useState<CheckinsFetchState>({ kind: "idle" });

  // Custom range only fetches once both dates are set and ordered. For
  // the relative ranges this is always true.
  const customReady =
    range !== "custom" || (from !== "" && to !== "" && from <= to);

  useEffect(() => {
    if (!customReady) {
      // Custom selected but incomplete — hold off and let the UI prompt
      // for both dates instead of firing an invalid request.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    const params = new URLSearchParams({ range, scope });
    if (range === "custom") {
      params.set("from", from);
      params.set("to", to);
    }
    void apiFetch(`/api/offices/checkins?${params.toString()}`)
      .then(async (res) => {
        if (cancelled) return;
        const data = (await res.json().catch(() => null)) as
          | (CheckinsResponse & ApiErrorShape)
          | null;
        if (!res.ok || !data?.checkins) {
          setState({
            kind: "error",
            error: data?.error ?? `Could not load check-ins (${res.status}).`,
          });
          return;
        }
        setState({
          kind: "ready",
          items: data.checkins,
          truncated: data.truncated === true,
          scope: data.scope,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setState({
          kind: "error",
          error: "Network error while loading check-ins.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [range, scope, from, to, customReady]);

  const datesInverted =
    range === "custom" && from !== "" && to !== "" && from > to;

  return (
    <div className="space-y-3">
      {/* Range chips. */}
      <div
        role="radiogroup"
        aria-label="Check-in date range"
        className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5"
      >
        {CHECKIN_RANGES.map((r) => {
          const active = range === r.key;
          return (
            <button
              key={r.key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setRange(r.key)}
              className={cn(
                "shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                active
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              {r.label}
            </button>
          );
        })}
      </div>

      {/* Custom date pickers. */}
      {range === "custom" && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1">
            <label
              htmlFor="checkin-from"
              className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
            >
              From
            </label>
            <input
              id="checkin-from"
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
              // text-base on mobile (≥16px) prevents iOS Safari
              // tap-to-zoom; md:text-sm preserves the desktop sizing.
              className="rounded-md border border-input bg-background px-3 py-2 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
            />
          </div>
          <div className="grid gap-1">
            <label
              htmlFor="checkin-to"
              className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
            >
              To
            </label>
            <input
              id="checkin-to"
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
              // text-base on mobile (≥16px) prevents iOS Safari
              // tap-to-zoom; md:text-sm preserves the desktop sizing.
              className="rounded-md border border-input bg-background px-3 py-2 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
            />
          </div>
        </div>
      )}

      {datesInverted && (
        <p role="alert" className="px-1 text-xs text-destructive">
          The From date must be on or before the To date.
        </p>
      )}

      {/* Admin-only Mine | Team toggle. */}
      {isAdmin && (
        <div
          role="radiogroup"
          aria-label="Whose check-ins"
          className="inline-flex w-fit rounded-full border border-border bg-muted/30 p-0.5"
        >
          {(
            [
              { value: "mine", label: "Mine" },
              { value: "team", label: "Team" },
            ] as const
          ).map(({ value, label }) => {
            const active = scope === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setScope(value)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold transition-colors",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {value === "team" && (
                  <Users aria-hidden="true" className="size-3.5" />
                )}
                {label}
              </button>
            );
          })}
        </div>
      )}

      {/* Body. */}
      {state.kind === "idle" && range === "custom" && !customReady && (
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Pick a From and To date to see check-ins.
            </p>
          </CardContent>
        </Card>
      )}

      {state.kind === "loading" && (
        <p className="px-1 text-sm text-muted-foreground">
          Loading check-ins…
        </p>
      )}

      {state.kind === "error" && (
        <Card>
          <CardContent>
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {state.error}
            </p>
          </CardContent>
        </Card>
      )}

      {state.kind === "ready" && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {state.items.length}{" "}
              {state.items.length === 1 ? "check-in" : "check-ins"}
              {state.scope === "team" ? " · all AEs" : ""}
            </span>
            {state.truncated && (
              <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
                <AlertTriangle aria-hidden="true" className="size-3" />
                Showing the most recent — narrow the range to see all
              </span>
            )}
          </div>

          {state.items.length === 0 ? (
            <Card>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  No check-ins in this window
                  {state.scope === "mine" ? " for you" : ""}. Log a visit
                  from the Map or an office page and it&apos;ll show up here.
                </p>
              </CardContent>
            </Card>
          ) : (
            <ul className="flex flex-col gap-2">
              {state.items.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/offices/${c.office_id}`}
                    className="group block rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10 transition-colors hover:bg-muted/50"
                  >
                    <div className="flex items-start gap-3 p-3">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <p className="truncate text-base font-semibold leading-snug">
                            {c.office_name}
                          </p>
                          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                            {formatActivityStamp(c.visited_at)}
                          </span>
                        </div>
                        {state.scope === "team" && (
                          <p className="text-xs text-muted-foreground">
                            by{" "}
                            <span className="font-medium text-foreground/80">
                              {c.salesperson_name}
                            </span>
                          </p>
                        )}
                        {c.note && (
                          <p className="line-clamp-2 text-sm text-foreground/80">
                            {c.note}
                          </p>
                        )}
                      </div>
                      <ChevronRight
                        aria-hidden="true"
                        className="mt-1 size-4 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground"
                      />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

