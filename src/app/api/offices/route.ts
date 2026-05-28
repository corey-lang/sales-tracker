import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  badRequest,
  handleApiError,
  parseBody,
  requireAeToolAccess,
} from "@/lib/server/auth";
import {
  buildOfficeDedupeKey,
  officeEnvironmentFor,
  OFFICES_TABLE,
  OFFICE_VISITS_TABLE,
  OFFICE_LIST_LIMIT,
  OFFICE_LIST_QUERY_LIMIT,
  type OfficeListItem,
  type OfficeRow,
} from "@/lib/offices";

// GET /api/offices?q=<search>
//
// AE office list.
//
// AUDIENCE
//   `requireAeToolAccess` — same gate as the rest of the office
//   surface. Every signed-in salesperson except juice_box_only
//   reaches their own office catalog. The list is per-caller:
//   every row carries `salesperson_id = me.id` in its predicate so
//   no AE ever sees another AE's offices.
//
// ENVIRONMENT
//   The slice an AE sees is derived from `officeEnvironmentFor(me)`:
//   the seeded test account stays in `"test"`, every real AE works
//   in `"production"`. Test data never leaks into production AEs'
//   lists and vice-versa.
//
// SCOPE
//   * `environment = officeEnvironmentFor(me)` pinned on every read.
//   * `salesperson_id = me.id` pinned on every read.
//
// SEARCH
//   Optional `q` matches office.name / office.city / office.zip via
//   case-insensitive ilike. Input is sanitized to alphanumerics + a
//   small set of address-safe punctuation so a stray `%`, `,`, or
//   PostgREST operator separator can't break out of the value
//   position. Empty / all-stripped `q` is treated as "no query" and
//   the caller's full office set is returned.
//
// SORT
//   1. Visited offices first, most-recently-visited at top.
//   2. Then never-visited offices, alphabetical by name.
//
//   The DB pre-fetches alphabetically and the JS sort promotes
//   visited rows to the top. Doing the sort in JS avoids needing a
//   denormalized `last_visited_at` column on `offices` (which would
//   need a trigger + backfill migration); for a 2,000-row per-AE
//   office set the in-process aggregation is cheap.
//
// RESPONSE
//   * `offices`        — up to OFFICE_LIST_LIMIT items (200), sorted.
//   * `total_matched`  — total rows that passed the filter before the
//                        OFFICE_LIST_LIMIT slice, so the UI can show
//                        "200+ matches — refine your search."
//   * `truncated`      — true when more rows existed than the DB
//                        query pulled (>= OFFICE_LIST_QUERY_LIMIT).
//                        Hint to the UI that an even broader sort
//                        across the AE's full office set would need
//                        a tighter search.
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
  next_action_due_date: string | null;
};

type VisitTimestampRow = {
  office_id: string;
  visited_at: string;
};

export async function GET(req: Request) {
  try {
    const me = await requireAeToolAccess(req);
    const environment = officeEnvironmentFor(me);

    const url = new URL(req.url);
    const rawQ = url.searchParams.get("q");
    const parsed = QuerySchema.safeParse({ q: rawQ ?? undefined });
    if (!parsed.success) {
      throw badRequest("Invalid search query.");
    }
    const cleanQ = parsed.data.q ? sanitizeSearchTerm(parsed.data.q) : "";

    const supabase = getServerSupabase();

    // Base query: this AE's offices in their slice (production for
    // real AEs, test for the test account — derived per-caller by
    // officeEnvironmentFor so test data never bleeds into production
    // AEs' lists and vice-versa). Alphabetical pre-fetch.
    // Archived offices (`archived_at IS NOT NULL`) are excluded so a
    // soft-deleted row disappears from the List view immediately.
    let officeQuery = supabase
      .from(OFFICES_TABLE)
      .select(
        "id, name, street, city, state, zip, next_action, next_action_due_date",
      )
      .eq("salesperson_id", me.id)
      .eq("environment", environment)
      .is("archived_at", null)
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
    // count + most-recent visited_at. Scoped to this AE + env so a
    // future shared-office model can't contaminate the personal sort.
    //
    // CHUNKED IN(): for an AE with thousands of imported offices
    // (Chanel/Hilary post-rollout), passing every office_id in a
    // single `.in(...)` clause builds a multi-tens-of-KB query
    // string that overflows the upstream proxy's URL/header budget
    // (Cloudflare ~8KB headers, Vercel ~16KB total) and surfaces as
    // a request error long before Postgres sees it. Chunking keeps
    // each request small and lets the visit map merge across pages.
    //
    // NON-FATAL: a failure here used to 500 the entire list page
    // — misleading copy ("Could not load visit history.") for what
    // is really a sort-degradation. We now log + skip the failing
    // chunk and continue. Worst case the list renders without the
    // "visited first" promotion for offices in the failed chunk,
    // which matches the same office_set's fresh-import baseline
    // (never-visited rows sort alphabetical) and never blocks the
    // page from loading.
    const visitMap = new Map<string, { last: string; count: number }>();
    if (offices.length > 0) {
      const officeIds = offices.map((o) => o.id);
      // 200 UUIDs (~37 chars each + commas) ≈ 7.5KB query — well
      // under the conservative 8KB header floor and small enough
      // to keep request latency steady.
      const VISITS_IN_CHUNK = 200;
      for (let i = 0; i < officeIds.length; i += VISITS_IN_CHUNK) {
        const chunk = officeIds.slice(i, i + VISITS_IN_CHUNK);
        const chunkStartedAt = Date.now();
        try {
          const visitsRes = await supabase
            .from(OFFICE_VISITS_TABLE)
            .select("office_id, visited_at")
            .eq("salesperson_id", me.id)
            .eq("environment", environment)
            .in("office_id", chunk);

          if (visitsRes.error) {
            console.warn(
              `[office-list] visits chunk failed ae=${me.id} chunk_start=${i} chunk_size=${chunk.length} elapsed_ms=${Date.now() - chunkStartedAt} code=${visitsRes.error.code ?? "?"} msg=${visitsRes.error.message}`,
            );
            continue;
          }

          for (const v of (visitsRes.data ?? []) as VisitTimestampRow[]) {
            const existing = visitMap.get(v.office_id);
            if (!existing) {
              visitMap.set(v.office_id, { last: v.visited_at, count: 1 });
              continue;
            }
            existing.count += 1;
            // ISO 8601 sorts lexically — comparing strings is
            // correct and avoids the cost of Date construction per
            // visit.
            if (v.visited_at > existing.last) existing.last = v.visited_at;
          }
        } catch (err) {
          // Thrown exceptions (network/timeout/aborted fetch) land
          // here — same degradation as the row-error path.
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[office-list] visits chunk threw ae=${me.id} chunk_start=${i} chunk_size=${chunk.length} elapsed_ms=${Date.now() - chunkStartedAt} err=${msg}`,
          );
        }
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
        next_action_due_date: o.next_action_due_date,
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

// ---------------------------------------------------------------------------
// POST /api/offices  — AE Add Office.
// ---------------------------------------------------------------------------
//
// AE-facing "manually add an office to my list" endpoint. Used by
// the Add Office modal on /offices.
//
// REQUIRED
//   name, address (mapped to the `street` column; matches how the
//   Badger import stores combined addresses).
//
// OPTIONAL
//   city, state, zip — splittable address columns when the user
//   wants them broken out. Most manual entries leave these blank.
//   office_phone, office_email — contact info.
//   office_notes, next_action — start the office with first-touch
//   memory. These are import-safe (the Badger import only seeds
//   them on first create), so a future re-import won't clobber.
//   next_action_due_date — optional YYYY-MM-DD.
//
// COORDINATES
//   Manually-added offices may now carry latitude + longitude when
//   the AE picks a result from the Add Office address autocomplete
//   (powered by /api/geocode/search, OpenStreetMap-backed). The
//   client passes the chosen address's lat/lng straight through to
//   this route. Manual address entry without a picked suggestion
//   still works — those rows insert with NULL coords and surface in
//   List immediately, just not on the Map until coords appear.
//
// OWNERSHIP / SCOPE
//   `requireAeToolAccess` gate (same as the rest of the office
//   surface). `salesperson_id` is the caller's id, `environment`
//   is derived per-caller via `officeEnvironmentFor` (test for the
//   test account, production for real AEs). `dedupe_key` is derived
//   from name+street+zip (same builder the import uses) so
//   duplicate detection is consistent between manual + bulk paths.
//   A duplicate insert surfaces as a uniform 409 "An office with
//   this name and address is already in your list." rather than
//   the raw 23505 text.
//
// IDEMPOTENT
//   Repeated submits with the same name/address against the same
//   AE/env produce one row (first wins via the
//   `uq_offices_dedupe_per_env` partial UNIQUE index) and a 409
//   on every subsequent attempt.

const TRIM_MAX = (max: number) =>
  z.string().trim().min(1).max(max);

const OPTIONAL_TEXT = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null))
    .nullable();

const OPTIONAL_DUE_DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "next_action_due_date must be in YYYY-MM-DD format.")
  .refine(
    (v) => !Number.isNaN(Date.parse(v)),
    "next_action_due_date is not a real date.",
  )
  .nullable()
  .optional();

const CreateOfficeSchema = z.object({
  name: TRIM_MAX(200),
  // "Address" UI field maps to `street` so the manual-add path
  // behaves the same as the Badger `_Address` import (full address
  // in one column). Future surface can split this when needed.
  street: TRIM_MAX(500),
  city: OPTIONAL_TEXT(100),
  state: OPTIONAL_TEXT(64),
  zip: OPTIONAL_TEXT(20),
  // Coordinates are optional. The client passes them through when
  // the AE picks a geocoded result from the Add Office address
  // autocomplete; manual address entry leaves them null and the
  // row inserts without map placement.
  latitude: z.number().gte(-90).lte(90).nullable().optional(),
  longitude: z.number().gte(-180).lte(180).nullable().optional(),
  office_phone: OPTIONAL_TEXT(64),
  office_email: OPTIONAL_TEXT(254),
  office_notes: OPTIONAL_TEXT(10_000),
  next_action: OPTIONAL_TEXT(2_000),
  next_action_due_date: OPTIONAL_DUE_DATE,
});

const NEW_OFFICE_COLUMNS =
  "id, salesperson_id, import_batch_id, name, street, city, state, zip, " +
  "latitude, longitude, source, dedupe_key, environment, " +
  "office_notes, next_action, next_action_due_date, " +
  "office_phone, office_email, external_badger_id, archived_at, " +
  "created_at, updated_at";

export async function POST(req: Request) {
  try {
    const me = await requireAeToolAccess(req);
    const environment = officeEnvironmentFor(me);
    const body = await parseBody(req, CreateOfficeSchema);
    const supabase = getServerSupabase();

    const dedupeKey = buildOfficeDedupeKey({
      name: body.name,
      street: body.street,
      zip: body.zip,
    });

    const insertPayload: {
      salesperson_id: string;
      name: string;
      street: string;
      city: string | null;
      state: string | null;
      zip: string | null;
      latitude: number | null;
      longitude: number | null;
      office_phone: string | null;
      office_email: string | null;
      office_notes: string | null;
      next_action: string | null;
      next_action_due_date: string | null;
      source: string;
      dedupe_key: string;
      environment: typeof environment;
    } = {
      salesperson_id: me.id,
      name: body.name,
      street: body.street,
      city: body.city ?? null,
      state: body.state ?? null,
      zip: body.zip ?? null,
      latitude: body.latitude ?? null,
      longitude: body.longitude ?? null,
      office_phone: body.office_phone ?? null,
      office_email: body.office_email ?? null,
      office_notes: body.office_notes ?? null,
      next_action: body.next_action ?? null,
      next_action_due_date: body.next_action_due_date ?? null,
      // `source` labels the row's provenance. Matches the import
      // route's "<source label>" pattern so the offices table reads
      // self-describing.
      source: "Manual add",
      dedupe_key: dedupeKey,
      environment,
    };

    const insertRes = await supabase
      .from(OFFICES_TABLE)
      .insert(insertPayload)
      .select(NEW_OFFICE_COLUMNS)
      .single();

    if (insertRes.error) {
      // 23505 = duplicate against the `uq_offices_dedupe_per_env`
      // partial unique index. Translate to a friendly 409 so the
      // form can show actionable copy rather than the raw DB text.
      if (insertRes.error.code === "23505") {
        return Response.json(
          {
            error:
              "An office with this name and address is already in your list.",
          },
          { status: 409 },
        );
      }
      console.warn(
        `[office-create] insert failed ae=${me.id} code=${insertRes.error.code ?? "?"} msg=${insertRes.error.message}`,
      );
      throw new ApiError(500, "Could not add this office.");
    }
    if (!insertRes.data) {
      console.warn(`[office-create] insert returned no data ae=${me.id}`);
      throw new ApiError(500, "Could not add this office.");
    }

    const office = insertRes.data as unknown as OfficeRow;
    return Response.json(
      { office },
      {
        status: 201,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
