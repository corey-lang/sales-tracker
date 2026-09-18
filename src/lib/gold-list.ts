/**
 * Shared types + constants for the Gold List feature.
 *
 * Safe to import from both client components and server routes — no
 * server-only imports here.
 *
 * WHAT THE FEATURE IS
 *   A lightweight relationship follow-up loop for AEs, NOT a CRM:
 *     add an agent -> schedule an activity -> complete it with an optional
 *     outcome note -> schedule the next one, with completed activities kept
 *     as history.
 *
 *   Gold List agents and their activity history live on their own tables
 *   (`gold_list_agents`, `gold_list_activities`, see supabase/gold_list.sql)
 *   and persist independently of any Weekly Focus / 1:1 record — nothing here
 *   is week-scoped or reset weekly.
 *
 * NAMING — there are three unrelated "gold list" things in this codebase:
 *   * `gold_list_targets` + `activity_entries.gold_list_touches` — the daily
 *     touch COUNTER on the activity log (lib/activities.ts).
 *   * `coaching_relationships` — the MANAGER's coaching layer inside Weekly
 *     Focus (lib/one-on-ones.ts), admin-owned.
 *   * this module — the AE-owned follow-up list at /gold-list.
 */

/** Table names, so routes and tests never hand-type them. */
export const GOLD_LIST_AGENTS_TABLE = "gold_list_agents";
export const GOLD_LIST_ACTIVITIES_TABLE = "gold_list_activities";

// ---------------------------------------------------------------------------
// Activity types + statuses
// ---------------------------------------------------------------------------

/**
 * The kinds of follow-up an AE can schedule. Mirrors the CHECK constraint on
 * `gold_list_activities.activity_type` — adding one means editing BOTH this
 * list and supabase/gold_list.sql.
 */
export const GOLD_LIST_ACTIVITY_TYPES = [
  { key: "call", label: "Call" },
  { key: "text", label: "Text" },
  { key: "email", label: "Email" },
  { key: "office_visit", label: "Office visit" },
  { key: "one_on_one", label: "1-on-1" },
  { key: "lunch", label: "Lunch / coffee" },
  { key: "event", label: "Event" },
  { key: "other", label: "Other" },
] as const;

export type GoldListActivityType =
  (typeof GOLD_LIST_ACTIVITY_TYPES)[number]["key"];

/** Every allowed activity type as a plain tuple (for zod enums / guards). */
export const GOLD_LIST_ACTIVITY_TYPE_KEYS = GOLD_LIST_ACTIVITY_TYPES.map(
  (t) => t.key,
) as unknown as readonly [GoldListActivityType, ...GoldListActivityType[]];

/** Status values a `gold_list_activities` row may hold. Mirrors the DB CHECK. */
export const GOLD_LIST_ACTIVITY_STATUSES = [
  "scheduled",
  "completed",
  "cancelled",
] as const;

export type GoldListActivityStatus =
  (typeof GOLD_LIST_ACTIVITY_STATUSES)[number];

/** Human label for an activity type; falls back to the raw key if unknown. */
export function activityTypeLabel(value: string): string {
  const match = GOLD_LIST_ACTIVITY_TYPES.find((t) => t.key === value);
  return match ? match.label : value;
}

export function isGoldListActivityType(
  value: unknown,
): value is GoldListActivityType {
  return (
    typeof value === "string" &&
    GOLD_LIST_ACTIVITY_TYPES.some((t) => t.key === value)
  );
}

export function isGoldListActivityStatus(
  value: unknown,
): value is GoldListActivityStatus {
  return (
    typeof value === "string" &&
    (GOLD_LIST_ACTIVITY_STATUSES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Field limits — enforced by the route zod schemas, reused by the forms so the
// UI can't submit something the server will reject.
// ---------------------------------------------------------------------------

export const AGENT_NAME_MAX_LENGTH = 120;
export const AGENT_FIELD_MAX_LENGTH = 160;
export const AGENT_NOTES_MAX_LENGTH = 2000;
export const OUTCOME_NOTE_MAX_LENGTH = 2000;
/** The optional note attached to a SCHEDULED activity (its plan/purpose). */
export const ACTIVITY_NOTE_MAX_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/** One `gold_list_activities` row as the API returns it. */
export type GoldListActivity = {
  id: string;
  agent_id: string;
  /** The owning AE. Always equal to the parent agent's owner (composite FK). */
  salesperson_id: string;
  activity_type: GoldListActivityType;
  description: string;
  /**
   * OPTIONAL note captured when the activity is SCHEDULED — what this touch is
   * for ("get him on the phone about his upcoming listing").
   *
   * THREE SEPARATE NOTES, none of them a rename of another:
   *   * `GoldListAgent.notes`  — the standing relationship note on the person.
   *   * `activity_note` (this) — the plan for one scheduled activity.
   *   * `outcome_note`         — what actually happened, written on completion.
   * They have their own columns, their own form fields, and their own lines in
   * history; nothing merges or overwrites one with another.
   */
  activity_note: string | null;
  /** ISO date (yyyy-mm-dd). */
  scheduled_for: string;
  status: GoldListActivityStatus;
  outcome_note: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

/** The summary shape used in agent lists — omits `outcome_note` (history only). */
export type GoldListActivitySummary = Omit<
  GoldListActivity,
  "outcome_note" | "created_at" | "updated_at"
>;

/** One `gold_list_agents` row as the API returns it. */
export type GoldListAgent = {
  id: string;
  salesperson_id: string;
  agent_name: string;
  brokerage: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  /** Null for an active agent; a timestamp once archived. */
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * An agent decorated with the follow-up state the board renders. The extra
 * fields are computed per request, not stored.
 */
export type GoldListAgentWithFollowUp = GoldListAgent & {
  /** Owner's display name — the admin all-AEs view labels each card with it. */
  owner_name: string | null;
  /** Whether the CALLER may write to this agent (owner-only; admins read). */
  can_edit: boolean;
  /** The single open activity, or null when nothing is scheduled yet. */
  next_activity: GoldListActivitySummary | null;
  /** How many activities have been completed (the preserved history). */
  completed_count: number;
  /** Completion date in the app timezone of the most recently completed activity, or null. */
  last_completed_on: string | null;
};

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/** Active (non-archived) agents only — the basis of the header count. */
export function activeAgents<T extends { archived_at: string | null }>(
  agents: readonly T[],
): T[] {
  return agents.filter((a) => a.archived_at === null);
}

/**
 * The count phrase in the page header: "Gold List — 18 agents".
 * Singular at exactly one so a one-agent list doesn't read "1 agents".
 */
export function agentCountLabel(count: number): string {
  return `${count} ${count === 1 ? "agent" : "agents"}`;
}

/** How a scheduled date reads relative to today, for tone + copy. */
export type ScheduleTone = "overdue" | "today" | "upcoming";

/**
 * Classifies a scheduled date against "today". Both arguments are yyyy-mm-dd
 * strings in the app timezone (America/Denver) — callers pass
 * `format(todayInAppTimezone(), "yyyy-MM-dd")` — so a rep in a different
 * timezone, and the server, agree on what "today" means. String comparison is
 * safe and exact for the ISO date format.
 */
export function scheduleToneFor(
  scheduledFor: string,
  todayIso: string,
): ScheduleTone {
  if (scheduledFor < todayIso) return "overdue";
  if (scheduledFor === todayIso) return "today";
  return "upcoming";
}

/**
 * Board order: the follow-ups that need attention first.
 *
 *   overdue -> due today -> upcoming (soonest first) -> nothing scheduled,
 *   ties broken by agent name so the list is stable between renders.
 *
 * Sorting by due date alone produces exactly that grouping: any overdue date
 * sorts before today's, which sorts before any future date. Agents with no
 * scheduled activity sink to the bottom — they are the ones to pick up once
 * the dated work is handled, not the ones to act on now.
 *
 * Pure and exported so the ordering rule can be reasoned about (and tested)
 * without mounting the page.
 */
export function sortAgentsByFollowUp<T extends SortableAgent>(
  agents: readonly T[],
): T[] {
  return [...agents].sort((a, b) => {
    const aDate = a.next_activity?.scheduled_for;
    const bDate = b.next_activity?.scheduled_for;
    if (aDate && bDate && aDate !== bDate) return aDate < bDate ? -1 : 1;
    if (aDate && !bDate) return -1;
    if (!aDate && bDate) return 1;
    return compareAgents(a, b);
  });
}

// ---------------------------------------------------------------------------
// Board controls — search, sort, status filter
// ---------------------------------------------------------------------------
//
// All three are PURE FUNCTIONS OVER ROWS THE SERVER ALREADY RETURNED. The
// board applies them to the payload of `GET /api/gold-list/agents`, which is
// scoped by `resolveGoldListScope` to exactly what the caller may see: their
// own list, or — for an admin — the AE they filtered to. Narrowing that set in
// the browser can therefore never widen it; there is no search endpoint, no
// cross-AE query, and nothing here reaches data the caller was not already
// sent. (It also means results appear as you type, with no refetch.)

/** The minimal agent shape these helpers need. `id` is optional so callers
 *  that only care about ordering can pass lighter objects. */
type SortableAgent = {
  id?: string;
  agent_name: string;
  next_activity: { scheduled_for: string } | null;
};

/** The searchable contact fields. All optional except the name. */
type SearchableAgent = {
  agent_name: string;
  brokerage?: string | null;
  phone?: string | null;
  email?: string | null;
};

export const GOLD_LIST_SORTS = [
  { key: "due_date", label: "Due date" },
  { key: "agent_name", label: "Agent name" },
] as const;

export type GoldListSort = (typeof GOLD_LIST_SORTS)[number]["key"];

/** Due date is the default: the board's job is "who needs me today". */
export const DEFAULT_GOLD_LIST_SORT: GoldListSort = "due_date";

export function isGoldListSort(value: unknown): value is GoldListSort {
  return GOLD_LIST_SORTS.some((s) => s.key === value);
}

export const GOLD_LIST_STATUS_FILTERS = [
  { key: "all", label: "All" },
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Due Today" },
  { key: "none", label: "No Next Activity" },
] as const;

export type GoldListStatusFilter =
  (typeof GOLD_LIST_STATUS_FILTERS)[number]["key"];

export const DEFAULT_GOLD_LIST_STATUS_FILTER: GoldListStatusFilter = "all";

export function isGoldListStatusFilter(
  value: unknown,
): value is GoldListStatusFilter {
  return GOLD_LIST_STATUS_FILTERS.some((f) => f.key === value);
}

/**
 * Digits of a phone number or a phone-shaped search term, with a leading US
 * country code dropped so "1 (303) 555-0147", "303-555-0147" and "3035550147"
 * all normalize to the same string. Mirrors the normalization the duplicate
 * check uses in gold-list-validation.ts.
 */
export function searchableDigits(value: string): string {
  return value.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
}

/**
 * Case-insensitive match across name, brokerage, phone and email.
 *
 * Text is matched as a plain substring on every field (so "sum" finds "Summit
 * Realty" and a literal "(303)" finds a number typed that way). A query
 * carrying at least three digits is ALSO compared digit-to-digit against the
 * phone, so any common formatting of the same number matches regardless of how
 * either side was punctuated.
 *
 * An empty or whitespace-only query matches everything — "no search".
 */
export function matchesAgentSearch(
  agent: SearchableAgent,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;

  const fields = [agent.agent_name, agent.brokerage, agent.phone, agent.email];
  if (fields.some((f) => f && f.toLowerCase().includes(needle))) return true;

  const digits = searchableDigits(needle);
  if (digits.length >= 3 && /^[+\d\s().-]+$/.test(needle) && agent.phone) {
    return searchableDigits(agent.phone).includes(digits);
  }
  return false;
}

/**
 * Whether an agent belongs in the current status filter.
 *
 * `todayIso` is yyyy-mm-dd in the app's business timezone (America/Denver),
 * the same value the cards judge their overdue/today tone with, so a filter
 * and the badge on the card it reveals can never disagree.
 */
export function matchesStatusFilter(
  agent: { next_activity: { scheduled_for: string } | null },
  filter: GoldListStatusFilter,
  todayIso: string,
): boolean {
  if (filter === "all") return true;
  if (filter === "none") return agent.next_activity === null;
  if (!agent.next_activity) return false;
  const tone = scheduleToneFor(agent.next_activity.scheduled_for, todayIso);
  return filter === "overdue" ? tone === "overdue" : tone === "today";
}

/** Case-insensitive name comparison, with the id as a stable final tiebreak. */
function compareAgents(a: SortableAgent, b: SortableAgent): number {
  const byName = a.agent_name.localeCompare(b.agent_name, undefined, {
    sensitivity: "base",
  });
  if (byName !== 0) return byName;
  return (a.id ?? "").localeCompare(b.id ?? "");
}

/** A–Z by agent name, case-insensitive and stable. */
export function sortAgentsByName<T extends SortableAgent>(
  agents: readonly T[],
): T[] {
  return [...agents].sort(compareAgents);
}

/** Applies whichever of the two sort choices is selected. */
export function sortAgents<T extends SortableAgent>(
  agents: readonly T[],
  sort: GoldListSort,
): T[] {
  return sort === "agent_name"
    ? sortAgentsByName(agents)
    : sortAgentsByFollowUp(agents);
}

/**
 * Search + status filter + sort, in that order — the one place the three
 * controls combine, so the board, the archived list and the tests all agree on
 * what "currently visible" means.
 *
 * Deliberately does NOT touch active/archived partitioning or the admin AE
 * filter: those decide WHICH rows the board is holding (the second of them
 * server-side), and these controls narrow whatever it holds.
 */
export function visibleAgents<T extends SortableAgent & SearchableAgent>(
  agents: readonly T[],
  options: {
    query: string;
    status: GoldListStatusFilter;
    sort: GoldListSort;
    todayIso: string;
  },
): T[] {
  const matched = agents.filter(
    (agent) =>
      matchesAgentSearch(agent, options.query) &&
      matchesStatusFilter(agent, options.status, options.todayIso),
  );
  return sortAgents(matched, options.sort);
}
