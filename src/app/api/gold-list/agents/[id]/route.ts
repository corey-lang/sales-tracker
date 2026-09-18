import { emailSchema, phoneSchema } from "@/lib/gold-list-validation";
import { requireGoldListAccess } from "@/lib/server/gold-list";
import { z } from "zod";

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
  isUniqueViolation,
  requireOwnedAgent,
} from "@/lib/server/gold-list";
import {
  AGENT_FIELD_MAX_LENGTH,
  AGENT_NAME_MAX_LENGTH,
  AGENT_NOTES_MAX_LENGTH,
  GOLD_LIST_AGENTS_TABLE,
  type GoldListAgent,
} from "@/lib/gold-list";

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

const optionalField = z.string().trim().max(AGENT_FIELD_MAX_LENGTH).nullish();

const UpdateAgentSchema = z.object({
  agent_name: z
    .string()
    .trim()
    .min(1, "Agent name cannot be empty.")
    .max(AGENT_NAME_MAX_LENGTH)
    .optional(),
  brokerage: optionalField,
  phone: phoneSchema,
  email: emailSchema,
  notes: z.string().trim().max(AGENT_NOTES_MAX_LENGTH).nullish(),
  /** true = archive, false = restore. Omit to leave the archive state alone. */
  archived: z.boolean().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const me = await requireGoldListAccess(req);
    const { id } = await params;
    const body = await parseBody(req, UpdateAgentSchema);
    const supabase = getServerSupabase();

    await requireOwnedAgent(supabase, id, me);

    const patch: Record<string, unknown> = {};
    if (body.agent_name !== undefined) patch.agent_name = body.agent_name;
    if (body.brokerage !== undefined) patch.brokerage = body.brokerage || null;
    if (body.phone !== undefined) patch.phone = body.phone || null;
    if (body.email !== undefined) patch.email = body.email || null;
    if (body.notes !== undefined) patch.notes = body.notes || null;
    if (body.archived !== undefined) {
      patch.archived_at = body.archived ? new Date().toISOString() : null;
    }
    if (Object.keys(patch).length === 0) {
      return Response.json({ error: "No fields to update." }, { status: 400 });
    }

    const res = await supabase
      .from(GOLD_LIST_AGENTS_TABLE)
      .update(patch)
      .eq("id", id)
      .eq("salesperson_id", me.id)
      .select(AGENT_COLUMNS)
      .maybeSingle();

    if (res.error) {
      // Renaming into a collision with another ACTIVE agent, or restoring an
      // archived agent whose name is now taken by an active one.
      if (isUniqueViolation(res.error)) {
        throw new ApiError(
          409,
          "Another active agent on your Gold List already has that name and brokerage.",
        );
      }
      console.warn(
        `[gold-list] agent update failed agent_id=${id} caller=${me.id} code=${res.error.code ?? "?"} msg=${res.error.message}`,
      );
      throw new ApiError(500, "Could not save that agent.");
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
