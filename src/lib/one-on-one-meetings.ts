// Manager 1:1 workspace — shared types, constants, and pure helpers.
//
// PRODUCT MODEL
//   A 1:1 is a MEETING, not a week. The manager opens an AE, clicks
//   "Start 1:1" (which creates — or resumes — the AE's single in-progress
//   draft), works through Wins → Activity & Results → Gold List → Coaching →
//   Commitments, and completes it. Completion freezes the record.
//
//   "Last 1:1" is the most recently COMPLETED meeting, whenever it was — not
//   the previous calendar week.
//
// LIVE vs. HISTORICAL
//   Live data (activity, goals, Gold List, commitments) keeps changing. A
//   completed meeting keeps what was true when it was completed:
//   `activity_snapshot` (the comparison exactly as reviewed), Gold List note
//   snapshots (with only EXPLICITLY attributed 1:1 actions), and frozen
//   commitment reviews — all written in one transaction. See
//   supabase/one_on_one_meetings.sql.
//
// LEGACY
//   The Weekly Focus tables (`one_on_ones` & co., lib/one-on-ones.ts) are
//   untouched and still readable under "Legacy Weekly Focus" on the page.
//
// Safe to import from client components — no server-only imports.

import type { ActivityKey } from "@/lib/activities";
import type { GoldListAgentWithFollowUp } from "@/lib/gold-list";
import type {
  CurrentWeeklyGoal,
  NextWeekGoalOverride,
  WeeklyFocusCommitment,
} from "@/lib/one-on-ones";

// ---------------------------------------------------------------------------
// Tables + limits
// ---------------------------------------------------------------------------

export const MEETINGS_TABLE = "one_on_one_meetings" as const;
export const MEETING_GOLD_LIST_NOTES_TABLE = "one_on_one_gold_list_notes" as const;
export const MEETING_COMMITMENTS_TABLE = "one_on_one_meeting_commitments" as const;
export const MEETING_COMMITMENT_REVIEWS_TABLE =
  "one_on_one_commitment_reviews" as const;

/** Mirrors the CHECK constraints in one_on_one_meetings.sql. */
export const MEETING_NOTES_MAX_LENGTH = 5000;
export const COACHING_FOCUS_MAX_LENGTH = 300;
export const PRIVATE_NOTES_MAX_LENGTH = 5000;
export const FOLLOWUP_SUBJECT_MAX_LENGTH = 300;
export const FOLLOWUP_BODY_MAX_LENGTH = 10000;
export const MEETING_COMMITMENT_MAX_LENGTH = 500;
export const GOLD_LIST_DISCUSSION_NOTE_MAX_LENGTH = 2000;

/** Completed meetings per history page (initial workspace load + "Load older"). */
export const MEETING_HISTORY_PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type MeetingStatus = "in_progress" | "completed";

/**
 * The editable free-text fields on a meeting.
 *
 *   coaching_notes   — the "1:1 Notes" (shareable meeting notes; the column
 *                      predates the rename, so earlier meetings' notes carry
 *                      over unchanged);
 *   coaching_focus   — legacy: no longer edited in the workspace, still
 *                      readable on older records;
 *   private_notes    — PRIVATE MANAGER NOTES. Never shared: excluded from the
 *                      AI follow-up email and from every summary of a meeting
 *                      (see PreviousMeetingSummary, followup-context.ts);
 *   followup_subject / followup_body — the AE follow-up email draft.
 */
export const MEETING_TEXT_FIELDS = [
  "wins",
  "activity_notes",
  "coaching_focus",
  "coaching_notes",
  "private_notes",
  "followup_subject",
  "followup_body",
] as const;
export type MeetingTextField = (typeof MEETING_TEXT_FIELDS)[number];

/** The revision column that guards each draft text field. */
export function revisionColumn(field: MeetingTextField) {
  return `${field}_rev` as const;
}

/**
 * Body of a 409 when a draft save was based on a stale revision: the text
 * and revision now stored, so the client can offer "keep mine" (re-save on
 * top of `revision`) or "use theirs".
 */
export type DraftConflictBody = {
  error: string;
  conflict: { value: string | null; revision: number };
};

/** One goal change made from a 1:1 (recorded by the goals route). */
export type GoalChange = {
  start: "this_week" | "next_week";
  /** Monday the new goal takes effect, yyyy-mm-dd. */
  effective_from: string;
  values: Record<string, number>;
  at: string;
};

export type OneOnOneMeeting = {
  id: string;
  ae_id: string;
  manager_id: string | null;
  ae_name: string | null;
  manager_name: string | null;
  /** yyyy-mm-dd, America/Denver. */
  meeting_date: string;
  status: MeetingStatus;
  started_at: string;
  completed_at: string | null;
  completed_by: string | null;
  wins: string | null;
  activity_notes: string | null;
  coaching_focus: string | null;
  /** The "1:1 Notes". */
  coaching_notes: string | null;
  /** PRIVATE MANAGER NOTES — never shared, never sent to the AI. */
  private_notes: string | null;
  followup_subject: string | null;
  followup_body: string | null;
  /** When the email was last generated, and the fingerprint of the shareable
   *  meeting content it was generated from (staleness detection). */
  followup_generated_at: string | null;
  followup_context_hash: string | null;
  followup_model: string | null;
  /** Goal changes made from this 1:1. */
  goal_changes: GoalChange[];
  /** Per-field save revisions (optimistic concurrency across tabs). */
  wins_rev: number;
  activity_notes_rev: number;
  coaching_focus_rev: number;
  coaching_notes_rev: number;
  private_notes_rev: number;
  followup_subject_rev: number;
  followup_body_rev: number;
  /** Null while in progress; frozen at completion. */
  activity_snapshot: ActivitySnapshot | null;
  created_at: string;
  updated_at: string;
};

export const COMMITMENT_OWNERS = ["ae", "manager"] as const;
export type CommitmentOwner = (typeof COMMITMENT_OWNERS)[number];

export const MEETING_COMMITMENT_STATUSES = [
  "open",
  "completed",
  "dropped",
] as const;
export type MeetingCommitmentStatus =
  (typeof MEETING_COMMITMENT_STATUSES)[number];

/** A LIVE commitment. */
export type MeetingCommitment = {
  id: string;
  ae_id: string;
  origin_meeting_id: string;
  description: string;
  owner: CommitmentOwner;
  due_date: string | null;
  status: MeetingCommitmentStatus;
  completed_at: string | null;
  resolved_in_meeting_id: string | null;
  created_at: string;
  updated_at: string;
};

/** A live commitment decorated with the date of the meeting it came from. */
export type MeetingCommitmentWithOrigin = MeetingCommitment & {
  origin_meeting_date: string | null;
};

/** A legacy Weekly Focus commitment surfaced as carryover. */
export type LegacyCarryoverCommitment = WeeklyFocusCommitment & {
  source_week_start: string | null;
};

/** A FROZEN per-meeting copy of one commitment. */
export type CommitmentReview = {
  id: string;
  meeting_id: string;
  commitment_id: string | null;
  legacy_commitment_id: string | null;
  origin: "new" | "carryover";
  origin_meeting_date: string | null;
  description: string;
  owner: CommitmentOwner;
  due_date: string | null;
  status: MeetingCommitmentStatus;
  /** Display order within the meeting's record. */
  sort_order: number;
  created_at: string;
};

export type GoldListActivityChange = {
  kind: "completed" | "scheduled" | "rescheduled" | "cancelled";
  description: string;
  /** yyyy-mm-dd */
  date: string;
};

/** One Gold List agent discussed in one meeting. */
export type GoldListDiscussionNote = {
  id: string;
  meeting_id: string;
  ae_id: string;
  agent_id: string | null;
  note: string | null;
  /** Save revision of `note` (optimistic concurrency across tabs). */
  revision: number;
  action_taken: boolean;
  /** The agent was ADDED to the live Gold List during this 1:1. */
  agent_added: boolean;
  /** The agent's details were edited during this 1:1. */
  agent_edited: boolean;
  agent_name: string;
  brokerage: string | null;
  last_activity_on: string | null;
  last_activity_description: string | null;
  next_activity_on: string | null;
  next_activity_description: string | null;
  activity_changes: GoldListActivityChange[];
  snapshot_taken_at: string | null;
  created_at: string;
  updated_at: string;
};

// ---------------------------------------------------------------------------
// Activity & Results snapshot
// ---------------------------------------------------------------------------

/** One activity for one week — the same shape as the admin activity report. */
export type ActivityComparisonCell = {
  actual: number;
  /** Time-off-adjusted weekly target the % is computed against. */
  goal: number;
  /** The unadjusted goal from `weekly_goals` in effect that week. */
  original_goal: number;
  percent: number | null;
};

export type ActivityWeekResult = {
  /** Monday of the Mon-Fri business week (goal + availability anchor). */
  week_start: string;
  /** Sun-Sat activity window the actuals were summed over. */
  activity_since: string;
  activity_through: string;
  /** Weekly score — identical to the leaderboard %. */
  score: number | null;
  available_days: number;
  is_holiday_week: boolean;
  cells: Record<ActivityKey, ActivityComparisonCell>;
};

export type ActivitySnapshot = {
  version: 1;
  /** When the comparison was computed (completion time, for a frozen one). */
  computed_at: string;
  last_week: ActivityWeekResult;
  this_week: ActivityWeekResult;
};

// ---------------------------------------------------------------------------
// API payloads
// ---------------------------------------------------------------------------

/** A Gold List agent as the 1:1 workspace renders it. */
export type WorkspaceGoldListAgent = GoldListAgentWithFollowUp & {
  last_completed: { description: string; completed_on: string } | null;
};

export type MeetingHistoryItem = {
  id: string;
  meeting_date: string;
  completed_at: string;
  coaching_focus: string | null;
  /** First line of the 1:1 Notes (never the private notes). */
  notes_preview: string | null;
  manager_name: string | null;
};

/**
 * What the workspace shows of the previous completed 1:1: an explicit
 * ALLOWLIST of shareable fields. It deliberately has no private notes — the
 * server builds it field by field (toPreviousMeeting), never by passing a
 * meeting row through.
 */
export type PreviousMeetingSummary = Pick<
  OneOnOneMeeting,
  "id" | "meeting_date" | "completed_at" | "coaching_focus" | "coaching_notes"
>;

/** "Subject: …" then a blank line then the body — paste-ready for Outlook. */
export function formatEmailForCopy(subject: string, body: string): string {
  const s = subject.trim();
  const b = body.trim();
  return s ? `Subject: ${s}\n\n${b}` : b;
}

/** GET /api/admin/coaching/[ae_id]/meetings */
export type OneOnOneWorkspace = {
  ae: { id: string; first_name: string };
  /** Denver date the workspace was computed for. */
  today: string;
  /** The single in-progress draft, if one exists. */
  meeting: OneOnOneMeeting | null;
  last_completed: {
    meeting: PreviousMeetingSummary;
    /** Commitments created in that meeting, with their LIVE status. */
    commitments: MeetingCommitment[];
  } | null;
  /** The most recent completed 1:1s (one page). */
  history: MeetingHistoryItem[];
  /** More completed 1:1s exist — page with GET …/meetings/history. */
  history_has_more: boolean;
  /** Live comparison (always computed, even before a meeting starts). */
  activity: ActivitySnapshot;
  gold_list: WorkspaceGoldListAgent[];
  /** Discussion notes for the in-progress meeting. */
  gold_list_notes: GoldListDiscussionNote[];
  /**
   * Agents with a Gold List action EXPLICITLY attributed to the in-progress
   * meeting (scheduled / completed / cancelled / rescheduled from the 1:1).
   */
  gold_list_action_agent_ids: string[];
  /** Agents ADDED to the live Gold List during the in-progress 1:1. */
  gold_list_added_agent_ids: string[];
  /** Agents whose details were edited during the in-progress 1:1. */
  gold_list_edited_agent_ids: string[];
  /**
   * The generated follow-up email no longer matches the shareable meeting
   * content (something changed since it was generated). False when there is
   * no generated email.
   */
  followup_stale: boolean;
  /** Open (or resolved-in-this-meeting) commitments from earlier meetings. */
  carryover: MeetingCommitmentWithOrigin[];
  /** Open legacy Weekly Focus commitments. */
  legacy_carryover: LegacyCarryoverCommitment[];
  /** Commitments created in the in-progress meeting. */
  new_commitments: MeetingCommitment[];
  weekly_goal_current: CurrentWeeklyGoal;
  weekly_goal_next_override: NextWeekGoalOverride | null;
  next_week_start: string;
};

/** GET /api/admin/one-on-one-meetings/[id] — a full meeting record. */
export type MeetingRecord = {
  meeting: OneOnOneMeeting;
  gold_list_notes: GoldListDiscussionNote[];
  commitment_reviews: CommitmentReview[];
};

// ---------------------------------------------------------------------------
// Gold List review ordering (pure)
// ---------------------------------------------------------------------------

export type GoldListReviewBucket =
  | "overdue"
  | "no_next"
  | "due_this_week"
  | "later";

/** Sunday-Saturday: the last day of the activity week containing `todayIso`. */
export function endOfActivityWeek(todayIso: string): string {
  const d = new Date(`${todayIso}T12:00:00Z`);
  const saturday = new Date(d);
  saturday.setUTCDate(d.getUTCDate() + (6 - d.getUTCDay()));
  return saturday.toISOString().slice(0, 10);
}

/**
 * Which review bucket an agent falls in. Dates are yyyy-mm-dd in the app
 * timezone, the same convention every Gold List surface uses.
 */
export function goldListReviewBucket(
  agent: { next_activity: { scheduled_for: string } | null },
  todayIso: string,
  weekEndIso: string = endOfActivityWeek(todayIso),
): GoldListReviewBucket {
  const due = agent.next_activity?.scheduled_for;
  if (!due) return "no_next";
  if (due < todayIso) return "overdue";
  if (due <= weekEndIso) return "due_this_week";
  return "later";
}

const BUCKET_ORDER: Record<GoldListReviewBucket, number> = {
  overdue: 0,
  no_next: 1,
  due_this_week: 2,
  later: 3,
};

/**
 * 1:1 review order: overdue → no next activity → due this week → the rest.
 * Within a bucket: soonest due date first, then name.
 */
export function sortGoldListForReview<
  T extends {
    agent_name: string;
    id?: string;
    next_activity: { scheduled_for: string } | null;
  },
>(agents: readonly T[], todayIso: string): T[] {
  const weekEnd = endOfActivityWeek(todayIso);
  return [...agents].sort((a, b) => {
    const ba = BUCKET_ORDER[goldListReviewBucket(a, todayIso, weekEnd)];
    const bb = BUCKET_ORDER[goldListReviewBucket(b, todayIso, weekEnd)];
    if (ba !== bb) return ba - bb;
    const da = a.next_activity?.scheduled_for ?? "";
    const db = b.next_activity?.scheduled_for ?? "";
    if (da !== db) return da < db ? -1 : 1;
    const byName = a.agent_name.localeCompare(b.agent_name, undefined, {
      sensitivity: "base",
    });
    if (byName !== 0) return byName;
    return (a.id ?? "").localeCompare(b.id ?? "");
  });
}

export type GoldListReviewSummary = {
  total: number;
  overdue: number;
  no_next: number;
  due_this_week: number;
};

export function summarizeGoldListForReview(
  agents: ReadonlyArray<{ next_activity: { scheduled_for: string } | null }>,
  todayIso: string,
): GoldListReviewSummary {
  const weekEnd = endOfActivityWeek(todayIso);
  const out: GoldListReviewSummary = {
    total: agents.length,
    overdue: 0,
    no_next: 0,
    due_this_week: 0,
  };
  for (const a of agents) {
    const bucket = goldListReviewBucket(a, todayIso, weekEnd);
    if (bucket !== "later") out[bucket] += 1;
  }
  return out;
}

export const GOLD_LIST_REVIEW_FILTERS = [
  { key: "attention", label: "Needs attention" },
  { key: "upcoming", label: "Upcoming" },
  { key: "all", label: "All" },
] as const;
export type GoldListReviewFilter =
  (typeof GOLD_LIST_REVIEW_FILTERS)[number]["key"];

/** attention = overdue or nothing scheduled; upcoming = due this week. */
export function matchesGoldListReviewFilter(
  agent: { next_activity: { scheduled_for: string } | null },
  filter: GoldListReviewFilter,
  todayIso: string,
): boolean {
  if (filter === "all") return true;
  const bucket = goldListReviewBucket(agent, todayIso);
  if (filter === "attention")
    return bucket === "overdue" || bucket === "no_next";
  return bucket === "due_this_week";
}

// ---------------------------------------------------------------------------
// Carryover rules (pure — used by the server, unit-tested). The completion
// snapshot itself is built inside complete_one_on_one_meeting() in SQL, in
// the same transaction that freezes the meeting.
// ---------------------------------------------------------------------------

/**
 * Commitments from EARLIER meetings that belong on the current meeting's
 * carryover list: everything still open, plus anything closed out during
 * this meeting (so it shows as checked off rather than vanishing).
 */
export function carryoverFor(
  commitments: readonly MeetingCommitment[],
  meetingId: string | null,
): MeetingCommitment[] {
  return commitments.filter((c) => {
    if (meetingId && c.origin_meeting_id === meetingId) return false;
    if (c.status === "open") return true;
    return meetingId !== null && c.resolved_in_meeting_id === meetingId;
  });
}

/**
 * How a status change on a commitment, made from inside meeting
 * `meetingId`, records where it was resolved. A carryover commitment closed
 * in a later meeting remembers that meeting; reopening clears it; closing a
 * commitment in its own origin meeting leaves it null.
 */
export function resolutionFor(
  commitment: Pick<MeetingCommitment, "origin_meeting_id">,
  nextStatus: MeetingCommitmentStatus,
  meetingId: string,
): string | null {
  if (nextStatus === "open") return null;
  return commitment.origin_meeting_id === meetingId ? null : meetingId;
}

/** yyyy-mm-dd of an ISO instant in America/Denver. */
export function appDateOf(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}
