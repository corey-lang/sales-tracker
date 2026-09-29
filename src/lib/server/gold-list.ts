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
  canSeeSalesperson,
  visibleRosterOr,
  type RosterVisibilityRow,
} from "@/lib/roster";
import { requireVisibleSalesperson } from "@/lib/server/roster";
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
  // A private test account someone else owns is also "not found".
  const res = await supabase
    .from("salespeople")
    .select("id, is_test, test_owner_id")
    .eq("id", requested)
    .maybeSingle();
  if (res.error) {
    console.warn(
      `[gold-list] AE filter lookup failed ae_id=${requested} code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    throw new ApiError(500, "Could not load that AE's Gold List.");
  }
  if (!res.data || !canSeeSalesperson(me, res.data as RosterVisibilityRow)) {
    throw notFound("AE not found.");
  }
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
  if (agent.salesperson_id !== me.id) {
    if (!canViewAllGoldLists(me)) throw notFound("Gold List agent not found.");
    // Admin read of someone else's agent: not a private test account they
    // don't own.
    await requireVisibleSalesperson(
      supabase,
      me,
      agent.salesperson_id,
      "Gold List agent not found.",
    );
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
  /** Summaries the caller already loaded with `loadActivitySummaries`, so a
   *  caller that also needs the raw rows doesn't query twice. */
  preloaded?: GoldListActivitySummary[],
): Promise<GoldListAgentWithFollowUp[]> {
  if (agents.length === 0) return [];

  const activities =
    preloaded ??
    (await loadActivitySummaries(
      supabase,
      agents.map((a) => a.id),
      me,
    ));

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
 * Every activity (summary columns) for the given agents, batched and paged.
 * Bounds the IN-list as well as paging the result: thousands of UUIDs in one
 * PostgREST URL exceed gateway URL limits before pagination can run.
 */
export async function loadActivitySummaries(
  supabase: Db,
  agentIds: readonly string[],
  me: AuthedSalesperson,
  columns: string = ACTIVITY_SUMMARY_COLUMNS,
): Promise<GoldListActivitySummary[]> {
  const activities: GoldListActivitySummary[] = [];
  for (let offset = 0; offset < agentIds.length; offset += 100) {
    const batch = agentIds.slice(offset, offset + 100) as string[];
    const res = await allGoldListRows<GoldListActivitySummary>(
      supabase
        .from(GOLD_LIST_ACTIVITIES_TABLE)
        .select(columns)
        .in("agent_id", batch)
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
  return activities;
}

// ---------------------------------------------------------------------------
// Activity writes — ONE implementation shared by the AE routes
// (/api/gold-list/agents/:id/activities*) and the manager 1:1 routes
// (/api/admin/one-on-one-meetings/:id/gold-list/*). Callers authorize first
// (owner-only for AEs; admin + in-progress 1:1 + agent belongs to that
// meeting's AE for managers) and pass the already-authorized agent. Every
// write below is pinned to `agent.salesperson_id`, so the denormalized owner
// can never drift from the agent row.
//
// `manager` is passed ONLY by the manager 1:1 path. It stamps the actor
// (`created_by` / `completed_by`) AND the 1:1 the action was taken from
// (`created_in_meeting_id` / `closed_in_meeting_id` /
// `rescheduled_in_meeting_id`) IN THE SAME STATEMENT as the Gold List change,
// so the change and its attribution commit together. A DB trigger locks that
// meeting and refuses the write if it has completed (the error carries
// "1:1", mapped to a read-only 409). The AE path names none of these columns,
// so AE writes never take the meeting lock and keep working even before
// one_on_one_meetings.sql adds the columns.
// ---------------------------------------------------------------------------

export type ScheduleActivityInput = {
  activity_type: GoldListActivity["activity_type"];
  description: string;
  activity_note?: string | null;
  request_id?: string;
  scheduled_for: string;
};

export type UpdateActivityInput = {
  status?: GoldListActivity["status"];
  outcome_note?: string | null;
  activity_note?: string | null;
  activity_type?: GoldListActivity["activity_type"];
  description?: string;
  scheduled_for?: string;
};

/** Who acted and from which in-progress 1:1 — manager path only. */
export type ManagerMeetingAction = { actorId: string; meetingId: string };

/** 23514 from the meeting-attribution trigger vs. the Gold List's own guards. */
function activityConflict(error: { code?: string; message?: string }): ApiError {
  if (error.code === "55P03") {
    // The 1:1 this action is attributed to is being completed right now.
    return new ApiError(409, "This 1:1 is being completed right now.");
  }
  return new ApiError(
    409,
    error.message?.includes("1:1")
      ? "This 1:1 is completed and read-only."
      : "This agent or activity changed. Refresh before trying again.",
  );
}

export async function scheduleAgentActivity(
  supabase: Db,
  agent: GoldListAgent,
  body: ScheduleActivityInput,
  logCaller: string,
  manager: ManagerMeetingAction | null = null,
): Promise<{ activity: GoldListActivity; created: boolean }> {
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
      .eq("agent_id", agent.id)
      .eq("salesperson_id", agent.salesperson_id)
      .maybeSingle();
    if (previous.error)
      throw new ApiError(500, "Could not check this activity request.");
    // A retried request replays the original row (200), never a duplicate.
    if (previous.data)
      return { activity: previous.data as GoldListActivity, created: false };
  }

  const res = await supabase
    .from(GOLD_LIST_ACTIVITIES_TABLE)
    .insert({
      agent_id: agent.id,
      // Denormalized owner. Taken from the AGENT row (which the caller just
      // authorized), never from the request — and the composite FK would
      // reject it anyway if the pair didn't match.
      salesperson_id: agent.salesperson_id,
      activity_type: body.activity_type,
      description: body.description,
      // "" and null both mean "no note"; store NULL so the column has one
      // empty representation.
      activity_note: body.activity_note || null,
      ...(body.request_id ? { id: body.request_id } : {}),
      ...(manager
        ? { created_by: manager.actorId, created_in_meeting_id: manager.meetingId }
        : {}),
      scheduled_for: body.scheduled_for,
      status: "scheduled",
    })
    .select(ACTIVITY_COLUMNS)
    .single();

  if (res.error) {
    if (res.error.code === "23514" || res.error.code === "55P03")
      throw activityConflict(res.error);
    if (isUniqueViolation(res.error)) {
      throw new ApiError(
        409,
        "This agent already has an activity scheduled. Complete or reschedule it first.",
      );
    }
    console.warn(
      `[gold-list] activity insert failed agent_id=${agent.id} caller=${logCaller} code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    throw new ApiError(500, "Could not schedule that activity.");
  }
  return { activity: res.data as GoldListActivity, created: true };
}

export async function updateAgentActivity(
  supabase: Db,
  agent: GoldListAgent,
  activityId: string,
  body: UpdateActivityInput,
  logCaller: string,
  manager: ManagerMeetingAction | null = null,
): Promise<GoldListActivity> {
  if (agent.archived_at)
    throw new ApiError(409, "Restore this agent before changing activities.");

  // Pin BOTH the activity id and its parent agent (and owner), so a
  // mismatched agent segment in the URL 404s instead of updating a row that
  // hangs off a different agent.
  const lookup = await supabase
    .from(GOLD_LIST_ACTIVITIES_TABLE)
    .select(ACTIVITY_COLUMNS)
    .eq("id", activityId)
    .eq("agent_id", agent.id)
    .eq("salesperson_id", agent.salesperson_id)
    .maybeSingle();
  if (lookup.error) {
    console.warn(
      `[gold-list] activity lookup failed activity_id=${activityId} caller=${logCaller} code=${lookup.error.code ?? "?"} msg=${lookup.error.message}`,
    );
    throw new ApiError(500, "Could not load that activity.");
  }
  if (!lookup.data) throw notFound("Activity not found.");
  if ((lookup.data as GoldListActivity).status !== "scheduled") {
    throw new ApiError(
      409,
      "This activity is already finished. Refresh to see its preserved history.",
    );
  }

  const patch: Record<string, unknown> = {};
  if (body.description !== undefined) patch.description = body.description;
  if (body.activity_note !== undefined) {
    patch.activity_note = body.activity_note || null;
  }
  if (body.activity_type !== undefined) {
    patch.activity_type = body.activity_type;
  }
  if (body.scheduled_for !== undefined) {
    patch.scheduled_for = body.scheduled_for;
  }
  if (body.outcome_note !== undefined) {
    patch.outcome_note = body.outcome_note || null;
  }
  if (body.status !== undefined) {
    patch.status = body.status;
    // Kept consistent with gold_list_activities_completed_at_matches_status.
    patch.completed_at =
      body.status === "completed" ? new Date().toISOString() : null;
    if (manager && body.status === "completed") patch.completed_by = manager.actorId;
  }
  if (manager) {
    // Attribute the action to the 1:1: closing (complete/cancel) or editing
    // the open activity. Reopening to "scheduled" isn't a manager action.
    if (body.status === "completed" || body.status === "cancelled") {
      patch.closed_in_meeting_id = manager.meetingId;
    } else if (Object.keys(patch).some((k) => k !== "status" && k !== "completed_at")) {
      patch.rescheduled_in_meeting_id = manager.meetingId;
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new ApiError(400, "No fields to update.");
  }

  const res = await supabase
    .from(GOLD_LIST_ACTIVITIES_TABLE)
    .update(patch)
    .eq("id", activityId)
    .eq("agent_id", agent.id)
    .eq("salesperson_id", agent.salesperson_id)
    .eq("status", "scheduled")
    .select(ACTIVITY_COLUMNS)
    .maybeSingle();

  if (res.error) {
    if (res.error.code === "23514" || res.error.code === "55P03")
      throw activityConflict(res.error);
    // A concurrent scheduled-activity write violated the one-open rule.
    if (isUniqueViolation(res.error)) {
      throw new ApiError(
        409,
        "This agent already has an activity scheduled. Complete or reschedule that one first.",
      );
    }
    console.warn(
      `[gold-list] activity update failed activity_id=${activityId} caller=${logCaller} code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    throw new ApiError(500, "Could not update that activity.");
  }
  if (!res.data)
    throw new ApiError(
      409,
      "This activity changed. Refresh to see its preserved history.",
    );
  return res.data as GoldListActivity;
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
  viewer: { id: string },
): Promise<Array<{ id: string; first_name: string }>> {
  // Real AEs/admins, plus the viewer's OWN private test account(s).
  const res = await supabase
    .from("salespeople")
    .select("id, first_name, role")
    .in("role", ["ae", "admin"])
    .or(visibleRosterOr(viewer.id))
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
