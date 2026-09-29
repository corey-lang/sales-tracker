import {
  LEGACY_DROP_PATCH,
  LegacyCommitmentUpdateSchema,
  buildLegacyCommitmentPatch,
} from "@/lib/legacy-commitments";
import { getServerSupabase } from "@/lib/supabase/server";
import { requireVisibleWeek } from "@/lib/server/roster";
import {
  handleApiError,
  notFound,
  parseBody,
  requireAdmin,
} from "@/lib/server/auth";
import type { WeeklyFocusCommitment } from "@/lib/one-on-ones";

// PATCH /api/admin/one-on-ones/[id]/commitments/[cid]   -> { commitment: ... }
// DELETE /api/admin/one-on-ones/[id]/commitments/[cid]  -> { commitment: ... }
//
// Admin-only.
//
// PATCH accepts:
//   - status:    'open' | 'completed' | 'dropped'   (authoritative lifecycle)
//   - completed: boolean                            (LEGACY — maps to status)
//   - content:   string
//   - due_date:  YYYY-MM-DD | null
//
// DELETE never hard-deletes. Coaching history matters, so "remove from
// active focus" is modeled as `status = 'dropped'` — the row stays
// queryable but stops surfacing as active/carryover. To truly delete a
// commitment a service-role caller can act on the row directly; the UI
// never does.
//
// The DB lookup pins BOTH `cid` and `one_on_one_id = id` so the URL's
// parent segment is enforced as a real ownership check — a mismatched
// pair returns 404 instead of silently editing a commitment that lives
// on a different week.
//
// CONSISTENCY WITH 1:1s: the write goes through update_legacy_commitment(),
// which takes the AE's in-progress 1:1 lock (meeting row, then commitment
// row) before updating, so even an old client can't change a commitment
// "through" a 1:1's completion snapshot. With no 1:1 in progress it behaves
// exactly as the plain UPDATE did. The request/response contract is
// unchanged.
//
// The 1:1 workspace does NOT use this route for legacy carryover — it uses
// /api/admin/one-on-one-meetings/[id]/legacy-commitments/[cid], which applies
// the same rules (lib/legacy-commitments.ts) under the 1:1's lock.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The write, via update_legacy_commitment() (supabase/one_on_one_meetings.sql):
 * pinned to `cid` + week `id` exactly as before, but at the database boundary
 * it first takes the AE's in-progress 1:1 lock (if there is one), so it can't
 * race that 1:1's completion snapshot. Same result + errors as the direct
 * UPDATE it replaces.
 */
async function writeLegacy(
  weekId: string,
  cid: string,
  patch: Record<string, unknown>,
  me: { id: string },
): Promise<WeeklyFocusCommitment> {
  const supabase = getServerSupabase();
  // A private test account's commitments are reachable only by its owner —
  // same 404 as a commitment that doesn't exist (contract unchanged).
  await requireVisibleWeek(supabase, weekId, me, "Commitment not found.");
  const res = await supabase.rpc("update_legacy_commitment", {
    p_week_id: weekId,
    p_commitment_id: cid,
    p_patch: patch,
  });
  if (res.error) {
    if (res.error.code === "P0002") throw notFound("Commitment not found.");
    throw new Error(res.error.message);
  }
  if (!res.data) throw notFound("Commitment not found.");
  return res.data as WeeklyFocusCommitment;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; cid: string }> },
) {
  try {
    const me = await requireAdmin(req);
    const { id, cid } = await params;
    const body = await parseBody(req, LegacyCommitmentUpdateSchema);

    const patch = buildLegacyCommitmentPatch(body);
    if (!patch) {
      return Response.json({ error: "No fields to update." }, { status: 400 });
    }

    return Response.json({ commitment: await writeLegacy(id, cid, patch, me) });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; cid: string }> },
) {
  try {
    const me = await requireAdmin(req);
    const { id, cid } = await params;
    // Soft-delete: mark status='dropped' instead of removing the row.
    // Preserves coaching history; the UI's trash affordance is really
    // "remove from active focus", not "erase from history".
    return Response.json({
      commitment: await writeLegacy(id, cid, { ...LEGACY_DROP_PATCH }, me),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
