import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import { selectAllPages } from "@/lib/server/paginate";
import { visibleRosterOr } from "@/lib/roster";
import {
  ApiError,
  badRequest,
  handleApiError,
  parseBody,
  requireOfficeImporter,
} from "@/lib/server/auth";
import {
  OFFICES_TABLE,
  OFFICE_IMPORT_BATCHES_TABLE,
  COORDINATE_CONFLICT_MILES,
  buildOfficeDedupeKey,
  normalizeForDedupe,
  officeEnvironmentFor,
  validateCoordinatePair,
  type OfficeEnvironment,
} from "@/lib/offices";
import { haversineMiles } from "@/lib/geo";

// POST /api/admin/offices/import
//
// Admin-only office bulk-import endpoint. Accepts JSON rows derived
// from a CSV (the client does the CSV → JSON conversion so the server
// stays dependency-light). Per row the route:
//   1. Validates required fields (office name).
//   2. Resolves the AE — either from the row's own salesperson_id /
//      salesperson_first_name fields, OR from the batch-level
//      `default_salesperson_id` / `default_salesperson_first_name`
//      (so Badger CSVs that don't carry per-row AE columns import).
//   3. MATCHES the row against that AE's existing offices (see MATCHING).
//   4. Creates the office if it is new; otherwise FILLS BLANKS on the
//      existing office and FLAGS anything that conflicts (see UPDATE POLICY).
//
// MATCHING (strongest evidence first; never merges merely-similar offices)
//   a. `external_badger_id` — a stable source identifier, when the row has
//      one. Survives the office being renamed or moving address.
//   b. `dedupe_key` (normalized name | street | zip) — the existing unique
//      identity (uq_offices_dedupe_per_env). Compared against both the
//      stored key and the key recomputed from the office's current fields,
//      so an AE edit through the detail UI can't make a re-import miss.
//   c. Name + street, ONLY when exactly one existing office has them AND
//      one side has no zip. Covers offices imported before zips were known
//      (e.g. the original Badger rows) without ever merging two offices that
//      have different zips.
//   More than one candidate at any step → the row is SKIPPED and reported
//   for review rather than guessed at. Two offices that merely share a name
//   (different addresses) or share an address (different names) never match.
//
// UPDATE POLICY (re-imports never erase information)
//   A matched office is only ever ENRICHED:
//     * a stored field that is blank is filled from the row;
//     * a stored field that has a value is KEPT — if the row disagrees it is
//       reported in `conflicts[]`, not overwritten;
//     * a row field that is blank/missing never clears anything;
//     * `office_notes`, `next_action`, visits, tasks and the office id are
//       never touched (they are not in the update at all).
//   Coordinates fill only when the office has none; a differing pair more
//   than COORDINATE_CONFLICT_MILES away is a conflict, not a silent move.
//
// COORDINATES
//   A pair must be complete and valid WGS84 (see validateCoordinatePair).
//   An invalid pair is DROPPED and the row reported in `flagged[]`; the
//   office itself still imports and stays available in List + search. The
//   route never invents coordinates.
//
// LARGE FILES
//   One request carries at most 5,000 rows. For bigger files the client
//   sends consecutive requests (~1,000 rows each) and passes the first
//   response's `batch_id` back as `batch_id` so they share ONE provenance
//   row. Every request re-reads the AE's current offices, so a duplicate
//   across requests simply matches the office an earlier request created —
//   and re-sending a request that already succeeded is harmless (nothing
//   changes), which is what makes a failed run resumable.
//
// SUMMARY SHAPE
//   created   — offices that didn't exist before.
//   updated   — existing offices that had at least one blank filled.
//   unchanged — existing offices matched with nothing to add.
//   skipped[] — rows the IMPORTER intentionally bypassed (validation fail,
//               AE not found, ambiguous match, duplicate in the file).
//   flagged[] — rows imported but with a problem worth reviewing (dropped
//               invalid coordinates).
//   conflicts[] — incoming values that differ from a stored value and were
//               NOT applied (capped; see conflicts_total).
//   errors[]  — rows the DATABASE rejected (constraint violation,
//               connection blip) — system problem, generally transient.
//
// ENVIRONMENT
//   The environment slice each row lands in is derived per-row from
//   the resolved AE via `officeEnvironmentFor`: the test account →
//   `"test"`, every other AE → `"production"`. The request body does
//   NOT carry an `environment` flag — the importer can't accidentally
//   route real-AE rows into the test slice. The batch row itself
//   takes the default AE's env (if a default was supplied) else
//   `"production"`; a mixed-AE batch with no default lands the batch
//   provenance row in `"production"` even when individual rows split
//   across both slices (rare — the common case is a single-AE batch).
//
// ACCESS
//   requireOfficeImporter(req) — admins pass automatically; anyone
//   else needs the per-user `salespeople.can_import_offices` flag
//   (migration #26). AEs without the flag, plain assistants without
//   the flag, and juice_box_only are all rejected outright (403).
//   Identity comes from the signed session; `uploaded_by` is the
//   caller's id, never a client-supplied value.
//   Note: the URL still lives under `/api/admin/` because the existing
//   page references it and a rename would be churn beyond this fix.
//   The gate, not the URL prefix, is the source of truth for who can
//   call this route.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const NON_EMPTY = (max: number) =>
  z.string().trim().min(1).max(max);

const OPTIONAL_STRING = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null))
    .nullable();

const OPTIONAL_NUMBER = z
  .number()
  .finite()
  .optional()
  .nullable();

const RawRowSchema = z.object({
  /** Per-row AE assignment. Either column may be missing for a row;
   *  the route falls back to the batch-level `default_salesperson_*`
   *  if neither is present. The "no AE resolved anywhere" case is
   *  reported as a skip, not a validation error. */
  salesperson_id: z.uuid().optional(),
  salesperson_first_name: z.string().trim().min(1).max(64).optional(),
  name: NON_EMPTY(200),
  // `street` cap raised so Badger's combined `_Address` string
  // ("212 South Main Street, Spanish Fork, UT, 84660") fits when the
  // CSV doesn't split city/state/zip into their own columns.
  street: OPTIONAL_STRING(500),
  city: OPTIONAL_STRING(100),
  state: OPTIONAL_STRING(64),
  zip: OPTIONAL_STRING(20),
  latitude: OPTIONAL_NUMBER,
  longitude: OPTIONAL_NUMBER,
  // Badger contact + identity fields. All optional, all factual data
  // from the source system → refreshed on every import. The dedupe
  // key still derives from name+street+zip — external_badger_id is
  // stored but not yet promoted to the conflict key.
  office_phone: OPTIONAL_STRING(64),
  office_email: OPTIONAL_STRING(254),
  external_badger_id: OPTIONAL_STRING(128),
  // Persistent "office memory" — Badger `_Notes` / `_FollowUp`. These
  // are written ONLY on first create for a given dedupe key (see the
  // seed-notes pass after the chunked upsert) so re-imports never
  // clobber AE edits made through the future office-detail UI.
  office_notes: OPTIONAL_STRING(10_000),
  next_action: OPTIONAL_STRING(2_000),
});

type ParsedRow = z.infer<typeof RawRowSchema>;

const RequestSchema = z.object({
  /** Free-form label stored on the import batch (e.g. "CRM-2026-Q1"). */
  source: NON_EMPTY(120),
  /**
   * Batch-level AE fallback. When a CSV row carries no per-row AE
   * (the common Badger case — Badger exports MY offices), the
   * resolver uses these. At most one should be set per request; both
   * being null/undefined means every row must carry its own AE columns
   * (the old behavior).
   */
  default_salesperson_id: z.uuid().optional(),
  default_salesperson_first_name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional(),
  /** Continue an existing import batch (large files are sent as several
   *  requests that share one provenance row). Must belong to the caller. */
  batch_id: z.uuid().optional(),
  rows: z.array(z.unknown()).min(1).max(5_000),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Skipped = {
  /** 1-indexed position of the row in the request payload. */
  row: number;
  reason: string;
};

type RowError = {
  row: number;
  reason: string;
};

type Flag = { row: number; reason: string };

type Conflict = {
  row: number;
  office_id: string;
  office_name: string;
  field: string;
  existing: string | null;
  incoming: string | null;
  reason: string;
};

/** Cap on how many flagged/conflict entries a single response carries (the
 *  full count is always reported separately). Keeps a pathological file from
 *  producing a multi-megabyte response. */
const RESPONSE_LIST_CAP = 500;

/** Parallel single-office UPDATEs per wave. */
const UPDATE_CONCURRENCY = 25;

/**
 * Chunk size for the batched insert call. Keeps each Supabase round-
 * trip well under the 6 MB row payload limit on PostgREST and the
 * 30–60 s Vercel function budget — even a 5,000-row import is ten
 * round-trips, not five thousand.
 */
const UPSERT_CHUNK_SIZE = 500;

/**
 * Columns added by migration #29 (offices_badger_fields.sql). If a
 * deploy ships this route code without running the migration first,
 * EVERY chunked upsert fails with a "column does not exist" /
 * PostgREST schema-cache-miss error because the payload includes
 * these three keys. Without special handling each row in each chunk
 * gets bucketed as a generic "Database insert failed" — accurate but
 * useless to the admin debugging it.
 *
 * `isMissingBadgerColumnError` recognizes that specific failure mode
 * by name-matching on the error message, so the route can short-
 * circuit with a single clear migration-required response instead.
 */
const BADGER_MIGRATION_COLUMNS = [
  "office_phone",
  "office_email",
  "external_badger_id",
] as const;

const MIGRATION_REQUIRED_MESSAGE =
  "Office import schema is out of date. Run supabase/offices_badger_fields.sql before importing Badger CSV files.";

/**
 * True when `err` looks like the migration-required failure mode
 * (a missing-column error that names one of the migration's three
 * new columns).
 *
 * Detection strategy: name-match on `err.message`. PostgREST's
 * schema-cache-miss text and PG's `column "X" of relation "Y" does
 * not exist` text both quote the column name, and there's no other
 * realistic path to "Database insert failed mentioning office_phone"
 * — the column doesn't appear in app code anywhere else that the
 * import route writes to. Checked WITHOUT requiring a specific
 * error code so we don't miss the case across PostgREST version
 * shifts (PGRST204 vs 42703 etc.).
 */
function isMissingBadgerColumnError(
  err: { message?: string | null } | null | undefined,
): boolean {
  if (!err?.message) return false;
  const msg = err.message.toLowerCase();
  return BADGER_MIGRATION_COLUMNS.some((c) => msg.includes(c));
}

/** Resolved AE record carried through the upsert path. `is_test` is
 *  read from the `salespeople` row at resolve time (never trusted from
 *  the wire) and drives `officeEnvironmentFor(resolved)` for each row's
 *  env slice. */
type ResolvedAe = { id: string; is_test: boolean };

/** Salesperson lookup result — mapped to {id, is_test}. Null = not found. */
type SalespersonResolver = {
  byId: Map<string, ResolvedAe>;
  /** Keyed by lowercased first_name; CITEXT unique → one row per name. */
  byFirstName: Map<string, ResolvedAe>;
};

/**
 * Batch-resolves the AE for every row in one round-trip per identifier
 * type. We always resolve by id when supplied (cheapest, unambiguous);
 * otherwise we resolve by first_name (CITEXT, case-insensitive unique).
 * The batch-level defaults are folded into the lookup set so the
 * single default also resolves through the same path.
 */
async function resolveSalespeople(
  supabase: ReturnType<typeof getServerSupabase>,
  rows: ParsedRow[],
  defaults: {
    id?: string | null;
    firstName?: string | null;
  },
  viewer: { id: string },
): Promise<SalespersonResolver> {
  const wantedIds = new Set<string>();
  const wantedNames = new Set<string>();
  for (const r of rows) {
    if (r.salesperson_id) wantedIds.add(r.salesperson_id);
    if (r.salesperson_first_name) wantedNames.add(r.salesperson_first_name);
  }
  if (defaults.id) wantedIds.add(defaults.id);
  if (defaults.firstName) wantedNames.add(defaults.firstName);

  const byId = new Map<string, ResolvedAe>();
  const byFirstName = new Map<string, ResolvedAe>();

  // Two parallel reads. Service-role bypasses RLS so we get the full set.
  // We don't filter by role here — the import route can target any AE
  // (including the Test account). The admin gate already restricts who
  // can call this route. `is_test` is selected so the upsert path can
  // derive each row's env slice via `officeEnvironmentFor(resolved)`.
  //
  // We DO filter on `deactivated_at IS NULL`: an import is a NEW assignment,
  // and nothing should be assigned to someone who has left the company. A
  // deactivated AE simply doesn't resolve, so those rows land in `skipped`
  // with the existing "Salesperson … not found." reason instead of being
  // silently attached to a departed AE. Existing offices already owned by
  // that person are untouched.
  const idArr = Array.from(wantedIds);
  const nameArr = Array.from(wantedNames);

  const [idRes, nameRes] = await Promise.all([
    idArr.length > 0
      ? supabase
          .from("salespeople")
          .select("id, first_name, is_test")
          .is("deactivated_at", null)
          // Another admin's private test account resolves as "not found".
          .or(visibleRosterOr(viewer.id))
          .in("id", idArr)
      : Promise.resolve({ data: [], error: null } as const),
    nameArr.length > 0
      ? supabase
          .from("salespeople")
          .select("id, first_name, is_test")
          .is("deactivated_at", null)
          // Another admin's private test account resolves as "not found".
          .or(visibleRosterOr(viewer.id))
          .in("first_name", nameArr)
      : Promise.resolve({ data: [], error: null } as const),
  ]);

  // Both lookups fail the whole import — there's no useful partial
  // progress when we can't resolve any AEs. Raw provider error is
  // logged server-side with the lookup-mode context so a real outage
  // is debuggable from Vercel function logs; the caller sees only the
  // sanitized message.
  if (idRes.error) {
    console.warn(
      `[offices-import] salesperson lookup failed mode=id count=${idArr.length} code=${idRes.error.code ?? "?"} msg=${idRes.error.message}`,
    );
    throw new ApiError(
      500,
      "Could not resolve salespeople for this import.",
    );
  }
  if (nameRes.error) {
    console.warn(
      `[offices-import] salesperson lookup failed mode=first_name count=${nameArr.length} code=${nameRes.error.code ?? "?"} msg=${nameRes.error.message}`,
    );
    throw new ApiError(
      500,
      "Could not resolve salespeople for this import.",
    );
  }

  for (const row of (idRes.data ?? []) as Array<{
    id: string;
    first_name: string;
    is_test: boolean | null;
  }>) {
    byId.set(row.id, { id: row.id, is_test: row.is_test === true });
  }
  for (const row of (nameRes.data ?? []) as Array<{
    id: string;
    first_name: string;
    is_test: boolean | null;
  }>) {
    // CITEXT unique on first_name → at most one row per name. Store the
    // canonical first_name lowercased so case-mismatch lookups still hit.
    byFirstName.set(row.first_name.toLowerCase(), {
      id: row.id,
      is_test: row.is_test === true,
    });
  }

  return { byId, byFirstName };
}

/** Returns the resolved AE record for a row, or null if not found.
 *  Falls back to the batch-level defaults when the row carries neither
 *  its own salesperson_id nor salesperson_first_name. The returned
 *  `is_test` flag drives `officeEnvironmentFor` on the upsert payload. */
function resolveRowSalesperson(
  row: ParsedRow,
  resolver: SalespersonResolver,
  defaults: { id?: string | null; firstName?: string | null },
): ResolvedAe | null {
  if (row.salesperson_id) {
    return resolver.byId.get(row.salesperson_id) ?? null;
  }
  if (row.salesperson_first_name) {
    return (
      resolver.byFirstName.get(row.salesperson_first_name.toLowerCase()) ??
      null
    );
  }
  // Per-row AE missing → fall back to the batch-level default.
  if (defaults.id) return resolver.byId.get(defaults.id) ?? null;
  if (defaults.firstName) {
    return resolver.byFirstName.get(defaults.firstName.toLowerCase()) ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  try {
    const me = await requireOfficeImporter(req);
    const body = await parseBody(req, RequestSchema);

    // Validate each row up front so the per-row reporting is structural
    // (not a mix of "couldn't parse" + "couldn't insert"). The
    // first-pass validation gives us a clean ParsedRow[] OR a Skipped
    // entry per malformed row.
    //
    // Reasons returned to the caller are admin-safe ("Invalid office
    // data — <field>.") — verbose zod issue text is logged server-
    // side only, so a malformed CSV doesn't surface stack-trace-ish
    // detail in the API response.
    const parsed: Array<{ idx: number; row: ParsedRow }> = [];
    const skipped: Skipped[] = [];
    const errors: RowError[] = [];
    for (let i = 0; i < body.rows.length; i++) {
      const r = RawRowSchema.safeParse(body.rows[i]);
      if (!r.success) {
        const firstIssue = r.error.issues[0];
        const field =
          firstIssue && firstIssue.path.length > 0
            ? firstIssue.path.join(".")
            : "(row)";
        const detail = r.error.issues
          .map((issue) => {
            const path = issue.path.join(".") || "(row)";
            return `${path}: ${issue.message}`;
          })
          .join("; ");
        console.warn(
          `[offices-import] validation failed row=${i + 1} field=${field} detail=${detail}`,
        );
        skipped.push({
          row: i + 1,
          reason: `Invalid office data — ${field}.`,
        });
        continue;
      }
      parsed.push({ idx: i + 1, row: r.data });
    }

    const supabase = getServerSupabase();

    const defaults = {
      id: body.default_salesperson_id ?? null,
      firstName: body.default_salesperson_first_name ?? null,
    };

    // Resolve every AE referenced by the payload + the batch-level
    // default in one shot. Run before the early-return so we can pin
    // a correct `batch_environment` on the response even when every
    // row failed Zod (no rows to upsert, but the default-AE pre-flight
    // still tells us where the import *would* have landed).
    const resolver = await resolveSalespeople(
      supabase,
      parsed.map((p) => p.row),
      defaults,
      me,
    );

    // Pre-flight: if a default AE was specified, fail the whole batch
    // when it doesn't resolve — every row that relied on the default
    // would individually skip with the same message, which is noisy
    // and misleading (the problem is the user's input, not the rows).
    const defaultResolved = defaults.id
      ? resolver.byId.get(defaults.id) ?? null
      : defaults.firstName
        ? resolver.byFirstName.get(defaults.firstName.toLowerCase()) ?? null
        : null;
    if (defaults.id && !defaultResolved) {
      throw badRequest(
        `Default salesperson id ${defaults.id} not found. Pick a different default AE.`,
      );
    }
    if (defaults.firstName && !defaultResolved) {
      throw badRequest(
        `Default salesperson "${defaults.firstName}" not found. Pick a different default AE.`,
      );
    }

    // Env slice for the BATCH row. Per-row offices derive their own
    // env from their resolved AE (see the upsert loop below); the
    // batch provenance row takes the default AE's slice when a default
    // was supplied, else "production" (the post-rollout common case).
    // A mixed-AE batch with no default lands the batch row in
    // "production" — rare in practice (admins usually pick a default).
    const batchEnvironment: OfficeEnvironment = defaultResolved
      ? officeEnvironmentFor(defaultResolved)
      : "production";

    if (parsed.length === 0) {
      // Nothing to insert — return early without creating an empty batch.
      return Response.json(
        {
          batch_id: null,
          source: body.source,
          environment: batchEnvironment,
          created: 0,
          updated: 0,
          total_rows: body.rows.length,
          skipped,
          errors,
        },
        { status: 200 },
      );
    }

    // Create the batch FIRST so each office row can carry its
    // import_batch_id — or continue the one a previous request of the same
    // large file created. row_count is updated at the end.
    let batchId: string;
    let batchRowCount = 0;
    if (body.batch_id) {
      const existingBatch = await supabase
        .from(OFFICE_IMPORT_BATCHES_TABLE)
        .select("id, uploaded_by, row_count")
        .eq("id", body.batch_id)
        .maybeSingle();
      const eb = existingBatch.data as {
        id: string;
        uploaded_by: string;
        row_count: number;
      } | null;
      if (existingBatch.error || !eb || eb.uploaded_by !== me.id) {
        throw badRequest("Unknown import batch. Start a new import.");
      }
      batchId = eb.id;
      batchRowCount = eb.row_count;
    } else {
      const batchRes = await supabase
        .from(OFFICE_IMPORT_BATCHES_TABLE)
        .insert({
          source: body.source,
          uploaded_by: me.id,
          environment: batchEnvironment,
          row_count: 0,
        })
        .select("id")
        .single();
      if (batchRes.error || !batchRes.data) {
        // Batch creation gates the rest of the import — without a batch
        // row there's no `import_batch_id` to write onto the offices.
        // Raw provider error logged server-side so DB outages or schema
        // drift are debuggable; caller sees only the sanitized message.
        console.warn(
          `[offices-import] batch create failed source=${body.source} env=${batchEnvironment} code=${batchRes.error?.code ?? "?"} msg=${batchRes.error?.message ?? "no data"}`,
        );
        throw new ApiError(500, "Could not create office import batch.");
      }
      batchId = (batchRes.data as { id: string }).id;
    }

    // -----------------------------------------------------------------
    // Resolve each row's AE + slice, validate coordinates, and drop rows
    // that repeat an earlier row in THIS request.
    // -----------------------------------------------------------------
    type Incoming = {
      idx: number;
      ae: ResolvedAe;
      env: OfficeEnvironment;
      row: ParsedRow;
      dedupeKey: string;
      latitude: number | null;
      longitude: number | null;
    };
    const flagged: Flag[] = [];
    const conflicts: Conflict[] = [];
    let conflictsTotal = 0;
    const addConflict = (c: Conflict) => {
      conflictsTotal++;
      if (conflicts.length < RESPONSE_LIST_CAP) conflicts.push(c);
    };

    // Intra-request duplicates. Postgres can't apply two writes to one office
    // in a request, so keep the LAST occurrence (matches the "last write wins"
    // mental model) and report the earlier one as skipped. A repeated
    // external id is a duplicate even when the name/address text differs.
    const lastByKey = new Map<string, number>();
    const lastByExt = new Map<string, number>();
    const prepared: Incoming[] = [];
    for (const { idx, row } of parsed) {
      const resolved = resolveRowSalesperson(row, resolver, defaults);
      if (!resolved) {
        skipped.push({
          row: idx,
          reason: row.salesperson_id
            ? `Salesperson id ${row.salesperson_id} not found.`
            : row.salesperson_first_name
              ? `Salesperson "${row.salesperson_first_name}" not found.`
              : "Missing AE for this row (no per-row AE column and no default AE selected).",
        });
        continue;
      }

      // Env slice is derived from the resolved AE — never from the
      // request body. Real AEs land in "production", the test account
      // in "test"; rows can't cross slices.
      const env = officeEnvironmentFor(resolved);
      const dedupeKey = buildOfficeDedupeKey({
        name: row.name,
        street: row.street,
        zip: row.zip,
      });

      const pair = validateCoordinatePair(row.latitude, row.longitude);
      let latitude: number | null = null;
      let longitude: number | null = null;
      if (pair.ok) {
        latitude = pair.latitude;
        longitude = pair.longitude;
      } else {
        flagged.push({
          row: idx,
          reason: `Coordinates not imported — ${pair.reason}`,
        });
      }

      const keyId = `${resolved.id}|${env}|${dedupeKey}`;
      const extId = row.external_badger_id
        ? `${resolved.id}|${env}|${row.external_badger_id}`
        : null;
      for (const earlier of [lastByKey.get(keyId), extId ? lastByExt.get(extId) : undefined]) {
        if (earlier !== undefined) {
          const e = prepared.find((p) => p.idx === earlier);
          if (e && !skipped.some((k) => k.row === earlier)) {
            skipped.push({
              row: earlier,
              reason: `Duplicate of row ${idx} in this file — kept the later one.`,
            });
            prepared.splice(prepared.indexOf(e), 1);
          }
        }
      }
      lastByKey.set(keyId, idx);
      if (extId) lastByExt.set(extId, idx);
      prepared.push({ idx, ae: resolved, env, row, dedupeKey, latitude, longitude });
    }

    // -----------------------------------------------------------------
    // Load each affected AE slice's CURRENT offices once (paged — PostgREST
    // clamps a response to 1,000 rows) and index them for matching.
    // -----------------------------------------------------------------
    type Existing = {
      id: string;
      name: string;
      street: string | null;
      city: string | null;
      state: string | null;
      zip: string | null;
      latitude: number | null;
      longitude: number | null;
      dedupe_key: string;
      external_badger_id: string | null;
      office_phone: string | null;
      office_email: string | null;
      archived_at: string | null;
    };
    type SliceIndex = {
      all: Existing[];
      byExt: Map<string, Existing[]>;
      byKey: Map<string, Existing[]>;
      byNameStreet: Map<string, Existing[]>;
      storedKeys: Set<string>;
    };
    const push = (m: Map<string, Existing[]>, k: string, o: Existing) => {
      const l = m.get(k);
      if (!l) m.set(k, [o]);
      else if (!l.includes(o)) l.push(o);
    };
    const indexOffice = (ix: SliceIndex, o: Existing) => {
      if (o.external_badger_id) push(ix.byExt, o.external_badger_id, o);
      push(ix.byKey, o.dedupe_key, o);
      push(
        ix.byKey,
        buildOfficeDedupeKey({ name: o.name, street: o.street, zip: o.zip }),
        o,
      );
      push(
        ix.byNameStreet,
        `${normalizeForDedupe(o.name)}|${normalizeForDedupe(o.street)}`,
        o,
      );
      ix.storedKeys.add(o.dedupe_key);
    };
    const slices = new Map<string, SliceIndex>();
    for (const sliceKey of new Set(prepared.map((p) => `${p.ae.id}|${p.env}`))) {
      const [aeId, env] = sliceKey.split("|");
      const res = await selectAllPages<Existing>(() =>
        supabase
          .from(OFFICES_TABLE)
          .select(
            "id, name, street, city, state, zip, latitude, longitude, dedupe_key, external_badger_id, office_phone, office_email, archived_at",
          )
          .eq("salesperson_id", aeId)
          .eq("environment", env)
          .order("id", { ascending: true }),
      );
      if (res.error) {
        if (isMissingBadgerColumnError(res.error)) {
          console.warn(
            `[offices-import] migration #29 missing code=${res.error.code ?? "?"} msg=${res.error.message}`,
          );
          throw new ApiError(500, MIGRATION_REQUIRED_MESSAGE);
        }
        console.warn(
          `[offices-import] existing offices read failed slice=${sliceKey} code=${res.error.code ?? "?"} msg=${res.error.message}`,
        );
        throw new ApiError(500, "Could not read existing offices for this import.");
      }
      const ix: SliceIndex = {
        all: res.data,
        byExt: new Map(),
        byKey: new Map(),
        byNameStreet: new Map(),
        storedKeys: new Set(),
      };
      for (const o of res.data) indexOffice(ix, o);
      slices.set(sliceKey, ix);
    }

    // -----------------------------------------------------------------
    // Match every row, then plan inserts and fill-only updates.
    // -----------------------------------------------------------------
    type Match =
      | { kind: "match"; office: Existing; via: "external_id" | "key" | "name_street" }
      | { kind: "ambiguous"; reason: string }
      | { kind: "none" };
    const blank = (v: string | null | undefined) => v === null || v === undefined || v.trim() === "";
    const matchRow = (ix: SliceIndex, r: Incoming): Match => {
      const ext = r.row.external_badger_id;
      if (ext) {
        const c = ix.byExt.get(ext) ?? [];
        if (c.length > 1) {
          return {
            kind: "ambiguous",
            reason: `External id ${ext} matches ${c.length} existing offices — resolve the duplicates first.`,
          };
        }
        if (c.length === 1) return { kind: "match", office: c[0], via: "external_id" };
      }
      const byKey = ix.byKey.get(r.dedupeKey) ?? [];
      if (byKey.length > 1) {
        return {
          kind: "ambiguous",
          reason: "Matches more than one existing office by name + address.",
        };
      }
      if (byKey.length === 1) return { kind: "match", office: byKey[0], via: "key" };

      const ns = `${normalizeForDedupe(r.row.name)}|${normalizeForDedupe(r.row.street)}`;
      const cands = (ix.byNameStreet.get(ns) ?? []).filter(
        // Only a missing zip on either side can bridge a key mismatch; two
        // different zips are two different offices.
        (c) => blank(c.zip) || blank(r.row.zip),
      );
      if (cands.length > 1) {
        return {
          kind: "ambiguous",
          reason: "Matches more than one existing office by name + street (zip missing).",
        };
      }
      if (cands.length === 1) return { kind: "match", office: cands[0], via: "name_street" };
      return { kind: "none" };
    };

    type InsertPayload = {
      salesperson_id: string;
      import_batch_id: string;
      name: string;
      street: string | null;
      city: string | null;
      state: string | null;
      zip: string | null;
      latitude: number | null;
      longitude: number | null;
      source: string;
      dedupe_key: string;
      environment: OfficeEnvironment;
      office_phone: string | null;
      office_email: string | null;
      external_badger_id: string | null;
      // Persistent "office memory" — seeded only when the office is created.
      office_notes: string | null;
      next_action: string | null;
    };
    const inserts: Array<{ idx: number; payload: InsertPayload }> = [];
    const updates: Array<{
      idx: number;
      id: string;
      aeId: string;
      patch: Record<string, string | number | null>;
    }> = [];
    let unchanged = 0;
    const claimed = new Map<string, number>(); // existing id → row that claimed it

    for (const r of prepared) {
      const ix = slices.get(`${r.ae.id}|${r.env}`) as SliceIndex;
      const m = matchRow(ix, r);

      if (m.kind === "ambiguous") {
        skipped.push({ row: r.idx, reason: m.reason });
        continue;
      }

      if (m.kind === "none") {
        const payload: InsertPayload = {
          salesperson_id: r.ae.id,
          import_batch_id: batchId,
          name: r.row.name,
          street: r.row.street,
          city: r.row.city,
          state: r.row.state,
          zip: r.row.zip,
          latitude: r.latitude,
          longitude: r.longitude,
          source: body.source,
          dedupe_key: r.dedupeKey,
          environment: r.env,
          office_phone: r.row.office_phone,
          office_email: r.row.office_email,
          external_badger_id: r.row.external_badger_id,
          office_notes: r.row.office_notes,
          next_action: r.row.next_action,
        };
        inserts.push({ idx: r.idx, payload });
        // Index the planned office so a later row in this request that
        // matches it is recognized (and an intra-request key clash can't
        // reach the database).
        indexOffice(ix, {
          id: `planned-${r.idx}`,
          name: r.row.name,
          street: r.row.street,
          city: r.row.city,
          state: r.row.state,
          zip: r.row.zip,
          latitude: r.latitude,
          longitude: r.longitude,
          dedupe_key: r.dedupeKey,
          external_badger_id: r.row.external_badger_id,
          office_phone: r.row.office_phone,
          office_email: r.row.office_email,
          archived_at: null,
        });
        continue;
      }

      // ---- matched an existing office: enrich only ----
      const o = m.office;
      const earlierClaim = claimed.get(o.id);
      if (earlierClaim !== undefined) {
        skipped.push({
          row: r.idx,
          reason: `Matches the same existing office as row ${earlierClaim} — kept the first.`,
        });
        continue;
      }
      claimed.set(o.id, r.idx);
      if (o.id.startsWith("planned-")) {
        // Matched an office this same request is about to create (e.g. two
        // rows for one external id with different text). Not a DB match.
        skipped.push({
          row: r.idx,
          reason: "Duplicate of another row in this file.",
        });
        continue;
      }

      const patch: Record<string, string | number | null> = {};
      const conflict = (field: string, existing: unknown, incoming: unknown, reason: string) =>
        addConflict({
          row: r.idx,
          office_id: o.id,
          office_name: o.name,
          field,
          existing: existing === null || existing === undefined ? null : String(existing),
          incoming: incoming === null || incoming === undefined ? null : String(incoming),
          reason,
        });

      if (m.via !== "key" && normalizeForDedupe(o.name) !== normalizeForDedupe(r.row.name)) {
        conflict("name", o.name, r.row.name, `Matched by ${m.via.replace("_", " ")}, but the name differs — kept the stored name.`);
      }
      if (o.archived_at) {
        conflict("archived", o.archived_at, null, "Matches an archived office — left archived.");
      }

      // Plain text fields: fill blanks, flag disagreements, never clear.
      for (const f of ["street", "city", "office_phone", "office_email", "external_badger_id"] as const) {
        const incoming = r.row[f];
        if (blank(incoming)) continue;
        const stored = o[f];
        if (blank(stored)) {
          patch[f] = incoming as string;
        } else if (
          normalizeForDedupe(stored) !== normalizeForDedupe(incoming)
        ) {
          conflict(f, stored, incoming, "Differs from the stored value — kept the stored value.");
        }
      }
      if (blank(o.state) && !blank(r.row.state)) patch.state = r.row.state as string;

      // Zip: filling it changes the dedupe key, so make sure the new key
      // can't collide with a different office before writing it.
      if (!blank(r.row.zip)) {
        if (blank(o.zip)) {
          const newKey = buildOfficeDedupeKey({
            name: o.name,
            street: (patch.street as string | undefined) ?? o.street,
            zip: r.row.zip,
          });
          const clash = (ix.byKey.get(newKey) ?? []).some((x) => x.id !== o.id);
          if (clash || (newKey !== o.dedupe_key && ix.storedKeys.has(newKey))) {
            conflict("zip", o.zip, r.row.zip, "Filling the zip would make this office identical to another one — left blank.");
          } else {
            patch.zip = r.row.zip as string;
            patch.dedupe_key = newKey;
            ix.storedKeys.delete(o.dedupe_key);
            ix.storedKeys.add(newKey);
          }
        } else if (normalizeForDedupe(o.zip) !== normalizeForDedupe(r.row.zip)) {
          conflict("zip", o.zip, r.row.zip, "Differs from the stored value — kept the stored value.");
        }
      }

      // Coordinates: fill only when the office has none.
      if (r.latitude !== null && r.longitude !== null) {
        if (o.latitude === null || o.longitude === null) {
          patch.latitude = r.latitude;
          patch.longitude = r.longitude;
        } else if (
          haversineMiles(o.latitude, o.longitude, r.latitude, r.longitude) >
          COORDINATE_CONFLICT_MILES
        ) {
          conflict(
            "coordinates",
            `${o.latitude},${o.longitude}`,
            `${r.latitude},${r.longitude}`,
            "Differs from the stored location — kept the stored location.",
          );
        }
      }

      if (Object.keys(patch).length === 0) unchanged++;
      else updates.push({ idx: r.idx, id: o.id, aeId: r.ae.id, patch });
    }

    // -----------------------------------------------------------------
    // Write. Inserts in chunks (a failed chunk is retried row-by-row so one
    // bad row can't sink 499 good ones); updates one office at a time with
    // ONLY the changed columns, so concurrent AE edits are never clobbered.
    // -----------------------------------------------------------------
    let created = 0;
    let updated = 0;
    for (let i = 0; i < inserts.length; i += UPSERT_CHUNK_SIZE) {
      const chunk = inserts.slice(i, i + UPSERT_CHUNK_SIZE);
      const res = await supabase
        .from(OFFICES_TABLE)
        .insert(chunk.map((c) => c.payload))
        .select("id");
      if (!res.error) {
        created += (res.data ?? []).length;
        continue;
      }
      if (isMissingBadgerColumnError(res.error)) {
        console.warn(
          `[offices-import] migration #29 missing batch=${batchId} code=${res.error.code ?? "?"} msg=${res.error.message}`,
        );
        throw new ApiError(500, MIGRATION_REQUIRED_MESSAGE);
      }
      console.warn(
        `[offices-import] insert chunk failed batch=${batchId} chunk_start=${i} chunk_size=${chunk.length} code=${res.error.code ?? "?"} msg=${res.error.message}`,
      );
      for (const c of chunk) {
        const one = await supabase
          .from(OFFICES_TABLE)
          .insert(c.payload)
          .select("id");
        if (!one.error) {
          created++;
        } else if (one.error.code === "23505") {
          skipped.push({
            row: c.idx,
            reason: "An office with this name and address already exists (created by a concurrent import).",
          });
        } else {
          errors.push({ row: c.idx, reason: "Database insert failed for this row." });
        }
      }
    }

    for (let i = 0; i < updates.length; i += UPDATE_CONCURRENCY) {
      await Promise.all(
        updates.slice(i, i + UPDATE_CONCURRENCY).map(async (u) => {
          const res = await supabase
            .from(OFFICES_TABLE)
            .update(u.patch)
            .eq("id", u.id)
            .eq("salesperson_id", u.aeId);
          if (res.error) {
            console.warn(
              `[offices-import] update failed batch=${batchId} row=${u.idx} id=${u.id} code=${res.error.code ?? "?"} msg=${res.error.message}`,
            );
            errors.push({
              row: u.idx,
              reason:
                res.error.code === "23505"
                  ? "Updating this office would make it identical to another one."
                  : "Database update failed for this row.",
            });
          } else {
            updated++;
          }
        }),
      );
    }

    // Provenance count = offices this batch created or enriched. If the
    // update fails the rows are still intact — only the audit count is stale;
    // surface that as a soft warning (and log the raw error server-side).
    let provenanceWarning: string | null = null;
    const touched = created + updated;
    if (touched > 0) {
      const updRes = await supabase
        .from(OFFICE_IMPORT_BATCHES_TABLE)
        .update({ row_count: batchRowCount + touched })
        .eq("id", batchId);
      if (updRes.error) {
        console.warn(
          `[offices-import] batch row_count update failed batch=${batchId} count=${touched} msg=${updRes.error.message}`,
        );
        provenanceWarning =
          "Offices were saved, but the batch row_count audit field could not be updated. " +
          "Re-derive the true count from offices.import_batch_id if needed.";
      }
    }

    skipped.sort((a, b) => a.row - b.row);
    return Response.json(
      {
        batch_id: batchId,
        source: body.source,
        environment: batchEnvironment,
        created,
        updated,
        unchanged,
        total_rows: body.rows.length,
        skipped,
        flagged: flagged.slice(0, RESPONSE_LIST_CAP),
        flagged_total: flagged.length,
        conflicts,
        conflicts_total: conflictsTotal,
        errors,
        ...(provenanceWarning ? { warning: provenanceWarning } : {}),
      },
      { status: 201 },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
