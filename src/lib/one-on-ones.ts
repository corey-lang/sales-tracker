// Weekly Focus coaching system — shared TypeScript types.
//
// PRODUCT MODEL
//   One Weekly Focus row per AE per business week (Mon-Fri). The row is
//   auto-created when the manager first opens the AE's coaching page in a
//   new week — there's no "Start new 1:1" flow anymore. Commitments left
//   open in prior weeks carry forward and are surfaced as motivational
//   "carried over" rows on the current week.
//
//   Gold List / Key Relationships persist across weeks (NOT reset), and
//   Training Focus is captured per week.
//
// SCHEMA
//   The DB still calls the table `one_on_ones` (see
//   supabase/weekly_focus.sql for the additive migration that introduced
//   `week_start` and the per-pane notes columns; see
//   supabase/weekly_focus_v2.sql for the commitment `status` lifecycle,
//   the relationship `archived_at` lifecycle, and the move of
//   `notes_manager` off `one_on_ones` into the separate
//   `weekly_focus_private_notes` table). The code-side rename to
//   "Weekly Focus" is purely semantic — the table aliases below preserve
//   the SQL constants while the rest of the codebase speaks the new model.
//
//   Phase 1 surfaces these models through the /api/admin/coaching/* routes
//   only. Admin-only — AE-facing exposure comes later behind the
//   `visibility = 'shared'` flag that already exists on the row.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Table names — kept here so a future rename only touches one file. */
export const WEEKLY_FOCUS_TABLE = "one_on_ones" as const;
export const WEEKLY_FOCUS_COMMITMENTS_TABLE = "one_on_one_commitments" as const;
export const WEEKLY_FOCUS_PRIVATE_NOTES_TABLE = "weekly_focus_private_notes" as const;
export const COACHING_RELATIONSHIPS_TABLE = "coaching_relationships" as const;
export const TRAINING_COMMITMENTS_TABLE = "training_commitments" as const;

/**
 * Back-compat aliases. The DB tables kept their original `one_on_ones` /
 * `one_on_one_commitments` names through the Weekly Focus migration — these
 * exports let any older import keep working while new code uses the
 * weekly-focus names. Remove after a full sweep proves nothing imports the
 * old names.
 */
export const ONE_ON_ONES_TABLE = WEEKLY_FOCUS_TABLE;
export const ONE_ON_ONE_COMMITMENTS_TABLE = WEEKLY_FOCUS_COMMITMENTS_TABLE;

/**
 * Visibility for a Weekly Focus row. Phase 1 is `manager_only` everywhere;
 * `shared` is here so AE-facing routes can be added later without a schema
 * migration.
 */
export const WEEKLY_FOCUS_VISIBILITIES = ["manager_only", "shared"] as const;
export type WeeklyFocusVisibility = (typeof WEEKLY_FOCUS_VISIBILITIES)[number];

export function isWeeklyFocusVisibility(
  value: unknown,
): value is WeeklyFocusVisibility {
  return value === "manager_only" || value === "shared";
}

/** Back-compat aliases — see the table-alias note above. */
export const ONE_ON_ONE_VISIBILITIES = WEEKLY_FOCUS_VISIBILITIES;
export type OneOnOneVisibility = WeeklyFocusVisibility;
export const isOneOnOneVisibility = isWeeklyFocusVisibility;

/** Cap on free-text fields so a typo in a textarea can't blow up the DB. */
export const NOTES_MAX_LENGTH = 5000;
export const COMMITMENT_CONTENT_MAX_LENGTH = 500;
export const RELATIONSHIP_FIELD_MAX_LENGTH = 200;
export const RELATIONSHIP_NOTES_MAX_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export type WeeklyFocus = {
  id: string;
  ae_id: string;
  manager_id: string | null;
  /** YYYY-MM-DD — Monday of this focus row's business week. */
  week_start: string;
  /**
   * YYYY-MM-DD. Legacy column from the original 1:1 model; kept for back-
   * compat and surfaces in history listings as the date the row was first
   * touched in the week. The week the row belongs to is `week_start`.
   */
  meeting_date: string;
  visibility: WeeklyFocusVisibility;
  /** "This Week Focus" pane. */
  notes_focus: string | null;
  /** "Wins" pane. */
  notes_wins: string | null;
  /** "Need Help / Blockers" pane (legacy column name kept). */
  notes_opportunities: string | null;
  /** "Training Focus" pane. */
  notes_training: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Commitment lifecycle.
 *   * `open`      — active; appears in this week's list or as carryover
 *   * `completed` — finished; remains in history, drops out of carryover
 *   * `dropped`   — removed from active focus; remains in history, does
 *                   NOT count as a missed item or surface as carryover
 *
 * `status` is the authoritative source. The legacy `completed` boolean
 * is kept on the row only to avoid breaking any older external query —
 * new code never filters on it.
 */
export const COMMITMENT_STATUSES = ["open", "completed", "dropped"] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

export function isCommitmentStatus(value: unknown): value is CommitmentStatus {
  return value === "open" || value === "completed" || value === "dropped";
}

export type WeeklyFocusCommitment = {
  id: string;
  /** FK to the parent Weekly Focus row. */
  one_on_one_id: string;
  ae_id: string;
  content: string;
  /** Authoritative lifecycle field — see CommitmentStatus. */
  status: CommitmentStatus;
  /**
   * Legacy boolean kept in sync with `status === 'completed'`. Prefer
   * `status` in new code; this field exists for back-compat only.
   */
  completed: boolean;
  completed_at: string | null;
  /** YYYY-MM-DD or null */
  due_date: string | null;
  created_at: string;
  updated_at: string;
};

/** Back-compat aliases — see the table-alias note above. */
export type OneOnOne = WeeklyFocus;
export type OneOnOneCommitment = WeeklyFocusCommitment;

export type CoachingRelationship = {
  id: string;
  ae_id: string;
  contact_name: string;
  company: string | null;
  title: string | null;
  status: string | null;
  next_step: string | null;
  notes: string | null;
  /**
   * Soft-archive timestamp. Active relationships have `archived_at === null`;
   * archived rows stay queryable for longitudinal history but are excluded
   * from the active Gold List by default.
   */
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TrainingCommitment = {
  id: string;
  ae_id: string;
  content: string;
  completed: boolean;
  completed_at: string | null;
  /** YYYY-MM-DD or null */
  due_date: string | null;
  created_at: string;
  updated_at: string;
};

// ---------------------------------------------------------------------------
// Aggregate response shapes returned by the API
// ---------------------------------------------------------------------------

/** Quick snapshot row used on the coaching index (AE picker list). */
export type CoachingAeSummary = {
  id: string;
  first_name: string;
  /** Current week % from /api/leaderboard, null when the AE has no goal. */
  percent: number | null;
  /** 1-indexed; null when percent is null. */
  rank: number | null;
  /**
   * Monday (YYYY-MM-DD) of the AE's most recent Weekly Focus row. Null
   * when the manager hasn't opened a focus surface for them yet. With
   * auto-create on the detail GET, this will almost always be the current
   * week once the manager has visited the AE this week.
   */
  latest_week_start: string | null;
  /**
   * Count of open commitments across THIS AE'S current Weekly Focus row
   * (the latest one). Excludes carryover from prior weeks — those count
   * as motivational context, not "this week's worklist".
   */
  open_commitments: number;
  /**
   * Count of open commitments from PRIOR weeks that will surface as
   * carryover on the current Weekly Focus. Surfaced separately so the
   * index can render "+2 carried" without inflating `open_commitments`.
   */
  carried_commitments: number;
};

/** Single-AE snapshot used in the detail-page header. */
export type CoachingSnapshot = {
  /** Current-week percent of weekly goal — same value as the leaderboard. */
  percent: number | null;
  rank: number | null;
  total_ranked: number;
  /**
   * Sum of each activity for the current Mon-Fri week. Mirrors the
   * `ACTIVITIES` list in `src/lib/activities.ts` (so all eight goal-
   * tracked columns are present), plus `business_cards` which is
   * tracked outside the goal table.
   */
  week_totals: {
    office_visits: number;
    service_requests: number;
    ones_scheduled: number;
    ones_held: number;
    presentations: number;
    impressions: number;
    team_meetings: number;
    gold_list_touches: number;
    business_cards: number;
  };
  /**
   * Last 4 calendar weeks (oldest -> newest) of `percent` so the UI can
   * draw a tiny sparkline / trend pills. `null` entries mean the rep had
   * no goal that week or no activity was logged.
   */
  trend: Array<{ week_start: string; percent: number | null }>;
};

/**
 * Number of past Weekly Focus weeks (excluding the current week) returned
 * in the detail-page history timeline. Capped so an AE with a year+ of
 * history doesn't ship hundreds of rows down to the browser; the timeline
 * UX targets the recent quarter.
 */
export const WEEKLY_FOCUS_HISTORY_LIMIT = 12;

/** Most recently archived relationships to surface in the "Archived" section. */
export const ARCHIVED_RELATIONSHIPS_LIMIT = 50;

/**
 * Reasonable upper bound on a single weekly goal target. The values in
 * `weekly_goals` are weekly Mon-Fri totals (not daily — see the
 * `computeStandings` math), so anything above this is almost certainly a
 * typo. Kept liberal so legitimate high-volume activities (impressions
 * etc.) aren't artificially capped.
 */
export const WEEKLY_GOAL_MAX_VALUE = 999;

/**
 * A resolved weekly goal — the columns that come back from `weekly_goals`
 * for ONE row, narrowed to the activity counters + provenance fields the
 * coaching UI needs.
 *
 * Values are WEEKLY Mon-Fri totals (matches `computeStandings`, which
 * treats the raw column values as weekly targets, NOT daily). The UI
 * shows `actual / weekly_target`.
 */
export type WeeklyGoalValues = {
  office_visits: number;
  service_requests: number;
  ones_scheduled: number;
  ones_held: number;
  presentations: number;
  impressions: number;
  team_meetings: number;
  gold_list_touches: number;
};

/** A weekly_goals row scoped to the current-week / next-week views. */
export type WeeklyGoalRow = WeeklyGoalValues & {
  id: string;
  /** Null = global default; UUID = per-AE override. */
  salesperson_id: string | null;
  /** YYYY-MM-DD. */
  effective_from: string;
};

/** Coaching-page snapshot of the current week's resolved goal. */
export type CurrentWeeklyGoal = {
  /** Resolved weekly targets — already chosen between personal/global. */
  values: WeeklyGoalValues;
  /** Where the resolved row came from. `none` => no goal in effect. */
  source: "personal" | "global" | "none";
  /**
   * Underlying row id when `source !== 'none'`; null when the helper
   * fell through to ZERO targets (no goal exists yet).
   */
  id: string | null;
  /** YYYY-MM-DD of the resolved row's effective_from, or null. */
  effective_from: string | null;
};

/**
 * The per-AE next-week OVERRIDE, if one has been scheduled. Distinct from
 * `CurrentWeeklyGoal` because we deliberately don't fall back to a global
 * goal here — a missing override means "next week inherits whatever's
 * active that day", and the UI presents that as "Keep same goals as this
 * week" (checkbox ON).
 */
export type NextWeekGoalOverride = {
  id: string;
  effective_from: string;
  values: WeeklyGoalValues;
};

/** What the detail page GET returns under the Weekly Focus model. */
export type CoachingDetail = {
  ae: { id: string; first_name: string };
  snapshot: CoachingSnapshot;
  /** Persistent Gold List / Key Relationships — NOT reset weekly. */
  relationships: CoachingRelationship[];
  /**
   * Archived relationships — kept queryable for longitudinal history and
   * to power the "Archived" section's Restore affordance. Newest-archived
   * first. Capped to a small recent window so a long-tenured AE doesn't
   * download years of archived rows on every page load.
   */
  archived_relationships: CoachingRelationship[];
  /** Standing per-AE training assignments — not tied to any single week. */
  training: TrainingCommitment[];
  /**
   * The auto-created Weekly Focus row for the current business week. Always
   * present after a successful GET — the route upserts the row if it
   * doesn't exist yet — with its own commitments inline.
   */
  current_week: WeeklyFocus & { commitments: WeeklyFocusCommitment[] };
  /**
   * The current week's manager-only notes. Stored separately from
   * `current_week` so the AE-facing surface (future) can never accidentally
   * receive this payload — it lives in a different table the AE-facing
   * routes simply do not query.
   */
  manager_notes: string | null;
  /**
   * Open commitments left over from any prior week, surfaced under the
   * current week as motivational carryover. Each carries the original
   * `one_on_one_id` (so updates round-trip to the original row's PATCH
   * endpoint) plus the source week's Monday for UI context. Excludes
   * `completed` (already done) and `dropped` (removed from focus).
   */
  carried_commitments: Array<
    WeeklyFocusCommitment & {
      /** Monday of the week this commitment was originally created in. */
      source_week_start: string;
    }
  >;
  /**
   * Past Weekly Focus rows newest-first, EXCLUDING the current week.
   * Powers the "Past weeks" timeline. Capped to
   * `WEEKLY_FOCUS_HISTORY_LIMIT`. Each entry carries its commitments
   * inline so the history can show "3/4 done" without a follow-up fetch.
   */
  history: Array<WeeklyFocus & { commitments: WeeklyFocusCommitment[] }>;
  /**
   * Current-week resolved goal — used by the Weekly Goals / Goal Progress
   * card to show `actual / weekly_target` per activity. Resolved with the
   * same personal-then-global precedence the leaderboard uses, so the
   * coaching page can never disagree with the leaderboard about targets.
   */
  weekly_goal_current: CurrentWeeklyGoal;
  /**
   * Per-AE override row scheduled for NEXT business week, or null if the
   * AE will inherit whatever goal is active on next Monday. Drives the
   * Next Week Goals card's "Keep same goals as this week" default state.
   */
  weekly_goal_next_override: NextWeekGoalOverride | null;
  /** Monday (YYYY-MM-DD) of next business week — convenience for the UI. */
  next_week_start: string;
};
