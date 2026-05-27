"use client";

import { useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { CheckCircle2, Navigation } from "lucide-react";
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

/** Per-pin styling variant. Today always "default"; reserved as the
 *  single hook a future "office overdue" / "recently visited" /
 *  "priority" differentiation would extend. */
type PinVariant = "default";

/** Future seam — given a `NearbyOfficeItem`, return the variant its
 *  pin should render as. Today every office gets the brand-orange
 *  default; tomorrow this is where last-visit recency, overdue
 *  next-action, etc. would map to differentiated pin styles. The
 *  argument is intentionally received but not consumed today so the
 *  signature documents the future-proofed seam. */
function pinVariantFor(item: NearbyOfficeItem): PinVariant {
  void item;
  return "default";
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
  const FILL = "#ff7a00";
  switch (variant) {
    case "default":
    default:
      return `
        <svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36" aria-hidden="true" style="filter: drop-shadow(0 1px 2px rgba(0,0,0,0.35));">
          <path d="M14 0C6.27 0 0 6.27 0 14c0 10.5 14 22 14 22s14-11.5 14-22C28 6.27 21.73 0 14 0z" fill="${FILL}"/>
          <circle cx="14" cy="14" r="5" fill="#ffffff"/>
        </svg>
      `;
  }
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
  /** Triggers the shared Log Visit POST. Updates flow through the
   *  parent state map so a log from the map AND a log from the list
   *  apply to the same per-id slot. */
  onLogVisit: (officeId: string) => void;
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
}: NearbyOfficesMapProps) {
  // Pre-build one icon per variant up front (today: just "default").
  // Building inside useMemo and treating the result as read-only
  // satisfies react-hooks/immutability — adding a new variant means
  // appending another entry to the literal below, not mutating an
  // in-flight cache.
  const iconByVariant = useMemo<Readonly<Record<PinVariant, L.DivIcon>>>(
    () => ({
      default: buildPinIcon("default"),
    }),
    [],
  );

  return (
    <div
      // Leaflet requires its container to have a definite, non-zero
      // height at the moment `L.map()` runs. Earlier this used
      // `flex-1 min-h-[60vh]` which relied on the parent flex
      // column resolving height correctly — on iOS Safari that
      // sometimes settled AFTER Leaflet had already measured 0,
      // contributing to "blank dark rectangle" reports.
      //
      // The deterministic `h-[70vh] min-h-[420px]` removes the
      // flex dependency entirely: the wrapper is always 70 % of
      // the viewport (or at least 420 px on very short viewports —
      // covers iPhone SE in landscape, fold devices, etc.).
      // `MapResizer` below also calls `invalidateSize()` post-mount
      // so any residual mid-init layout change is corrected.
      className="relative h-[70vh] min-h-[420px] w-full overflow-hidden rounded-lg border border-border"
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
          const variant = pinVariantFor(item);
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
                  {item.last_visit_at && (
                    <p className="text-[11px] text-muted-foreground">
                      Last visit{" "}
                      <span className="font-medium text-foreground/80">
                        {formatActivityStamp(item.last_visit_at)}
                      </span>
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
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => onLogVisit(item.id)}
                      disabled={logging || disabled}
                    >
                      {logging ? "Logging…" : "Log visit"}
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
      </MapContainer>
    </div>
  );
}
