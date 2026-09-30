// Server-side helpers for the manager 1:1 workspace.
//
// Every function here assumes the caller already passed requireAdmin(). The
// tables are RLS-locked (no policies), so this service-role code path is the
// ONLY way to read or write them.
//
// REUSE, NOT RE-IMPLEMENTATION
//   * Activity & Results = the admin activity report's per-AE scoring
//     (scoreActivityWeek, via buildSingleAeActivityWeek) run for last week
//     and this week. That helper already resolves each
//     week's goal AS OF that week's Monday (resolveActiveGoal), applies the
//     PTO/holiday adjustment, and scores with adjustedWeekScore() — the same
//     call the leaderboard makes. So last week's % uses last week's goals, and
//     the weekly score equals the leaderboard %.
//   * Gold List writes go through scheduleAgentActivity/updateAgentActivity
//     in server/gold-list.ts — the same code the AE routes run.
//   * Goal editing stays on PUT /api/admin/coaching/[ae_id]/goals.
//
// CONSISTENCY
//   Completion runs in ONE database transaction
//   (complete_one_on_one_meeting, supabase/one_on_one_meetings.sql), and
//   every meeting-scoped write is guarded by a trigger that locks the meeting
//   row and refuses a completed meeting. The in-progress checks in the routes
//   are for clear errors; the database is what makes them race-proof, and
//   routes map its refusal (23514) to the same read-only 409.

import { addDays, format, parseISO } from "date-fns";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ACTIVITIES, type ActivityKey } from "@/lib/activities";
import { todayInAppTimezone } from "@/lib/dates";
import {
  activityWindowForBusinessWeek,
  pairedBusinessMonday,
} from "@/lib/goals";
import {
  GOLD_LIST_AGENTS_TABLE,
  type GoldListActivitySummary,
  type GoldListAgent,
} from "@/lib/gold-list";
import {
  MEETING_COMMITMENT_REVIEWS_TABLE,
  MEETING_COMMITMENTS_TABLE,
  MEETING_GOLD_LIST_NOTES_TABLE,
  MEETING_HISTORY_PAGE_SIZE,
  MEETINGS_TABLE,
  appDateOf,
  carryoverFor,
  type ActivityComparisonCell,
  type ActivitySnapshot,
  type ActivityWeekResult,
  revisionColumn,
  type CommitmentReview,
  type DraftConflictBody,
  type GoldListDiscussionNote,
  type LegacyCarryoverCommitment,
  type MeetingCommitment,
  type MeetingCommitmentWithOrigin,
  type MeetingHistoryItem,
  type MeetingRecord,
  type MeetingTextField,
  type GoalChange,
  type OneOnOneMeeting,
  type OneOnOneWorkspace,
  type PreviousMeetingSummary,
  type WorkspaceGoldListAgent,
} from "@/lib/one-on-one-meetings";
import {
  WEEKLY_FOCUS_COMMITMENTS_TABLE,
  WEEKLY_FOCUS_TABLE,
  type WeeklyFocusCommitment,
} from "@/lib/one-on-ones";
import { buildSingleAeActivityWeek } from "@/lib/server/activity-report";
import {
  ApiError,
  notFound,
  type AuthedSalesperson,
} from "@/lib/server/auth";
import { fetchAeWeeklyGoals } from "@/lib/server/coaching";
import {
  AGENT_COLUMNS,
  allGoldListRows,
  decorateAgents,
  isUniqueViolation,
  loadActivitySummaries,
} from "@/lib/server/gold-list";
import { GOLD_LIST_ACTIVITIES_TABLE } from "@/lib/gold-list";
import { requireVisibleSalesperson } from "@/lib/server/roster";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Postgres check_violation — what the freeze triggers raise. */
const CHECK_VIOLATION = "23514";

export const MEETING_READ_ONLY_MESSAGE =
  "This 1:1 is completed and read-only.";

function denverDate(asOf: Date): string {
  return format(asOf, "yyyy-MM-dd");
}

// ---------------------------------------------------------------------------
// Meeting lookup + lifecycle
// ---------------------------------------------------------------------------

export async function findInProgressMeeting(
  supabase: Db,
  aeId: string,
): Promise<OneOnOneMeeting | null> {
  const res = await supabase
    .from(MEETINGS_TABLE)
    .select("*")
    .eq("ae_id", aeId)
    .eq("status", "in_progress")
    .maybeSingle();
  if (res.error) {
    throw new ApiError(500, `Could not load the current 1:1: ${res.error.message}`);
  }
  return (res.data as OneOnOneMeeting | null) ?? null;
}

/**
 * "Start 1:1": returns the AE's in-progress meeting, creating it only when
 * none exists. The partial unique index
 * (idx_one_on_one_meetings_one_in_progress) makes this race-safe — a
 * concurrent second insert fails with 23505 and we return the winner — so a
 * double tap or a refresh can never fork a second draft.
 */
export async function startOrResumeMeeting(
  supabase: Db,
  ae: { id: string; first_name: string },
  manager: AuthedSalesperson,
  asOf: Date = todayInAppTimezone(),
): Promise<{ meeting: OneOnOneMeeting; created: boolean }> {
  const existing = await findInProgressMeeting(supabase, ae.id);
  if (existing) return { meeting: existing, created: false };

  const res = await supabase
    .from(MEETINGS_TABLE)
    .insert({
      ae_id: ae.id,
      manager_id: manager.id,
      ae_name: ae.first_name,
      manager_name: manager.first_name,
      meeting_date: denverDate(asOf),
      status: "in_progress",
    })
    .select("*")
    .single();
  if (res.data) return { meeting: res.data as OneOnOneMeeting, created: true };

  if (isUniqueViolation(res.error)) {
    const winner = await findInProgressMeeting(supabase, ae.id);
    if (winner) return { meeting: winner, created: false };
  }
  throw new ApiError(
    500,
    `Could not start the 1:1: ${res.error?.message ?? "unknown error"}`,
  );
}

async function loadMeeting(
  supabase: Db,
  meetingId: string,
): Promise<OneOnOneMeeting> {
  const res = await supabase
    .from(MEETINGS_TABLE)
    .select("*")
    .eq("id", meetingId)
    .maybeSingle();
  if (res.error) {
    throw new ApiError(500, `Could not load that 1:1: ${res.error.message}`);
  }
  if (!res.data) throw notFound("1:1 not found.");
  return res.data as OneOnOneMeeting;
}

/**
 * Loads a meeting for `viewer` (the signed-in admin). A meeting whose AE is a
 * private test account the viewer doesn't own is a 404, exactly like a
 * meeting that doesn't exist — every /one-on-one-meetings/[id] route goes
 * through here, so a meeting id can't be used to reach someone else's test
 * AE.
 */
export async function requireMeeting(
  supabase: Db,
  meetingId: string,
  viewer: { id: string },
): Promise<OneOnOneMeeting> {
  const meeting = await loadMeeting(supabase, meetingId);
  await requireVisibleSalesperson(supabase, viewer, meeting.ae_id, "1:1 not found.");
  return meeting;
}

/** Writes are only allowed while a meeting is in progress. */
export function assertInProgress(meeting: OneOnOneMeeting): void {
  if (meeting.status !== "in_progress") {
    throw new ApiError(409, MEETING_READ_ONLY_MESSAGE);
  }
}

/**
 * A draft save based on a stale revision — another tab/device saved newer
 * text for the same field. Routes answer 409 with the stored value so
 * nothing is silently overwritten (see toConflictResponse).
 */
export class DraftRevisionConflict extends Error {
  constructor(
    readonly value: string | null,
    readonly revision: number,
  ) {
    super("This was changed in another tab or device.");
    this.name = "DraftRevisionConflict";
  }
}

/**
 * Regenerating the follow-up email replaces subject AND body together, so a
 * stale save names both revisions; either one having moved on (another tab
 * edited the email) refuses the whole replacement and reports both.
 */
export class FollowupRevisionConflict extends Error {
  constructor(
    readonly subject: { value: string | null; revision: number },
    readonly body: { value: string | null; revision: number },
  ) {
    super("The email was changed in another tab or device.");
    this.name = "FollowupRevisionConflict";
  }
}

/** 409 body for a DraftRevisionConflict, or null for any other error. */
export function toConflictResponse(err: unknown): Response | null {
  if (err instanceof FollowupRevisionConflict) {
    return Response.json(
      {
        error: err.message,
        followup_conflict: { subject: err.subject, body: err.body },
      },
      { status: 409 },
    );
  }
  if (!(err instanceof DraftRevisionConflict)) return null;
  const body: DraftConflictBody = {
    error: err.message,
    conflict: { value: err.value, revision: err.revision },
  };
  return Response.json(body, { status: 409 });
}

/**
 * Saves one draft text field IF its revision is still `expected`; returns
 * the updated meeting (revision + 1). The compare-and-set is one UPDATE, so
 * two tabs can't both win. Other fields are untouched and never conflict.
 */
export async function saveMeetingField(
  supabase: Db,
  meetingId: string,
  field: MeetingTextField,
  value: string | null,
  expected: number,
): Promise<OneOnOneMeeting> {
  const rev = revisionColumn(field);
  const res = await supabase
    .from(MEETINGS_TABLE)
    .update({ [field]: value || null, [rev]: expected + 1 })
    .eq("id", meetingId)
    .eq("status", "in_progress")
    .eq(rev, expected)
    .select("*")
    .maybeSingle();
  throwIfFrozen(res.error);
  if (res.error) {
    throw new ApiError(500, `Could not save the 1:1: ${res.error.message}`);
  }
  if (res.data) return res.data as OneOnOneMeeting;
  // Nothing matched: completed, or a newer save exists. Say which.
  const now = await loadMeeting(supabase, meetingId);
  assertInProgress(now);
  throw new DraftRevisionConflict(now[field], now[rev]);
}

/** Postgres lock_not_available — the meeting lock is held by completion. */
const LOCK_NOT_AVAILABLE = "55P03";

export const MEETING_COMPLETING_MESSAGE =
  "This 1:1 is being completed right now.";

/**
 * Maps the database's refusal of a meeting-scoped write to a 409:
 *   * 23514 — the meeting is completed (freeze / lock triggers);
 *   * 55P03 — completion holds the meeting lock this very moment
 *             (lock_open_one_on_one_meeting uses NOWAIT).
 */
export function throwIfFrozen(error: { code?: string | null } | null): void {
  if (error?.code === CHECK_VIOLATION) {
    throw new ApiError(409, MEETING_READ_ONLY_MESSAGE);
  }
  if (error?.code === LOCK_NOT_AVAILABLE) {
    throw new ApiError(409, MEETING_COMPLETING_MESSAGE);
  }
}

/**
 * The Gold List agent a manager may act on from inside `meeting`: it must
 * belong to the meeting's AE. Anything else — another AE's agent, a typo'd
 * id — is a 404, indistinguishable from "doesn't exist".
 */
export async function requireManagedAgent(
  supabase: Db,
  meeting: OneOnOneMeeting,
  agentId: string,
): Promise<GoldListAgent> {
  const res = await supabase
    .from(GOLD_LIST_AGENTS_TABLE)
    .select(AGENT_COLUMNS)
    .eq("id", agentId)
    .eq("salesperson_id", meeting.ae_id)
    .maybeSingle();
  if (res.error) {
    throw new ApiError(500, "Could not load that Gold List agent.");
  }
  if (!res.data) throw notFound("Gold List agent not found.");
  return res.data as GoldListAgent;
}

// ---------------------------------------------------------------------------
// Activity & Results
// ---------------------------------------------------------------------------

/**
 * The two weeks a 1:1 compares, anchored exactly like the leaderboard and the
 * coaching trend (recentWeekRanges): "this week" is the business Monday paired
 * with the current Sun-Sat activity week, "last week" the one before it. Each
 * week's goal is resolved AS OF its own Monday.
 */
export function comparisonWeeks(asOf: Date = todayInAppTimezone()): {
  today: string;
  last: { since: string; through: string; goalAsOf: string };
  this: { since: string; through: string; goalAsOf: string };
} {
  const today = denverDate(asOf);
  const thisMonday = pairedBusinessMonday(asOf);
  const lastMonday = format(addDays(parseISO(thisMonday), -7), "yyyy-MM-dd");
  const window = (monday: string) => {
    const friday = format(addDays(parseISO(monday), 4), "yyyy-MM-dd");
    return {
      since: monday,
      through: friday < today ? friday : today,
      goalAsOf: monday,
    };
  };
  return { today, last: window(lastMonday), this: window(thisMonday) };
}

function emptyCells(): Record<ActivityKey, ActivityComparisonCell> {
  const cells = {} as Record<ActivityKey, ActivityComparisonCell>;
  for (const a of ACTIVITIES) {
    cells[a.key] = { actual: 0, goal: 0, original_goal: 0, percent: null };
  }
  return cells;
}

async function weekResult(
  supabase: Db,
  aeId: string,
  week: { since: string; through: string; goalAsOf: string },
  today: string,
): Promise<ActivityWeekResult> {
  // One AE's row, scored by the SAME scoreActivityWeek() the team activity
  // report (and, via adjustedWeekScore, the leaderboard) uses. Reading just
  // this AE means a private test account gets real numbers on its own 1:1
  // without ever being added to a team report.
  const report = await buildSingleAeActivityWeek(
    supabase,
    { id: aeId, first_name: "" },
    week.since,
    week.through,
    week.goalAsOf,
    today,
  );
  if (report.error) throw new ApiError(500, report.error);
  const row = report.row;
  const activity = activityWindowForBusinessWeek(week.since, today);
  return {
    week_start: week.since,
    activity_since: activity.since,
    activity_through: activity.through,
    score: row?.score ?? null,
    available_days: row?.available_days ?? 5,
    is_holiday_week: row?.is_holiday_week ?? false,
    cells: row ? { ...row.cells } : emptyCells(),
  };
}

/** Last Week vs This Week for one AE, as of `asOf`. */
export async function buildActivityComparison(
  supabase: Db,
  aeId: string,
  asOf: Date = todayInAppTimezone(),
): Promise<ActivitySnapshot> {
  const weeks = comparisonWeeks(asOf);
  const [last, current] = await Promise.all([
    weekResult(supabase, aeId, weeks.last, weeks.today),
    weekResult(supabase, aeId, weeks.this, weeks.today),
  ]);
  return {
    version: 1,
    computed_at: new Date().toISOString(),
    last_week: last,
    this_week: current,
  };
}

// ---------------------------------------------------------------------------
// Commitments
// ---------------------------------------------------------------------------

async function loadAeCommitments(
  supabase: Db,
  aeId: string,
): Promise<MeetingCommitment[]> {
  const res = await supabase
    .from(MEETING_COMMITMENTS_TABLE)
    .select("*")
    .eq("ae_id", aeId)
    .order("created_at", { ascending: true });
  if (res.error) {
    throw new ApiError(500, `Could not load commitments: ${res.error.message}`);
  }
  return (res.data ?? []) as MeetingCommitment[];
}

async function meetingDatesById(
  supabase: Db,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const res = await supabase
    .from(MEETINGS_TABLE)
    .select("id, meeting_date")
    .in("id", ids as string[]);
  if (res.error) {
    throw new ApiError(500, `Could not load 1:1 dates: ${res.error.message}`);
  }
  for (const row of (res.data ?? []) as Array<{ id: string; meeting_date: string }>) {
    out.set(row.id, row.meeting_date);
  }
  return out;
}

function withOrigin(
  commitments: readonly MeetingCommitment[],
  dates: Map<string, string>,
): MeetingCommitmentWithOrigin[] {
  return commitments.map((c) => ({
    ...c,
    origin_meeting_date: dates.get(c.origin_meeting_id) ?? null,
  }));
}

/** Legacy Weekly Focus commitments still open — carryover in the next 1:1. */
async function loadLegacyCarryover(
  supabase: Db,
  aeId: string,
): Promise<LegacyCarryoverCommitment[]> {
  const res = await supabase
    .from(WEEKLY_FOCUS_COMMITMENTS_TABLE)
    .select("*")
    .eq("ae_id", aeId)
    .eq("status", "open")
    .order("created_at", { ascending: true });
  if (res.error) {
    throw new ApiError(
      500,
      `Could not load Weekly Focus commitments: ${res.error.message}`,
    );
  }
  const rows = (res.data ?? []) as WeeklyFocusCommitment[];
  if (rows.length === 0) return [];
  const weeks = await supabase
    .from(WEEKLY_FOCUS_TABLE)
    .select("id, week_start")
    .in("id", [...new Set(rows.map((r) => r.one_on_one_id))]);
  const weekById = new Map<string, string>();
  if (!weeks.error) {
    for (const w of (weeks.data ?? []) as Array<{ id: string; week_start: string }>) {
      weekById.set(w.id, w.week_start);
    }
  }
  return rows.map((r) => ({
    ...r,
    source_week_start: weekById.get(r.one_on_one_id) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Gold List
// ---------------------------------------------------------------------------

/** Most recent completed activity per agent (description + Denver date). */
function lastCompletedByAgent(
  activities: readonly GoldListActivitySummary[],
): Map<string, { description: string; completed_on: string }> {
  const best = new Map<string, GoldListActivitySummary>();
  for (const a of activities) {
    if (a.status !== "completed" || !a.completed_at) continue;
    const prev = best.get(a.agent_id);
    if (!prev || (prev.completed_at ?? "") < a.completed_at) best.set(a.agent_id, a);
  }
  const out = new Map<string, { description: string; completed_on: string }>();
  for (const [agentId, a] of best) {
    out.set(agentId, {
      description: a.description,
      completed_on: appDateOf(a.completed_at!),
    });
  }
  return out;
}

/**
 * The AE's live Gold List, decorated the same way /gold-list decorates it,
 * plus the last completed activity. `can_edit` is re-derived for the MANAGER:
 * true only while a 1:1 is in progress (the only context in which the
 * manager routes accept writes).
 */
export async function loadWorkspaceGoldList(
  supabase: Db,
  agents: GoldListAgent[],
  me: AuthedSalesperson,
  canEdit: boolean,
): Promise<WorkspaceGoldListAgent[]> {
  if (agents.length === 0) return [];
  const summaries = await loadActivitySummaries(
    supabase,
    agents.map((a) => a.id),
    me,
  );
  const decorated = await decorateAgents(supabase, agents, me, summaries);
  const last = lastCompletedByAgent(summaries);
  return decorated.map((a) => ({
    ...a,
    can_edit: canEdit && a.archived_at === null,
    last_completed: last.get(a.id) ?? null,
  }));
}

async function loadActiveAgents(
  supabase: Db,
  aeId: string,
): Promise<GoldListAgent[]> {
  const res = await allGoldListRows<GoldListAgent>(
    supabase
      .from(GOLD_LIST_AGENTS_TABLE)
      .select(AGENT_COLUMNS)
      .eq("salesperson_id", aeId)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .order("id"),
  );
  if (res.error) throw new ApiError(500, "Could not load the Gold List.");
  return res.data;
}

export async function loadMeetingNotes(
  supabase: Db,
  meetingId: string,
): Promise<GoldListDiscussionNote[]> {
  const res = await supabase
    .from(MEETING_GOLD_LIST_NOTES_TABLE)
    .select("*")
    .eq("meeting_id", meetingId)
    .order("agent_name", { ascending: true });
  if (res.error) {
    throw new ApiError(500, `Could not load Gold List notes: ${res.error.message}`);
  }
  return (res.data ?? []) as GoldListDiscussionNote[];
}

/**
 * Saves the manager's 1:1 discussion note about one agent (creating the row
 * on first save). Gold List ACTIONS are not recorded here — they carry their
 * own explicit meeting attribution on the activity row itself.
 */
export async function saveGoldListDiscussionNote(
  supabase: Db,
  meeting: OneOnOneMeeting,
  agent: GoldListAgent,
  note: string | null,
  expected: number,
): Promise<GoldListDiscussionNote> {
  // Revision 0 = "no row yet": insert (never upsert — a row another tab just
  // created must be a conflict, not overwritten). Otherwise compare-and-set.
  const res =
    expected === 0
      ? await supabase
          .from(MEETING_GOLD_LIST_NOTES_TABLE)
          .insert({
            meeting_id: meeting.id,
            ae_id: meeting.ae_id,
            agent_id: agent.id,
            agent_name: agent.agent_name,
            brokerage: agent.brokerage,
            note: note || null,
            revision: 1,
          })
          .select("*")
          .maybeSingle()
      : await supabase
          .from(MEETING_GOLD_LIST_NOTES_TABLE)
          .update({ note: note || null, revision: expected + 1 })
          .eq("meeting_id", meeting.id)
          .eq("agent_id", agent.id)
          .eq("revision", expected)
          .select("*")
          .maybeSingle();
  throwIfFrozen(res.error);
  if (res.error && !isUniqueViolation(res.error)) {
    throw new ApiError(500, `Could not save the Gold List note: ${res.error.message}`);
  }
  if (res.data) return res.data as GoldListDiscussionNote;

  const current = await supabase
    .from(MEETING_GOLD_LIST_NOTES_TABLE)
    .select("note, revision")
    .eq("meeting_id", meeting.id)
    .eq("agent_id", agent.id)
    .maybeSingle();
  if (current.error) {
    throw new ApiError(500, `Could not load the Gold List note: ${current.error.message}`);
  }
  const row = current.data as { note: string | null; revision: number } | null;
  throw new DraftRevisionConflict(row?.note ?? null, row?.revision ?? 0);
}

/** Agents with a Gold List action explicitly attributed to `meetingId`. */
async function loadActionAgentIds(
  supabase: Db,
  meetingId: string,
): Promise<string[]> {
  const res = await supabase
    .from(GOLD_LIST_ACTIVITIES_TABLE)
    .select("agent_id")
    .or(
      `created_in_meeting_id.eq.${meetingId},closed_in_meeting_id.eq.${meetingId},rescheduled_in_meeting_id.eq.${meetingId}`,
    );
  if (res.error) {
    throw new ApiError(500, `Could not load 1:1 Gold List actions: ${res.error.message}`);
  }
  return [...new Set((res.data ?? []).map((r: { agent_id: string }) => r.agent_id))];
}

/** First non-empty line of the 1:1 Notes, trimmed for a one-line preview. */
export function notesPreview(notes: string | null): string | null {
  const line = (notes ?? "").split("\n").map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

/**
 * The shareable subset of a completed meeting the workspace shows as "From
 * last 1:1". Built FIELD BY FIELD from an allowlist so the private manager
 * notes (or any column added to the meeting later) can never ride along on
 * a meeting row spread into this payload.
 */
export function toPreviousMeeting(m: OneOnOneMeeting): PreviousMeetingSummary {
  return {
    id: m.id,
    meeting_date: m.meeting_date,
    completed_at: m.completed_at,
    coaching_focus: m.coaching_focus,
    coaching_notes: m.coaching_notes,
  };
}

/** Agents ADDED to / EDITED on the live Gold List from this 1:1. */
async function loadAgentAttribution(
  supabase: Db,
  meetingId: string,
): Promise<{ added: string[]; edited: string[] }> {
  const res = await supabase
    .from(GOLD_LIST_AGENTS_TABLE)
    .select("id, created_in_meeting_id, edited_in_meeting_id")
    .or(`created_in_meeting_id.eq.${meetingId},edited_in_meeting_id.eq.${meetingId}`);
  if (res.error) {
    throw new ApiError(500, `Could not load 1:1 Gold List agents: ${res.error.message}`);
  }
  const rows = (res.data ?? []) as Array<{
    id: string;
    created_in_meeting_id: string | null;
    edited_in_meeting_id: string | null;
  }>;
  return {
    added: rows.filter((r) => r.created_in_meeting_id === meetingId).map((r) => r.id),
    edited: rows.filter((r) => r.edited_in_meeting_id === meetingId).map((r) => r.id),
  };
}

/**
 * Completed meetings for the history list, newest first, keyset-paged on the
 * composite (completed_at, id) — deterministic even when several meetings
 * share a completed_at, so nothing is skipped or repeated between pages.
 * `before` is the last item of the previous page.
 */
export async function loadMeetingHistory(
  supabase: Db,
  aeId: string,
  before: { completed_at: string; id: string } | null = null,
  limit: number = MEETING_HISTORY_PAGE_SIZE,
): Promise<{ items: MeetingHistoryItem[]; has_more: boolean }> {
  let query = supabase
    .from(MEETINGS_TABLE)
    // Explicit columns: the 1:1 Notes (for a one-line preview) but NEVER
    // private_notes.
    .select("id, meeting_date, completed_at, coaching_focus, coaching_notes, manager_name")
    .eq("ae_id", aeId)
    .eq("status", "completed");
  if (before) {
    // (completed_at, id) < (cursor): older, or same instant with a lower id.
    // Values are double-quoted: timestamps contain PostgREST's reserved ":".
    const ts = `"${before.completed_at}"`;
    query = query.or(
      `completed_at.lt.${ts},and(completed_at.eq.${ts},id.lt.${before.id})`,
    );
  }
  const res = await query
    .order("completed_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (res.error) {
    throw new ApiError(500, `Could not load 1:1 history: ${res.error.message}`);
  }
  const rows = (res.data ?? []) as Array<
    Omit<MeetingHistoryItem, "notes_preview"> & { coaching_notes: string | null }
  >;
  const items: MeetingHistoryItem[] = rows.slice(0, limit).map((r) => ({
    id: r.id,
    meeting_date: r.meeting_date,
    completed_at: r.completed_at,
    coaching_focus: r.coaching_focus,
    notes_preview: notesPreview(r.coaching_notes),
    manager_name: r.manager_name,
  }));
  return { items, has_more: rows.length > limit };
}

// ---------------------------------------------------------------------------
// Workspace + record reads
// ---------------------------------------------------------------------------

export async function loadWorkspace(
  supabase: Db,
  ae: { id: string; first_name: string },
  me: AuthedSalesperson,
  asOf: Date = todayInAppTimezone(),
): Promise<OneOnOneWorkspace> {
  const [
    meeting,
    history,
    commitments,
    legacy,
    goals,
    activity,
    agents,
  ] = await Promise.all([
    findInProgressMeeting(supabase, ae.id),
    loadMeetingHistory(supabase, ae.id),
    loadAeCommitments(supabase, ae.id),
    loadLegacyCarryover(supabase, ae.id),
    fetchAeWeeklyGoals(supabase, ae.id, asOf),
    buildActivityComparison(supabase, ae.id, asOf),
    loadActiveAgents(supabase, ae.id),
  ]);
  const [lastMeeting, notes, actionAgentIds, attribution, goldList] = await Promise.all([
    history.items[0]
      ? loadMeeting(supabase, history.items[0].id)
      : Promise.resolve(null),
    meeting ? loadMeetingNotes(supabase, meeting.id) : Promise.resolve([]),
    meeting ? loadActionAgentIds(supabase, meeting.id) : Promise.resolve([]),
    meeting
      ? loadAgentAttribution(supabase, meeting.id)
      : Promise.resolve({ added: [], edited: [] }),
    loadWorkspaceGoldList(supabase, agents, me, meeting !== null),
  ]);

  const dates = await meetingDatesById(supabase, [
    ...new Set(commitments.map((c) => c.origin_meeting_id)),
  ]);
  const carryover = withOrigin(
    carryoverFor(commitments, meeting?.id ?? null),
    dates,
  ).sort((a, b) =>
    (b.origin_meeting_date ?? "").localeCompare(a.origin_meeting_date ?? ""),
  );

  return {
    ae: { id: ae.id, first_name: ae.first_name },
    today: denverDate(asOf),
    meeting,
    last_completed: lastMeeting
      ? {
          // Allowlisted fields only — never the previous meeting's private notes.
          meeting: toPreviousMeeting(lastMeeting),
          commitments: commitments.filter(
            (c) => c.origin_meeting_id === lastMeeting.id && c.status !== "dropped",
          ),
        }
      : null,
    history: history.items,
    history_has_more: history.has_more,
    activity,
    gold_list: goldList,
    gold_list_notes: notes,
    gold_list_action_agent_ids: [
      ...new Set([...actionAgentIds, ...attribution.added, ...attribution.edited]),
    ],
    gold_list_added_agent_ids: attribution.added,
    gold_list_edited_agent_ids: attribution.edited,
    // Filled in by the workspace route (followup-context.ts), which owns the
    // shareable-content fingerprint.
    followup_stale: false,
    carryover,
    legacy_carryover: legacy,
    new_commitments: meeting
      ? commitments.filter((c) => c.origin_meeting_id === meeting.id)
      : [],
    weekly_goal_current: goals.current,
    weekly_goal_next_override: goals.nextOverride,
    next_week_start: goals.nextMonday,
  };
}

export async function loadMeetingRecord(
  supabase: Db,
  meeting: OneOnOneMeeting,
): Promise<MeetingRecord> {
  const [notes, reviewsRes] = await Promise.all([
    loadMeetingNotes(supabase, meeting.id),
    supabase
      .from(MEETING_COMMITMENT_REVIEWS_TABLE)
      .select("*")
      .eq("meeting_id", meeting.id)
      .order("sort_order", { ascending: true }),
  ]);
  if (reviewsRes.error) {
    throw new ApiError(500, `Could not load commitments: ${reviewsRes.error.message}`);
  }
  return {
    meeting,
    gold_list_notes: notes,
    commitment_reviews: (reviewsRes.data ?? []) as CommitmentReview[],
  };
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/**
 * Completes `meeting`, freezing what was reviewed.
 *
 * The Last Week / This Week comparison is computed here, from LIVE activity
 * and goals (the same per-AE activity-report scoring the workspace shows) — that's
 * not meeting-scoped data. Everything meeting-scoped — Gold List discussion
 * snapshots, attributed Gold List actions, commitment reviews — plus the
 * status flip happens inside complete_one_on_one_meeting(), ONE transaction
 * holding FOR UPDATE on the meeting row. A failure anywhere rolls the whole
 * thing back to an ordinary, retryable draft.
 *
 * Idempotent: completing an already-completed meeting returns it unchanged
 * (so a retry after a lost response succeeds instead of erroring).
 *
 * GOAL-CHANGE ORDERING. The comparison is computed here, BEFORE the function
 * takes the meeting lock, so a goal change made from this 1:1 could land in
 * between (it commits the live goal + the meeting's history together, see
 * updateGoalInMeeting). Each attempt therefore reads how many goal changes the
 * meeting holds BEFORE computing the snapshot and passes that count to the
 * function, which re-checks it under the lock and raises 40001 if it moved.
 * On 40001 the snapshot is recomputed against the new goals and the attempt
 * repeats, so a completed meeting can never hold history for a goal its frozen
 * comparison did not use.
 */
export async function completeMeeting(
  supabase: Db,
  meeting: OneOnOneMeeting,
  me: AuthedSalesperson,
  asOf: Date = todayInAppTimezone(),
): Promise<OneOnOneMeeting> {
  if (meeting.status === "completed") return meeting;
  for (let attempt = 1; attempt <= COMPLETION_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const current = await loadMeeting(supabase, meeting.id);
    // A concurrent completion already finished: its record, unchanged.
    if (current.status === "completed") return current;
    const goalChangesSeen = (current.goal_changes ?? []).length;
    const activity = await buildActivityComparison(supabase, meeting.ae_id, asOf);
    const res = await supabase.rpc("complete_one_on_one_meeting", {
      p_meeting_id: meeting.id,
      p_completed_by: me.id,
      p_activity_snapshot: activity,
      p_goal_changes_seen: goalChangesSeen,
    });
    if (res.error) {
      // A goal change landed after the count was read: recompute and retry.
      if (res.error.code === SERIALIZATION_FAILURE) continue;
      if (res.error.code === "P0002") throw notFound("1:1 not found.");
      throwIfFrozen(res.error);
      throw new ApiError(500, `Could not complete the 1:1: ${res.error.message}`);
    }
    const done = res.data as OneOnOneMeeting | null;
    if (!done || done.status !== "completed") {
      throw new ApiError(500, "Could not complete the 1:1.");
    }
    // If a concurrent completion won the lock, this is its (unchanged) record.
    return done;
  }
  throw new ApiError(
    409,
    "Goals were changed while the 1:1 was being completed. Please try completing again.",
  );
}

/** A goal change landed after completion read the meeting's goal history. */
const SERIALIZATION_FAILURE = "40001";
const COMPLETION_SNAPSHOT_ATTEMPTS = 4;

// ---------------------------------------------------------------------------
// Goal changes + generated follow-up email
// ---------------------------------------------------------------------------

/**
 * Writes an AE's weekly goal FROM an in-progress 1:1: the live weekly_goals
 * row and the meeting's goal-change history commit together, in ONE database
 * transaction (update_weekly_goal_in_one_on_one), after taking the meeting
 * lock — so completion either waits for this (and snapshots it) or this is
 * refused outright.
 *
 * It never degrades to "saved but not recorded": every refusal THROWS and the
 * transaction has already rolled the live goal back —
 *   * 23514 — the meeting is completed, or isn't this AE's  -> 409
 *   * 55P03 — completion holds the meeting this very moment  -> 409
 *   * 23503 — no such meeting                                -> 404
 *   * 23505 — a concurrent save claimed this Monday first    -> 409
 */
export async function updateGoalInMeeting(
  supabase: Db,
  args: {
    meetingId: string;
    aeId: string;
    start: GoalChange["start"];
    effectiveFrom: string;
    values: Record<string, number>;
    createdBy: string;
  },
): Promise<OneOnOneMeeting> {
  const res = await supabase.rpc("update_weekly_goal_in_one_on_one", {
    p_meeting_id: args.meetingId,
    p_ae_id: args.aeId,
    p_start: args.start,
    p_effective_from: args.effectiveFrom,
    p_values: args.values,
    p_created_by: args.createdBy,
  });
  if (res.error) {
    throwIfFrozen(res.error);
    if (res.error.code === "23503") throw notFound("1:1 not found.");
    if (isUniqueViolation(res.error)) {
      throw new ApiError(
        409,
        "Another save just landed for this week. Reload and try again.",
      );
    }
    throw new ApiError(500, `Could not save goals: ${res.error.message}`);
  }
  const meeting = res.data as OneOnOneMeeting | null;
  if (!meeting) throw new ApiError(500, "Could not save goals.");
  return meeting;
}

/**
 * The follow-up email is the ONE thing still writable on a COMPLETED 1:1 (the
 * rest of the record is frozen by the database; see
 * supabase/one_on_one_followup_v2_1.sql). Both writers below touch ONLY the
 * email columns, so even a bug here could not reach anything else — and the
 * freeze trigger would refuse it if it tried.
 */

export const FOLLOWUP_COMPLETED_WHILE_WRITING_MESSAGE =
  "This 1:1 was completed while the email was being written. Generate it again from the completed record.";

/**
 * Stores a freshly GENERATED follow-up email: subject + body replaced
 * together (each revision + 1), with the generation metadata, in ONE
 * compare-and-set UPDATE. It lands only if both revisions are still the ones
 * the client saw — so a regeneration can never overwrite an edit made in
 * another tab — AND the meeting is still in `expectedStatus`, the state its
 * context was built from. A generation built from LIVE data (in progress)
 * therefore can't land on a meeting that completed meanwhile (its content would
 * no longer match the frozen record); the manager regenerates from the record.
 * Works on in-progress and completed meetings alike; nothing else is written.
 */
export async function saveGeneratedFollowup(
  supabase: Db,
  meetingId: string,
  generated: { subject: string; body: string; model: string; contextHash: string },
  expected: { subject: number; body: number },
  expectedStatus: OneOnOneMeeting["status"] = "in_progress",
): Promise<OneOnOneMeeting> {
  const res = await supabase
    .from(MEETINGS_TABLE)
    .update({
      followup_subject: generated.subject,
      followup_body: generated.body,
      followup_subject_rev: expected.subject + 1,
      followup_body_rev: expected.body + 1,
      followup_generated_at: new Date().toISOString(),
      followup_context_hash: generated.contextHash,
      followup_model: generated.model,
    })
    .eq("id", meetingId)
    .eq("status", expectedStatus)
    .eq("followup_subject_rev", expected.subject)
    .eq("followup_body_rev", expected.body)
    .select("*")
    .maybeSingle();
  throwIfFrozen(res.error);
  if (res.error) {
    throw new ApiError(500, `Could not save the email: ${res.error.message}`);
  }
  if (res.data) return res.data as OneOnOneMeeting;
  const now = await loadMeeting(supabase, meetingId);
  if (now.status !== expectedStatus) {
    throw new ApiError(409, FOLLOWUP_COMPLETED_WHILE_WRITING_MESSAGE);
  }
  throw new FollowupRevisionConflict(
    { value: now.followup_subject, revision: now.followup_subject_rev },
    { value: now.followup_body, revision: now.followup_body_rev },
  );
}

/**
 * Saves a MANUALLY edited follow-up email (subject + body together) on an
 * in-progress OR completed 1:1, in ONE compare-and-set UPDATE on both email
 * revisions: a save based on a stale view (another tab saved, or a generation
 * landed) matches no row and gets the current text back as a
 * FollowupRevisionConflict instead of overwriting it. Only the email text and
 * its revisions are written — never the generation metadata, the status,
 * timestamps or any other column.
 */
export async function saveFollowupEmail(
  supabase: Db,
  meetingId: string,
  email: { subject: string | null; body: string | null },
  expected: { subject: number; body: number },
): Promise<OneOnOneMeeting> {
  const res = await supabase
    .from(MEETINGS_TABLE)
    .update({
      followup_subject: email.subject?.trim() ? email.subject : null,
      followup_body: email.body?.trim() ? email.body : null,
      followup_subject_rev: expected.subject + 1,
      followup_body_rev: expected.body + 1,
    })
    .eq("id", meetingId)
    .eq("followup_subject_rev", expected.subject)
    .eq("followup_body_rev", expected.body)
    .select("*")
    .maybeSingle();
  throwIfFrozen(res.error);
  if (res.error) {
    throw new ApiError(500, `Could not save the email: ${res.error.message}`);
  }
  if (res.data) return res.data as OneOnOneMeeting;
  const now = await loadMeeting(supabase, meetingId);
  throw new FollowupRevisionConflict(
    { value: now.followup_subject, revision: now.followup_subject_rev },
    { value: now.followup_body, revision: now.followup_body_rev },
  );
}
