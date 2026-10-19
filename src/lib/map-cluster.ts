/**
 * Pure marker-clustering helpers for the office Map (no Leaflet import, safe
 * on server and client, unit-tested).
 *
 * WHY THIS EXISTS
 *   The Map used to render one Leaflet <Marker> per office. That is fine for
 *   a few hundred pins but a ~6,000-office territory (San Antonio) would put
 *   thousands of DOM nodes on a phone. This module decides, for the current
 *   viewport, which offices render as individual pins and which collapse into
 *   a count bubble. It adds no dependency and no new data path — the Map still
 *   loads the same /api/offices/map response and applies the same filters.
 *
 * TWO KINDS OF GROUPING
 *   1. Grid clusters — only for LARGE territories (> CLUSTER_MIN_ITEMS pins)
 *      and only below CLUSTER_MAX_ZOOM. Pins that land in the same
 *      CLUSTER_CELL_PX-sized screen cell collapse into one bubble. Cells are
 *      anchored to the world pixel grid (not the viewport), so panning never
 *      reshuffles membership. Territories at or under the threshold behave
 *      exactly as before: every pin renders individually.
 *   2. Stacks — ALWAYS, at every zoom and territory size. Offices at the same
 *      coordinates (a multi-tenant building, or several MLS offices sharing
 *      one address) would otherwise sit on top of each other and only the top
 *      pin would be tappable. A stack renders as one bubble whose popup lists
 *      every office in it.
 */

/**
 * Territories at or below this many (filtered) pins never grid-cluster.
 *
 * 1,000 is the most individual pins the Map ever rendered before clustering
 * existed (PostgREST silently capped every response at 1,000 rows), so no AE
 * is asked to render more individual pins than they already were — and
 * territories under it look exactly as they always have. Above it, a 1,300-pin
 * view measured ~1 s of main-thread work on a throttled phone vs ~0.1 s
 * clustered.
 */
export const CLUSTER_MIN_ITEMS = 1_000;

/** At or above this zoom, grid clustering stops; only exact stacks remain. */
export const CLUSTER_MAX_ZOOM = 16;

/** Grid cell edge, in screen pixels. */
export const CLUSTER_CELL_PX = 64;

/** ~1 metre at the equator — pins closer than this are treated as co-located. */
const COLOCATED_PRECISION = 1e-5;

export type ClusterPoint = {
  id: string;
  latitude: number;
  longitude: number;
};

export type ViewBounds = {
  south: number;
  west: number;
  north: number;
  east: number;
};

export type PinGroup<T extends ClusterPoint> = {
  /** Stable React key — derived from cell / coordinates, not from order. */
  key: string;
  latitude: number;
  longitude: number;
  items: T[];
  /** True when every member shares (effectively) the same coordinates —
   *  zooming in can never separate them, so the UI lists them instead. */
  colocated: boolean;
  /** Tight bounds around the members, for zoom-to-cluster. */
  bounds: ViewBounds;
};

export type ClusterResult<T extends ClusterPoint> = {
  /** Offices that render as ordinary individual pins. */
  singles: T[];
  /** Grid clusters and co-located stacks (always >= 2 members each). */
  groups: PinGroup<T>[];
};

/** Web-Mercator world pixel coordinates at `zoom` (256px tiles). */
export function projectToPixels(
  latitude: number,
  longitude: number,
  zoom: number,
): { x: number; y: number } {
  const scale = 256 * 2 ** zoom;
  const sin = Math.sin((latitude * Math.PI) / 180);
  // Clamp so a bad latitude can't produce ±Infinity.
  const clamped = Math.min(Math.max(sin, -0.9999), 0.9999);
  return {
    x: ((longitude + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + clamped) / (1 - clamped)) / (4 * Math.PI)) * scale,
  };
}

/** Grows `bounds` by `fraction` of its size on every side (>= 0). */
export function padBounds(bounds: ViewBounds, fraction: number): ViewBounds {
  const dLat = (bounds.north - bounds.south) * fraction;
  const dLng = (bounds.east - bounds.west) * fraction;
  return {
    south: bounds.south - dLat,
    north: bounds.north + dLat,
    west: bounds.west - dLng,
    east: bounds.east + dLng,
  };
}

function inBounds(p: ClusterPoint, b: ViewBounds): boolean {
  return (
    p.latitude >= b.south &&
    p.latitude <= b.north &&
    p.longitude >= b.west &&
    p.longitude <= b.east
  );
}

function groupFrom<T extends ClusterPoint>(key: string, items: T[]): PinGroup<T> {
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  let latSum = 0;
  let lngSum = 0;
  for (const it of items) {
    south = Math.min(south, it.latitude);
    north = Math.max(north, it.latitude);
    west = Math.min(west, it.longitude);
    east = Math.max(east, it.longitude);
    latSum += it.latitude;
    lngSum += it.longitude;
  }
  const colocated =
    north - south <= COLOCATED_PRECISION && east - west <= COLOCATED_PRECISION;
  return {
    key,
    latitude: latSum / items.length,
    longitude: lngSum / items.length,
    items,
    colocated,
    bounds: { south, west, north, east },
  };
}

/** Splits `points` into singles + groups using `keyOf` to bucket them. */
function bucket<T extends ClusterPoint>(
  points: T[],
  keyOf: (p: T) => string,
  prefix: string,
): ClusterResult<T> {
  const buckets = new Map<string, T[]>();
  for (const p of points) {
    const k = keyOf(p);
    const list = buckets.get(k);
    if (list) list.push(p);
    else buckets.set(k, [p]);
  }
  const singles: T[] = [];
  const groups: PinGroup<T>[] = [];
  for (const [k, list] of buckets) {
    if (list.length === 1) singles.push(list[0]);
    else groups.push(groupFrom(`${prefix}:${k}`, list));
  }
  return { singles, groups };
}

/**
 * Decides what to draw for the current view.
 *
 * `bounds` should already be padded (see `padBounds`) so pins just off-screen
 * are ready when the user pans. Only pins inside `bounds` are returned.
 */
export function clusterForView<T extends ClusterPoint>(
  items: readonly T[],
  view: { zoom: number; bounds: ViewBounds },
  options: {
    minItems?: number;
    maxZoom?: number;
    cellPx?: number;
  } = {},
): ClusterResult<T> {
  const minItems = options.minItems ?? CLUSTER_MIN_ITEMS;
  const maxZoom = options.maxZoom ?? CLUSTER_MAX_ZOOM;
  const cellPx = options.cellPx ?? CLUSTER_CELL_PX;

  const visible = items.filter((p) => inBounds(p, view.bounds));

  const gridClustering = items.length > minItems && view.zoom < maxZoom;
  if (gridClustering) {
    return bucket(
      visible,
      (p) => {
        const { x, y } = projectToPixels(p.latitude, p.longitude, view.zoom);
        return `${Math.floor(x / cellPx)}:${Math.floor(y / cellPx)}`;
      },
      `z${view.zoom}`,
    );
  }

  // Individual pins — but never let offices on the same spot hide each other.
  return bucket(
    visible,
    (p) =>
      `${Math.round(p.latitude / COLOCATED_PRECISION)}:${Math.round(
        p.longitude / COLOCATED_PRECISION,
      )}`,
    "stack",
  );
}
