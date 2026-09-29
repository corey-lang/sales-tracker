// Complete result sets from PostgREST, which caps every response (Supabase's
// API max rows, 1000 by default) WITHOUT signalling truncation.
//
// Reporting rule: resolve the eligible (real, `is_test = false`) salesperson
// ids FIRST, filter to them IN the query, and page through the result — never
// fetch broadly and drop test rows afterwards (test rows would otherwise use
// up response slots and silently push real rows out), and never trust one
// page to be the whole answer (large real datasets would be truncated too).

/** Rows per request. At or below the API cap so a full page means "maybe more". */
export const PAGE_SIZE = 1000;

/** Max ids per `.in()` filter — keeps request URLs well under gateway limits. */
export const ID_CHUNK = 200;

type Page = PromiseLike<{
  data: unknown;
  error: { code?: string; message: string } | null;
}>;

/**
 * Pages a query to completion. `build` must return a fresh query with a
 * DETERMINISTIC order (end with a unique column, e.g. `.order("id")`) so
 * pages neither overlap nor skip rows.
 */
export async function selectAllPages<T>(
  build: () => { range: (from: number, to: number) => Page },
): Promise<{ data: T[]; error: { code?: string; message: string } | null }> {
  const out: T[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await build().range(offset, offset + PAGE_SIZE - 1);
    if (page.error) return { data: [], error: page.error };
    const rows = (page.data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) return { data: out, error: null };
  }
}

/** `selectAllPages` over id chunks, for `.in(column, ids)` filters. */
export async function selectAllPagesForIds<T>(
  ids: readonly string[],
  build: (chunk: string[]) => { range: (from: number, to: number) => Page },
): Promise<{ data: T[]; error: { code?: string; message: string } | null }> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK) as string[];
    const res = await selectAllPages<T>(() => build(chunk));
    if (res.error) return res;
    out.push(...res.data);
  }
  return { data: out, error: null };
}

/**
 * `weekly_goals` rows that can apply to these salespeople: their own
 * per-person rows plus the global (NULL) rows — never other people's. Paged.
 */
export function goalScopeOr(ids: readonly string[]): string {
  return ids.length
    ? `salesperson_id.is.null,salesperson_id.in.(${ids.join(",")})`
    : "salesperson_id.is.null";
}
