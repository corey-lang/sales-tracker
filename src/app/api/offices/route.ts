import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  badRequest,
  handleApiError,
  requireTestAccount,
} from "@/lib/server/auth";
import {
  OFFICES_TABLE,
  OFFICE_VISITS_TABLE,
  OFFICE_LIST_LIMIT,
  OFFICE_LIST_QUERY_LIMIT,
  type OfficeListItem,
} from "@/lib/offices";

// GET /api/offices?q=<search>
//
// Phase 1B office list — test-only.
//
// AUDIENCE
//   `requireTestAccount` — same gate as /api/offices/[id]. Real AEs,
//   plain admins (no `is_test`), and juice_box_only are all rejected.
//   The list is per-caller: every row carries `salesperson_id = me.id`
//   in its predicate so an authorized test AE never sees another
//   AE's sandbox offices.
//
// SCOPE
//   * `environment = "test"` pinned on every read.
//   * `salesperson_id = me.id` pinned on every read.
//
// SEARCH
//   Optional `q` matches office.name / office.city / office.zip via
//   case-insensitive ilike. Input is sanitized to alphanumerics + a
//   small set of address-safe punctuation so a stray `%`, `,`, or
//   PostgREST operator separator can't break out of the value
//   position. Empty / all-stripped `q` is treated as "no query" and
//   the full sandbox is returned.
//
// SORT
//   1. Visited offices first, most-recently-visited at top.
//   2. Then never-visited offices, alphabetical by name.
//
//   The DB pre-fetches alphabetically and the JS sort promotes
//   visited rows to the top. Doing the sort in JS avoids needing a
//   denormalized `last_visited_at` column on `offices` (which would
//   need a trigger + backfill migration); for a 2,000-row sandbox
//   the in-process aggregation is cheap.
//
// RESPONSE
//   * `offices`        — up to OFFICE_LIST_LIMIT items (200), sorted.
//   * `total_matched`  — total rows that passed the filter before the
//                        OFFICE_LIST_LIMIT slice, so the UI can show
//                        "200+ matches — refine your search."
//   * `truncated`      — true when more rows existed than the DB
//                        query pulled (>= OFFICE_LIST_QUERY_LIMIT).
//                        Hint to the UI that an even broader sort
//                        across the full sandbox would need a tighter
//                        search.
//
// ERROR HANDLING
//   Raw Supabase error text never reaches the caller. Failures log
//   with the `[office-list]` prefix; the caller gets a sanitized 500.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const Q_MAX = 80;

const QuerySchema = z.object({
  // Cap length so a paste of an entire CSV row can't blow up the URL or
  // the ilike pattern.
  q: z.string().trim().max(Q_MAX).optional(),
});

/**
 * Sanitize a search term for use inside a PostgREST `or(...ilike...)` filter.
 *
 *   * Keeps letters, digits, whitespace, `-`, `.`, `/`, `&` — covers office
 *     names ("Smith & Co."), street numbers / fragments ("12-34"), and zip
 *     ranges. Anything else (including `%`, `,`, `(`, `)`, `:`, backslash)
 *     is stripped.
 *   * Trims and collapses runs of whitespace to single spaces.
 *
 * The `%` strip is important: a user-supplied `%` would otherwise become
 * an extra wildcard in the ilike pattern. Commas and parens are stripped
 * because they have grammatical meaning inside `.or(...)` PostgREST
 * filters and could let a crafted query escape the value position.
 */
function sanitizeSearchTerm(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9\s\-./&]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

type OfficeBaseRow = {
  id: string;
  name: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  next_action: string | null;
};

type VisitTimestampRow = {
  office_id: string;
  visited_at: string;
};

export async function GET(req: Request) {
  try {
    const me = await requireTestAccount(req);

    const url = new URL(req.url);
    const rawQ = url.searchParams.get("q");
    const parsed = QuerySchema.safeParse({ q: rawQ ?? undefined });
    if (!parsed.success) {
      throw badRequest("Invalid search query.");
    }
    const cleanQ = parsed.data.q ? sanitizeSearchTerm(parsed.data.q) : "";

    const supabase = getServerSupabase();

    // Base query: this AE's sandbox offices, alphabetical pre-fetch.
    let officeQuery = supabase
      .from(OFFICES_TABLE)
      .select("id, name, street, city, state, zip, next_action")
      .eq("salesperson_id", me.id)
      .eq("environment", "test")
      .order("name", { ascending: true })
      .limit(OFFICE_LIST_QUERY_LIMIT);

    if (cleanQ.length > 0) {
      // PostgREST `or` filter expects an unquoted list of
      // `column.op.value` pairs separated by commas. The value is
      // already sanitized above, so the only metacharacter we have to
      // be careful with is `%` — we want literal-`%` stripped (handled
      // by sanitizeSearchTerm) and our own leading/trailing `%`
      // wildcards added here.
      const needle = `%${cleanQ}%`;
      officeQuery = officeQuery.or(
        `name.ilike.${needle},city.ilike.${needle},zip.ilike.${needle}`,
      );
    }

    const officesRes = await officeQuery;

    if (officesRes.error) {
      console.warn(
        `[office-list] offices fetch failed ae=${me.id} q_len=${cleanQ.length} code=${officesRes.error.code ?? "?"} msg=${officesRes.error.message}`,
      );
      throw new ApiError(500, "Could not load offices.");
    }

    const offices = (officesRes.data ?? []) as OfficeBaseRow[];

    // Visit-aggregate pass. Keyed by office_id, accumulates per-AE
    // count + most-recent visited_at. Scoped to this AE + test so a
    // future shared-office model can't contaminate the personal sort.
    const visitMap = new Map<string, { last: string; count: number }>();
    if (offices.length > 0) {
      const officeIds = offices.map((o) => o.id);
      const visitsRes = await supabase
        .from(OFFICE_VISITS_TABLE)
        .select("office_id, visited_at")
        .eq("salesperson_id", me.id)
        .eq("environment", "test")
        .in("office_id", officeIds);

      if (visitsRes.error) {
        console.warn(
          `[office-list] visits fetch failed ae=${me.id} office_count=${officeIds.length} code=${visitsRes.error.code ?? "?"} msg=${visitsRes.error.message}`,
        );
        throw new ApiError(500, "Could not load visit history.");
      }

      for (const v of (visitsRes.data ?? []) as VisitTimestampRow[]) {
        const existing = visitMap.get(v.office_id);
        if (!existing) {
          visitMap.set(v.office_id, { last: v.visited_at, count: 1 });
          continue;
        }
        existing.count += 1;
        // ISO 8601 sorts lexically — comparing strings is correct
        // and avoids the cost of Date construction per visit.
        if (v.visited_at > existing.last) existing.last = v.visited_at;
      }
    }

    const items: OfficeListItem[] = offices.map((o) => {
      const v = visitMap.get(o.id);
      return {
        id: o.id,
        name: o.name,
        street: o.street,
        city: o.city,
        state: o.state,
        zip: o.zip,
        next_action: o.next_action,
        last_visit_at: v?.last ?? null,
        visit_count: v?.count ?? 0,
      };
    });

    // Sort: visited (most-recent first) → unvisited (alphabetical).
    // ISO timestamps compare via localeCompare for correctness.
    items.sort((a, b) => {
      const aVisited = a.last_visit_at !== null;
      const bVisited = b.last_visit_at !== null;
      if (aVisited !== bVisited) return aVisited ? -1 : 1;
      if (aVisited && bVisited) {
        // Both visited — `last_visit_at` is non-null on both branches.
        return (b.last_visit_at as string).localeCompare(
          a.last_visit_at as string,
        );
      }
      return a.name.localeCompare(b.name);
    });

    const trimmed = items.slice(0, OFFICE_LIST_LIMIT);
    const truncated = offices.length >= OFFICE_LIST_QUERY_LIMIT;

    return Response.json(
      {
        offices: trimmed,
        total_matched: items.length,
        truncated,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
