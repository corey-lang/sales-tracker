// Swag Leads — shared types and the ONE definition of every dashboard metric.
//
// WHAT A SWAG LEAD IS: a social-media prospecting lead. An agent requested some
// of our swag; the assigned AE follows up to build a relationship and
// eventually earn business. It is NOT a swag order — there is no approval,
// vendor, shipping, tracking or order status anywhere in this feature.
//
// FIELD MEANINGS (the spreadsheet is the source of truth):
//   swag_delivered   "Swag delivered?" — a plain yes/no prospecting outcome.
//   orders_received  "Any orders received?" — has the AGENT since sent business
//                    to Elevate.
//   orders_count     "How many?" — how many orders/business transactions the
//                    agent sent us. NOT a swag quantity.
//
// METRICS: each clickable dashboard metric has exactly one predicate here.
// The server uses the same predicate to COUNT and to LIST ("show me those 12"),
// so a count and the leads behind it cannot disagree.
//
// Safe to import from client components (no server-only imports).

export const SWAG_LEADS_TABLE = "swag_leads" as const;
export const SWAG_LEAD_EVENTS_TABLE = "swag_lead_events" as const;

export const SWAG_LEAD_COLUMNS =
  "id, name, contact_info, confirmed_realtor, transactions_last_12_months, date_lead_received, date_first_contact, follow_up_attempts, swag_delivered, met_in_person, orders_received, orders_count, notes, assigned_to, is_ooa, is_test_data, revision, created_by, created_at, updated_at";

export const SWAG_LEAD_NAME_MAX = 200;
export const SWAG_LEAD_CONTACT_MAX = 500;
export const SWAG_LEAD_NOTES_MAX = 5000;
export const SWAG_LEAD_REASON_MAX = 500;
export const SWAG_LEAD_COUNT_MAX = 100000;
export const SWAG_LEAD_FOLLOW_UP_MAX = 1000;

/** The spreadsheet row, as stored. Dates are yyyy-mm-dd. */
export type SwagLead = {
  id: string;
  name: string;
  contact_info: string | null;
  confirmed_realtor: boolean;
  /** The lead's production. null = not recorded. */
  transactions_last_12_months: number | null;
  date_lead_received: string;
  /** null = not yet contacted ("Needs First Contact"). */
  date_first_contact: string | null;
  follow_up_attempts: number;
  swag_delivered: boolean;
  met_in_person: boolean;
  /** Has the agent sent us business? */
  orders_received: boolean;
  /** Orders the agent sent us. null = not recorded. */
  orders_count: number | null;
  notes: string | null;
  /** Current owner. null exactly when is_ooa. */
  assigned_to: string | null;
  /** Out Of Area: a bucket, never an AE. */
  is_ooa: boolean;
  is_test_data: boolean;
  revision: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type SwagAttention = "needs_first_contact" | "needs_follow_up" | null;

/** A lead as the API returns it: the row plus derived, read-only fields. */
export type SwagLeadView = SwagLead & {
  /** Current owner's first name, or "OOA". */
  assigned_label: string;
  /** Territory is DERIVED from the current owner's Cogent territory mappings. */
  territories: string[];
  attention: SwagAttention;
};

export type SwagLeadEventType = "created" | "transferred" | "updated";

export type SwagLeadEvent = {
  id: string;
  lead_id: string;
  event_type: SwagLeadEventType;
  actor_id: string;
  actor_name: string;
  occurred_at: string;
  from_assigned_to: string | null;
  from_label: string | null;
  to_assigned_to: string | null;
  to_label: string | null;
  reason: string | null;
  changes: Record<string, { from?: unknown; to?: unknown; changed?: boolean }>;
};

export const SWAG_EVENT_COLUMNS =
  "id, lead_id, event_type, actor_id, actor_name, occurred_at, from_assigned_to, from_label, to_assigned_to, to_label, reason, changes";

// ---------------------------------------------------------------------------
// Attention (what needs doing) — derived from the spreadsheet fields only.
// No follow-up target is invented: "needs follow-up" just means contacted,
// nothing further logged yet.
// ---------------------------------------------------------------------------

export function leadAttention(
  lead: Pick<SwagLead, "date_first_contact" | "follow_up_attempts">,
): SwagAttention {
  if (!lead.date_first_contact) return "needs_first_contact";
  if (lead.follow_up_attempts === 0) return "needs_follow_up";
  return null;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export const SWAG_METRIC_KEYS = [
  "total",
  "needs_first_contact",
  "contacted",
  "followed_up",
  "no_follow_up",
  "met_in_person",
  "swag_delivered",
  "with_orders",
  "ooa",
] as const;
export type SwagMetricKey = (typeof SWAG_METRIC_KEYS)[number];

export function isSwagMetricKey(value: unknown): value is SwagMetricKey {
  return (SWAG_METRIC_KEYS as readonly unknown[]).includes(value);
}

/** The single predicate behind each clickable metric (count AND list). */
export function matchesMetric(
  lead: Pick<
    SwagLead,
    | "date_first_contact"
    | "follow_up_attempts"
    | "met_in_person"
    | "swag_delivered"
    | "orders_received"
    | "is_ooa"
  >,
  key: SwagMetricKey,
): boolean {
  switch (key) {
    case "total":
      return true;
    case "needs_first_contact":
      return lead.date_first_contact === null;
    case "contacted":
      return lead.date_first_contact !== null;
    case "followed_up":
      return lead.follow_up_attempts >= 1;
    case "no_follow_up":
      // Contacted, but no follow-up attempt logged yet.
      return lead.date_first_contact !== null && lead.follow_up_attempts === 0;
    case "met_in_person":
      return lead.met_in_person;
    case "swag_delivered":
      return lead.swag_delivered;
    case "with_orders":
      // "Any orders received?" = yes: agents who have sent us business.
      return lead.orders_received;
    case "ooa":
      return lead.is_ooa;
  }
}

export const SWAG_METRIC_LABELS: Record<SwagMetricKey, string> = {
  total: "Total Leads",
  needs_first_contact: "Needs First Contact",
  contacted: "Contacted",
  followed_up: "Followed Up",
  no_follow_up: "Contacted, No Follow-Up",
  met_in_person: "Met In Person",
  swag_delivered: "Swag Delivered",
  with_orders: "Agents With Orders",
  ooa: "OOA",
};

export type SwagMetrics = {
  total: number;
  needs_first_contact: number;
  contacted: number;
  /** Leads with at least one follow-up attempt. */
  followed_up: number;
  no_follow_up: number;
  /** Sum of "# of follow up attempts" — the follow-up ACTIVITY. */
  follow_up_attempts: number;
  met_in_person: number;
  swag_delivered: number;
  /** Agents who have sent business ("Any orders received?" = yes). */
  agents_with_orders: number;
  /** Sum of "How many?" — orders/business the agents sent us. */
  total_orders: number;
  ooa: number;
};

export function emptyMetrics(): SwagMetrics {
  return {
    total: 0,
    needs_first_contact: 0,
    contacted: 0,
    followed_up: 0,
    no_follow_up: 0,
    follow_up_attempts: 0,
    met_in_person: 0,
    swag_delivered: 0,
    agents_with_orders: 0,
    total_orders: 0,
    ooa: 0,
  };
}

/** Metrics over exactly the leads given — each lead counted once. */
export function computeMetrics(leads: readonly SwagLead[]): SwagMetrics {
  const m = emptyMetrics();
  for (const l of leads) {
    m.total += 1;
    if (matchesMetric(l, "needs_first_contact")) m.needs_first_contact += 1;
    if (matchesMetric(l, "contacted")) m.contacted += 1;
    if (matchesMetric(l, "followed_up")) m.followed_up += 1;
    if (matchesMetric(l, "no_follow_up")) m.no_follow_up += 1;
    m.follow_up_attempts += l.follow_up_attempts;
    if (matchesMetric(l, "met_in_person")) m.met_in_person += 1;
    if (matchesMetric(l, "swag_delivered")) m.swag_delivered += 1;
    if (matchesMetric(l, "with_orders")) m.agents_with_orders += 1;
    m.total_orders += l.orders_count ?? 0;
    if (matchesMetric(l, "ooa")) m.ooa += 1;
  }
  return m;
}

// ---------------------------------------------------------------------------
// Filters + ordering (applied to an already-scoped set)
// ---------------------------------------------------------------------------

export type YesNo = "yes" | "no";

export type SwagFilters = {
  q?: string;
  confirmed_realtor?: YesNo;
  contacted?: YesNo;
  met_in_person?: YesNo;
  swag_delivered?: YesNo;
  orders_received?: YesNo;
  /** A Cogent territory name; matches leads whose CURRENT owner has it. */
  territory?: string;
  /** Date Lead Received, inclusive yyyy-mm-dd. */
  from?: string;
  to?: string;
};

const yn = (want: YesNo | undefined, have: boolean) =>
  want === undefined || (want === "yes") === have;

export function applyFilters(
  leads: readonly SwagLeadView[],
  f: SwagFilters,
): SwagLeadView[] {
  const q = f.q?.trim().toLowerCase();
  return leads.filter((l) => {
    if (q) {
      const hay = `${l.name}\n${l.contact_info ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (!yn(f.confirmed_realtor, l.confirmed_realtor)) return false;
    if (!yn(f.contacted, l.date_first_contact !== null)) return false;
    if (!yn(f.met_in_person, l.met_in_person)) return false;
    if (!yn(f.swag_delivered, l.swag_delivered)) return false;
    if (!yn(f.orders_received, l.orders_received)) return false;
    if (f.territory && !l.territories.includes(f.territory)) return false;
    if (f.from && l.date_lead_received < f.from) return false;
    if (f.to && l.date_lead_received > f.to) return false;
    return true;
  });
}

/**
 * Default order: leads that need attention first (never contacted, then
 * contacted-but-no-follow-up), OLDEST first within those groups — the lead
 * waiting longest is the most urgent — then everything else, newest first.
 */
export function sortLeads<T extends SwagLead & { attention: SwagAttention }>(
  leads: readonly T[],
): T[] {
  const rank = (l: T) =>
    l.attention === "needs_first_contact" ? 0 : l.attention === "needs_follow_up" ? 1 : 2;
  return [...leads].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (a.date_lead_received !== b.date_lead_received) {
      const asc = a.date_lead_received < b.date_lead_received ? -1 : 1;
      return ra < 2 ? asc : -asc;
    }
    return a.id < b.id ? -1 : 1;
  });
}

// ---------------------------------------------------------------------------
// API payloads
// ---------------------------------------------------------------------------

export type SwagScopeKind = "mine" | "all" | "ooa" | "ae";

export type SwagAeOption = { id: string; first_name: string; is_test: boolean };

export type SwagLeadsResponse = {
  scope: {
    kind: SwagScopeKind;
    ae_id: string | null;
    ae_name: string | null;
    viewer_id: string;
    /** Management sees every lead and the AE selector; an AE sees their own. */
    is_manager: boolean;
  };
  /** Over the WHOLE scope (never narrowed by search/filters/metric). */
  metrics: SwagMetrics;
  /** Scope "all" only: one row per AE (OOA excluded) … */
  by_ae: Array<{ ae_id: string; name: string; metrics: SwagMetrics }> | null;
  /** … the AEs-only subtotal … */
  ae_total: SwagMetrics | null;
  /** … and OOA as its own bucket. */
  ooa_metrics: SwagMetrics | null;
  /** The scope's leads after the metric + filters were applied. */
  leads: SwagLeadView[];
  matched: number;
  active_metric: SwagMetricKey | null;
  ae_options: SwagAeOption[];
  territories: string[];
};

export type SwagLeadDetailResponse = {
  lead: SwagLeadView;
  events: SwagLeadEvent[];
  permissions: {
    /** Edit the prospecting fields. */
    can_edit: boolean;
    /** Edit the source-of-truth identity fields (name, date received). */
    can_edit_identity: boolean;
    can_transfer: boolean;
  };
  ae_options: SwagAeOption[];
};

export type SwagConflictBody = { error: string; conflict: SwagLeadView };

/** Human wording for an event, e.g. "Hilary → OOA". */
export function describeEvent(e: SwagLeadEvent): string {
  switch (e.event_type) {
    case "created":
      return `Lead created${e.to_label ? ` and assigned to ${e.to_label}` : ""}`;
    case "transferred":
      return `Transferred ${e.from_label ?? "?"} → ${e.to_label ?? "?"}`;
    case "updated":
      return "Lead updated";
  }
}

export const SWAG_FIELD_LABELS: Record<string, string> = {
  name: "Name",
  contact_info: "Contact info",
  confirmed_realtor: "Confirmed realtor?",
  transactions_last_12_months: "Transactions in last 12 months",
  date_lead_received: "Date lead received",
  date_first_contact: "Date of first contact",
  follow_up_attempts: "# of follow up attempts",
  swag_delivered: "Swag delivered?",
  met_in_person: "Did you meet in person?",
  orders_received: "Any orders received?",
  orders_count: "How many?",
  notes: "Notes",
};
