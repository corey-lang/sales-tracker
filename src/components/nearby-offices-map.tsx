"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { Check, CheckCircle2, Navigation, NotebookPen, Plus } from "lucide-react";
import L from "leaflet";
import {
  CircleMarker,
  MapContainer,
  Marker,
  Popup,
  TileLayer,
  useMap,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";

import { Button, buttonVariants } from "@/components/ui/button";
import { formatActivityStamp } from "@/lib/dates";
import type { NearbyOfficeItem, NearbyRadius } from "@/lib/offices";

// ---------------------------------------------------------------------------
// NearbyOfficesMap — client-only Leaflet map for /offices/nearby.
//
// Lifted out of the page module so it can be code-split via
// next/dynamic({ ssr: false }) — Leaflet touches `window`/`document`
// at module load and Next 16's SSR would crash without it.
//
// LIBRARY CHOICE
//   * leaflet@1.9.x + react-leaflet@5 + OpenStreetMap tiles. No
//     API key, no paid dependency, no Google footprint. Standard
//     attribution shown in the corner per OSM tile usage policy.
//   * Marker icons are HTML `divIcon`s, not the default Leaflet PNG
//     pins. The default PNGs ship at the wrong URLs under Next.js's
//     bundler unless you patch L.Icon.Default's image paths — and
//     they're red drops, which doesn't fit the brand. Using divIcons
//     gives us inline SVG + branded orange + zero static-asset
//     plumbing.
//
// FUTURE-PROOFING (do NOT implement yet, but the seams are here)
//   * `pinVariantFor(item)` is the single switch where a future
//     "office overdue" / "recently visited" / "high priority" pin
//     differentiation would land. Today it always returns "default".
//   * `renderPinHtml(variant)` derives every pin's HTML from its
//     variant, so adding a second variant means one new `case` and
//     one new SVG string.
// ---------------------------------------------------------------------------

/** Per-pin styling variant. "selected" = chosen for the current route
 *  (green); "default" = brand orange. The seam still reserves room for a
 *  future "overdue" / "priority" style. */
type PinVariant = "default" | "selected";

/** Given an office + the current route selection, return the variant its pin
 *  should render as. Selected offices turn green so the lassoed set is
 *  obvious against the orange defaults. */
function pinVariantFor(item: NearbyOfficeItem, selected: boolean): PinVariant {
  return selected ? "selected" : "default";
}

/**
 * Returns the HTML body for a Leaflet `divIcon` given a pin variant.
 *
 * The pin is a 28×36 SVG drop with a white center disc. Orange fill
 * (#ff7a00, matches `--primary` in globals.css). Drop-shadow keeps
 * the pin readable over light OSM tiles. The variant switch is the
 * only place to touch when adding a new style.
 */
function renderPinHtml(variant: PinVariant): string {
  // Orange = default; green = selected for the route.
  const FILL = variant === "selected" ? "#16a34a" : "#ff7a00";
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36" aria-hidden="true" style="filter: drop-shadow(0 1px 2px rgba(0,0,0,0.35));">
      <path d="M14 0C6.27 0 0 6.27 0 14c0 10.5 14 22 14 22s14-11.5 14-22C28 6.27 21.73 0 14 0z" fill="${FILL}"/>
      <circle cx="14" cy="14" r="5" fill="#ffffff"/>
    </svg>
  `;
}

// ---------------------------------------------------------------------------
// Lasso (freehand area select)
// ---------------------------------------------------------------------------

type ScreenPoint = { x: number; y: number };

/** Ray-casting point-in-polygon over container (screen) coordinates. */
function pointInPolygon(pt: ScreenPoint, poly: ScreenPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect =
      yi > pt.y !== yj > pt.y &&
      pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Lifts the Leaflet map instance up to the parent so the lasso overlay can
 *  convert office lat/lng → container points. */
function MapReady({ onReady }: { onReady: (map: L.Map) => void }) {
  const map = useMap();
  useEffect(() => {
    onReady(map);
  }, [map, onReady]);
  return null;
}

/**
 * Freehand lasso overlay. When active it sits ON TOP of the map (so the map
 * never pans/zooms or opens popups while drawing) and captures a pointer
 * stroke. On release it converts each VISIBLE office's lat/lng to a container
 * point and selects those inside the drawn polygon. Because `items` is already
 * the filtered/visible set, hidden offices can never be selected.
 */
function LassoOverlay({
  map,
  items,
  onSelect,
}: {
  map: L.Map;
  items: NearbyOfficeItem[];
  onSelect: (ids: string[]) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pathRef = useRef<ScreenPoint[]>([]);
  const drawingRef = useRef(false);
  const [path, setPath] = useState<ScreenPoint[]>([]);

  const localPoint = (e: ReactPointerEvent): ScreenPoint => {
    const rect = ref.current?.getBoundingClientRect();
    return {
      x: e.clientX - (rect?.left ?? 0),
      y: e.clientY - (rect?.top ?? 0),
    };
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    drawingRef.current = true;
    ref.current?.setPointerCapture(e.pointerId);
    pathRef.current = [localPoint(e)];
    setPath(pathRef.current);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drawingRef.current) return;
    pathRef.current = [...pathRef.current, localPoint(e)];
    setPath(pathRef.current);
  };
  const finish = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const poly = pathRef.current;
    if (poly.length >= 3) {
      const ids = items
        .filter((it) => {
          const p = map.latLngToContainerPoint([it.latitude, it.longitude]);
          return pointInPolygon({ x: p.x, y: p.y }, poly);
        })
        .map((it) => it.id);
      if (ids.length > 0) onSelect(ids);
    }
    pathRef.current = [];
    setPath([]);
  };

  return (
    <div
      ref={ref}
      className="absolute inset-0 z-[1200] cursor-crosshair"
      style={{ touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
    >
      {path.length > 1 && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full">
          <polyline
            points={path.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="rgba(255,122,0,0.12)"
            stroke="#ff7a00"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      )}
    </div>
  );
}

/** Builds the actual Leaflet icon. `iconAnchor` puts the tip of the
 *  drop at the office's coordinate; `popupAnchor` lifts the popup
 *  off the pin so it doesn't cover its own marker. */
function buildPinIcon(variant: PinVariant): L.DivIcon {
  return L.divIcon({
    className: "nearby-office-pin", // empty styling slot; SVG carries the look
    html: renderPinHtml(variant),
    iconSize: [28, 36],
    iconAnchor: [14, 36],
    popupAnchor: [0, -32],
  });
}

/**
 * Picks an initial zoom level that comfortably frames the radius
 * around the user's location. Tuned against the OSM zoom table —
 * higher zoom = more zoomed-in. These values place the requested
 * radius roughly in the middle third of a phone-width map.
 */
function initialZoomFor(radius: NearbyRadius): number {
  if (radius <= 5) return 12;
  if (radius <= 10) return 11;
  return 10;
}

/**
 * Re-centers the map whenever the user's location OR the radius
 * changes so a fresh fix / radius swap doesn't leave the viewport
 * pointed at the old position. Lives inside `<MapContainer>` so it
 * can call `useMap()`.
 */
function MapRecenter({
  center,
  radius,
}: {
  center: [number, number];
  radius: NearbyRadius;
}) {
  const map = useMap();
  const lastKeyRef = useRef<string>("");
  useEffect(() => {
    // Cheap key so we re-fly only when the user actually moves
    // (avoid a re-fly on every parent re-render).
    const key = `${center[0]},${center[1]},${radius}`;
    if (lastKeyRef.current === key) return;
    lastKeyRef.current = key;
    map.setView(center, initialZoomFor(radius));
  }, [center, radius, map]);
  return null;
}

/**
 * Forces Leaflet to re-measure its container after mount.
 *
 * Leaflet measures the container ONCE at `L.map()` init time. On
 * iOS Safari (and any time the layout settles after Leaflet inits
 * — toolbar animations, font load shifts, parent flex re-layout
 * when the user toggles List → Map), the initial measurement can
 * be slightly wrong: tiles for the wrong viewport are requested
 * and the map appears blank, off-center, or with a strip of
 * missing tiles.
 *
 * Calling `invalidateSize()` makes Leaflet remeasure + re-request
 * any missing tiles. Two passes catches both the immediate post-
 * mount race AND the post-toolbar-animation case ~100-150 ms
 * later. Cheap (one DOM read) and safe to call extra.
 */
function MapResizer() {
  const map = useMap();
  useEffect(() => {
    // Immediate pass — fixes the common "container has dimensions
    // but Leaflet measured 0×0 between mount and layout" case.
    map.invalidateSize();
    // Delayed pass — fixes the iOS Safari toolbar-animation case
    // where the visual viewport changes height after first paint.
    const t = window.setTimeout(() => map.invalidateSize(), 200);
    return () => window.clearTimeout(t);
  }, [map]);
  return null;
}

/** YYYY-MM-DD → "Jun 5, 2026" — local-TZ safe (no `new Date(str)`
 *  TZ-shift). Mirrors the helper in the page module. */
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

/** Compact mile distance string. Mirrors the page helper. */
function formatDistance(miles: number): string {
  if (miles < 10) return `${miles.toFixed(1)} mi`;
  return `${Math.round(miles)} mi`;
}

/** Builds a Google Maps URL for an office row. Mirrors the page
 *  helper so the Map view's Directions button behaves identically. */
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

export type NearbyOfficesMapProps = {
  /** Searched-from location (user's geolocation fix). */
  center: { lat: number; lng: number };
  /** Same array the list view renders, in the same order. */
  items: NearbyOfficeItem[];
  /** Current radius — drives initial zoom + re-fly behavior. */
  radius: NearbyRadius;
  /** Id of an office whose Log Visit POST is in flight, if any. */
  loggingId: string | null;
  /** Id-keyed result message for the per-card success pill. */
  logNoticeById: Map<string, string>;
  /** Id-keyed error message for failed Log Visit attempts. */
  logErrorById: Map<string, string>;
  /** Disable the Log Visit button when another card's log is in flight. */
  isLogDisabled: (officeId: string) => boolean;
  /** Triggers the shared one-tap Log Visit POST (no note). Updates flow
   *  through the parent state map so a log from the map AND a log from
   *  the list apply to the same per-id slot. */
  onLogVisit: (officeId: string) => void;
  /** Opens the "Log Visit + Note" modal for this office. The parent
   *  renders the modal (above the map) and applies the result. */
  onLogVisitWithNote: (office: { id: string; name: string }) => void;
  // ---- Lasso / route selection (V1) ----
  /** When true, the lasso overlay captures pointer strokes (map pan is
   *  suppressed) and a release selects the offices inside the drawn shape. */
  lassoActive?: boolean;
  /** Ids currently chosen for the route — drives the green pin styling. */
  selectedIds?: ReadonlySet<string>;
  /** Lasso completed: add these offices (already filtered to the visible set)
   *  to the selection. */
  onLassoSelect?: (ids: string[]) => void;
  /** Tap a pin's Add/Remove button to toggle one office in the selection. */
  onToggleSelect?: (officeId: string) => void;
};

export default function NearbyOfficesMap({
  center,
  items,
  radius,
  loggingId,
  logNoticeById,
  logErrorById,
  isLogDisabled,
  onLogVisit,
  onLogVisitWithNote,
  lassoActive = false,
  selectedIds,
  onLassoSelect,
  onToggleSelect,
}: NearbyOfficesMapProps) {
  // Pre-build one icon per variant up front. Building inside useMemo and
  // treating the result as read-only satisfies react-hooks/immutability —
  // adding a new variant means appending another entry to the literal below.
  const iconByVariant = useMemo<Readonly<Record<PinVariant, L.DivIcon>>>(
    () => ({
      default: buildPinIcon("default"),
      selected: buildPinIcon("selected"),
    }),
    [],
  );

  // Leaflet map instance, lifted from a child so the lasso overlay (a sibling
  // of MapContainer) can convert office coords to screen points.
  const [mapInstance, setMapInstance] = useState<L.Map | null>(null);

  return (
    <div
      // Map sizing has two competing constraints:
      //   1. Leaflet needs a definite, non-zero height at `L.map()`
      //      init time (the prior `flex-1` design fell back to 0
      //      on iOS Safari before flex resolved, producing "blank
      //      dark rectangle" reports).
      //   2. The bottom nav floats above the page with a
      //      semi-transparent (`bg-background/85`) backdrop. If the
      //      map extends into the nav's vertical zone, map tiles
      //      bleed through the translucency and the nav looks
      //      covered. The fix is to keep the map's bottom edge
      //      ABOVE the nav at scroll=0 so the nav only ever floats
      //      over the page's bottom padding (BOTTOM_NAV_SPACER) or
      //      empty body background — never over tiles.
      //
      // The `calc(100dvh - 23rem)` ceiling subtracts roughly the
      // above-map controls (~16rem on mobile, less on desktop) +
      // the bottom nav (~5rem) + a small buffer (~2rem). `dvh` (not
      // `vh`) tracks the iOS Safari visual viewport as the toolbar
      // shows/hides — without it the map would peek behind the nav
      // when the toolbar collapses.
      //
      // Min height `300px` is the floor for tiny viewports (fold
      // devices, iPhone SE landscape). On those a small amount of
      // overlap is unavoidable; the dynamic ceiling keeps it minimal
      // everywhere else.
      //
      // `MapResizer` below also calls `invalidateSize()` post-mount
      // so any residual mid-init layout change is corrected.
      //
      // STACKING CONTEXT (`isolate`)
      //   Leaflet sets high z-indexes on its internal panes (200-700
      //   for tile/marker/popup panes, 1000 for the .leaflet-top /
      //   .leaflet-bottom control containers). `.leaflet-container`
      //   itself is only `position: relative` — that does NOT create
      //   a stacking context, so those high z-indexes escape into
      //   the parent stacking context (typically <body>). The
      //   consequence: any sibling modal at z-50 (e.g. the Add
      //   Office sheet on /offices) renders BELOW the map because
      //   z-1000 > z-50 in the shared body context.
      //
      //   Adding `isolate` (CSS `isolation: isolate`) on the wrapper
      //   establishes a new stacking context here — Leaflet's panes
      //   and controls stay contained, and the wrapper itself
      //   competes against siblings at z-auto (= 0). Modals at z-50
      //   then layer correctly above the map without any global
      //   z-index bumps.
      className="relative isolate h-[calc(100dvh-23rem)] min-h-[300px] w-full overflow-hidden rounded-lg border border-border"
    >
      <MapContainer
        center={[center.lat, center.lng]}
        zoom={initialZoomFor(radius)}
        scrollWheelZoom={true}
        // Drag is on by default; double-tap zoom + pinch zoom work
        // out of the box on iOS Safari. `tap` is the unified handler
        // for touch + click.
        className="h-full w-full"
      >
        <TileLayer
          // Standard OpenStreetMap tile server. Free for moderate
          // use; an 11-person internal team is well within the
          // policy. Attribution is required and rendered in the
          // bottom-right corner by Leaflet automatically.
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {/* User location — blue dot with white ring. CircleMarker
            stays a constant pixel size as the user zooms, which is
            what you want for a "you are here" indicator. */}
        <CircleMarker
          center={[center.lat, center.lng]}
          radius={8}
          pathOptions={{
            color: "#ffffff",
            weight: 2,
            fillColor: "#2563eb",
            fillOpacity: 1,
          }}
        >
          <Popup>You are here</Popup>
        </CircleMarker>

        {/* Office pins. Tap a pin → branded popup with the same
            actions the List view's card row carries. */}
        {items.map((item) => {
          const selected = selectedIds?.has(item.id) ?? false;
          const variant = pinVariantFor(item, selected);
          const mapsHref = mapsUrlFor(item);
          const notice = logNoticeById.get(item.id) ?? null;
          const error = logErrorById.get(item.id) ?? null;
          const dueDate = formatDueDate(item.next_action_due_date);
          const logging = loggingId === item.id;
          const disabled = isLogDisabled(item.id);
          return (
            <Marker
              key={item.id}
              position={[item.latitude, item.longitude]}
              icon={iconByVariant[variant]}
            >
              <Popup maxWidth={280} minWidth={240}>
                <div className="space-y-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-semibold leading-snug">
                      {item.name}
                    </p>
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">
                      {formatDistance(item.distance_miles)}
                    </span>
                  </div>
                  {item.last_visit_at ? (
                    <p className="text-[11px] text-muted-foreground">
                      Last visit{" "}
                      <span className="font-medium text-foreground/80">
                        {formatActivityStamp(item.last_visit_at)}
                      </span>
                    </p>
                  ) : (
                    <p className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
                      No visit yet
                    </p>
                  )}
                  {item.next_action && (
                    <p className="text-xs">
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
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    {onToggleSelect && (
                      <Button
                        type="button"
                        size="sm"
                        variant={selected ? "outline" : "default"}
                        onClick={() => onToggleSelect(item.id)}
                      >
                        {selected ? (
                          <>
                            <Check aria-hidden="true" className="size-4" />
                            In route
                          </>
                        ) : (
                          <>
                            <Plus aria-hidden="true" className="size-4" />
                            Add to route
                          </>
                        )}
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onLogVisit(item.id)}
                      disabled={logging || disabled}
                    >
                      {logging ? "Logging…" : "Log visit"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        onLogVisitWithNote({ id: item.id, name: item.name })
                      }
                      disabled={logging || disabled}
                    >
                      <NotebookPen aria-hidden="true" className="size-4" />
                      Log + note
                    </Button>
                    {mapsHref && (
                      <a
                        href={mapsHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={buttonVariants({
                          variant: "outline",
                          size: "sm",
                        })}
                      >
                        <Navigation aria-hidden="true" className="size-4" />
                        Directions
                      </a>
                    )}
                    <Link
                      href={`/offices/${item.id}`}
                      className={buttonVariants({
                        variant: "ghost",
                        size: "sm",
                      })}
                    >
                      Open
                    </Link>
                  </div>
                  {notice && (
                    <p
                      role="status"
                      className="inline-flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400"
                    >
                      <CheckCircle2
                        aria-hidden="true"
                        className="size-3.5"
                      />
                      {notice}
                    </p>
                  )}
                  {error && (
                    <p
                      role="alert"
                      className="text-xs text-destructive"
                    >
                      {error}
                    </p>
                  )}
                </div>
              </Popup>
            </Marker>
          );
        })}

        <MapRecenter
          center={[center.lat, center.lng]}
          radius={radius}
        />
        <MapResizer />
        <MapReady onReady={setMapInstance} />
      </MapContainer>

      {/* Lasso draw surface — only mounted while active so normal map
          interaction (pan/zoom/popups) is untouched otherwise. */}
      {lassoActive && mapInstance && onLassoSelect && (
        <LassoOverlay
          map={mapInstance}
          items={items}
          onSelect={onLassoSelect}
        />
      )}
    </div>
  );
}
