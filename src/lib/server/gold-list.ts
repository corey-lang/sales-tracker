/**
 * Server-side helpers for the Gold List routes (`/api/gold-list/*`).
 *
 * THE PERMISSION MODEL LIVES HERE, not in the UI. Every route funnels through
 * these helpers so the two rules are stated once:
 *
 *   READ   — an AE reads only their own list. An admin may read ANY AE's list
 *            and may read all lists at once (the `?ae_id=` filter on the page).
 *   WRITE  — owner-only, for everyone. An admin viewing someone else's list
 *            gets read-only rows back (`can_edit: false`) and any write they
 *            attempt against a row they don't own is rejected server-side.
 *
 * The owner of a new agent is ALWAYS the authenticated caller — `salesperson_id`
 * is never read from a request body or query string on a write path.
 *
 * Server-only. Never import from a "use client" component.
 */

import { APP_TIMEZONE } from "@/lib/dates";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  forbidden,
  notFound,
  ApiError,
  requireAeToolAccess,
  type AuthedSalesperson,
} from "@/lib/server/auth";
import {
  GOLD_LIST_ACTIVITIES_TABLE,
  GOLD_LIST_AGENTS_TABLE,
  type GoldListActivity,
  type GoldListActivitySummary,
  type GoldListAgent,
  type GoldListAgentWithFollowUp,
} from "@/lib/gold-list";

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The service-role client. `any` matches how the other server helpers in this
 *  project type it — the generated DB types aren't wired up. */
type Db = SupabaseClient<any, any, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Columns selected for an agent row. Mirrors GoldListAgent. */
export const AGENT_COLUMNS =
  "id, salesperson_id, agent_name, brokerage, phone, email, notes, archived_at, created_at, updated_at";

/** Columns selected for a full activity row (history view). Carries BOTH notes
 *  — the scheduled plan (`activity_note`) and the completion outcome
 *  (`outcome_note`) — because history renders them as separate lines. */
export const ACTIVITY_COLUMNS =
  "id, agent_id, salesperson_id, activity_type, description, activity_note, scheduled_for, status, outcome_note, completed_at, created_at, updated_at";

/** Columns for the list-summary read. `activity_note` IS included — the card
 *  shows the scheduled note under the open activity's description. The
 *  completion `outcome_note` is not: that belongs to history, and leaving it
 *  out keeps the board payload small. */
export const ACTIVITY_SUMMARY_COLUMNS =
  "id, agent_id, salesperson_id, activity_type, description, activity_note, scheduled_for, status, completed_at";

/** Postgres unique_violation. Both unique indexes on these tables use it. */
export function isUniqueViolation(error: { code?: string | null } | null) {
  return error?.code === "23505";
}

/**
 * Roles allowed to read every AE's Gold List and to use the AE filter.
 * `admin` is the app's leadership role (same gate as `requireAdmin` and
 * `isAdminUser`) — there is no separate "leadership" role in this codebase.
 */
export function canViewAllGoldLists(person: { role: string }): boolean {
  return person.role === "admin";
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

/** Which rows a list request is allowed to see. */
export type GoldListScope = {
  me: AuthedSalesperson;
  /** The single AE whose list was requested, or null for "every AE". */
  ownerId: string | null;
  /** True when the caller asked for (and may have) every AE's list. */
  viewAll: boolean;
};

/**
 * Resolves the caller and the AE whose list they are asking for.
 *
 *   * no `ae_id`      — an AE gets their own list; an admin gets every list.
 *   * `ae_id` = self  — always allowed.
 *   * `ae_id` = other — admins only; anyone else gets a 403.
 *
 * The 403 (rather than an empty list) is deliberate: it tells the UI the
 * filter is not available to them instead of silently showing nothing, and the
 * roster is not a secret — the sign-in screen already lists every name.
 */
export async function resolveGoldListScope(
  req: Request,
  supabase: Db,
): Promise<GoldListScope> {
  // Same gate as To-Dos / Scan / the activity log: any signed-in salesperson
  // restricted to AE and admin roles by requireGoldListAccess.
  const me = await requireGoldListAccess(req);
  const requested = new URL(req.url).searchParams.get("ae_id");

  if (!requested || requested === "all") {
    return {
      me,
      ownerId: canViewAllGoldLists(me) ? null : me.id,
      viewAll: canViewAllGoldLists(me),
    };
  }
  if (requested === me.id) {
    return { me, ownerId: me.id, viewAll: false };
  }
  if (!canViewAllGoldLists(me)) {
    throw forbidden("You can only view your own Gold List.");
  }
  // An admin filtering by AE — confirm the id is a real salesperson so a typo
  // in the query string reads as "not found" rather than an empty Gold List.
  const res = await supabase
    .from("salespeople")
    .select("id")
    .eq("id", requested)
    .maybeSingle();
  if (res.error) {
    console.warn(
      `[gold-list] AE filter lookup failed ae_id=${requested} code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    throw new ApiError(500, "Could not load that AE's Gold List.");
  }
  if (!res.data) throw notFound("AE not found.");
  return { me, ownerId: requested, viewAll: false };
}

// ---------------------------------------------------------------------------
// Per-agent access
// ---------------------------------------------------------------------------

/**
 * Loads one agent for a READ (its activity history).
 *
 * Owner always passes; an admin passes for any agent. Everyone else gets a
 * 404 — an agent that isn't yours and that you can't view is indistinguishable
 * from one that doesn't exist.
 */
export async function requireViewableAgent(
  supabase: Db,
  agentId: string,
  me: AuthedSalesperson,
): Promise<GoldListAgent> {
  const res = await supabase
    .from(GOLD_LIST_AGENTS_TABLE)
    .select(AGENT_COLUMNS)
    .eq("id", agentId)
    .maybeSingle();
  if (res.error) {
    console.warn(
      `[gold-list] agent lookup failed agent_id=${agentId} caller=${me.id} code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    throw new ApiError(500, "Could not load that Gold List agent.");
  }
  if (!res.data) throw notFound("Gold List agent not found.");
  const agent = res.data as GoldListAgent;
  if (agent.salesperson_id !== me.id && !canViewAllGoldLists(me)) {
    throw notFound("Gold List agent not found.");
  }
  return agent;
}

/**
 * Loads one agent for a WRITE. Owner-only — an admin acting on someone else's
 * agent is rejected with the same 404 as any other non-owner.
 *
 * WHY ADMINS CANNOT WRITE HERE: leadership needs visibility (read + filter),
 * not the ability to edit a rep's follow-ups. Widening this later means
 * changing one function, and the audit question ("who completed this?") would
 * need an actor column first.
 */
export async function requireOwnedAgent(
  supabase: Db,
  agentId: string,
  me: AuthedSalesperson,
): Promise<GoldListAgent> {
  const agent = await requireViewableAgent(supabase, agentId, me);
  if (agent.salesperson_id !== me.id) {
    throw notFound("Gold List agent not found.");
  }
  return agent;
}

/**
 * Loads one activity for a WRITE, pinning BOTH the activity id and its parent
 * agent so the URL's agent segment is a real ownership check rather than
 * decoration: PATCHing /agents/<other-agent>/activities/<id> 404s instead of
 * silently updating a row that hangs off a different agent.
 */
export async function requireOwnedActivity(
  supabase: Db,
  agentId: string,
  activityId: string,
  me: AuthedSalesperson,
): Promise<GoldListActivity> {
  const res = await supabase
    .from(GOLD_LIST_ACTIVITIES_TABLE)
    .select(ACTIVITY_COLUMNS)
    .eq("id", activityId)
    .eq("agent_id", agentId)
    .eq("salesperson_id", me.id)
    .maybeSingle();
  if (res.error) {
    console.warn(
      `[gold-list] activity lookup failed activity_id=${activityId} caller=${me.id} code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    throw new ApiError(500, "Could not load that activity.");
  }
  if (!res.data) throw notFound("Activity not found.");
  return res.data as GoldListActivity;
}

// ---------------------------------------------------------------------------
// Decoration — attaching follow-up state to agent rows
// ---------------------------------------------------------------------------

/**
 * Attaches the follow-up summary each agent card renders: the single open
 * activity, how many are completed (history), when the last one happened, the
 * owner's display name, and whether the caller may edit the row.
 *
 * Queries are batched across scoped agents, with one owner-name lookup;
 * there is no per-agent query. Activities are fetched in
 * full for the scoped agents rather than aggregated in SQL; at this app's
 * scale (a closed team, a couple of dozen agents each) that is far cheaper
 * than a view or an RPC. Scheduled notes are included for the main cards.
 */
export async function decorateAgents(
  supabase: Db,
  agents: GoldListAgent[],
  me: AuthedSalesperson,
): Promise<GoldListAgentWithFollowUp[]> {
  if (agents.length === 0) return [];

  const activities: GoldListActivitySummary[] = [];
  // Bound the IN-list as well as paging the result: thousands of UUIDs in
  // one PostgREST URL exceed gateway URL limits before pagination can run.
  for (let offset = 0; offset < agents.length; offset += 100) {
    const agentIds = agents.slice(offset, offset + 100).map((a) => a.id);
    const res = await allGoldListRows<GoldListActivitySummary>(
      supabase
        .from(GOLD_LIST_ACTIVITIES_TABLE)
        .select(ACTIVITY_SUMMARY_COLUMNS)
        .in("agent_id", agentIds)
        .order("id", { ascending: true }),
    );
    if (res.error) {
      console.warn(
        `[gold-list] activity summary failed caller=${me.id} code=${res.error.code ?? "?"}`,
      );
      throw new ApiError(500, "Could not load Gold List activity.");
    }
    activities.push(...res.data);
  }

  const nextByAgent = new Map<string, GoldListActivitySummary>();
  const completedCount = new Map<string, number>();
  const lastCompleted = new Map<string, string>();
  for (const activity of activities) {
    if (activity.status === "scheduled") {
      // The DB allows at most one open activity per agent
      // (idx_gold_list_activities_one_open), so the first one wins outright.
      if (!nextByAgent.has(activity.agent_id)) {
        nextByAgent.set(activity.agent_id, activity);
      }
    } else if (activity.status === "completed") {
      completedCount.set(
        activity.agent_id,
        (completedCount.get(activity.agent_id) ?? 0) + 1,
      );
      const stamp = activity.completed_at;
      if (stamp && stamp > (lastCompleted.get(activity.agent_id) ?? "")) {
        lastCompleted.set(activity.agent_id, stamp);
      }
    }
  }

  const ownerNames = await loadOwnerNames(supabase, agents, me);

  return agents.map((agent) => ({
    ...agent,
    owner_name: ownerNames.get(agent.salesperson_id) ?? null,
    can_edit: agent.salesperson_id === me.id,
    next_activity: nextByAgent.get(agent.id) ?? null,
    completed_count: completedCount.get(agent.id) ?? 0,
    last_completed_on: lastCompleted.has(agent.id)
      ? new Intl.DateTimeFormat("en-CA", {
          timeZone: APP_TIMEZONE,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(lastCompleted.get(agent.id)!))
      : null,
  }));
}

/**
 * Display names for the owners present in a result set. Deliberately does NOT
 * filter `deactivated_at` — a departed rep's rows still render their name, the
 * same posture history lookups take elsewhere (see supabase/README.md,
 * "Offboarding & reassignment").
 */
async function loadOwnerNames(
  supabase: Db,
  agents: GoldListAgent[],
  me: AuthedSalesperson,
): Promise<Map<string, string>> {
  const ids = [...new Set(agents.map((a) => a.salesperson_id))];
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  // Single-owner scope (the everyday AE case) needs no query at all.
  if (ids.length === 1 && ids[0] === me.id) {
    names.set(me.id, me.first_name);
    return names;
  }
  const res = await supabase
    .from("salespeople")
    .select("id, first_name")
    .in("id", ids);
  if (res.error) {
    // Non-fatal: names are a label, not data. Log and fall through to nulls.
    console.warn(
      `[gold-list] owner name lookup failed code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    return names;
  }
  for (const row of (res.data ?? []) as Array<{
    id: string;
    first_name: string;
  }>) {
    names.set(row.id, row.first_name);
  }
  return names;
}

/**
 * The AE options for the admin filter: the roster minus the roles that
 * have no Gold List surface (`juice_box_only` and assistants) and minus the seeded test
 * account. Matches the roster filters used by the admin AE selectors elsewhere
 * (see `buildAeSummaries`), except that admins are INCLUDED here because an
 * admin who also sells has their own Gold List.
 */
export async function listGoldListAeOptions(
  supabase: Db,
): Promise<Array<{ id: string; first_name: string }>> {
  const res = await supabase
    .from("salespeople")
    .select("id, first_name, role")
    .in("role", ["ae", "admin"])
    .eq("is_test", false)
    .order("first_name", { ascending: true });
  if (res.error) {
    console.warn(
      `[gold-list] AE options lookup failed code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    throw new ApiError(500, "Could not load the AE list.");
  }
  return ((res.data ?? []) as Array<{ id: string; first_name: string }>).map(
    (row) => ({ id: row.id, first_name: row.first_name }),
  );
}

export async function requireGoldListAccess(req: Request) {
  const me = await requireAeToolAccess(req);
  if (me.role !== "ae" && me.role !== "admin")
    throw forbidden("Gold List is available to AEs and leadership.");
  return me;
}

/** PostgREST caps each response; page explicitly so counts and history stay complete. */
export async function allGoldListRows<T>(query: {
  range: (
    from: number,
    to: number,
  ) => PromiseLike<{
    data: unknown;
    error: { code?: string; message: string } | null;
  }>;
}): Promise<{ data: T[]; error: { code?: string; message: string } | null }> {
  const data: T[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const page = await query.range(offset, offset + pageSize - 1);
    if (page.error) return { data: [], error: page.error };
    const rows = (page.data ?? []) as T[];
    data.push(...rows);
    if (rows.length < pageSize) return { data, error: null };
  }
}
