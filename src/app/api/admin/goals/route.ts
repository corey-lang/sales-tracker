import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  handleApiError,
  parseBody,
  requireAdmin,
} from "@/lib/server/auth";
import { WEEKLY_GOAL_MAX_VALUE } from "@/lib/one-on-ones";

// POST /api/admin/goals
//
// Admin-only. Single endpoint behind which all admin Goal-card writes
// flow now that `weekly_goals` is RLS-locked from anon clients (see
// supabase/weekly_goals_lockdown.sql).
//
// Body:
//   {
//     salesperson_id: string | null,   // null = global default
//     effective_from: "YYYY-MM-DD",
//     office_visits: int >= 0,
//     service_requests: int >= 0,
//     ones_scheduled: int >= 0,
//     ones_held: int >= 0,
//     presentations: int >= 0,
//     impressions: int >= 0,
//     team_meetings: int >= 0,
//     gold_list_touches: int >= 0,
//   }
//
// Idempotent by (salesperson_id, effective_from): if a row already
// exists for the same scope and start date, the values on that row are
// REPLACED in place. That matches the new DB-level partial UNIQUE
// indexes (`idx_weekly_goals_per_ae_effective`,
// `idx_weekly_goals_global_effective`) — two saves on the same day for
// the same scope can never stack duplicate rows.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const goalValueField = z
  .number()
  .int("Goals must be whole numbers.")
  .min(0, "Goals must be 0 or greater.")
  .max(
    WEEKLY_GOAL_MAX_VALUE,
    `Goals must be ${WEEKLY_GOAL_MAX_VALUE} or less.`,
  );

const CreateSchema = z.object({
  salesperson_id: z.string().uuid().nullable(),
  effective_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "effective_from must be YYYY-MM-DD."),
  office_visits: goalValueField,
  service_requests: goalValueField,
  ones_scheduled: goalValueField,
  ones_held: goalValueField,
  presentations: goalValueField,
  impressions: goalValueField,
  team_meetings: goalValueField,
  gold_list_touches: goalValueField,
});

export async function POST(req: Request) {
  try {
    const me = await requireAdmin(req);
    const body = await parseBody(req, CreateSchema);

    const supabase = getServerSupabase();

    // Find the existing row at (scope, effective_from). One row max,
    // thanks to the partial UNIQUE indexes.
    let existingQuery = supabase
      .from("weekly_goals")
      .select("id")
      .eq("effective_from", body.effective_from);
    if (body.salesperson_id === null) {
      existingQuery = existingQuery.is("salesperson_id", null);
    } else {
      existingQuery = existingQuery.eq("salesperson_id", body.salesperson_id);
    }
    const existing = await existingQuery.maybeSingle();
    if (existing.error) {
      throw new ApiError(
        500,
        `Could not look up existing goal: ${existing.error.message}`,
      );
    }

    const payload = {
      salesperson_id: body.salesperson_id,
      effective_from: body.effective_from,
      created_by: me.id,
      office_visits: body.office_visits,
      service_requests: body.service_requests,
      ones_scheduled: body.ones_scheduled,
      ones_held: body.ones_held,
      presentations: body.presentations,
      impressions: body.impressions,
      team_meetings: body.team_meetings,
      gold_list_touches: body.gold_list_touches,
    };

    if (existing.data) {
      const updRes = await supabase
        .from("weekly_goals")
        .update(payload)
        .eq("id", (existing.data as { id: string }).id)
        .select("*")
        .maybeSingle();
      if (updRes.error) {
        throw new ApiError(
          500,
          `Could not update goal: ${updRes.error.message}`,
        );
      }
      return Response.json({ goal: updRes.data });
    }

    const insRes = await supabase
      .from("weekly_goals")
      .insert(payload)
      .select("*")
      .maybeSingle();
    if (insRes.error) {
      // 23505 = unique_violation. A concurrent admin save raced us and
      // landed first; turn the race into a clean 409 instead of a 500.
      if (insRes.error.code === "23505") {
        throw new ApiError(
          409,
          "Another save just landed for the same scope and date. Reload and try again.",
        );
      }
      throw new ApiError(500, `Could not save goal: ${insRes.error.message}`);
    }
    return Response.json({ goal: insRes.data });
  } catch (err) {
    return handleApiError(err);
  }
}
