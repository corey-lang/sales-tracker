import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
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
  buildOfficeDedupeKey,
  type OfficeEnvironment,
} from "@/lib/offices";

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
//   3. UPSERTs the office on (salesperson_id, environment, dedupe_key)
//      — duplicates UPDATE in place rather than skipping, so a re-
//      import propagates address corrections, lat/lng fills,
//      phone/email/external_badger_id refreshes, etc.
//      Persistent user memory (`office_notes`, `next_action`) is
//      intentionally NOT in the upsert payload — instead a follow-up
//      "seed notes" UPDATE runs ONLY for rows the upsert just
//      created. Re-imports never touch those columns, so AE edits
//      made through the office-detail UI are preserved. The seed
//      pass lets the first Badger import populate notes/next_action
//      from `_Notes` / `_FollowUp` without giving the importer a
//      future foot-gun.
//
// SUMMARY SHAPE
//   The route returns four buckets so the UI can show separate counts:
//     created   — rows that didn't exist before (INSERT path)
//     updated   — rows that matched an existing dedupe key (UPDATE path)
//     skipped[] — rows the IMPORTER intentionally bypassed (validation
//                 fail, AE not found) — caller decision required to fix
//     errors[]  — rows the DATABASE rejected (constraint violation,
//                 connection blip) — system problem, generally transient
//   Created vs updated is inferred from the returned `created_at` ===
//   `updated_at` (true on freshly-inserted rows; the BEFORE UPDATE
//   trigger bumps updated_at on every UPDATE so they diverge there).
//
// SANDBOX GUARD
//   This first iteration is sandbox-only. Only `environment === "test"`
//   is accepted; an explicit `"production"` value returns 400. The
//   schema's CHECK constraint already accepts both values so this gate
//   can be lifted in a one-line route change when the feature ships.
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
   * Sandbox flag. The schema CHECK accepts "test" | "production", but
   * this route enforces "test" only for the MVP (see SANDBOX GUARD).
   * Default keeps casual callers in the sandbox without thinking about it.
   */
  environment: z.enum(["test", "production"]).default("test"),
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

/**
 * Chunk size for the batched upsert call. Keeps each Supabase round-
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

/** Salesperson lookup result — mapped to id. Null = not found. */
type SalespersonResolver = {
  byId: Map<string, string>;
  /** Keyed by lowercased first_name; CITEXT unique → one row per name. */
  byFirstName: Map<string, string>;
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
): Promise<SalespersonResolver> {
  const wantedIds = new Set<string>();
  const wantedNames = new Set<string>();
  for (const r of rows) {
    if (r.salesperson_id) wantedIds.add(r.salesperson_id);
    if (r.salesperson_first_name) wantedNames.add(r.salesperson_first_name);
  }
  if (defaults.id) wantedIds.add(defaults.id);
  if (defaults.firstName) wantedNames.add(defaults.firstName);

  const byId = new Map<string, string>();
  const byFirstName = new Map<string, string>();

  // Two parallel reads. Service-role bypasses RLS so we get the full set.
  // We don't filter by role here — the import route can target any AE
  // (including the Test account). The admin gate already restricts who
  // can call this route.
  const idArr = Array.from(wantedIds);
  const nameArr = Array.from(wantedNames);

  const [idRes, nameRes] = await Promise.all([
    idArr.length > 0
      ? supabase
          .from("salespeople")
          .select("id, first_name")
          .in("id", idArr)
      : Promise.resolve({ data: [], error: null } as const),
    nameArr.length > 0
      ? supabase
          .from("salespeople")
          .select("id, first_name")
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
  }>) {
    byId.set(row.id, row.id);
  }
  for (const row of (nameRes.data ?? []) as Array<{
    id: string;
    first_name: string;
  }>) {
    // CITEXT unique on first_name → at most one row per name. Store the
    // canonical first_name lowercased so case-mismatch lookups still hit.
    byFirstName.set(row.first_name.toLowerCase(), row.id);
  }

  return { byId, byFirstName };
}

/** Returns the resolved salesperson_id for a row, or null if not found.
 *  Falls back to the batch-level defaults when the row carries neither
 *  its own salesperson_id nor salesperson_first_name. */
function resolveRowSalesperson(
  row: ParsedRow,
  resolver: SalespersonResolver,
  defaults: { id?: string | null; firstName?: string | null },
): string | null {
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

    // SANDBOX GUARD — see header comment.
    if (body.environment !== "test") {
      throw badRequest(
        "Office import is sandbox-only for now — only `environment: \"test\"` is accepted.",
      );
    }
    const environment: OfficeEnvironment = "test";

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

    if (parsed.length === 0) {
      // Nothing to insert — return early without creating an empty batch.
      return Response.json(
        {
          batch_id: null,
          source: body.source,
          environment,
          created: 0,
          updated: 0,
          total_rows: body.rows.length,
          skipped,
          errors,
        },
        { status: 200 },
      );
    }

    const supabase = getServerSupabase();

    const defaults = {
      id: body.default_salesperson_id ?? null,
      firstName: body.default_salesperson_first_name ?? null,
    };

    // Resolve every AE referenced by the payload + the batch-level
    // default in one shot.
    const resolver = await resolveSalespeople(
      supabase,
      parsed.map((p) => p.row),
      defaults,
    );

    // Pre-flight: if a default AE was specified, fail the whole batch
    // when it doesn't resolve — every row that relied on the default
    // would individually skip with the same message, which is noisy
    // and misleading (the problem is the user's input, not the rows).
    if (defaults.id && !resolver.byId.get(defaults.id)) {
      throw badRequest(
        `Default salesperson id ${defaults.id} not found. Pick a different default AE.`,
      );
    }
    if (
      defaults.firstName &&
      !resolver.byFirstName.get(defaults.firstName.toLowerCase())
    ) {
      throw badRequest(
        `Default salesperson "${defaults.firstName}" not found. Pick a different default AE.`,
      );
    }

    // Create the batch FIRST so each office row can carry its
    // import_batch_id. row_count is updated at the end.
    const batchRes = await supabase
      .from(OFFICE_IMPORT_BATCHES_TABLE)
      .insert({
        source: body.source,
        uploaded_by: me.id,
        environment,
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
        `[offices-import] batch create failed source=${body.source} env=${environment} code=${batchRes.error?.code ?? "?"} msg=${batchRes.error?.message ?? "no data"}`,
      );
      throw new ApiError(
        500,
        "Could not create office import batch.",
      );
    }
    const batchId = (batchRes.data as { id: string }).id;

    // Build the upsert payloads. AE resolution happens here; rows
    // with no resolvable AE become skips (not errors).
    //
    // INTRA-BATCH DEDUPE
    //   Postgres `ON CONFLICT DO UPDATE` is undefined when two rows in
    //   the same statement target the same conflict tuple. We pre-
    //   dedupe in JS by (salesperson_id, dedupe_key), keeping the LAST
    //   occurrence — matches the "last write wins" mental model.
    //   Earlier duplicates are reported as skips with a clear reason.
    type UpsertPayload = {
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
      // Factual contact + identity columns are part of the upsert
      // payload — they get refreshed on every import. (office_notes
      // and next_action are deliberately NOT part of the upsert and
      // are handled in the seed-notes pass below.)
      office_phone: string | null;
      office_email: string | null;
      external_badger_id: string | null;
    };
    /** Notes payload kept alongside each queued upsert. Applied
     *  AFTER the upsert in a separate pass so it only lands on
     *  newly-created rows — see the seed-notes loop below. */
    type SeedNotes = {
      office_notes: string | null;
      next_action: string | null;
    };
    const byKey = new Map<
      string,
      { idx: number; payload: UpsertPayload; notes: SeedNotes }
    >();
    for (const { idx, row } of parsed) {
      const salespersonId = resolveRowSalesperson(row, resolver, defaults);
      if (!salespersonId) {
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

      const dedupeKey = buildOfficeDedupeKey({
        name: row.name,
        street: row.street,
        zip: row.zip,
      });

      const key = `${salespersonId}|${dedupeKey}`;
      const payload: UpsertPayload = {
        salesperson_id: salespersonId,
        import_batch_id: batchId,
        name: row.name,
        street: row.street,
        city: row.city,
        state: row.state,
        zip: row.zip,
        // Coordinates are nullable. `?? null` keeps an explicit 0 from
        // getting dropped to null — equator/prime-meridian points are
        // legitimate values.
        latitude: row.latitude ?? null,
        longitude: row.longitude ?? null,
        source: body.source,
        dedupe_key: dedupeKey,
        environment,
        office_phone: row.office_phone,
        office_email: row.office_email,
        external_badger_id: row.external_badger_id,
      };
      const notes: SeedNotes = {
        office_notes: row.office_notes,
        next_action: row.next_action,
      };

      const existing = byKey.get(key);
      if (existing) {
        // Earlier duplicate within this same batch — report the
        // earlier row as a skip and keep the later one. The CSV
        // probably has two near-identical rows for the same office.
        skipped.push({
          row: existing.idx,
          reason: `Duplicate of row ${idx} in this CSV — kept the later one.`,
        });
      }
      byKey.set(key, { idx, payload, notes });
    }

    // Run the upsert in chunks. Each call returns the rows it touched
    // with created_at + updated_at so we can split into created vs
    // updated buckets.
    //
    // Crucially the payload omits office_notes and next_action — the
    // user-edited "office memory" columns — so a re-import never wipes
    // them. Postgres `DO UPDATE SET col = EXCLUDED.col` only updates
    // the columns named in the INSERT, so columns absent from the
    // payload retain their existing values on the matched row.
    const queued = Array.from(byKey.values());
    let created = 0;
    let updated = 0;

    for (let i = 0; i < queued.length; i += UPSERT_CHUNK_SIZE) {
      const chunk = queued.slice(i, i + UPSERT_CHUNK_SIZE);
      const upsertRes = await supabase
        .from(OFFICES_TABLE)
        .upsert(
          chunk.map((q) => q.payload),
          {
            onConflict: "salesperson_id,environment,dedupe_key",
          },
        )
        .select("id, created_at, updated_at");

      if (upsertRes.error) {
        // Migration-missing short-circuit. If the upsert failed
        // because office_phone / office_email / external_badger_id
        // don't exist on `offices`, EVERY chunk will fail with the
        // same root cause — bucketing N rows as "Database insert
        // failed" would bury the actual problem (admin needs to run
        // the migration) under a wall of generic per-row errors.
        // Throw once with a clear actionable message; the outer
        // handleApiError serializes it as a 500. The seed-notes
        // pass below is skipped because we never reach it.
        if (isMissingBadgerColumnError(upsertRes.error)) {
          console.warn(
            `[offices-import] migration #29 missing batch=${batchId} code=${upsertRes.error.code ?? "?"} msg=${upsertRes.error.message}`,
          );
          throw new ApiError(500, MIGRATION_REQUIRED_MESSAGE);
        }

        // The whole chunk failed — report every row in it as a
        // database error (not a skip; the importer's input was
        // structurally valid, the DB rejected the write). Continue
        // with the next chunk so a transient blip doesn't kill an
        // otherwise-good import. Raw error logged server-side.
        console.warn(
          `[offices-import] upsert chunk failed batch=${batchId} chunk_start=${i} chunk_size=${chunk.length} code=${upsertRes.error.code ?? "?"} msg=${upsertRes.error.message}`,
        );
        for (const q of chunk) {
          errors.push({
            row: q.idx,
            reason: "Database insert failed for this row.",
          });
        }
        continue;
      }

      const rows = (upsertRes.data ?? []) as Array<{
        id: string;
        created_at: string;
        updated_at: string;
      }>;
      // PostgREST returns upserted rows in input order. If a chunk
      // came back shorter than expected (rare — should only happen
      // on partial constraint failures we can't see), report the
      // tail as errors.
      //
      // Notes seed list — collected here per chunk and applied below.
      // Only newly-created rows get the seed, so re-imports never
      // touch AE-edited office_notes / next_action.
      const seeds: Array<{
        id: string;
        row: number;
        notes: SeedNotes;
      }> = [];
      for (let j = 0; j < chunk.length; j++) {
        const result = rows[j];
        if (!result) {
          errors.push({
            row: chunk[j].idx,
            reason: "Database did not confirm this row was written.",
          });
          continue;
        }
        // Trigger bumps updated_at on UPDATE; on INSERT the column
        // defaults set both columns to the same NOW() instant.
        const isCreated = result.created_at === result.updated_at;
        if (isCreated) created++;
        else updated++;

        // Notes seed: only on first create AND only when the source
        // row actually carried a non-empty value for either field.
        // The upsert path itself never includes these columns, so the
        // newly-created row sits with notes=NULL until we run the
        // follow-up UPDATE; on subsequent imports the row exists
        // (isCreated=false) and the seed is skipped, preserving any
        // AE edits.
        if (
          isCreated &&
          (chunk[j].notes.office_notes !== null ||
            chunk[j].notes.next_action !== null)
        ) {
          seeds.push({
            id: result.id,
            row: chunk[j].idx,
            notes: chunk[j].notes,
          });
        }
      }

      // Apply notes seeds in parallel. Each is a single-row UPDATE
      // scoped to the freshly-inserted id. Failures here are
      // non-fatal — the office row itself is already saved; an extra
      // UPDATE failing just means the notes didn't seed on this
      // import. Logged server-side so the admin can re-run if needed.
      if (seeds.length > 0) {
        const seedFields = (n: SeedNotes) => {
          const out: { office_notes?: string; next_action?: string } = {};
          if (n.office_notes !== null) out.office_notes = n.office_notes;
          if (n.next_action !== null) out.next_action = n.next_action;
          return out;
        };
        await Promise.all(
          seeds.map(async (s) => {
            const updRes = await supabase
              .from(OFFICES_TABLE)
              .update(seedFields(s.notes))
              .eq("id", s.id);
            if (updRes.error) {
              console.warn(
                `[offices-import] notes seed failed batch=${batchId} row=${s.row} id=${s.id} code=${updRes.error.code ?? "?"} msg=${updRes.error.message}`,
              );
            }
          }),
        );
      }
    }

    // Update the batch's row_count to the final created+updated count
    // so the provenance row reflects what we actually touched. Skipped
    // rows and database errors are NOT counted. If the update itself
    // fails the rows are still intact — only the audit count is stale.
    // Surface that as a soft `warning` field on the response (and log
    // raw error server-side) instead of letting provenance silently drift.
    let provenanceWarning: string | null = null;
    const touched = created + updated;
    if (touched > 0) {
      const updRes = await supabase
        .from(OFFICE_IMPORT_BATCHES_TABLE)
        .update({ row_count: touched })
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

    return Response.json(
      {
        batch_id: batchId,
        source: body.source,
        environment,
        created,
        updated,
        total_rows: body.rows.length,
        skipped,
        errors,
        ...(provenanceWarning ? { warning: provenanceWarning } : {}),
      },
      { status: 201 },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
