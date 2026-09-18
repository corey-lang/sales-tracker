import { possibleDuplicate } from "@/lib/gold-list-validation";
import { emailSchema, phoneSchema } from "@/lib/gold-list-validation";
import { allGoldListRows, requireGoldListAccess } from "@/lib/server/gold-list";
import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import { ApiError, handleApiError, parseBody } from "@/lib/server/auth";
import {
  AGENT_COLUMNS,
  canViewAllGoldLists,
  decorateAgents,
  isUniqueViolation,
  listGoldListAeOptions,
  resolveGoldListScope,
} from "@/lib/server/gold-list";
import {
  AGENT_FIELD_MAX_LENGTH,
  AGENT_NAME_MAX_LENGTH,
  AGENT_NOTES_MAX_LENGTH,
  GOLD_LIST_AGENTS_TABLE,
  activeAgents,
  type GoldListAgent,
  type GoldListAgentWithFollowUp,
} from "@/lib/gold-list";

// Gold List agents — list + create.
//   GET  /api/gold-list/agents[?ae_id=<uuid|all>][&include_archived=1]
//        -> { agents, active_count, scope, ae_options? }
//   POST /api/gold-list/agents  -> { agent }
//
// ACCESS
//   AE and admin roles only, through the Gold List server guard.
//
// OWNERSHIP
//   Reads are scoped by `resolveGoldListScope`: an AE sees only their own
//   agents; an admin may pass `?ae_id=` to filter, or omit it to see every
//   AE's list. On create, the owner is ALWAYS the authenticated caller —
//   `salesperson_id` is never read from the request body.
//
// COUNTS
//   `active_count` is the number of non-archived agents in the requested
//   scope. It is what the page header renders ("Gold List — 18 agents"); the
//   board keeps it in sync locally from the rows this route returns, so adding
//   or archiving an agent moves the number without a refetch.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const optionalField = z.string().trim().max(AGENT_FIELD_MAX_LENGTH).nullish();

const CreateAgentSchema = z.object({
  confirm_duplicate: z.boolean().default(false),
  request_id: z.string().uuid().optional(),
  agent_name: z
    .string()
    .trim()
    .min(1, "Agent name is required.")
    .max(AGENT_NAME_MAX_LENGTH),
  brokerage: optionalField,
  phone: phoneSchema,
  email: emailSchema,
  notes: z.string().trim().max(AGENT_NOTES_MAX_LENGTH).nullish(),
});

export type GoldListAgentsResponse = {
  agents: GoldListAgentWithFollowUp[];
  active_count: number;
  scope: {
    /** The AE being viewed, or null when viewing every AE. */
    ae_id: string | null;
    view_all: boolean;
    viewer_id: string;
    /** Whether the caller may use the AE filter at all. */
    can_view_all: boolean;
  };
  /** Present only for callers who can view every list — the filter's options. */
  ae_options?: Array<{ id: string; first_name: string }>;
};

export async function GET(req: Request) {
  try {
    const supabase = getServerSupabase();
    const { me, ownerId, viewAll } = await resolveGoldListScope(req, supabase);

    const url = new URL(req.url);
    const includeArchived =
      url.searchParams.get("include_archived") === "1" ||
      url.searchParams.get("include_archived") === "true";

    let query = supabase.from(GOLD_LIST_AGENTS_TABLE).select(AGENT_COLUMNS);
    // viewAll is only ever true for a caller canViewAllGoldLists() approved,
    // so an unscoped read cannot be reached by an AE.
    if (ownerId) query = query.eq("salesperson_id", ownerId);
    if (!includeArchived) query = query.is("archived_at", null);

    const res = await allGoldListRows<GoldListAgent>(
      query
        .order("archived_at", { ascending: true, nullsFirst: true })
        .order("created_at", { ascending: false })
        .order("id"),
    );
    if (res.error) {
      console.warn(
        `[gold-list] agent list failed caller=${me.id} scope=${ownerId ?? "all"} code=${res.error.code ?? "?"} msg=${res.error.message}`,
      );
      throw new ApiError(500, "Could not load the Gold List.");
    }

    const rows = (res.data ?? []) as GoldListAgent[];
    const agents = await decorateAgents(supabase, rows, me);

    const body: GoldListAgentsResponse = {
      agents,
      active_count: activeAgents(agents).length,
      scope: {
        ae_id: ownerId,
        view_all: viewAll,
        viewer_id: me.id,
        can_view_all: canViewAllGoldLists(me),
      },
    };
    if (canViewAllGoldLists(me)) {
      body.ae_options = await listGoldListAeOptions(supabase);
    }
    return Response.json(body, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const me = await requireGoldListAccess(req);
    const body = await parseBody(req, CreateAgentSchema);
    const supabase = getServerSupabase();

    const existing = await allGoldListRows<GoldListAgent>(
      supabase
        .from(GOLD_LIST_AGENTS_TABLE)
        .select(AGENT_COLUMNS)
        .eq("salesperson_id", me.id)
        .order("id"),
    );
    if (existing.error)
      throw new ApiError(500, "Could not check your existing agents.");
    const ownAgents = (existing.data ?? []) as GoldListAgent[];
    const previous =
      body.request_id && ownAgents.find((a) => a.id === body.request_id);
    if (previous) {
      const [agent] = await decorateAgents(supabase, [previous], me);
      return Response.json({ agent });
    }
    const duplicates = ownAgents.filter((a) => possibleDuplicate(body, a));
    if (!body.confirm_duplicate && duplicates.length) {
      return Response.json({
        duplicates: duplicates.map((a) => ({
          id: a.id,
          agent_name: a.agent_name,
          archived: a.archived_at !== null,
        })),
      });
    }
    const res = await supabase
      .from(GOLD_LIST_AGENTS_TABLE)
      .insert({
        // Owner is the authenticated caller, always. An admin adding an agent
        // adds it to THEIR OWN Gold List, never to the AE they're viewing.
        salesperson_id: me.id,
        ...(body.request_id ? { id: body.request_id } : {}),
        agent_name: body.agent_name,
        brokerage: body.brokerage || null,
        phone: body.phone || null,
        email: body.email || null,
        notes: body.notes || null,
      })
      .select(AGENT_COLUMNS)
      .single();

    if (res.error) {
      // A concurrent retry may have inserted this request UUID already.
      if (isUniqueViolation(res.error)) {
        throw new ApiError(
          409,
          "This request has already been saved. Refresh your Gold List before retrying.",
        );
      }
      console.warn(
        `[gold-list] agent insert failed caller=${me.id} code=${res.error.code ?? "?"} msg=${res.error.message}`,
      );
      throw new ApiError(500, "Could not add that agent.");
    }

    // A brand-new agent has no activities yet, so decoration is exact and
    // free: no open activity, no history.
    const agent: GoldListAgentWithFollowUp = {
      ...(res.data as GoldListAgent),
      owner_name: me.first_name,
      can_edit: true,
      next_activity: null,
      completed_count: 0,
      last_completed_on: null,
    };
    return Response.json({ agent }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
