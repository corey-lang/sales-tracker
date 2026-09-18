import {
  activityNoteSchema,
  descriptionSchema,
  dateSchema,
} from "@/lib/gold-list-validation";
import { allGoldListRows, requireGoldListAccess } from "@/lib/server/gold-list";
import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import { ApiError, handleApiError, parseBody } from "@/lib/server/auth";
import {
  ACTIVITY_COLUMNS,
  isUniqueViolation,
  requireOwnedAgent,
  requireViewableAgent,
} from "@/lib/server/gold-list";
import {
  GOLD_LIST_ACTIVITIES_TABLE,
  GOLD_LIST_ACTIVITY_TYPE_KEYS,
  type GoldListActivity,
} from "@/lib/gold-list";

// Activities for one Gold List agent — history + schedule.
//   GET  /api/gold-list/agents/:id/activities  -> { activities }
//   POST /api/gold-list/agents/:id/activities  -> { activity }
//
// HISTORY IS THE POINT
//   GET returns EVERY activity for the agent — scheduled, completed, and
//   cancelled — newest first. Completing an activity never deletes or
//   overwrites it; the next activity is a new row. That is what preserves the
//   relationship's timeline across weeks, independent of any Weekly Focus
//   record.
//
// ACCESS
//   GET  — the owner, or an admin (read-only visibility into any AE's list).
//   POST — owner-only.
//
// ONE OPEN ACTIVITY AT A TIME
//   The DB holds a partial unique index on (agent_id) WHERE status =
//   'scheduled'. Scheduling a second open activity is rejected with a 409
//   rather than silently creating a parallel track — the workflow is
//   complete-then-schedule-the-next by design.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A yyyy-mm-dd date that also parses to a real calendar date (matches /api/tasks). */
const scheduledForSchema = dateSchema;

const CreateActivitySchema = z.object({
  activity_type: z.enum(GOLD_LIST_ACTIVITY_TYPE_KEYS).default("other"),
  description: descriptionSchema,
  /** OPTIONAL plan note for this touch. Never the completion outcome — that is
   *  written later, to `outcome_note`, by the PATCH route. */
  activity_note: activityNoteSchema,
  request_id: z.string().uuid().optional(),
  scheduled_for: scheduledForSchema,
});

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireGoldListAccess(req);
    const { id } = await params;
    const supabase = getServerSupabase();

    // Owner or admin. A non-owner AE gets a 404 here, not an empty list.
    await requireViewableAgent(supabase, id, me);

    const res = await allGoldListRows<GoldListActivity>(
      supabase
        .from(GOLD_LIST_ACTIVITIES_TABLE)
        .select(ACTIVITY_COLUMNS)
        .eq("agent_id", id)
        .order("completed_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .order("id"),
    );

    if (res.error) {
      console.warn(
        `[gold-list] activity history failed agent_id=${id} caller=${me.id} code=${res.error.code ?? "?"} msg=${res.error.message}`,
      );
      throw new ApiError(500, "Could not load that agent's activity.");
    }
    return Response.json(
      { activities: (res.data ?? []) as GoldListActivity[] },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireGoldListAccess(req);
    const { id } = await params;
    const body = await parseBody(req, CreateActivitySchema);
    const supabase = getServerSupabase();

    const agent = await requireOwnedAgent(supabase, id, me);
    if (agent.archived_at !== null) {
      throw new ApiError(
        409,
        "That agent is archived. Restore them before scheduling new activity.",
      );
    }

    if (body.request_id) {
      const previous = await supabase
        .from(GOLD_LIST_ACTIVITIES_TABLE)
        .select(ACTIVITY_COLUMNS)
        .eq("id", body.request_id)
        .eq("agent_id", id)
        .eq("salesperson_id", me.id)
        .maybeSingle();
      if (previous.error)
        throw new ApiError(500, "Could not check this activity request.");
      if (previous.data) return Response.json({ activity: previous.data });
    }

    const res = await supabase
      .from(GOLD_LIST_ACTIVITIES_TABLE)
      .insert({
        agent_id: agent.id,
        // Denormalized owner. Taken from the AGENT row (which was just
        // ownership-checked), never from the request — and the composite FK
        // would reject it anyway if the pair didn't match.
        salesperson_id: agent.salesperson_id,
        activity_type: body.activity_type,
        description: body.description,
        // "" and null both mean "no note"; store NULL so the column has one
        // empty representation.
        activity_note: body.activity_note || null,
        ...(body.request_id ? { id: body.request_id } : {}),
        scheduled_for: body.scheduled_for,
        status: "scheduled",
      })
      .select(ACTIVITY_COLUMNS)
      .single();

    if (res.error) {
      if (res.error.code === "23514")
        throw new ApiError(
          409,
          "This agent or activity changed. Refresh before trying again.",
        );
      if (isUniqueViolation(res.error)) {
        throw new ApiError(
          409,
          "This agent already has an activity scheduled. Complete or reschedule it first.",
        );
      }
      console.warn(
        `[gold-list] activity insert failed agent_id=${id} caller=${me.id} code=${res.error.code ?? "?"} msg=${res.error.message}`,
      );
      throw new ApiError(500, "Could not schedule that activity.");
    }
    return Response.json(
      { activity: res.data as GoldListActivity },
      { status: 201 },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
