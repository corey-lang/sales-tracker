import { updateAgentSchema } from "@/lib/gold-list-validation";
import { requireGoldListAccess } from "@/lib/server/gold-list";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  handleApiError,
  notFound,
  parseBody,
} from "@/lib/server/auth";
import {
  AGENT_COLUMNS,
  decorateAgents,
  requireOwnedAgent,
  updateGoldListAgent,
} from "@/lib/server/gold-list";
import { GOLD_LIST_AGENTS_TABLE, type GoldListAgent } from "@/lib/gold-list";

// One Gold List agent — edit / archive.
//   PATCH  /api/gold-list/agents/:id   body: { agent_name?, brokerage?, phone?,
//                                              email?, notes?, archived? }
//   DELETE /api/gold-list/agents/:id   -> soft archive
//
// OWNERSHIP
//   Owner-only, enforced twice: `requireOwnedAgent` resolves the row and
//   rejects a non-owner (including an admin acting on someone else's agent)
//   with a 404, and the write itself is additionally pinned to
//   `salesperson_id = me.id` so no race can widen it.
//
// ARCHIVE, NOT DELETE
//   DELETE soft-archives (`archived_at = NOW()`), the same shape as
//   offices.archived_at and coaching_relationships.archived_at. Hard-deleting
//   would cascade the agent's activity history away — the history is the
//   point of the feature. PATCH `{ archived: false }` restores.
//
// FIELD SEMANTICS
//   Omitted field = leave as-is. Explicit null (or "") = clear it. Only
//   `agent_name` cannot be cleared.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireGoldListAccess(req);
    const { id } = await params;
    const body = await parseBody(req, updateAgentSchema);
    const supabase = getServerSupabase();

    const current = await requireOwnedAgent(supabase, id, me);

    const agent = await updateGoldListAgent(supabase, current, body, me.id);
    if (!agent) throw notFound("Gold List agent not found.");

    const [decorated] = await decorateAgents(supabase, [agent], me);
    return Response.json({ agent: decorated });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireGoldListAccess(req);
    const { id } = await params;
    const supabase = getServerSupabase();

    await requireOwnedAgent(supabase, id, me);

    // Soft archive. The agent's activities are intentionally left untouched —
    // restoring brings the whole history back exactly as it was.
    const res = await supabase
      .from(GOLD_LIST_AGENTS_TABLE)
      .update({ archived_at: new Date().toISOString() })
      .eq("id", id)
      .eq("salesperson_id", me.id)
      .select(AGENT_COLUMNS)
      .maybeSingle();

    if (res.error) {
      console.warn(
        `[gold-list] agent archive failed agent_id=${id} caller=${me.id} code=${res.error.code ?? "?"} msg=${res.error.message}`,
      );
      throw new ApiError(500, "Could not archive that agent.");
    }
    if (!res.data) throw notFound("Gold List agent not found.");

    const [agent] = await decorateAgents(
      supabase,
      [res.data as GoldListAgent],
      me,
    );
    return Response.json({ agent });
  } catch (err) {
    return handleApiError(err);
  }
}
