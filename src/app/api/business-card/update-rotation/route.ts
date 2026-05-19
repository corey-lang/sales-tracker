import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  handleApiError,
  parseBody,
  requireReviewer,
} from "@/lib/server/auth";

// Persist a business card scan's display rotation.
// POST /api/business-card/update-rotation
//   body: { scanId: string, rotation: 0 | 90 | 180 | 270 }
//   200:  { ok: true, scanId, rotation }
//
// Autosave for the Verification Center's rotate-left / rotate-right controls.
// Rotation is DISPLAY METADATA — the uploaded image in Storage is untouched,
// and AI extraction is neither changed nor re-run.
//
// AUTHORIZATION
//   requireReviewer() — admin or the assistant (Tonja).

export const runtime = "nodejs";

const UpdateRotationSchema = z.object({
  scanId: z.string().min(1, "scanId is required."),
  // Normalized to a quarter turn — anything else is rejected with a 400.
  rotation: z.union([
    z.literal(0),
    z.literal(90),
    z.literal(180),
    z.literal(270),
  ]),
});

export async function POST(req: Request) {
  try {
    await requireReviewer(req);
    const { scanId, rotation } = await parseBody(req, UpdateRotationSchema);

    const supabase = getServerSupabase();

    // Only an existing scan's rotation may be updated.
    const upd = await supabase
      .from("business_card_scans")
      .update({ image_rotation_degrees: rotation })
      .eq("id", scanId)
      .select("id")
      .single();

    if (upd.error || !upd.data) {
      // PostgREST returns an error / no row when the id does not exist.
      return Response.json(
        { error: upd.error?.message ?? "Scan not found." },
        { status: upd.error ? 500 : 404 },
      );
    }

    return Response.json({ ok: true, scanId, rotation });
  } catch (err) {
    return handleApiError(err);
  }
}
