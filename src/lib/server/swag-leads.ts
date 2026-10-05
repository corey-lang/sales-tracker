// Swag Leads — server side: access, scoping, dashboard assembly, and the thin
// wrappers around the three database write functions.
//
// Swag Leads are social-media PROSPECTING leads worked by AEs (not swag
// orders); see lib/swag-leads.ts and supabase/swag_leads.sql.
//
// AUTHORIZATION, in layers (every layer is server-side):
//   1. requireSwagLeadsAccess(): a signed-in AE, or MANAGEMENT. Management =
//      role 'admin' OR salespeople.can_manage_swag_leads (Corey, Ryan, Tonja,
//      Faith) — the same orthogonal per-user capability pattern as
//      can_import_offices. A juice_box_only guest without the flag is refused.
//   2. Reads are scoped HERE: an AE reads only leads they currently own;
//      management reads every real lead. Test-account data never enters an
//      aggregate and is visible only to the test account's owner.
//   3. Every write goes through a database function that RE-CHECKS the actor
//      and locks the lead row, so the rules hold even if a route were wrong.
//
// The flag is read with its own small query (not bolted onto the shared session
// lookup), and fails CLOSED: if it can't be read, the caller is treated as not
// management.

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  SWAG_EVENT_COLUMNS,
  SWAG_LEAD_COLUMNS,
  SWAG_LEAD_EVENTS_TABLE,
  SWAG_LEADS_TABLE,
  applyFilters,
  computeMetrics,
  isSwagMetricKey,
  leadAttention,
  matchesMetric,
  sortLeads,
  type SwagAeOption,
  type SwagFilters,
  type SwagLead,
  type SwagLeadDetailResponse,
  type SwagLeadEvent,
  type SwagLeadView,
  type SwagLeadsResponse,
  type SwagMetricKey,
  type SwagScopeKind,
} from "@/lib/swag-leads";
import { canSeeSalesperson, visibleRosterOr } from "@/lib/roster";
import {
  ApiError,
  forbidden,
  notFound,
  requireSalesperson,
  type AuthedSalesperson,
} from "@/lib/server/auth";
import { selectAllPages, selectAllPagesForIds } from "@/lib/server/paginate";
import { ownedTestSalespersonIds } from "@/lib/server/roster";
import { getServerSupabase } from "@/lib/supabase/server";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/** Management: admin, or anyone granted `can_manage_swag_leads`. Fails closed. */
export async function canManageSwagLeads(
  supabase: Db,
  me: { id: string; role: string },
): Promise<boolean> {
  if (me.role === "admin") return true;
  const res = await supabase
    .from("salespeople")
    .select("can_manage_swag_leads")
    .eq("id", me.id)
    .maybeSingle();
  if (res.error) {
    console.warn(
      `[swag-leads] permission lookup failed id=${me.id} code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    return false;
  }
  return (res.data as { can_manage_swag_leads?: boolean } | null)?.can_manage_swag_leads === true;
}

export type SwagViewer = AuthedSalesperson & { is_manager: boolean };

/** Requires a signed-in AE or a management user; everyone else is a 403. */
export async function requireSwagLeadsAccess(req: Request): Promise<SwagViewer> {
  const me = await requireSalesperson(req);
  const is_manager = await canManageSwagLeads(getServerSupabase(), me);
  if (!is_manager && me.role !== "ae") {
    throw forbidden("Swag Leads is available to AEs and the leads team.");
  }
  return { ...me, is_manager };
}

/** Test accounts whose data `viewer` may see: their own session (if a test account) + ones they own. */
async function visibleTestActorIds(supabase: Db, me: AuthedSalesperson): Promise<string[]> {
  const owned = await ownedTestSalespersonIds(supabase, me);
  return me.is_test ? [...new Set([...owned, me.id])] : owned;
}

/**
 * Who may have CREATED a test-data lead that `me` is allowed to see: a test
 * account they own (or are), or themselves — an admin who adds a lead to their
 * own test AE is its `created_by`. Another admin can never appear here, because
 * they can't see (so can't create for) someone else's test account.
 */
async function testDataCreatorIds(supabase: Db, me: AuthedSalesperson): Promise<string[]> {
  return [...new Set([...(await visibleTestActorIds(supabase, me)), me.id])];
}

// ---------------------------------------------------------------------------
// AE roster (reuses the existing salespeople identity — no second AE list)
// ---------------------------------------------------------------------------

/** Active AEs as `viewer` may see them: real AEs plus the viewer's own test account(s). */
export async function listSwagAeOptions(
  supabase: Db,
  viewer: { id: string },
): Promise<SwagAeOption[]> {
  const res = await supabase
    .from("salespeople")
    .select("id, first_name, is_test")
    .eq("role", "ae")
    .is("deactivated_at", null)
    .or(visibleRosterOr(viewer.id))
    .order("first_name", { ascending: true });
  if (res.error) {
    console.warn(`[swag-leads] AE options failed code=${res.error.code ?? "?"} msg=${res.error.message}`);
    throw new ApiError(500, "Could not load the AE list.");
  }
  return ((res.data ?? []) as Array<{ id: string; first_name: string; is_test: boolean | null }>)
    .map((r) => ({ id: r.id, first_name: r.first_name, is_test: r.is_test === true }))
    .sort((a, b) => Number(a.is_test) - Number(b.is_test) || a.first_name.localeCompare(b.first_name));
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

export type SwagScope = {
  kind: SwagScopeKind;
  aeId: string | null;
  aeName: string | null;
};

/**
 * Resolves `?scope=` for `me`.
 *   * AE          — only their own leads ("mine", or their own id). Anything
 *                   else is a 403, not an empty list.
 *   * management  — "all" (default), "ooa", or an AE id. "mine" is the
 *                   manager's own list (empty unless they are also an AE).
 */
export async function resolveScope(
  supabase: Db,
  me: SwagViewer,
  raw: string | undefined,
): Promise<SwagScope> {
  const wanted = raw?.trim() || (me.is_manager ? "all" : "mine");
  if (wanted === "mine" || wanted === me.id) {
    return { kind: "mine", aeId: me.id, aeName: me.first_name };
  }
  if (!me.is_manager) throw forbidden("You can only view your own swag leads.");
  if (wanted === "all") return { kind: "all", aeId: null, aeName: null };
  if (wanted === "ooa") return { kind: "ooa", aeId: null, aeName: null };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(wanted)) {
    throw new ApiError(400, "Unknown scope.");
  }
  const res = await supabase
    .from("salespeople")
    .select("id, first_name, role, is_test, test_owner_id")
    .eq("id", wanted)
    .maybeSingle();
  if (res.error) throw new ApiError(500, "Could not load that AE.");
  const row = res.data as
    | { id: string; first_name: string; role: string; is_test: boolean | null; test_owner_id: string | null }
    | null;
  // Unknown, not an AE, or a test account someone else owns: indistinguishable.
  if (!row || row.role !== "ae" || !canSeeSalesperson(me, row)) throw notFound("AE not found.");
  return { kind: "ae", aeId: row.id, aeName: row.first_name };
}

type RawLead = SwagLead;

async function loadScopeLeads(supabase: Db, me: SwagViewer, scope: SwagScope): Promise<RawLead[]> {
  const testCreators = me.is_manager ? await testDataCreatorIds(supabase, me) : [];
  const res = await selectAllPages<RawLead>(() => {
    let q = supabase.from(SWAG_LEADS_TABLE).select(SWAG_LEAD_COLUMNS);
    if (scope.kind === "mine" || scope.kind === "ae") {
      q = q.eq("assigned_to", scope.aeId as string);
    } else if (scope.kind === "ooa") {
      q = q.eq("is_ooa", true);
      // Real OOA leads, plus OOA leads made by a test account the viewer owns.
      q = testCreators.length
        ? q.or(`is_test_data.eq.false,created_by.in.(${testCreators.join(",")})`)
        : q.eq("is_test_data", false);
    } else {
      // "All": a business aggregate — test data is never part of it.
      q = q.eq("is_test_data", false);
    }
    return q.order("created_at", { ascending: false }).order("id", { ascending: true });
  });
  if (res.error) {
    console.warn(`[swag-leads] list failed scope=${scope.kind} code=${res.error.code ?? "?"} msg=${res.error.message}`);
    throw new ApiError(500, "Could not load swag leads.");
  }
  return res.data;
}

// ---------------------------------------------------------------------------
// Decoration: owner label + derived territory
// ---------------------------------------------------------------------------

/** Active Cogent territory names per AE — the EXISTING territory architecture. */
async function territoriesByAe(supabase: Db): Promise<Map<string, string[]>> {
  const res = await selectAllPages<{ salesperson_id: string; sales_territory_name: string }>(() =>
    supabase
      .from("cogent_territory_mappings")
      .select("salesperson_id, sales_territory_name")
      .eq("active", true)
      .order("sales_territory_name", { ascending: true })
      .order("id", { ascending: true }),
  );
  const out = new Map<string, string[]>();
  if (res.error) {
    // Territory is a read-only convenience; never fail the page over it.
    console.warn(`[swag-leads] territory lookup failed code=${res.error.code ?? "?"} msg=${res.error.message}`);
    return out;
  }
  for (const r of res.data) {
    const list = out.get(r.salesperson_id) ?? [];
    list.push(r.sales_territory_name);
    out.set(r.salesperson_id, list);
  }
  return out;
}

async function namesFor(supabase: Db, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const res = await selectAllPagesForIds<{ id: string; first_name: string }>(ids, (chunk) =>
    supabase.from("salespeople").select("id, first_name").in("id", chunk).order("id", { ascending: true }),
  );
  if (res.error) throw new ApiError(500, "Could not load the AE names.");
  for (const r of res.data) out.set(r.id, r.first_name);
  return out;
}

export async function decorateLeads(supabase: Db, leads: RawLead[]): Promise<SwagLeadView[]> {
  const ids = [...new Set(leads.map((l) => l.assigned_to).filter((x): x is string => Boolean(x)))];
  const [names, territories] = await Promise.all([namesFor(supabase, ids), territoriesByAe(supabase)]);
  return leads.map((l) => ({
    ...l,
    assigned_label: l.is_ooa ? "OOA" : (names.get(l.assigned_to as string) ?? "Unknown"),
    territories: l.assigned_to ? (territories.get(l.assigned_to) ?? []) : [],
    attention: leadAttention(l),
  }));
}

// ---------------------------------------------------------------------------
// The dashboard / list payload
// ---------------------------------------------------------------------------

export async function buildLeadsResponse(
  supabase: Db,
  me: SwagViewer,
  scope: SwagScope,
  query: { metric?: string } & SwagFilters,
): Promise<SwagLeadsResponse> {
  const raw = await loadScopeLeads(supabase, me, scope);
  const views = await decorateLeads(supabase, raw);
  const aeOptions = await listSwagAeOptions(supabase, me);

  // Metrics cover the WHOLE scope — selecting an AE recomputes them from that
  // AE's leads; search/filters/metric only narrow the LIST.
  const metrics = computeMetrics(views);

  let byAe: SwagLeadsResponse["by_ae"] = null;
  let aeTotal: SwagLeadsResponse["ae_total"] = null;
  let ooaMetrics: SwagLeadsResponse["ooa_metrics"] = null;
  if (scope.kind === "all") {
    const owned = views.filter((l) => !l.is_ooa);
    const groups = new Map<string, SwagLeadView[]>();
    for (const l of owned) {
      const g = groups.get(l.assigned_to as string) ?? [];
      g.push(l);
      groups.set(l.assigned_to as string, g);
    }
    // Every active AE gets a row (zero is informative); an AE who left but
    // still owns leads keeps theirs.
    const nameOf = new Map<string, string>(aeOptions.map((a) => [a.id, a.first_name]));
    for (const l of owned) nameOf.set(l.assigned_to as string, l.assigned_label);
    byAe = [...new Set([...aeOptions.filter((a) => !a.is_test).map((a) => a.id), ...groups.keys()])]
      .map((id) => ({
        ae_id: id,
        name: nameOf.get(id) ?? "Unknown",
        metrics: computeMetrics(groups.get(id) ?? []),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    aeTotal = computeMetrics(owned);
    ooaMetrics = computeMetrics(views.filter((l) => l.is_ooa));
  }

  let listed = views;
  let active: SwagMetricKey | null = null;
  if (query.metric) {
    if (!isSwagMetricKey(query.metric)) throw new ApiError(400, "Unknown metric.");
    active = query.metric;
    listed = listed.filter((l) => matchesMetric(l, query.metric as SwagMetricKey));
  }
  listed = sortLeads(applyFilters(listed, query));

  const territories = [...new Set(views.flatMap((l) => l.territories))].sort();

  return {
    scope: {
      kind: scope.kind,
      ae_id: scope.aeId,
      ae_name: scope.aeName,
      viewer_id: me.id,
      is_manager: me.is_manager,
    },
    metrics,
    by_ae: byAe,
    ae_total: aeTotal,
    ooa_metrics: ooaMetrics,
    leads: listed,
    matched: listed.length,
    active_metric: active,
    ae_options: aeOptions,
    territories,
  };
}

// ---------------------------------------------------------------------------
// One lead
// ---------------------------------------------------------------------------

/**
 * Loads a lead `me` may see, or throws 404 (a lead you can't see is
 * indistinguishable from one that doesn't exist).
 *   * AE          — only a lead they currently own.
 *   * management  — any real lead; a test-data lead only if it belongs to a
 *                   test account they own.
 */
export async function requireVisibleLead(supabase: Db, me: SwagViewer, id: string): Promise<SwagLead> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw notFound("Swag lead not found.");
  }
  const res = await supabase.from(SWAG_LEADS_TABLE).select(SWAG_LEAD_COLUMNS).eq("id", id).maybeSingle();
  if (res.error) throw new ApiError(500, "Could not load that lead.");
  const lead = res.data as SwagLead | null;
  if (!lead) throw notFound("Swag lead not found.");
  if (!me.is_manager) {
    if (lead.assigned_to !== me.id) throw notFound("Swag lead not found.");
    return lead;
  }
  if (lead.is_test_data) {
    const actors = await visibleTestActorIds(supabase, me);
    const creators = await testDataCreatorIds(supabase, me);
    const mine =
      (lead.assigned_to !== null && actors.includes(lead.assigned_to)) ||
      (lead.created_by !== null && creators.includes(lead.created_by));
    if (!mine) throw notFound("Swag lead not found.");
  }
  return lead;
}

export function leadPermissions(me: SwagViewer, lead: SwagLead): SwagLeadDetailResponse["permissions"] {
  const owner = lead.assigned_to !== null && lead.assigned_to === me.id;
  return {
    can_edit: me.is_manager || owner,
    can_edit_identity: me.is_manager,
    can_transfer: me.is_manager || owner,
  };
}

export async function loadLeadEvents(supabase: Db, leadId: string): Promise<SwagLeadEvent[]> {
  const res = await selectAllPages<SwagLeadEvent>(() =>
    supabase
      .from(SWAG_LEAD_EVENTS_TABLE)
      .select(SWAG_EVENT_COLUMNS)
      .eq("lead_id", leadId)
      .order("seq", { ascending: false }),
  );
  if (res.error) throw new ApiError(500, "Could not load the lead history.");
  return res.data;
}

export async function viewOne(supabase: Db, lead: SwagLead): Promise<SwagLeadView> {
  const [view] = await decorateLeads(supabase, [lead]);
  return view;
}

/** What a transfer tells the person who made it. */
export type SwagTransferReceipt = Pick<
  SwagLeadView,
  "id" | "name" | "assigned_to" | "assigned_label" | "is_ooa" | "revision"
>;

/**
 * The transfer response. Management (who can still see the lead) gets the full
 * lead. An AE who has just moved their own lead to someone else no longer owns
 * it, so they get a RECEIPT — which lead, and where it went — and none of its
 * contact info, notes or outcomes. Current-owner visibility applies to every
 * response, not just to later reads.
 */
export function transferResponseLead(
  me: SwagViewer,
  view: SwagLeadView,
): SwagLeadView | SwagTransferReceipt {
  if (me.is_manager || view.assigned_to === me.id) return view;
  return {
    id: view.id,
    name: view.name,
    assigned_to: view.assigned_to,
    assigned_label: view.assigned_label,
    is_ooa: view.is_ooa,
    revision: view.revision,
  };
}

// ---------------------------------------------------------------------------
// Writes: the three database functions, errors mapped to HTTP
// ---------------------------------------------------------------------------

/** A stale revision: the route answers 409 with the lead as it is now. */
export class SwagStaleError extends Error {
  constructor() {
    super("This lead was changed by someone else. Review the latest and try again.");
    this.name = "SwagStaleError";
  }
}

type PgError = { code?: string | null; message: string };

const CONSTRAINT_MESSAGES: Array<[string, string]> = [
  ["swag_leads_first_contact_not_before_received", "First contact can't be before the lead was received."],
  ["swag_leads_orders_consistent", "Orders can't be counted when 'Any orders received?' is No."],
  ["swag_leads_orders_count_check", "Enter a valid number of orders."],
  ["swag_leads_follow_up_attempts_check", "Enter a valid number of follow-up attempts."],
  ["swag_leads_transactions_last_12_months_check", "Enter a valid number of transactions."],
];

export function throwSwagError(error: PgError): never {
  switch (error.code) {
    case "42501":
      throw forbidden("You can't change that lead.");
    case "P0002":
      throw notFound("Swag lead not found.");
    case "40001":
      throw new SwagStaleError();
    case "23505":
      throw new ApiError(409, "That request was already used.");
    case "22023":
    case "22004":
      // Authored messages from the write functions — safe to show.
      throw new ApiError(400, error.message);
    case "23514": {
      if (/already assigned/i.test(error.message)) throw new ApiError(409, error.message);
      const known = CONSTRAINT_MESSAGES.find(([c]) => error.message.includes(c));
      throw new ApiError(400, known ? known[1] : "That change isn't allowed.");
    }
    case "22007":
    case "22008":
    case "22P02":
    case "22003":
    case "23502":
      throw new ApiError(400, "One of the values isn't valid.");
    default:
      console.warn(`[swag-leads] write failed code=${error.code ?? "?"} msg=${error.message}`);
      throw new ApiError(500, "Could not save that change. Please try again.");
  }
}

export async function createLead(
  supabase: Db,
  me: SwagViewer,
  input: {
    fields: Record<string, unknown>;
    assignedTo: string | null;
    ooa: boolean;
    requestId: string | null;
  },
): Promise<SwagLead> {
  const res = await supabase.rpc("create_swag_lead", {
    p_actor: me.id,
    p_fields: input.fields,
    p_assigned_to: input.ooa ? null : input.assignedTo,
    p_ooa: input.ooa,
    p_request_id: input.requestId,
  });
  if (res.error) throwSwagError(res.error);
  return res.data as SwagLead;
}

export async function updateLead(
  supabase: Db,
  me: SwagViewer,
  id: string,
  expectedRevision: number,
  patch: Record<string, unknown>,
): Promise<SwagLead> {
  const res = await supabase.rpc("update_swag_lead", {
    p_actor: me.id,
    p_id: id,
    p_expected_revision: expectedRevision,
    p_patch: patch,
  });
  if (res.error) throwSwagError(res.error);
  return res.data as SwagLead;
}

export async function transferLead(
  supabase: Db,
  me: SwagViewer,
  id: string,
  input: { toAssignedTo: string | null; toOoa: boolean; reason: string | null; expectedRevision: number | null },
): Promise<SwagLead> {
  const res = await supabase.rpc("transfer_swag_lead", {
    p_actor: me.id,
    p_id: id,
    p_to_assigned_to: input.toOoa ? null : input.toAssignedTo,
    p_to_ooa: input.toOoa,
    p_reason: input.reason,
    p_expected_revision: input.expectedRevision,
  });
  if (res.error) throwSwagError(res.error);
  return res.data as SwagLead;
}

/** The 409 body for a stale save: the lead as it stands now. */
export async function conflictResponse(supabase: Db, me: SwagViewer, id: string): Promise<Response> {
  const lead = await requireVisibleLead(supabase, me, id);
  return Response.json(
    {
      error: "This lead was changed by someone else. Review the latest and try again.",
      conflict: await viewOne(supabase, lead),
    },
    { status: 409 },
  );
}
