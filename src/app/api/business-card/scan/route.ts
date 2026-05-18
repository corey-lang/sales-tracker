import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import { isTestAccount } from "@/lib/permissions";
import {
  handleApiError,
  parseBody,
  requireSalesperson,
} from "@/lib/server/auth";

// Server-side intake for a business card scan.
// POST /api/business-card/scan
//   body: { imageUrl: string }
//   200:  { scanId: string }
//
// AUTHORIZATION (Phase 0)
//   The caller is identified by their signed session token, validated by
//   requireSalesperson() against the salespeople table. The scan is attributed
//   to THAT salesperson — the route no longer trusts a salespersonId from the
//   request body, so an AE can only ever create scans for themselves.
//
//   business_card_scans has RLS enabled (see supabase/business_card_rls.sql)
//   and the app has no Supabase Auth, so the browser anon key cannot insert
//   scan rows. This route runs with the service-role key, which bypasses RLS.

export const runtime = "nodejs";

/** A scan image must live in the business-card-scans storage bucket. */
const IMAGE_URL_MARKER = "/business-card-scans/";

const ScanSchema = z.object({
  imageUrl: z.string().min(1, "imageUrl is required."),
});

export async function POST(req: Request) {
  try {
    // Identity comes from the session token, not the request body.
    const me = await requireSalesperson(req);
    const { imageUrl } = await parseBody(req, ScanSchema);

    // Only accept an image we just uploaded to our own bucket — never an
    // arbitrary external URL the client may have supplied.
    if (!imageUrl.includes(IMAGE_URL_MARKER)) {
      return Response.json(
        { error: "imageUrl is not a business-card-scans storage URL" },
        { status: 400 },
      );
    }

    const supabase = getServerSupabase();

    const insert = await supabase
      .from("business_card_scans")
      .insert({
        salesperson_id: me.id,
        // Server-trusted: the authenticated salesperson, not a body field.
        salesperson_name: me.first_name,
        image_url: imageUrl,
        status: "processing",
        // Keeps the seeded "Test" account's scans separable from real AE data
        // for the cleanup script.
        is_test_data: isTestAccount(me),
      })
      .select("id")
      .single();

    if (insert.error || !insert.data) {
      return Response.json(
        { error: insert.error?.message ?? "Failed to save scan" },
        { status: 500 },
      );
    }

    return Response.json({ scanId: insert.data.id });
  } catch (err) {
    return handleApiError(err);
  }
}
