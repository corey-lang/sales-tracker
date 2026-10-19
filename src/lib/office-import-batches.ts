/**
 * Client-side helpers for importing a large office file as several requests.
 *
 * The importer endpoint accepts at most 5,000 rows per request. Larger files
 * (a metro-sized list can be 6,000+) are split into consecutive batches that
 * share ONE provenance row: the first response's `batch_id` is passed back on
 * every later request. The endpoint matches against the AE's CURRENT offices
 * on every request, so:
 *   * an office repeated across batches matches the one an earlier batch made
 *     — it can't duplicate;
 *   * re-sending a batch that already succeeded changes nothing — which is
 *     exactly what makes a failed run resumable from the failed batch.
 */

/** Rows per request. Well under the 5,000 server cap so each request stays
 *  inside the function time budget and a failure re-sends little. */
export const IMPORT_BATCH_SIZE = 1_000;

/** Whole-file ceiling the page accepts (the server limit applies per request). */
export const IMPORT_MAX_FILE_ROWS = 50_000;

export type RowReport = { row: number; reason: string };

export type ConflictReport = {
  row: number;
  office_id: string;
  office_name: string;
  field: string;
  existing: string | null;
  incoming: string | null;
  reason: string;
};

export type ReviewReport = {
  row: number;
  office_name: string;
  candidate_id: string;
  candidate_name: string;
  candidate_street: string | null;
  reason: string;
};

export type BatchResult = {
  batch_id: string | null;
  source: string;
  environment: string;
  created: number;
  updated: number;
  /** Matched an existing office; nothing to add. */
  unchanged?: number;
  total_rows: number;
  skipped: RowReport[];
  errors: RowReport[];
  flagged?: RowReport[];
  flagged_total?: number;
  conflicts?: ConflictReport[];
  conflicts_total?: number;
  /** New offices that might be a corrected copy of an existing one. */
  review?: ReviewReport[];
  review_total?: number;
  warning?: string;
};

/** Keeps the merged lists from growing without bound across many batches. */
export const MERGED_LIST_CAP = 2_000;

export function batchCount(totalRows: number, size = IMPORT_BATCH_SIZE): number {
  return Math.ceil(totalRows / size);
}

export function batchSlice<T>(rows: readonly T[], batchIndex: number, size = IMPORT_BATCH_SIZE): T[] {
  return rows.slice(batchIndex * size, (batchIndex + 1) * size);
}

export function emptyResult(source: string): BatchResult {
  return {
    batch_id: null,
    source,
    environment: "production",
    created: 0,
    updated: 0,
    unchanged: 0,
    total_rows: 0,
    skipped: [],
    errors: [],
    flagged: [],
    flagged_total: 0,
    conflicts: [],
    conflicts_total: 0,
    review: [],
    review_total: 0,
  };
}

/**
 * Folds one batch's response into the running total. Row numbers inside a
 * response are relative to that request, so they are shifted by `rowOffset`
 * (the number of rows sent before it) to refer to the row in the whole file.
 */
export function mergeBatchResult(
  acc: BatchResult,
  next: BatchResult,
  rowOffset: number,
): BatchResult {
  const shift = <T extends { row: number }>(list: T[] | undefined): T[] =>
    (list ?? []).map((r) => ({ ...r, row: r.row + rowOffset }));
  const cap = <T,>(list: T[]) => list.slice(0, MERGED_LIST_CAP);
  return {
    batch_id: next.batch_id ?? acc.batch_id,
    source: next.source,
    environment: next.environment,
    created: acc.created + next.created,
    updated: acc.updated + next.updated,
    unchanged: (acc.unchanged ?? 0) + (next.unchanged ?? 0),
    total_rows: acc.total_rows + next.total_rows,
    skipped: cap([...acc.skipped, ...shift(next.skipped)]),
    errors: cap([...acc.errors, ...shift(next.errors)]),
    flagged: cap([...(acc.flagged ?? []), ...shift(next.flagged)]),
    flagged_total: (acc.flagged_total ?? 0) + (next.flagged_total ?? next.flagged?.length ?? 0),
    conflicts: cap([...(acc.conflicts ?? []), ...shift(next.conflicts)]),
    conflicts_total:
      (acc.conflicts_total ?? 0) + (next.conflicts_total ?? next.conflicts?.length ?? 0),
    review: cap([...(acc.review ?? []), ...shift(next.review)]),
    review_total: (acc.review_total ?? 0) + (next.review_total ?? next.review?.length ?? 0),
    warning: next.warning ?? acc.warning,
  };
}

/** Every sent row is accounted for in exactly one bucket. */
export function accountedRows(r: BatchResult): number {
  return r.created + r.updated + (r.unchanged ?? 0) + r.skipped.length + r.errors.length;
}

/**
 * One-line, human reconciliation of a result, e.g.
 * "6,401 processed = 5,909 new + 492 updated + 0 unchanged + 0 skipped + 0 errors".
 */
export function reconciliationLine(r: BatchResult): string {
  const n = (x: number) => x.toLocaleString("en-US");
  return `${n(r.total_rows)} processed = ${n(r.created)} new + ${n(r.updated)} updated + ${n(
    r.unchanged ?? 0,
  )} unchanged + ${n(r.skipped.length)} skipped + ${n(r.errors.length)} errors`;
}
