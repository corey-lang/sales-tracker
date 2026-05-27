"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  List,
  Locate,
  Map as MapIcon,
  MapPin,
  Navigation,
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
} from "@/lib/offices";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

// Leaflet touches `window` at module load, so the map component is
// pulled in lazily AND with SSR disabled. The loading state mirrors
// the page's "Looking for offices…" message so a slow first-paint
// of the map (~150 KB JS + ~14 KB CSS + tile fetches) reads as part
// of the normal flow rather than a layout flash.
const NearbyOfficesMap = dynamic(
  () => import("@/components/nearby-offices-map"),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-[60vh] flex-1 items-center justify-center rounded-lg border border-border bg-muted/20">
        <p className="text-sm text-muted-foreground">Loading map…</p>
      </div>
    ),
  },
);

/** [Map | List] toggle value. Map is the default — AEs think
 *  geographically; the list is the deep-detail fallback. */
type ViewMode = "map" | "list";

// ---------------------------------------------------------------------------
// /offices/nearby — Phase 1C test-only "what's around me" surface.
//
// Flow:
//   * Page mounts → no fix yet, shows "I'm Here" button.
//   * Tap → browser asks for location.
//   * On fix → GET /api/offices/nearby with lat/lng/radius.
//   * Render Map view (default) OR List view via the top toggle —
//     both consume the same fetched `results` array; logging a
//     visit from either view updates both equally.
//
// VIEWS
//   * Map (default) — Leaflet + OpenStreetMap tiles + branded
//     orange divIcon pins. Lazy-loaded via next/dynamic({ ssr:
//     false }) since Leaflet touches `window` at module load. See
//     src/components/nearby-offices-map.tsx.
//   * List — the original card layout for deep scanning.
//
// Access (same gate as /offices and /offices/[id]):
//   * `is_test === true` salesperson — passes.
//   * juice_box_only — redirected to /juice-box.
//   * Anyone else — redirected to /dashboard.
// ---------------------------------------------------------------------------

type NearbyResponse = {
  nearby: NearbyOfficeItem[];
  total_in_range: number;
  truncated: boolean;
  radius_miles: NearbyRadius;
  searched_at: { lat: number; lng: number };
};
type ApiErrorShape = { error?: string };
type VisitResponse = {
  visit: { id: string; office_id: string; visited_at: string };
};

/**
 * Geolocation state machine. Each branch maps to a clear UI:
 *   * `idle`        — haven't asked yet; the "I'm Here" button is the
 *                     only thing visible (besides radius + entry copy).
 *   * `asking`      — geolocation request in flight; show a spinner.
 *   * `unsupported` — browser has no geolocation API; show "open in
 *                     Safari/Chrome on phone" copy.
 *   * `denied`      — user clicked Block; show how-to-enable hint.
 *   * `unavailable` — geo errored for any other reason (timeout,
 *                     position unavailable, OS-level location off);
 *                     show retry button.
 *   * `ready`       — fix in hand; ready to query and render results.
 */
type LocationState =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "unsupported" }
  | { kind: "denied" }
  | { kind: "unavailable"; reason: string }
  | { kind: "ready"; lat: number; lng: number; takenAt: number };

type FetchState =
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

/**
 * Builds a Google Maps URL for an office row. Prefers a name + address
 * query (sometimes Maps resolves Place IDs from this), then a raw
 * lat/lng fallback. Returns null when there's nothing to map (no
 * address text + we'd never call this on a row without coords, but
 * defend in depth).
 */
function mapsUrlFor(item: NearbyOfficeItem): string | null {
  const address = [
    item.street,
    [item.city, item.state].filter(Boolean).join(", "),
    item.zip,
  ]
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0)
    .join(", ");
  if (address.length > 0) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      `${item.name} ${address}`,
    )}`;
  }
  if (Number.isFinite(item.latitude) && Number.isFinite(item.longitude)) {
    return `https://www.google.com/maps/search/?api=1&query=${item.latitude},${item.longitude}`;
  }
  return null;
}

/** Compact 1-decimal mile distance string. "0.4 mi" / "12.3 mi". */
function formatDistance(miles: number): string {
  if (miles < 10) return `${miles.toFixed(1)} mi`;
  return `${Math.round(miles)} mi`;
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

export default function NearbyOfficesPage() {
  const router = useRouter();
  const { salesperson, loaded: sessionLoaded } = useSalesperson();
  const { loaded: permsLoaded } = useLivePermissions();
  useScrollToTop();

  // ---- Access gate -------------------------------------------------------
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

  // ---- Radius + geolocation + fetch + view-mode state --------------------
  const [radius, setRadius] = useState<NearbyRadius>(NEARBY_DEFAULT_RADIUS);
  const [location, setLocation] = useState<LocationState>({ kind: "idle" });
  const [fetchState, setFetchState] = useState<FetchState>({ kind: "idle" });
  /** Default to Map per product direction — AEs think geographically.
   *  List remains a peer (not a fallback) for deep scanning of cards. */
  const [viewMode, setViewMode] = useState<ViewMode>("map");

  /**
   * Triggers the browser geolocation prompt + transitions through the
   * LocationState machine. `enableHighAccuracy: false` because office
   * proximity to the AE's current spot doesn't need sub-meter
   * precision — and high-accuracy mode is slower + battery-heavy.
   *
   * `maximumAge: 60_000` lets a recent (≤1 min) cached fix come back
   * instantly when the AE bounces between offices.
   */
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
        // PERMISSION_DENIED = 1, POSITION_UNAVAILABLE = 2, TIMEOUT = 3.
        // Sites without HTTPS may also see POSITION_UNAVAILABLE on
        // some browsers — same surface message either way.
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
      {
        enableHighAccuracy: false,
        maximumAge: 60_000,
        timeout: 10_000,
      },
    );
  }, []);

  /**
   * Runs the /api/offices/nearby fetch. Cancels in-flight requests
   * via a `cancelled` flag so a fast radius switch can't race a
   * stale response on top of a newer one. Logs the actual error
   * text into the FetchState; the route already sanitizes the
   * message before returning it.
   */
  const fetchNearby = useCallback(
    async (lat: number, lng: number, r: NearbyRadius): Promise<void> => {
      setFetchState({ kind: "loading" });
      try {
        const res = await apiFetch(
          `/api/offices/nearby?lat=${lat}&lng=${lng}&radius=${r}`,
        );
        const data = (await res.json().catch(() => null)) as
          | (NearbyResponse & ApiErrorShape)
          | null;
        if (!res.ok || !data?.nearby) {
          setFetchState({
            kind: "error",
            error: data?.error ?? `Could not load nearby offices (${res.status}).`,
          });
          return;
        }
        setFetchState({
          kind: "ready",
          results: data.nearby,
          totalInRange: data.total_in_range,
          truncated: data.truncated,
          radius: data.radius_miles,
        });
      } catch {
        setFetchState({
          kind: "error",
          error: "Network error while loading nearby offices.",
        });
      }
    },
    [],
  );

  // Re-fetch whenever we have a fix AND the radius / fix changes.
  // `fetchNearby` is the canonical fetch-on-state-change pattern used
  // by the rest of the office surface (see /offices and
  // /offices/[id]); the eslint disable matches their precedent.
  useEffect(() => {
    if (location.kind !== "ready") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchNearby(location.lat, location.lng, radius);
  }, [location, radius, fetchNearby]);

  // ---- Per-card Log Visit state ------------------------------------------
  // Keyed by office id so multiple in-flight logs (rare on mobile but
  // possible) don't trample each other. Notice maps to "✓ Visit
  // logged." auto-clearing pill, same pattern as the office-detail
  // snapshot card.
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
          // Same empty-body path as the office-detail one-tap log:
          // server defaults visited_at to NOW() and note to NULL.
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
        // Promote this office's last-visit timestamp in the rendered
        // list so the card shows the fresh value immediately. We do
        // NOT re-sort the list — the user's mental model is "what's
        // around me," not "what I haven't been to recently."
        setFetchState((current) => {
          if (current.kind !== "ready") return current;
          return {
            ...current,
            results: current.results.map((r) =>
              r.id === officeId ? { ...r, last_visit_at: visitedAt } : r,
            ),
          };
        });
        // Auto-clearing success notice on this card.
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

  // ---- Render guards -----------------------------------------------------
  if (!accessReady || !salesperson || !canView) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  return (
    <main className="pwa-safe-top mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-3 p-4">
      {/* Header — Back to /offices + Test pill. */}
      <header className="flex flex-wrap items-center justify-between gap-2">
        <Link
          href="/offices"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Back
        </Link>
        <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600 ring-1 ring-inset ring-amber-500/25 dark:text-amber-400">
          Test
        </span>
      </header>

      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          Nearby Offices
        </h1>
        <p className="text-xs text-muted-foreground">
          Sandbox nearby search — visible only to the test account.
        </p>
      </div>

      {/* Sandbox banner — matches the other office surfaces. */}
      <div
        role="note"
        className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
      >
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p className="leading-snug">
          Uses your device location to find offices in your sandbox
          within a small radius. Your location stays on your device —
          only lat/lng + radius are sent to the server.
        </p>
      </div>

      {/* Controls row — [Map | List] view toggle + radius picker.
          The two pill groups share a row on wide phones / desktop,
          stack on narrow phones via flex-wrap. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* View-mode toggle. Map is the default per product
            direction — AEs think geographically. List remains a
            peer for deep scanning. Both surfaces consume the
            same `fetchState.results` array so a Log Visit fired
            from either view updates both equally. */}
        <div
          role="radiogroup"
          aria-label="View"
          className="inline-flex rounded-full border border-border bg-muted/30 p-0.5"
        >
          {(
            [
              { value: "map", label: "Map", Icon: MapIcon },
              { value: "list", label: "List", Icon: List },
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

        {/* Radius picker — closed set, server enforces the same list. */}
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
                  disabled={fetchState.kind === "loading"}
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
      </div>

      {/* "I'm Here" / re-locate primary action. */}
      <LocationBanner location={location} onRequest={requestLocation} />

      {/* Result list / fetch states. */}
      {location.kind === "ready" && fetchState.kind === "loading" && (
        <p className="px-1 text-sm text-muted-foreground">
          Looking for offices within {radius} miles…
        </p>
      )}

      {location.kind === "ready" && fetchState.kind === "error" && (
        <Card>
          <CardContent>
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {fetchState.error}
            </p>
          </CardContent>
        </Card>
      )}

      {location.kind === "ready" &&
        fetchState.kind === "ready" &&
        fetchState.results.length === 0 && (
          <Card>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                No offices within {fetchState.radius} miles. Try a wider
                radius, or import more offices from /office-imports.
                Offices without coordinates aren&apos;t included here.
              </p>
            </CardContent>
          </Card>
        )}

      {location.kind === "ready" &&
        fetchState.kind === "ready" &&
        fetchState.results.length > 0 && (
          <>
            <p className="px-0.5 text-xs text-muted-foreground">
              {fetchState.results.length === 1
                ? "1 office nearby"
                : `${fetchState.results.length} offices nearby`}
              {fetchState.truncated && (
                <span className="text-amber-700 dark:text-amber-400">
                  {" "}
                  · showing closest{" "}
                  {fetchState.results.length} of {fetchState.totalInRange}
                </span>
              )}
            </p>
            {viewMode === "map" ? (
              <NearbyOfficesMap
                center={{ lat: location.lat, lng: location.lng }}
                items={fetchState.results}
                radius={fetchState.radius}
                loggingId={loggingId}
                logNoticeById={logNoticeById}
                logErrorById={logErrorById}
                isLogDisabled={(officeId) =>
                  loggingId !== null && loggingId !== officeId
                }
                onLogVisit={handleLogVisit}
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {fetchState.results.map((item) => (
                  <NearbyCard
                    key={item.id}
                    item={item}
                    logging={loggingId === item.id}
                    logDisabled={loggingId !== null && loggingId !== item.id}
                    notice={logNoticeById.get(item.id) ?? null}
                    error={logErrorById.get(item.id) ?? null}
                    onLogVisit={() => handleLogVisit(item.id)}
                  />
                ))}
              </ul>
            )}
          </>
        )}
    </main>
  );
}

/**
 * The "I'm Here" / "We have your location" banner. Owns every UI
 * branch of the LocationState union so the page body stays focused
 * on results.
 */
function LocationBanner({
  location,
  onRequest,
}: {
  location: LocationState;
  onRequest: () => void;
}) {
  if (location.kind === "idle") {
    return (
      <div className="rounded-lg border border-border bg-card p-3">
        <p className="text-sm text-foreground">
          Tap <strong>I&apos;m Here</strong> to see offices around your
          current location. Your phone will ask permission first.
        </p>
        <div className="mt-2">
          <Button type="button" size="sm" onClick={onRequest}>
            <Locate aria-hidden="true" className="size-4" />
            I&apos;m Here
          </Button>
        </div>
      </div>
    );
  }

  if (location.kind === "asking") {
    return (
      <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
        Asking for your location…
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
          desktop) and try again.
        </p>
        <div className="mt-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onRequest}
          >
            <Locate aria-hidden="true" className="size-4" />
            Try again
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
          Make sure location is on at the OS level, then try again.
        </p>
        <div className="mt-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onRequest}
          >
            <Locate aria-hidden="true" className="size-4" />
            Try again
          </Button>
        </div>
      </div>
    );
  }

  // location.kind === "ready"
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">
      <span className="text-muted-foreground">
        Using your current location.{" "}
        <span className="text-foreground/70">
          (Got fix {formatActivityStamp(new Date(location.takenAt).toISOString())})
        </span>
      </span>
      <Button type="button" size="sm" variant="outline" onClick={onRequest}>
        <Locate aria-hidden="true" className="size-3.5" />
        Re-find me
      </Button>
    </div>
  );
}

/**
 * One office card in the nearby list. Tap the body → /offices/[id];
 * the action buttons stop the row tap from firing so a tap on Log
 * Visit doesn't also navigate to the detail page.
 */
function NearbyCard({
  item,
  logging,
  logDisabled,
  notice,
  error,
  onLogVisit,
}: {
  item: NearbyOfficeItem;
  logging: boolean;
  logDisabled: boolean;
  notice: string | null;
  error: string | null;
  onLogVisit: () => void;
}) {
  const mapsHref = mapsUrlFor(item);
  const address = [
    item.street,
    [item.city, item.state].filter(Boolean).join(", "),
    item.zip,
  ]
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0)
    .join(" · ");
  const dueDate = formatDueDate(item.next_action_due_date);

  return (
    <li>
      <div className="rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10 transition-colors hover:bg-muted/40">
        {/* Top row — title + distance pill. Tap the title row to open
            the office detail page. */}
        <Link
          href={`/offices/${item.id}`}
          className="flex items-start gap-3 p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <p className="truncate text-base font-semibold leading-snug">
                {item.name}
              </p>
              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">
                {formatDistance(item.distance_miles)}
              </span>
            </div>
            {address && (
              <div className="mt-1 flex items-start gap-1 text-xs text-muted-foreground">
                <MapPin
                  aria-hidden="true"
                  className="mt-0.5 size-3 shrink-0"
                />
                <span className="min-w-0">{address}</span>
              </div>
            )}
            <div className="mt-1 space-y-0.5">
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
                  {dueDate && (
                    <span className="text-muted-foreground">
                      {" "}
                      · due {dueDate}
                    </span>
                  )}
                </p>
              )}
            </div>
          </div>
          <ChevronRight
            aria-hidden="true"
            className="mt-1 size-4 shrink-0 text-muted-foreground/60"
          />
        </Link>
        {/* Action row — separate from the Link so taps don't bubble
            into a navigation. The wrapping <div> sits on the card
            and is non-interactive; the buttons are individually
            focusable. */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border/40 px-3 py-2">
          <Button
            type="button"
            size="sm"
            onClick={onLogVisit}
            disabled={logging || logDisabled}
          >
            {logging ? "Logging…" : "Log visit"}
          </Button>
          {mapsHref && (
            <a
              href={mapsHref}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <Navigation aria-hidden="true" className="size-4" />
              Directions
            </a>
          )}
          <Link
            href={`/offices/${item.id}`}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            Open
            <ChevronRight aria-hidden="true" className="size-3.5" />
          </Link>
          {notice && (
            <p
              role="status"
              className="basis-full inline-flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400"
            >
              <CheckCircle2 aria-hidden="true" className="size-3.5" />
              {notice}
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="basis-full text-xs text-destructive"
            >
              {error}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}
