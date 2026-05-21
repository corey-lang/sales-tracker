import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  handleApiError,
  parseBody,
  requireAdmin,
} from "@/lib/server/auth";

// POST /api/admin/goals/maintenance
//
// Admin-only. Narrowly-scoped destructive operations on `weekly_goals`
// surfaced by the admin Maintenance card. Lives behind the same
// requireAdmin() gate as the rest of the admin write paths now that the
// table is RLS-locked from the anon key (see weekly_goals_lockdown.sql).
//
// Actions:
//   { action: "clear_all" }
//     -> Deletes EVERY goal row. The maintenance card double-confirms;
//        this route just executes. Returns the deleted count.
//
//   { action: "clear_old_versions" }
//     -> Per scope (`salesperson_id` value OR NULL = global), keeps the
//        most recently created row and deletes every older one. Safe
//        for the currently active goal — only history rows are dropped.
//
// Both actions return `{ deleted: number }` so the UI can show
// "Cleared N goal rows" rather than guessing.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("clear_all") }),
  z.object({ action: z.literal("clear_old_versions") }),
]);

// Same sentinel as the old client-side code: a date guaranteed to be
// older than any real row, used as the >= filter so Supabase's "delete
// requires a filter" guard passes without scoping the delete.
const MATCH_ALL_DATE = "1900-01-01";

export async function POST(req: Request) {
  try {
    await requireAdmin(req);
    const body = await parseBody(req, RequestSchema);
    const supabase = getServerSupabase();

    if (body.action === "clear_all") {
      const res = await supabase
        .from("weekly_goals")
        .delete({ count: "exact" })
        .gte("effective_from", MATCH_ALL_DATE);
      if (res.error) {
        throw new ApiError(
          500,
          `Could not clear goals: ${res.error.message}`,
        );
      }
      return Response.json({ deleted: res.count ?? 0 });
    }

    // clear_old_versions: SELECT all rows newest-first, walk per scope,
    // accumulate older-than-newest ids, then DELETE that id set. Two
    // queries (no transactional guarantee) but the worst-case race is a
    // simultaneous goal save — that race would already be caught by
    // the partial UNIQUE indexes on the table.
    const fetchRes = await supabase
      .from("weekly_goals")
      .select("id, salesperson_id, effective_from, created_at")
      .order("effective_from", { ascending: false })
      .order("created_at", { ascending: false });
    if (fetchRes.error) {
      throw new ApiError(
        500,
        `Could not load goal history: ${fetchRes.error.message}`,
      );
    }
    const all = (fetchRes.data ?? []) as Array<{
      id: string;
      salesperson_id: string | null;
    }>;
    const seenScope = new Set<string>();
    const idsToDelete: string[] = [];
    for (const row of all) {
      // `__global__` separates `salesperson_id IS NULL` from any string
      // id, matching the dedupe partition used by the lockdown migration.
      const scopeKey = row.salesperson_id ?? "__global__";
      if (seenScope.has(scopeKey)) {
        idsToDelete.push(row.id);
      } else {
        seenScope.add(scopeKey);
      }
    }
    if (idsToDelete.length === 0) {
      return Response.json({ deleted: 0 });
    }
    const delRes = await supabase
      .from("weekly_goals")
      .delete({ count: "exact" })
      .in("id", idsToDelete);
    if (delRes.error) {
      throw new ApiError(
        500,
        `Could not delete old goal versions: ${delRes.error.message}`,
      );
    }
    return Response.json({ deleted: delRes.count ?? idsToDelete.length });
  } catch (err) {
    return handleApiError(err);
  }
}
