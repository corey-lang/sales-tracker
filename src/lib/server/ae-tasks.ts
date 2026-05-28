import { getServerSupabase } from "@/lib/supabase/server";
import { ApiError, badRequest } from "@/lib/server/auth";
import type { AeTask } from "@/lib/ae-tasks";
import { officeEnvironmentFor } from "@/lib/offices";

// Server-only helpers for the /api/tasks routes.
//
// Keeps the "look up office names for tasks with an office_id" pass
// in one place so the GET / POST / PATCH routes can share it. Tasks
// with no office_id are passed through with office_name=null; tasks
// whose office_id no longer resolves (deleted office, archived,
// other env) also get null — the UI degrades to "From office: (no
// longer available)" rather than rendering a broken link.

/** Shape returned by the raw `ae_tasks` SELECT in the route handlers.
 *  Identical to `AeTask` minus the synthesized `office_name`. */
type AeTaskRow = Omit<AeTask, "office_name">;

/**
 * Attaches the office display name to each task. Single round-trip
 * (`offices` IN (…)) so a long task list with N office references
 * still costs one extra query, not N.
 *
 * Service-role bypasses RLS, so this works regardless of the
 * `offices` table's policy posture. The caller's identity has
 * already been validated at the route boundary; this helper does
 * not re-check ownership (it's a denormalization-only pass).
 */
export async function enrichTasksWithOfficeName(
  supabase: ReturnType<typeof getServerSupabase>,
  tasks: AeTaskRow[],
): Promise<AeTask[]> {
  const officeIds = Array.from(
    new Set(
      tasks
        .map((t) => t.office_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );

  if (officeIds.length === 0) {
    return tasks.map((t) => ({ ...t, office_name: null }));
  }

  // Archived offices are intentionally excluded from the lookup.
  // The To-Do list then renders "From office: (no longer available)"
  // for tasks linked to archived offices — matches the office-detail
  // pattern where archived rows disappear from every read surface.
  const officesRes = await supabase
    .from("offices")
    .select("id, name")
    .in("id", officeIds)
    .is("archived_at", null);

  if (officesRes.error) {
    // Don't fail the whole task fetch over a name lookup. Log + fall
    // through with office_name=null so the UI shows the back-link as
    // plain text rather than a broken hyperlink.
    console.warn(
      `[ae-tasks] office name lookup failed count=${officeIds.length} code=${officesRes.error.code ?? "?"} msg=${officesRes.error.message}`,
    );
    return tasks.map((t) => ({ ...t, office_name: null }));
  }

  const nameById = new Map<string, string>();
  for (const row of (officesRes.data ?? []) as Array<{
    id: string;
    name: string;
  }>) {
    nameById.set(row.id, row.name);
  }

  return tasks.map((t) => ({
    ...t,
    office_name: t.office_id ? (nameById.get(t.office_id) ?? null) : null,
  }));
}

/**
 * True when `err` is the office_id FK violation specifically. Used
 * by the task INSERT / UPDATE paths to map the race condition
 * "office was deleted between assertCallerOwnsOffice and the write"
 * to the same uniform 400 the pre-check uses, rather than letting
 * a raw 23503 surface to the client.
 *
 * Detection strategy: Postgres code `23503` (foreign_key_violation)
 * + the column name `office_id` appearing anywhere in the message
 * or details. Locking onto the constraint name alone would be
 * fragile across a future rename; the column reference is the more
 * durable signal.
 */
export function isOfficeLinkForeignKeyError(
  err: {
    code?: string | null;
    message?: string | null;
    details?: string | null;
  } | null
    | undefined,
): boolean {
  if (!err) return false;
  if (err.code !== "23503") return false;
  const text = `${err.message ?? ""} ${err.details ?? ""}`.toLowerCase();
  return text.includes("office_id");
}

/**
 * Verifies a caller-supplied `office_id` is valid for the calling AE
 * BEFORE the task INSERT / UPDATE runs. Without this pre-check, a
 * bad UUID would only fail at the FK boundary (Postgres 23503 →
 * generic 500 through handleApiError), which leaks low-value DB
 * noise to the client and obscures the real diagnosis.
 *
 * The route paths also call `isOfficeLinkForeignKeyError` on the
 * INSERT / UPDATE error to catch the small race where the office
 * is deleted between this check and the write.
 *
 * Validity predicate mirrors `/api/offices/[id]`:
 *   * office row exists,
 *   * its `salesperson_id` equals the caller,
 *   * its `environment` equals `officeEnvironmentFor(caller)` — real
 *     AEs operate in `"production"`, the test account in `"test"`.
 *
 * All branches collapse to a uniform 400 ("Office link is invalid or
 * no longer available.") so the response never confirms whether a
 * cross-env or another AE's office sits at that id.
 *
 * Distinguishes between:
 *   * Provider error (connection blip, etc.) → log + 500 with a
 *     sanitized "Could not verify office link." message.
 *   * Predicate miss → 400.
 *
 * Service-role bypasses RLS on the `offices` table, so the read
 * works regardless of the table's RLS-on-no-policy posture. The
 * caller identity has already been validated at the route boundary;
 * this helper only checks ownership of the office row.
 */
export async function assertCallerOwnsOffice(
  supabase: ReturnType<typeof getServerSupabase>,
  officeId: string,
  caller: { id: string; is_test: boolean },
): Promise<void> {
  const environment = officeEnvironmentFor(caller);
  const res = await supabase
    .from("offices")
    .select("id")
    .eq("id", officeId)
    .eq("salesperson_id", caller.id)
    .eq("environment", environment)
    // Archived offices can't be linked to new tasks — same uniform
    // 400 as a not-found / wrong-owner miss.
    .is("archived_at", null)
    .maybeSingle();

  if (res.error) {
    console.warn(
      `[ae-tasks] office link verify failed office_id=${officeId} caller=${caller.id} code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    throw new ApiError(500, "Could not verify office link.");
  }
  if (!res.data) {
    throw badRequest("Office link is invalid or no longer available.");
  }
}
