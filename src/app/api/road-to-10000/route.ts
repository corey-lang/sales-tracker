import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import { todayInAppTimezone } from "@/lib/dates";
import { format } from "date-fns";
import { handleApiError, parseBody } from "@/lib/server/auth";
import {
  RoadLowerThanCurrentError,
  RoadStaleError,
  buildRoadView,
  canUpdateRoadTotal,
  manualTotalSource,
  recordTotal,
  requireRoadReader,
  requireRoadUpdater,
} from "@/lib/server/road-to-10000";

// Road to 10,000 — the company goal of 10,000 Homescriptions sold in 2026.
//
//   GET  /api/road-to-10000  -> RoadView  (total, metrics, history, holidays counted)
//   POST /api/road-to-10000  -> RoadView  (record a new cumulative total)
//
// GET is open to any signed-in AE-tool user (view-only for AEs: `can_update` is
// false). POST is admin / assistant only, and the database function re-checks
// that. Before supabase/road_to_10000.sql is applied, GET answers
// `{ configured: false }` (200) and POST a clear 503 — nothing breaks.
//
// POST body: { total, expected_latest_id, is_correction?, note? }
//   * `total` is the CUMULATIVE number of Homescriptions sold — never a delta.
//   * `expected_latest_id` is the id of the latest total the screen was showing
//     (null if none): if someone else recorded one meanwhile, 409 with the
//     current view, nothing saved.
//   * A total LOWER than the current one is refused (409 `lower_than_current`)
//     unless `is_correction` is true with a `note` (the reason); the earlier
//     value stays in the history either way.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RecordSchema = z
  .object({
    total: z
      .number({ error: "Enter the cumulative total as a whole number." })
      .int("Enter a whole number.")
      .min(0, "The total can't be negative.")
      .max(10000, "The total can't be more than 10,000."),
    expected_latest_id: z.string().uuid().nullable(),
    is_correction: z.boolean().optional(),
    note: z.string().trim().max(500).nullish(),
  })
  .strict()
  .refine((v) => !v.is_correction || Boolean(v.note?.trim()), {
    message: "Add a short reason for the correction.",
    path: ["note"],
  });

const today = () => format(todayInAppTimezone(), "yyyy-MM-dd");

export async function GET(req: Request) {
  try {
    const me = await requireRoadReader(req);
    const supabase = getServerSupabase();
    const view = await buildRoadView(supabase, manualTotalSource(supabase), {
      canUpdate: canUpdateRoadTotal(me),
      today: today(),
    });
    return Response.json(view, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const me = await requireRoadUpdater(req);
    const body = await parseBody(req, RecordSchema);
    const supabase = getServerSupabase();
    const source = manualTotalSource(supabase);
    const view = () =>
      buildRoadView(supabase, source, { canUpdate: true, today: today() });
    try {
      await recordTotal(supabase, me, {
        total: body.total,
        isCorrection: body.is_correction === true,
        note: body.note?.trim() || null,
        expectedLatestId: body.expected_latest_id,
      });
    } catch (err) {
      if (err instanceof RoadStaleError) {
        return Response.json({ error: err.message, code: "stale", view: await view() }, { status: 409 });
      }
      if (err instanceof RoadLowerThanCurrentError) {
        return Response.json({ error: err.message, code: "lower_than_current" }, { status: 409 });
      }
      throw err;
    }
    return Response.json(await view(), { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
