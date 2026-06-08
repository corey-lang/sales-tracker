/**
 * Shared types + constants for the Map / Office Visits MVP.
 *
 * Safe to import from both client and server — contains no server-only
 * imports. Tables created by `supabase/offices.sql` (migration #25).
 */

/** Table names — kept here so a future rename only touches one place. */
export const OFFICES_TABLE = "offices" as const;
export const OFFICE_VISITS_TABLE = "office_visits" as const;
export const OFFICE_IMPORT_BATCHES_TABLE = "office_import_batches" as const;

/**
 * Environment slice stored on every offices / office_visits / batch row.
 *
 * Why a string column rather than a boolean: the same dataset carries
 * both kinds of records, and a self-documenting tag keeps query plans
 * + Vercel logs grep-friendly. The CHECK constraint in the migration
 * pins this to exactly two values.
 *
 * Every read/write goes through `officeEnvironmentFor(caller)` below
 * so the slice is derived from identity, never trusted from the wire:
 * real AEs land in `"production"`, the test account stays in `"test"`.
 * Each slice is invisible to the other.
 */
export const OFFICE_ENVIRONMENTS = ["test", "production"] as const;
export type OfficeEnvironment = (typeof OFFICE_ENVIRONMENTS)[number];

export function isOfficeEnvironment(
  value: unknown,
): value is OfficeEnvironment {
  return value === "test" || value === "production";
}

/**
 * Returns the office-table `environment` slice the calling salesperson
 * operates in.
 *
 *   * Test account (`is_test === true`) → `"test"`. Keeps the test
 *     data + workflow they already had during the sandbox phase
 *     untouched after production rollout.
 *   * Every other AE → `"production"`. Real AE office routes
 *     read/write the production slice; their data is invisible to
 *     the test account and vice-versa.
 *
 * Server routes call this on the authenticated caller; the import
 * route calls it on each resolved AE (so a batch can land rows in
 * `"test"` or `"production"` per-row based on the AE the row
 * targets). Centralizing the rule here keeps the "which slice"
 * decision out of the routes themselves — they just say
 * `officeEnvironmentFor(me)` and trust it.
 */
export function officeEnvironmentFor(salesperson: {
  is_test: boolean;
}): OfficeEnvironment {
  return salesperson.is_test ? "test" : "production";
}

/**
 * One imported office record, post-resolution.
 *
 * Required columns: `name` + `salesperson_id` + `environment`. Everything
 * else is nullable because real CSVs are sparse (an import may carry
 * names + addresses but no lat/lng yet — those get geocoded later).
 *
 * `office_notes` + `next_action` (migration #27) are the persistent
 * "office memory" — long-term reference info and the next-step intent.
 * Both start NULL on import; the future office-detail UI will edit them.
 */
export type OfficeRow = {
  id: string;
  salesperson_id: string;
  import_batch_id: string | null;
  name: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  latitude: number | null;
  longitude: number | null;
  source: string | null;
  dedupe_key: string;
  environment: OfficeEnvironment;
  /** Persistent reference info. Survives across visits. */
  office_notes: string | null;
  /** Persistent next-step intent. Survives across visits. */
  next_action: string | null;
  /** Optional due date paired with `next_action`. YYYY-MM-DD; nullable
   *  even when `next_action` is set (a follow-up may not yet be
   *  scheduled). Stored as DATE in Postgres — see
   *  offices_next_action_due_date.sql for why we don't use TIMESTAMPTZ. */
  next_action_due_date: string | null;
  /** Contact phone (`_Phone` in Badger). Refreshed on every import —
   *  contact info is factual source-system data, not AE-edited. */
  office_phone: string | null;
  /** Contact email (`_Email` in Badger). Refreshed on every import. */
  office_email: string | null;
  /** Opaque Badger-side UUID (`_CustomerId`). Stored so future surfaces
   *  can deep-link back to the Badger record; not yet part of the
   *  dedupe key — see offices_badger_fields.sql. */
  external_badger_id: string | null;
  /** Soft-delete timestamp. NULL on every active row; non-null after
   *  the AE archives the office via DELETE /api/offices/[id]. Every
   *  office read surface filters `archived_at IS NULL`, so archived
   *  rows are hidden from List, Map, detail, and visit logging while
   *  preserving the underlying office_visits + ae_tasks FK targets.
   *  See offices_archived_at.sql for the full rationale. */
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * One per-rep visit log entry.
 *
 * `note` is the visit's free-text note — the "what happened on this
 * trip" memory ("Dropped off donuts", "Met with Sarah and Mike",
 * "Follow up next week"). It's per-visit and historical, distinct
 * from the per-office persistent `office_notes` / `next_action` on
 * `OfficeRow`.
 */
export type OfficeVisitRow = {
  id: string;
  office_id: string;
  salesperson_id: string;
  note: string | null;
  visited_at: string;
  environment: OfficeEnvironment;
  created_at: string;
};

/** Provenance row created once per CSV import. */
export type OfficeImportBatchRow = {
  id: string;
  source: string;
  uploaded_by: string;
  environment: OfficeEnvironment;
  row_count: number;
  created_at: string;
};

/**
 * Aggregate "open this office" payload.
 *
 * Composed of:
 *   * The office row itself, including the persistent `office_notes`
 *     and `next_action` memory.
 *   * The visit log, newest-first, capped at OFFICE_VISITS_DETAIL_LIMIT.
 *   * `last_visit_at` — the `visited_at` of the most recent visit, or
 *     null when the office has never been visited. Derived so the UI
 *     doesn't have to peek into the visits array.
 *   * `visit_count` — derived from `visits.length`. Accurate when
 *     visit history fits in the inline cap (every realistic
 *     AE-office pair); for the edge case where a single AE has more
 *     than OFFICE_VISITS_DETAIL_LIMIT visits to one office, the count
 *     under-reports — acceptable since the UI's timeline is anchored
 *     at "most recent N" anyway.
 *   * `visits_load_warning` — present and human-readable when the
 *     visits sub-query failed and the page is degrading to an empty
 *     timeline. Office row + notes + next action all still load; the
 *     UI surfaces the warning inline so the AE knows their existing
 *     visit history (if any) didn't render. Logging a new visit
 *     still works.
 *   * `read_only` — true when the caller is viewing an office they do
 *     NOT own (admin cross-AE view). The detail UI hides the owner-only
 *     actions (Log Visit / Edit / Archive) in this mode; the write
 *     routes reject non-owners independently, so this is a UX signal,
 *     not the security boundary.
 *   * `owner_first_name` — present only in the read_only admin view so
 *     the UI can label whose office it is ("Viewing Sarah's office").
 */
export type OfficeDetail = {
  office: OfficeRow;
  visits: OfficeVisitRow[];
  last_visit_at: string | null;
  visit_count: number;
  visits_load_warning?: string;
  read_only?: boolean;
  owner_first_name?: string;
};

/**
 * Visible cap on the visits returned in OfficeDetail. The
 * authoritative `visit_count` is reported separately, so the UI can
 * show "27 visits" even when only the most-recent 200 ship inline.
 * Older history can be fetched on demand by a future paginated route.
 */
export const OFFICE_VISITS_DETAIL_LIMIT = 200;

/**
 * One row in the calling AE's office list.
 *
 * Trimmed shape of `OfficeRow` — only the fields the list UI renders,
 * plus the visit-derived fields that decide row sort order.
 *
 *   * `last_visit_at` — `office_visits.visited_at` of the most recent
 *     visit by the calling AE against this office, or null when never
 *     visited. Drives the "visited first, never-visited last" sort.
 *   * `visit_count`   — total visits by the calling AE against this
 *     office. Surfaced inline so the list can show a count badge
 *     without a follow-up fetch.
 *
 * Both visit fields are scoped to the calling AE (and the env slice
 * returned by `officeEnvironmentFor(me)`), not the office globally —
 * the list is a personal "what have I done" read.
 */
export type OfficeListItem = {
  id: string;
  name: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  next_action: string | null;
  /** Paired with `next_action`. YYYY-MM-DD or null. */
  next_action_due_date: string | null;
  last_visit_at: string | null;
  visit_count: number;
};

/**
 * Allowed radii (miles) for the /offices/nearby search. Closed set
 * so the UI's segmented control + server-side Zod schema stay in
 * lockstep — adding a new option means changing one constant.
 */
export const NEARBY_RADIUS_OPTIONS = [5, 10, 25] as const;
export type NearbyRadius = (typeof NEARBY_RADIUS_OPTIONS)[number];

/** Default radius for the first paint of /offices/nearby. */
export const NEARBY_DEFAULT_RADIUS: NearbyRadius = 10;

/** Hard cap on offices returned by /api/offices/nearby. Mobile cards
 *  are roughly 1 KB each on the wire; 100 keeps payloads small while
 *  still covering the realistic AE-day "what's around me" pattern. */
export const NEARBY_RESULT_LIMIT = 100;

/**
 * One row of the /api/offices/nearby response. Trimmed shape of
 * OfficeRow + the visit-derived "last visit" timestamp + a computed
 * `distance_miles` so the UI never recomputes geometry client-side.
 *
 * Offices without coordinates are EXCLUDED from this response — the
 * server filter pins `latitude IS NOT NULL AND longitude IS NOT NULL`
 * so the type can hold non-null number fields without `| null`.
 */
export type NearbyOfficeItem = {
  id: string;
  name: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  latitude: number;
  longitude: number;
  /** Great-circle distance from the search origin, in miles. */
  distance_miles: number;
  /** Most-recent visit by the calling AE against this office, or
   *  null when never visited. */
  last_visit_at: string | null;
  next_action: string | null;
  next_action_due_date: string | null;
};

/**
 * Hard cap on rows returned to the office-list UI. The DB query fetches
 * a wider window (see OFFICE_LIST_QUERY_LIMIT) so the JS-side sort can
 * promote visited offices to the top before we slice; the user only
 * ever sees the first OFFICE_LIST_LIMIT rows. 200 keeps the response
 * mobile-friendly (~60KB) and matches the "find one in seconds" UX —
 * past 200, refining the search is faster than scrolling.
 */
export const OFFICE_LIST_LIMIT = 200;

/**
 * Pre-sort cap on rows pulled from `offices` before the JS sort runs.
 * Larger than OFFICE_LIST_LIMIT so the top-200 returned to the UI is
 * picked from a representative sample of the AE's full office set,
 * not just whichever 200 happened to come back alphabetically. For a
 * 2,000-row per-AE office set this returns the full set; for larger
 * sets the alphabetical DB-side order is good enough as a pre-filter.
 */
export const OFFICE_LIST_QUERY_LIMIT = 2_000;

/**
 * Normalizes a string for dedupe-key composition: lowercase, collapse
 * non-alphanumerics to a single space, then trim. "12 Main St., Suite #4"
 * and "12 main st suite 4" both produce "12 main st suite 4" so they
 * dedupe against each other.
 */
function normalizeForDedupe(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Composes the `dedupe_key` stored on each offices row. Three parts
 * separated by `|` so the partial UNIQUE index on
 * (salesperson_id, environment, dedupe_key) can do per-AE per-env
 * duplicate detection in a single INSERT.
 *
 * Parts: normalized name, normalized street, normalized zip. City and
 * state are deliberately NOT in the key — duplicate offices are
 * usually variations in the city/state spelling (e.g. "Orem" vs
 * "Orem, UT") that we still want to detect as the same office.
 */
export function buildOfficeDedupeKey(parts: {
  name: string;
  street?: string | null;
  zip?: string | null;
}): string {
  return [
    normalizeForDedupe(parts.name),
    normalizeForDedupe(parts.street),
    normalizeForDedupe(parts.zip),
  ].join("|");
}

// ---------------------------------------------------------------------------
// Map "Not visited" filters + route building (Lasso Route foundation V1)
// ---------------------------------------------------------------------------

/**
 * Visit-recency filters for the office map. "Not visited" is per the product
 * rule scoped to the LOGGED-IN AE's own assigned offices — and the only data
 * this operates on (the /api/offices/nearby response) is already AE-scoped
 * server-side, so applying these client-side never widens the data set.
 *
 *   all    — every mapped office (assigned, not archived, has coords).
 *   30/60/90 — last visit is null OR older than X days ago.
 *   never  — no visit has ever been logged for that office by this AE.
 */
export type OfficeVisitFilter = "all" | "30" | "60" | "90" | "never";

export const OFFICE_VISIT_FILTERS: {
  key: OfficeVisitFilter;
  label: string;
  /** Lookback window in days; null for "all"/"never". */
  days: number | null;
}[] = [
  { key: "all", label: "All", days: null },
  { key: "30", label: "Not visited 30d", days: 30 },
  { key: "60", label: "Not visited 60d", days: 60 },
  { key: "90", label: "Not visited 90d", days: 90 },
  { key: "never", label: "Never visited", days: null },
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Core "is this office stale by N days?" predicate, shared by the
 * preset 30/60/90 chips and the custom days-since-last-check-in input.
 *
 * Matches when the office has NEVER been visited (null last-visit) OR
 * its last visit is strictly older than `days` days before `nowMs`.
 * "Never visited" deliberately counts as stale so the same filter
 * surfaces both kinds of neglected offices — mirroring the long-
 * standing behavior of the preset chips.
 *
 * `days` is clamped to a sane floor of 0 so a stray negative input can
 * never invert the comparison; `nowMs` is injected so callers stay
 * testable / timezone-explicit.
 */
export function officeMatchesDaysSince(
  lastVisitAt: string | null,
  days: number,
  nowMs: number,
): boolean {
  if (lastVisitAt === null) return true; // never visited → counts as stale
  const visitedMs = Date.parse(lastVisitAt);
  if (Number.isNaN(visitedMs)) return true; // unparseable → treat as stale, not hidden
  const threshold = Math.max(0, days);
  return visitedMs < nowMs - threshold * MS_PER_DAY;
}

/**
 * Does an office match a visit filter, given its last-visit timestamp?
 *   * all   → always true.
 *   * never → last_visit_at is null.
 *   * N     → last_visit_at is null OR strictly older than (now - N days).
 * `nowMs` is injected so callers stay testable / timezone-explicit.
 *
 * The numeric "custom days since" filter is NOT handled here — callers
 * branch to `officeMatchesDaysSince` for that since it takes an
 * arbitrary day count rather than one of the closed preset keys.
 */
export function officeMatchesVisitFilter(
  lastVisitAt: string | null,
  filter: OfficeVisitFilter,
  nowMs: number,
): boolean {
  if (filter === "all") return true;
  if (filter === "never") return lastVisitAt === null;
  const days = filter === "30" ? 30 : filter === "60" ? 60 : 90;
  return officeMatchesDaysSince(lastVisitAt, days, nowMs);
}

// ---------------------------------------------------------------------------
// Today's Check-ins (visit-log feed) — shared types + date-range resolver
// ---------------------------------------------------------------------------

/**
 * Closed set of quick ranges for the Check-ins feed. `custom` reveals a
 * from/to date picker; the rest are computed relative to "today" in the
 * app's business timezone (America/Denver) so a late-night check-in
 * reads on the right calendar day regardless of the viewer's device TZ.
 */
export type CheckinRange = "today" | "yesterday" | "7d" | "custom";

export function isCheckinRange(value: unknown): value is CheckinRange {
  return (
    value === "today" ||
    value === "yesterday" ||
    value === "7d" ||
    value === "custom"
  );
}

/**
 * Whose check-ins the feed shows.
 *   * `mine` — the calling AE's own visits (the everyday rule; the only
 *     scope a non-admin is ever allowed).
 *   * `team` — every AE's visits in the caller's environment. Admin-only,
 *     enforced server-side; the UI hides the Team toggle for non-admins.
 */
export type CheckinScope = "mine" | "team";

export function isCheckinScope(value: unknown): value is CheckinScope {
  return value === "mine" || value === "team";
}

/** Hard cap on rows returned by the Check-ins feed. Keeps the mobile
 *  payload small; for an 11-person team a day/week window is far under
 *  this. `truncated` flags the rare overflow so the UI can hint. */
export const CHECKINS_LIMIT = 200;

/**
 * One row in the Check-ins feed. A flattened `office_visits` row joined
 * to its office name + (for the team view) the AE who logged it.
 */
export type CheckinItem = {
  /** office_visits.id */
  id: string;
  office_id: string;
  office_name: string;
  salesperson_id: string;
  /** first_name of the AE who logged the visit. */
  salesperson_name: string;
  note: string | null;
  visited_at: string;
};

export type CheckinsResponse = {
  checkins: CheckinItem[];
  scope: CheckinScope;
  range: CheckinRange;
  /** Resolved inclusive calendar-day bounds (YYYY-MM-DD, Denver) — echoed
   *  back so the UI can label the window it actually queried. */
  from: string;
  to: string;
  truncated: boolean;
};

/**
 * Google Maps supports a limited number of stops in a single directions URL
 * (up to 9 intermediate waypoints + 1 destination via the `dir/?api=1` form).
 * With the rep's current location as the implicit origin, that's 10 office
 * stops in one route.
 */
export const MAX_ROUTE_STOPS = 10;
export const MIN_ROUTE_STOPS = 2;

export type RouteStop = { latitude: number; longitude: number };

/**
 * Builds a Google Maps DIRECTIONS url from selected offices, using lat/lng
 * waypoints. Origin is left implicit (Google uses the device's current
 * location). The last stop is the destination; the rest are ordered waypoints
 * — V1 does NOT optimize the route order.
 *
 * Returns `{ url }` on success or `{ error }` with friendly copy when there
 * are too few or too many stops.
 */
export function buildOfficeRouteUrl(
  stops: RouteStop[],
): { url: string; error?: undefined } | { url?: undefined; error: string } {
  if (stops.length < MIN_ROUTE_STOPS) {
    return { error: "Select at least 2 offices to create a route." };
  }
  if (stops.length > MAX_ROUTE_STOPS) {
    return { error: "Too many stops for one route. Select fewer offices." };
  }
  const coords = stops.map((s) => `${s.latitude},${s.longitude}`);
  const destination = coords[coords.length - 1];
  const waypoints = coords.slice(0, -1).join("|");
  const url =
    `https://www.google.com/maps/dir/?api=1&travelmode=driving` +
    `&destination=${encodeURIComponent(destination)}` +
    (waypoints ? `&waypoints=${encodeURIComponent(waypoints)}` : "");
  return { url };
}
