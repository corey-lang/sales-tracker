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
// stays dependency-light). Each row is validated, the AE resolved by
// id or first_name, the office insert attempted under the chosen
// environment. Duplicate rows (same AE + env + normalized
// name+street+zip) are skipped via the partial UNIQUE index from
// supabase/offices.sql and reported back in the summary.
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

const RawRowSchema = z
  .object({
    /** Either salesperson_id OR salesperson_first_name must be present. */
    salesperson_id: z.uuid().optional(),
    salesperson_first_name: z.string().trim().min(1).max(64).optional(),
    name: NON_EMPTY(200),
    street: OPTIONAL_STRING(200),
    city: OPTIONAL_STRING(100),
    state: OPTIONAL_STRING(64),
    zip: OPTIONAL_STRING(20),
    latitude: OPTIONAL_NUMBER,
    longitude: OPTIONAL_NUMBER,
  })
  .refine(
    (row) =>
      typeof row.salesperson_id === "string" ||
      typeof row.salesperson_first_name === "string",
    {
      message:
        "Either salesperson_id or salesperson_first_name is required.",
      path: ["salesperson_id"],
    },
  );

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

/** Salesperson lookup result — mapped to id. Null = not found. */
type SalespersonResolver = {
  byId: Map<string, string>;
  byFirstName: Map<string, string>;
};

/**
 * Batch-resolves the AE for every row in one round-trip per identifier
 * type. We always resolve by id when supplied (cheapest, unambiguous);
 * otherwise we resolve by first_name (CITEXT, case-insensitive unique).
 */
async function resolveSalespeople(
  supabase: ReturnType<typeof getServerSupabase>,
  rows: ParsedRow[],
): Promise<SalespersonResolver> {
  const wantedIds = new Set<string>();
  const wantedNames = new Set<string>();
  for (const r of rows) {
    if (r.salesperson_id) wantedIds.add(r.salesperson_id);
    else if (r.salesperson_first_name) {
      wantedNames.add(r.salesperson_first_name);
    }
  }

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

/** Returns the resolved salesperson_id for a row, or null if not found. */
function resolveRowSalesperson(
  row: ParsedRow,
  resolver: SalespersonResolver,
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
          inserted: 0,
          total_rows: body.rows.length,
          skipped,
        },
        { status: 200 },
      );
    }

    const supabase = getServerSupabase();

    // Resolve every AE referenced by the payload in one shot.
    const resolver = await resolveSalespeople(
      supabase,
      parsed.map((p) => p.row),
    );

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

    let inserted = 0;
    for (const { idx, row } of parsed) {
      const salespersonId = resolveRowSalesperson(row, resolver);
      if (!salespersonId) {
        skipped.push({
          row: idx,
          reason: row.salesperson_id
            ? `Salesperson id ${row.salesperson_id} not found.`
            : `Salesperson "${row.salesperson_first_name}" not found.`,
        });
        continue;
      }

      const dedupeKey = buildOfficeDedupeKey({
        name: row.name,
        street: row.street,
        zip: row.zip,
      });

      const insertRes = await supabase
        .from(OFFICES_TABLE)
        .insert({
          salesperson_id: salespersonId,
          import_batch_id: batchId,
          name: row.name,
          street: row.street,
          city: row.city,
          state: row.state,
          zip: row.zip,
          latitude: row.latitude ?? null,
          longitude: row.longitude ?? null,
          source: body.source,
          dedupe_key: dedupeKey,
          environment,
        })
        .select("id")
        .single();

      if (insertRes.error) {
        // 23505 = unique_violation on the per-(AE, env, dedupe_key)
        // index. Reported as a skip, not an error — the caller wanted
        // to import this row but it's already in the table.
        if (insertRes.error.code === "23505") {
          skipped.push({
            row: idx,
            reason: "Duplicate office for this AE/environment.",
          });
          continue;
        }
        // Surface a generic admin-safe reason; log the raw DB error
        // server-side with batch + row context so a real failure
        // (constraint mismatch, downed pool, etc.) is debuggable from
        // Vercel function logs without leaking internals to the
        // import response.
        console.warn(
          `[offices-import] insert failed batch=${batchId} row=${idx} code=${insertRes.error.code ?? "?"} msg=${insertRes.error.message}`,
        );
        skipped.push({
          row: idx,
          reason: "Database insert failed for this row.",
        });
        continue;
      }
      inserted++;
    }

    // Update the batch's row_count to the final inserted count so the
    // provenance row reflects reality. Skipped rows are NOT counted.
    // If the update itself fails, the inserted office rows are still
    // intact — only the audit count is stale. We surface that as a
    // soft `warning` field on the response (and log raw error
    // server-side) instead of letting provenance silently drift.
    let provenanceWarning: string | null = null;
    if (inserted > 0) {
      const updRes = await supabase
        .from(OFFICE_IMPORT_BATCHES_TABLE)
        .update({ row_count: inserted })
        .eq("id", batchId);
      if (updRes.error) {
        console.warn(
          `[offices-import] batch row_count update failed batch=${batchId} count=${inserted} msg=${updRes.error.message}`,
        );
        provenanceWarning =
          "Offices were inserted, but the batch row_count audit field could not be updated. " +
          "Re-derive the true count from offices.import_batch_id if needed.";
      }
    }

    return Response.json(
      {
        batch_id: batchId,
        source: body.source,
        environment,
        inserted,
        total_rows: body.rows.length,
        skipped,
        ...(provenanceWarning ? { warning: provenanceWarning } : {}),
      },
      { status: 201 },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
