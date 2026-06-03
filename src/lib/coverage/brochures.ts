/**
 * Coverage Intelligence — brochure registry store (Phase 1).
 *
 * Server-only CRUD over `plan_brochures` (the brochure VERSION registry). This
 * is metadata only — registering where a brochure came from and its version.
 * Extraction of coverage/pricing/add-on rows is a later phase and lives
 * elsewhere; nothing here fetches, parses, or interprets brochure content.
 *
 * Access: consumed exclusively by the admin-gated /api/admin/coverage/*
 * routes (service-role). The table is RLS-locked, so there is no anon path.
 * Never import from a "use client" component.
 */

import { getServerSupabase } from "@/lib/supabase/server";
import { ApiError } from "@/lib/server/auth";
import type { Brochure, BrochureStatus, StateCode } from "./types";

const BROCHURE_COLUMNS =
  "id, state_code, brochure_title, brochure_version, effective_date, source_url, file_hash, imported_at, status, notes";

type BrochureRow = {
  id: string;
  state_code: string;
  brochure_title: string;
  brochure_version: string | null;
  effective_date: string | null;
  source_url: string | null;
  file_hash: string | null;
  imported_at: string;
  status: BrochureStatus;
  notes: string | null;
};

function mapRow(row: BrochureRow): Brochure {
  return {
    id: row.id,
    stateCode: row.state_code,
    brochureTitle: row.brochure_title,
    brochureVersion: row.brochure_version,
    effectiveDate: row.effective_date,
    sourceUrl: row.source_url,
    fileHash: row.file_hash,
    importedAt: row.imported_at,
    status: row.status,
    notes: row.notes,
  };
}

export type RegisterBrochureInput = {
  stateCode: StateCode;
  brochureTitle: string;
  brochureVersion?: string;
  effectiveDate?: string; // YYYY-MM-DD
  sourceUrl?: string;
  /**
   * SHA-256 of the source file. Optional in Phase 1 (manual metadata
   * registration). The Phase 2 ingestion/fetch flow MUST populate this whenever
   * it has the actual bytes, so the brochure is tied to its exact source. The
   * DB freeze trigger permits a one-time NULL→value backfill but no later change.
   */
  fileHash?: string;
  notes?: string;
};

/**
 * Registers a brochure version. Always created with `status='imported'` — the
 * lifecycle (current/superseded/...) is managed by a later admin action, not at
 * registration. Append-only: a new version is always a new row.
 */
export async function registerBrochure(
  input: RegisterBrochureInput,
): Promise<Brochure> {
  const supabase = getServerSupabase();
  const res = await supabase
    .from("plan_brochures")
    .insert({
      state_code: input.stateCode,
      brochure_title: input.brochureTitle,
      brochure_version: input.brochureVersion ?? null,
      effective_date: input.effectiveDate ?? null,
      source_url: input.sourceUrl ?? null,
      file_hash: input.fileHash ?? null,
      notes: input.notes ?? null,
      status: "imported",
    })
    .select(BROCHURE_COLUMNS)
    .maybeSingle();

  if (res.error) {
    // 23505 = the (state_code, file_hash) unique index — identical file already
    // registered for this state.
    if (res.error.code === "23505") {
      throw new ApiError(
        409,
        "This brochure file is already registered for this state.",
      );
    }
    console.warn(
      `[coverage] brochure insert failed code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    throw new ApiError(500, "Could not register the brochure.");
  }
  if (!res.data) throw new ApiError(500, "Could not register the brochure.");
  return mapRow(res.data as BrochureRow);
}

/** Lists brochures, newest effective date first, optionally filtered. */
export async function listBrochures(filter: {
  stateCode?: StateCode;
  status?: BrochureStatus;
}): Promise<Brochure[]> {
  const supabase = getServerSupabase();
  let query = supabase
    .from("plan_brochures")
    .select(BROCHURE_COLUMNS)
    .order("state_code", { ascending: true })
    .order("effective_date", { ascending: false, nullsFirst: false })
    .order("imported_at", { ascending: false });

  if (filter.stateCode) query = query.eq("state_code", filter.stateCode);
  if (filter.status) query = query.eq("status", filter.status);

  const res = await query;
  if (res.error) {
    console.warn(
      `[coverage] brochure list failed code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    throw new ApiError(500, "Could not load brochures.");
  }
  return (res.data as BrochureRow[]).map(mapRow);
}

/**
 * Promotes a brochure to `status='current'` for its state, demoting the prior
 * current brochure to `superseded` — atomically, via the
 * `coverage_promote_current_brochure` RPC (one transaction), so the
 * one-current-per-state invariant is never transiently violated.
 */
export async function promoteCurrentBrochure(id: string): Promise<Brochure> {
  const supabase = getServerSupabase();
  const res = await supabase.rpc("coverage_promote_current_brochure", {
    target_id: id,
  });

  if (res.error) {
    // P0002 = the RPC's no_data_found RAISE (brochure id doesn't exist).
    if (res.error.code === "P0002") {
      throw new ApiError(404, "Brochure not found.");
    }
    // 23514 = the RPC's status guardrail (only an 'imported' brochure may be
    // promoted). Surface a clear, safe 409 instead of a generic 500.
    if (res.error.code === "23514") {
      throw new ApiError(
        409,
        "Only an imported brochure can be promoted to current.",
      );
    }
    console.warn(
      `[coverage] brochure promote failed id=${id} code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    throw new ApiError(500, "Could not promote the brochure.");
  }

  // RETURNS plan_brochures → a single composite row (handle array defensively).
  const row = (Array.isArray(res.data) ? res.data[0] : res.data) as
    | BrochureRow
    | null;
  if (!row) throw new ApiError(404, "Brochure not found.");
  return mapRow(row);
}

/** Reads one brochure by id, or null when it doesn't exist. */
export async function getBrochure(id: string): Promise<Brochure | null> {
  const supabase = getServerSupabase();
  const res = await supabase
    .from("plan_brochures")
    .select(BROCHURE_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (res.error) {
    console.warn(
      `[coverage] brochure get failed code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    throw new ApiError(500, "Could not load the brochure.");
  }
  return res.data ? mapRow(res.data as BrochureRow) : null;
}
