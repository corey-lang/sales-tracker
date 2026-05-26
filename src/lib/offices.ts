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
 * Sandbox flag stored on every offices / office_visits / batch row.
 *
 * Why a string column rather than a boolean: the same dataset will
 * eventually carry both kinds of records, and a self-documenting tag
 * keeps query plans + Vercel logs grep-friendly. The CHECK constraint
 * in the migration pins this to exactly two values.
 *
 * For the MVP, the import route hard-rejects anything but `"test"` so
 * a sandbox-only rollout is enforced server-side. The `"production"`
 * value already exists on the schema's CHECK so flipping live is a
 * one-line route change, not a migration.
 */
export const OFFICE_ENVIRONMENTS = ["test", "production"] as const;
export type OfficeEnvironment = (typeof OFFICE_ENVIRONMENTS)[number];

export function isOfficeEnvironment(
  value: unknown,
): value is OfficeEnvironment {
  return value === "test" || value === "production";
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
 * Aggregate "open this office" payload — what the future office-detail
 * surface (and any map detail popover) will fetch in one round trip.
 *
 * Composed of:
 *   * The office row itself, including the persistent `office_notes`
 *     and `next_action` memory.
 *   * The visit log, newest-first. May be capped by the read route at
 *     a sane upper bound (the future UI's "Visit History" timeline
 *     paginates via a separate older-history call if needed).
 *   * `last_visit_at` — the `visited_at` of the most recent visit, or
 *     null when the office has never been visited. Derived so the UI
 *     doesn't have to peek into the visits array.
 *   * `visit_count` — the AUTHORITATIVE count of visits, NOT
 *     visits.length. The read route uses Postgres COUNT(*) so this
 *     stays accurate even if visits was capped.
 */
export type OfficeDetail = {
  office: OfficeRow;
  visits: OfficeVisitRow[];
  last_visit_at: string | null;
  visit_count: number;
};

/**
 * Visible cap on the visits returned in OfficeDetail. The
 * authoritative `visit_count` is reported separately, so the UI can
 * show "27 visits" even when only the most-recent 200 ship inline.
 * Older history can be fetched on demand by a future paginated route.
 */
export const OFFICE_VISITS_DETAIL_LIMIT = 200;

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
