/**
 * Display helpers shared by the Map's pin popup and its stacked-office popup,
 * kept out of the Leaflet component so they can be unit-tested.
 */
import type { OfficeMapPinItem } from "@/lib/offices";

/** "123 Main St, San Antonio" — the one-line address shown under an office's
 *  name in pin popups. Chains reuse one name across many branches, so the name
 *  alone doesn't identify which office a pin is. */
export function addressLine(item: OfficeMapPinItem): string | null {
  const line = [item.street, item.city]
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0)
    .join(", ");
  return line.length > 0 ? line : null;
}

/** Builds a Google Maps URL for an office row. Mirrors the page
 *  helper so the Map view's Directions button behaves identically. */
export function mapsUrlFor(item: OfficeMapPinItem): string | null {
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

/** YYYY-MM-DD → "Jun 5, 2026" — local-TZ safe (no `new Date(str)`
 *  TZ-shift). */
export function formatDueDate(value: string | null): string | null {
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
