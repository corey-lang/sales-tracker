import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  badRequest,
  handleApiError,
  parseBody,
  requireAdmin,
} from "@/lib/server/auth";
import { requireCoachableAe } from "@/lib/server/coaching";
import {
  ONE_ON_ONES_TABLE,
  ONE_ON_ONE_VISIBILITIES,
  type OneOnOne,
} from "@/lib/one-on-ones";

// POST /api/admin/coaching/[ae_id]/one-on-ones
//
// Admin-only. Creates a new 1:1 meeting record for the given AE.
//
//   body: { meeting_date?: YYYY-MM-DD, visibility?: 'manager_only' | 'shared' }
//   -> { one_on_one: OneOnOne }
//
// The manager_id is stamped from the signed admin session — clients can't
// spoof another manager. The "previous 1:1 commitments" surfaced on the
// detail page after this insert are derived by the GET endpoint, NOT
// auto-cloned here, so the AE's prior checklist stays in place and the
// manager reviews + carries forward what's still relevant.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  meeting_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "meeting_date must be YYYY-MM-DD.")
    .optional(),
  visibility: z.enum(ONE_ON_ONE_VISIBILITIES).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ ae_id: string }> },
) {
  try {
    const me = await requireAdmin(req);
    const { ae_id } = await params;
    const body = await parseBody(req, CreateSchema);

    const supabase = getServerSupabase();

    // Verify the target is a coachable AE before inserting — 404 covers
    // both "doesn't exist" and "exists but wrong role" so the route
    // can't be used to seed 1:1s against admins or juice_box_only users.
    await requireCoachableAe(supabase, ae_id);

    // Build the insert row conditionally so the table's NOT NULL columns
    // with defaults (meeting_date DEFAULT CURRENT_DATE, visibility DEFAULT
    // 'manager_only') fall through to those defaults when the client
    // doesn't provide a value. Passing `null` here would override the
    // default and violate NOT NULL — which is exactly the bug the empty-
    // body "Start new 1:1" tap was hitting.
    const insertRow: {
      ae_id: string;
      manager_id: string | null;
      meeting_date?: string;
      visibility?: string;
    } = {
      ae_id,
      manager_id: me.id,
    };
    if (body.meeting_date) insertRow.meeting_date = body.meeting_date;
    if (body.visibility) insertRow.visibility = body.visibility;

    const insertRes = await supabase
      .from(ONE_ON_ONES_TABLE)
      .insert(insertRow)
      .select("*")
      .single();
    if (insertRes.error || !insertRes.data) {
      throw new Error(insertRes.error?.message ?? "Could not create 1:1.");
    }
    return Response.json({ one_on_one: insertRes.data as OneOnOne });
  } catch (err) {
    // parseBody throws 400 on schema mismatch; surface that as-is.
    if (err instanceof Error && err.message.includes("must be")) {
      return handleApiError(badRequest(err.message));
    }
    return handleApiError(err);
  }
}
