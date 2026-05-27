/**
 * Lightweight geo helpers — Haversine distance + bounding-box
 * computation for "find offices within R miles of (lat, lng)" queries.
 *
 * Server-AND-client safe: no Node-only or browser-only imports. The
 * /api/offices/nearby route uses both helpers; the page could
 * eventually re-use `haversineMiles` if it wants a client-side
 * "where am I relative to this office" hint.
 *
 * Accuracy: good enough for a 5-25 mile office radius at temperate
 * latitudes. Not appropriate for cross-pole routes, sub-mile precision,
 * or great-circle navigation problems. Office CRM nearby search is
 * exactly the sweet spot.
 */

/** Earth's mean radius in miles. */
export const EARTH_RADIUS_MILES = 3958.7613;

/** Length of one degree of latitude, in miles. Effectively constant
 *  across the globe (the meridian doesn't change much with latitude). */
export const MILES_PER_DEG_LAT = 69.0;

/**
 * Haversine distance in miles between two (lat, lng) points.
 * Inputs are degrees.
 */
export function haversineMiles(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_MILES * c;
}

/**
 * Returns a min/max lat/lng box covering a circle of `radiusMiles`
 * around `(lat, lng)`. Used to push a cheap, indexable filter into
 * the SQL query before refining the candidates with Haversine in JS.
 *
 * The box is intentionally a small percentage WIDER than the true
 * circle (the circle inscribes the box; the box's corners stick
 * out past the radius) — the Haversine refinement throws away the
 * overshoot, but a tight box would risk dropping points near the
 * cardinal extremes if rounding nudged them just outside. The 5%
 * margin is plenty for the radii we accept (5/10/25 mi).
 */
export function boundingBox(
  lat: number,
  lng: number,
  radiusMiles: number,
): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  const margin = radiusMiles * 1.05;
  const latDelta = margin / MILES_PER_DEG_LAT;
  // Longitude degrees shrink with latitude; clamp `cos(lat)` away from
  // zero so we don't divide by ~0 near the poles. The clamp value
  // corresponds to ~89.99°, well past any realistic office latitude.
  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 0.0001);
  const lngDelta = margin / (MILES_PER_DEG_LAT * cosLat);
  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta,
  };
}
