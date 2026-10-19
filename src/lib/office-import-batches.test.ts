import { describe, expect, it } from "vitest";

import {
  IMPORT_BATCH_SIZE,
  accountedRows,
  batchCount,
  batchSlice,
  emptyResult,
  mergeBatchResult,
  reconciliationLine,
  type BatchResult,
} from "./office-import-batches";

describe("batching", () => {
  it("splits a 6,427-row file into consecutive batches that cover every row exactly once", () => {
    const rows = Array.from({ length: 6_427 }, (_, i) => i);
    const n = batchCount(rows.length);
    expect(n).toBe(7);
    const back = Array.from({ length: n }, (_, b) => batchSlice(rows, b)).flat();
    expect(back).toEqual(rows);
    expect(batchSlice(rows, 6)).toHaveLength(6_427 - 6 * IMPORT_BATCH_SIZE);
  });

  it("keeps every batch under the server's 5,000-row request limit", () => {
    expect(IMPORT_BATCH_SIZE).toBeLessThanOrEqual(5_000);
  });
});

const batch = (over: Partial<BatchResult>): BatchResult => ({
  ...emptyResult("t"),
  batch_id: "b1",
  ...over,
});

describe("mergeBatchResult", () => {
  it("sums counts and keeps the first response's batch id", () => {
    const a = mergeBatchResult(emptyResult("t"), batch({ created: 5, updated: 1, unchanged: 2, total_rows: 8 }), 0);
    const b = mergeBatchResult(a, batch({ batch_id: "b1", created: 3, unchanged: 4, total_rows: 7 }), 1000);
    expect(b).toMatchObject({ batch_id: "b1", created: 8, updated: 1, unchanged: 6, total_rows: 15 });
  });

  it("shifts row numbers so they refer to the row in the WHOLE file", () => {
    const a = mergeBatchResult(emptyResult("t"), batch({ skipped: [{ row: 3, reason: "x" }], total_rows: 10 }), 0);
    const b = mergeBatchResult(
      a,
      batch({
        skipped: [{ row: 2, reason: "y" }],
        errors: [{ row: 5, reason: "z" }],
        flagged: [{ row: 1, reason: "f" }],
        flagged_total: 1,
        total_rows: 10,
      }),
      2_000,
    );
    expect(b.skipped.map((r) => r.row)).toEqual([3, 2_002]);
    expect(b.errors.map((r) => r.row)).toEqual([2_005]);
    expect(b.flagged?.map((r) => r.row)).toEqual([2_001]);
  });

  it("tracks true conflict totals even when the list is capped", () => {
    const r = mergeBatchResult(
      emptyResult("t"),
      batch({ conflicts: [], conflicts_total: 900, total_rows: 1 }),
      0,
    );
    expect(r.conflicts_total).toBe(900);
  });

  it("accounts for every sent row (created + updated + unchanged + skipped + errors)", () => {
    const r = mergeBatchResult(
      emptyResult("t"),
      batch({
        created: 6,
        updated: 1,
        unchanged: 1,
        skipped: [{ row: 9, reason: "s" }],
        errors: [{ row: 10, reason: "e" }],
        total_rows: 10,
      }),
      0,
    );
    expect(accountedRows(r)).toBe(r.total_rows);
  });
});

describe("reconciliationLine", () => {
  it("states processed = new + updated + unchanged + skipped + errors", () => {
    const r = batch({ created: 5909, updated: 492, unchanged: 0, total_rows: 6401 });
    expect(reconciliationLine(r)).toBe(
      "6,401 processed = 5,909 new + 492 updated + 0 unchanged + 0 skipped + 0 errors",
    );
    expect(accountedRows(r)).toBe(r.total_rows);
  });
  it("merges review items with file-wide row numbers", () => {
    const item = { row: 2, office_name: "X", candidate_id: "c", candidate_name: "Y", candidate_street: null, reason: "r" };
    const m = mergeBatchResult(emptyResult("t"), batch({ review: [item], review_total: 1, total_rows: 5 }), 1000);
    expect(m.review?.[0].row).toBe(1002);
    expect(m.review_total).toBe(1);
  });
});
