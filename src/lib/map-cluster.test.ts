import { describe, expect, it } from "vitest";

import {
  CLUSTER_MAX_ZOOM,
  CLUSTER_MIN_ITEMS,
  clusterForView,
  padBounds,
  projectToPixels,
  type ClusterPoint,
  type ViewBounds,
} from "./map-cluster";

const WORLD: ViewBounds = { south: -90, west: -180, north: 90, east: 180 };

function pt(id: string, latitude: number, longitude: number): ClusterPoint {
  return { id, latitude, longitude };
}

/** n distinct points on a fine lattice around downtown San Antonio. */
function lattice(n: number): ClusterPoint[] {
  return Array.from({ length: n }, (_, i) =>
    pt(`p${i}`, 29.4 + (i % 100) * 0.003, -98.6 + Math.floor(i / 100) * 0.003),
  );
}

describe("projectToPixels", () => {
  it("doubles pixel distance per zoom level", () => {
    const a = projectToPixels(29.4, -98.5, 10);
    const b = projectToPixels(29.4, -98.5, 11);
    expect(b.x).toBeCloseTo(a.x * 2, 6);
    expect(b.y).toBeCloseTo(a.y * 2, 6);
  });

  it("stays finite at the poles", () => {
    expect(Number.isFinite(projectToPixels(90, 0, 5).y)).toBe(true);
    expect(Number.isFinite(projectToPixels(-90, 0, 5).y)).toBe(true);
  });
});

describe("padBounds", () => {
  it("grows every side by the given fraction", () => {
    const p = padBounds({ south: 0, west: 0, north: 10, east: 20 }, 0.5);
    expect(p).toEqual({ south: -5, west: -10, north: 15, east: 30 });
  });
});

describe("clusterForView — small territory", () => {
  it("renders every pin individually (no grid clustering) at or under the threshold", () => {
    const items = lattice(CLUSTER_MIN_ITEMS);
    const r = clusterForView(items, { zoom: 8, bounds: WORLD });
    expect(r.groups).toHaveLength(0);
    expect(r.singles).toHaveLength(CLUSTER_MIN_ITEMS);
  });

  it("returns only pins inside the supplied bounds", () => {
    const items = [pt("in", 29.4, -98.5), pt("out", 40.7, -111.9)];
    const r = clusterForView(items, {
      zoom: 10,
      bounds: { south: 29, west: -99, north: 30, east: -98 },
    });
    expect(r.singles.map((s) => s.id)).toEqual(["in"]);
  });
});

describe("clusterForView — stacks (co-located offices)", () => {
  it("collapses offices at the same coordinates into one stack, even in a small territory", () => {
    const items = [
      pt("a", 29.4617, -98.6203),
      pt("b", 29.4617, -98.6203),
      pt("c", 29.4617, -98.6203),
      pt("d", 29.5, -98.5),
    ];
    const r = clusterForView(items, { zoom: 12, bounds: WORLD });
    expect(r.singles.map((s) => s.id)).toEqual(["d"]);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].colocated).toBe(true);
    expect(r.groups[0].items.map((i) => i.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps stacks at max zoom, where grid clustering has stopped", () => {
    const items = [...lattice(CLUSTER_MIN_ITEMS + 10), pt("x", 29.4, -98.6), pt("y", 29.4, -98.6)];
    const r = clusterForView(items, { zoom: CLUSTER_MAX_ZOOM, bounds: WORLD });
    const stack = r.groups.find((g) => g.items.some((i) => i.id === "x"));
    expect(stack?.colocated).toBe(true);
    // Everything else is an individual pin at max zoom.
    expect(r.groups.every((g) => g.colocated)).toBe(true);
  });

  it("does not treat pins a few metres apart as the same spot", () => {
    const r = clusterForView(
      [pt("a", 29.4, -98.5), pt("b", 29.4001, -98.5)],
      { zoom: 14, bounds: WORLD },
    );
    expect(r.groups).toHaveLength(0);
    expect(r.singles).toHaveLength(2);
  });
});

describe("clusterForView — large territory", () => {
  const big = lattice(CLUSTER_MIN_ITEMS + 500);

  it("collapses a large territory into far fewer markers when zoomed out", () => {
    const r = clusterForView(big, { zoom: 9, bounds: WORLD });
    const markers = r.singles.length + r.groups.length;
    expect(markers).toBeLessThan(big.length / 10);
    // Nothing is lost: every pin is in exactly one place.
    const total =
      r.singles.length + r.groups.reduce((n, g) => n + g.items.length, 0);
    expect(total).toBe(big.length);
  });

  it("separates pins as the user zooms in", () => {
    const far = clusterForView(big, { zoom: 9, bounds: WORLD });
    const near = clusterForView(big, { zoom: 14, bounds: WORLD });
    expect(near.singles.length + near.groups.length).toBeGreaterThan(
      far.singles.length + far.groups.length,
    );
  });

  it("is anchored to the world grid: the same pins cluster identically regardless of viewport", () => {
    const wide = clusterForView(big, { zoom: 11, bounds: WORLD });
    const narrowBounds = { south: 29.5, west: -98.5, north: 29.6, east: -98.4 };
    const narrow = clusterForView(big, { zoom: 11, bounds: narrowBounds });
    const wideKeys = new Set(wide.groups.map((g) => g.key));
    for (const g of narrow.groups) expect(wideKeys.has(g.key)).toBe(true);
  });

  it("reports cluster bounds that contain every member", () => {
    const r = clusterForView(big, { zoom: 10, bounds: WORLD });
    for (const g of r.groups) {
      for (const it of g.items) {
        expect(it.latitude).toBeGreaterThanOrEqual(g.bounds.south);
        expect(it.latitude).toBeLessThanOrEqual(g.bounds.north);
        expect(it.longitude).toBeGreaterThanOrEqual(g.bounds.west);
        expect(it.longitude).toBeLessThanOrEqual(g.bounds.east);
      }
    }
  });

  it("stops grid clustering at CLUSTER_MAX_ZOOM", () => {
    const r = clusterForView(big, { zoom: CLUSTER_MAX_ZOOM, bounds: WORLD });
    expect(r.groups).toHaveLength(0);
    expect(r.singles).toHaveLength(big.length);
  });
});
