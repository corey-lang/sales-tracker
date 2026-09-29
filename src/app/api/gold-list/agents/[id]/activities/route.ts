import { createActivitySchema } from "@/lib/gold-list-validation";
import { allGoldListRows, requireGoldListAccess } from "@/lib/server/gold-list";

import { getServerSupabase } from "@/lib/supabase/server";
import { ApiError, handleApiError, parseBody } from "@/lib/server/auth";
import {
  ACTIVITY_COLUMNS,
  requireOwnedAgent,
  requireViewableAgent,
  scheduleAgentActivity,
} from "@/lib/server/gold-list";
import {
  GOLD_LIST_ACTIVITIES_TABLE,
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
    const body = await parseBody(req, createActivitySchema);
    const supabase = getServerSupabase();

    const agent = await requireOwnedAgent(supabase, id, me);
    const { activity, created } = await scheduleAgentActivity(
      supabase,
      agent,
      body,
      me.id,
    );
    return Response.json({ activity }, { status: created ? 201 : 200 });
  } catch (err) {
    return handleApiError(err);
  }
}
