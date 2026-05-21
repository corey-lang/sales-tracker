// Manager 1:1 coaching system — shared TypeScript types.
//
// Phase 1 surfaces these models through the /api/admin/coaching/* routes
// only. The schema lives in supabase/manager_one_on_ones.sql; field names
// here match column names 1:1 so the API can return rows untouched.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Table names — kept here so a future rename only touches one file. */
export const ONE_ON_ONES_TABLE = "one_on_ones" as const;
export const ONE_ON_ONE_COMMITMENTS_TABLE = "one_on_one_commitments" as const;
export const COACHING_RELATIONSHIPS_TABLE = "coaching_relationships" as const;
export const TRAINING_COMMITMENTS_TABLE = "training_commitments" as const;

/**
 * Visibility for a 1:1. Phase 1 is `manager_only` everywhere; `shared` is
 * here so AE-facing routes can be added later without a schema migration.
 */
export const ONE_ON_ONE_VISIBILITIES = ["manager_only", "shared"] as const;
export type OneOnOneVisibility = (typeof ONE_ON_ONE_VISIBILITIES)[number];

export function isOneOnOneVisibility(
  value: unknown,
): value is OneOnOneVisibility {
  return value === "manager_only" || value === "shared";
}

/** Cap on free-text fields so a typo in a textarea can't blow up the DB. */
export const NOTES_MAX_LENGTH = 5000;
export const COMMITMENT_CONTENT_MAX_LENGTH = 500;
export const RELATIONSHIP_FIELD_MAX_LENGTH = 200;
export const RELATIONSHIP_NOTES_MAX_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export type OneOnOne = {
  id: string;
  ae_id: string;
  manager_id: string | null;
  /** YYYY-MM-DD */
  meeting_date: string;
  visibility: OneOnOneVisibility;
  notes_wins: string | null;
  notes_opportunities: string | null;
  notes_focus: string | null;
  created_at: string;
  updated_at: string;
};

export type OneOnOneCommitment = {
  id: string;
  one_on_one_id: string;
  ae_id: string;
  content: string;
  completed: boolean;
  completed_at: string | null;
  /** YYYY-MM-DD or null */
  due_date: string | null;
  created_at: string;
  updated_at: string;
};

export type CoachingRelationship = {
  id: string;
  ae_id: string;
  contact_name: string;
  company: string | null;
  title: string | null;
  status: string | null;
  next_step: string | null;
  notes: string | null;
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
  /** Most recent 1:1's meeting_date for this AE, or null. */
  latest_meeting_date: string | null;
  /** Count of unfinished commitments across this AE's most recent 1:1. */
  open_commitments: number;
};

/** Single-AE snapshot used in the detail-page header. */
export type CoachingSnapshot = {
  /** Current-week percent of weekly goal — same value as the leaderboard. */
  percent: number | null;
  rank: number | null;
  total_ranked: number;
  /** Sum of each activity for the current Mon-Fri week. */
  week_totals: {
    office_visits: number;
    service_requests: number;
    ones_scheduled: number;
    ones_held: number;
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

/** What the detail page GET returns. */
export type CoachingDetail = {
  ae: { id: string; first_name: string };
  snapshot: CoachingSnapshot;
  relationships: CoachingRelationship[];
  training: TrainingCommitment[];
  /** Newest-first. The first entry is the "current" 1:1; the rest are history. */
  one_on_ones: Array<
    OneOnOne & {
      commitments: OneOnOneCommitment[];
    }
  >;
  /**
   * Convenience: the commitments from the second-most-recent 1:1, which is
   * what the "Previous 1:1 Commitments" section displays during the
   * current meeting. Empty for the AE's very first 1:1.
   */
  previous_commitments: OneOnOneCommitment[];
};
