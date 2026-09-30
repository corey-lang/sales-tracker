// The ONLY place the AE follow-up email's AI input is assembled.
//
// PRIVACY BOUNDARY — PRIVATE MANAGER NOTES NEVER ENTER THIS FILE'S OUTPUT.
//   This is not "we tell the model to ignore them". The private notes are
//   structurally absent from everything that can reach the AI request:
//     1. The meeting is loaded with SHAREABLE_MEETING_COLUMNS — an explicit
//        column list. There is no `select("*")` of the meeting here, so a
//        column added to the table later (or `private_notes`) cannot ride
//        along on a serialized row.
//     2. The context is built FIELD BY FIELD into FollowupContext, a type with
//        no private field; nothing spreads a meeting object into it.
//     3. assertShareable() walks the finished context and throws if any key
//        looks private — a tripwire for a future edit that adds one.
//   The generator (lib/ai/followup-email.ts) accepts only a FollowupContext.
//   Tests assert the exact request body handed to the AI SDK for a meeting
//   whose private notes hold a unique marker.
//
// WHAT IT INCLUDES (shareable meeting content): wins, activity notes, the
// 1:1 Notes, this/last week's activity results, the Gold List discussion and
// actions taken in this 1:1 (agent name/brokerage/notes-from-the-discussion —
// never the agent's phone/email/private CRM notes), commitments, and goal
// changes. Swag Leads will be added here later as another allowed source.
//
// STALENESS
//   `contentHash` fingerprints the MEETING-OWNED part of the context (not live
//   activity numbers, which drift on their own). It is stored with a
//   generated email; when it stops matching, the UI says "Meeting details
//   changed since this email was generated" and offers Regenerate. Editing the
//   private notes cannot change it — they are not part of the context.

import { createHash } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { ACTIVITIES } from "@/lib/activities";
import { todayInAppTimezone } from "@/lib/dates";
import { GOLD_LIST_ACTIVITIES_TABLE, GOLD_LIST_AGENTS_TABLE } from "@/lib/gold-list";
import {
  MEETING_COMMITMENTS_TABLE,
  MEETINGS_TABLE,
  type ActivityWeekResult,
  type GoalChange,
  type MeetingCommitment,
} from "@/lib/one-on-one-meetings";
import { ApiError, notFound } from "@/lib/server/auth";
import {
  buildActivityComparison,
  loadMeetingNotes,
} from "@/lib/server/one-on-one-meetings";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = SupabaseClient<any, any, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * The meeting columns the email may see. EXPLICIT on purpose — see the
 * privacy boundary above. (No private_notes, no email draft, no revisions.)
 */
export const SHAREABLE_MEETING_COLUMNS =
  "id, ae_id, ae_name, manager_name, meeting_date, status, wins, activity_notes, coaching_notes, goal_changes";

type ShareableMeeting = {
  id: string;
  ae_id: string;
  ae_name: string | null;
  manager_name: string | null;
  meeting_date: string;
  status: string;
  wins: string | null;
  activity_notes: string | null;
  coaching_notes: string | null;
  goal_changes: GoldListSafeGoalChange[] | null;
};
type GoldListSafeGoalChange = GoalChange;

export type WeekBrief = {
  week_of: string;
  overall_score_percent: number | null;
  activities: Array<{
    activity: string;
    actual: number;
    goal: number;
    percent_of_goal: number | null;
  }>;
};

export type GoldListBrief = {
  agent: string;
  brokerage: string | null;
  added_to_gold_list_this_1_1: boolean;
  details_updated_this_1_1: boolean;
  /** The manager's discussion note about this agent, if any. */
  discussion: string | null;
  /** Gold List actions taken during this 1:1. */
  actions: Array<{ kind: string; what: string; date: string }>;
  next_activity: { what: string; date: string } | null;
};

export type CommitmentBrief = {
  what: string;
  who: "AE" | "Manager";
  due: string | null;
  status: "open" | "completed" | "dropped";
};

export type FollowupContext = {
  ae_first_name: string;
  manager_first_name: string;
  meeting_date: string;
  wins: string | null;
  activity_notes: string | null;
  one_on_one_notes: string | null;
  activity_results: { last_week: WeekBrief; this_week: WeekBrief };
  gold_list: GoldListBrief[];
  commitments: { made_in_this_1_1: CommitmentBrief[]; carried_over: CommitmentBrief[] };
  goal_changes: Array<{ takes_effect: string; goals: Record<string, number> }>;
};

// ---------------------------------------------------------------------------
// Tripwire
// ---------------------------------------------------------------------------

/** Keys that must never appear anywhere in an AI-bound payload. */
const FORBIDDEN_KEY = /private|secret|admin_pin|password/i;

/** Throws if any key in `value` looks private. Defense in depth, not the boundary. */
export function assertShareable(value: unknown, path = "context"): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertShareable(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(k)) {
        throw new Error(`Refusing to build an AI payload: forbidden key "${path}.${k}".`);
      }
      assertShareable(v, `${path}.${k}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

const ACTIVITY_LABEL = new Map<string, string>(
  ACTIVITIES.map((a) => [a.key, a.label] as const),
);

function weekBrief(week: ActivityWeekResult): WeekBrief {
  return {
    week_of: week.week_start,
    overall_score_percent: week.score,
    activities: Object.entries(week.cells)
      .filter(([, c]) => c.goal > 0 || c.actual > 0)
      .map(([key, c]) => ({
        activity: ACTIVITY_LABEL.get(key) ?? key,
        actual: c.actual,
        goal: c.goal,
        percent_of_goal: c.percent,
      })),
  };
}

function commitmentBrief(c: MeetingCommitment): CommitmentBrief {
  return {
    what: c.description,
    who: c.owner === "ae" ? "AE" : "Manager",
    due: c.due_date,
    status: c.status,
  };
}

type ActionRow = {
  id: string;
  agent_id: string;
  description: string;
  scheduled_for: string;
  status: string;
  completed_at: string | null;
  created_in_meeting_id: string | null;
  closed_in_meeting_id: string | null;
  rescheduled_in_meeting_id: string | null;
};

export async function loadShareableMeeting(
  supabase: Db,
  meetingId: string,
): Promise<ShareableMeeting> {
  const res = await supabase
    .from(MEETINGS_TABLE)
    .select(SHAREABLE_MEETING_COLUMNS)
    .eq("id", meetingId)
    .maybeSingle();
  if (res.error) {
    throw new ApiError(500, `Could not load that 1:1: ${res.error.message}`);
  }
  if (!res.data) throw notFound("1:1 not found.");
  return res.data as unknown as ShareableMeeting;
}

/**
 * Builds the AI-bound context for a meeting plus the fingerprint of its
 * meeting-owned content. Reads only shareable data (see file header).
 */
export async function loadFollowupContext(
  supabase: Db,
  meetingId: string,
  asOf: Date = todayInAppTimezone(),
): Promise<{ context: FollowupContext; contentHash: string }> {
  const meeting = await loadShareableMeeting(supabase, meetingId);

  const [comparison, notes, actions, attributed, commitments] = await Promise.all([
    buildActivityComparison(supabase, meeting.ae_id, asOf),
    loadMeetingNotes(supabase, meeting.id),
    supabase
      .from(GOLD_LIST_ACTIVITIES_TABLE)
      .select(
        "id, agent_id, description, scheduled_for, status, completed_at, created_in_meeting_id, closed_in_meeting_id, rescheduled_in_meeting_id",
      )
      .or(
        `created_in_meeting_id.eq.${meeting.id},closed_in_meeting_id.eq.${meeting.id},rescheduled_in_meeting_id.eq.${meeting.id}`,
      ),
    supabase
      .from(GOLD_LIST_AGENTS_TABLE)
      .select("id, created_in_meeting_id, edited_in_meeting_id")
      .or(`created_in_meeting_id.eq.${meeting.id},edited_in_meeting_id.eq.${meeting.id}`),
    supabase
      .from(MEETING_COMMITMENTS_TABLE)
      .select("*")
      .eq("ae_id", meeting.ae_id)
      .order("created_at", { ascending: true }),
  ]);
  for (const r of [actions, attributed, commitments]) {
    if (r.error) {
      throw new ApiError(500, `Could not load 1:1 details: ${r.error.message}`);
    }
  }

  const actionRows = (actions.data ?? []) as ActionRow[];
  const attribution = (attributed.data ?? []) as Array<{
    id: string;
    created_in_meeting_id: string | null;
    edited_in_meeting_id: string | null;
  }>;
  const noteByAgent = new Map(
    notes.filter((n) => n.agent_id).map((n) => [n.agent_id as string, n]),
  );

  // Agents in play: discussed, acted on, added, or edited in this 1:1.
  const agentIds = [
    ...new Set([
      ...noteByAgent.keys(),
      ...actionRows.map((a) => a.agent_id),
      ...attribution.map((a) => a.id),
    ]),
  ];
  const names = new Map<string, { agent_name: string; brokerage: string | null }>();
  const nextByAgent = new Map<string, { what: string; date: string }>();
  if (agentIds.length > 0) {
    const [agentRes, nextRes] = await Promise.all([
      // Name + brokerage ONLY — never the agent's phone, email or CRM notes.
      supabase.from(GOLD_LIST_AGENTS_TABLE).select("id, agent_name, brokerage").in("id", agentIds),
      supabase
        .from(GOLD_LIST_ACTIVITIES_TABLE)
        .select("agent_id, description, scheduled_for")
        .eq("status", "scheduled")
        .in("agent_id", agentIds),
    ]);
    if (agentRes.error || nextRes.error) {
      throw new ApiError(500, "Could not load the Gold List for the email.");
    }
    for (const a of (agentRes.data ?? []) as Array<{
      id: string;
      agent_name: string;
      brokerage: string | null;
    }>) {
      names.set(a.id, { agent_name: a.agent_name, brokerage: a.brokerage });
    }
    for (const n of (nextRes.data ?? []) as Array<{
      agent_id: string;
      description: string;
      scheduled_for: string;
    }>) {
      nextByAgent.set(n.agent_id, { what: n.description, date: n.scheduled_for });
    }
  }

  const goldList: GoldListBrief[] = agentIds
    .map((id): GoldListBrief => {
      const info = names.get(id);
      const note = noteByAgent.get(id);
      const attr = attribution.find((a) => a.id === id);
      const mine = actionRows.filter((a) => a.agent_id === id);
      const acts: GoldListBrief["actions"] = [];
      for (const a of mine) {
        if (a.created_in_meeting_id === meeting.id) {
          acts.push({ kind: "scheduled", what: a.description, date: a.scheduled_for });
        }
        if (a.closed_in_meeting_id === meeting.id) {
          acts.push({
            kind: a.status === "completed" ? "completed" : "cancelled",
            what: a.description,
            date: a.scheduled_for,
          });
        }
        if (
          a.rescheduled_in_meeting_id === meeting.id &&
          a.created_in_meeting_id !== meeting.id &&
          a.closed_in_meeting_id !== meeting.id
        ) {
          acts.push({ kind: "rescheduled", what: a.description, date: a.scheduled_for });
        }
      }
      return {
        agent: info?.agent_name ?? note?.agent_name ?? "Agent",
        brokerage: info?.brokerage ?? note?.brokerage ?? null,
        added_to_gold_list_this_1_1: attr?.created_in_meeting_id === meeting.id,
        details_updated_this_1_1: attr?.edited_in_meeting_id === meeting.id,
        discussion: note?.note?.trim() || null,
        actions: acts.sort((x, y) => `${x.date}${x.kind}${x.what}`.localeCompare(`${y.date}${y.kind}${y.what}`)),
        next_activity: nextByAgent.get(id) ?? null,
      };
    })
    .sort((x, y) => x.agent.localeCompare(y.agent) || (x.brokerage ?? "").localeCompare(y.brokerage ?? ""));

  const allCommitments = (commitments.data ?? []) as MeetingCommitment[];
  const made = allCommitments
    .filter((c) => c.origin_meeting_id === meeting.id && c.status !== "dropped")
    .map(commitmentBrief);
  const carried = allCommitments
    .filter(
      (c) =>
        c.origin_meeting_id !== meeting.id &&
        (c.status === "open" || c.resolved_in_meeting_id === meeting.id),
    )
    .map(commitmentBrief);

  const context: FollowupContext = {
    ae_first_name: meeting.ae_name ?? "there",
    manager_first_name: meeting.manager_name ?? "your manager",
    meeting_date: meeting.meeting_date,
    wins: meeting.wins?.trim() || null,
    activity_notes: meeting.activity_notes?.trim() || null,
    one_on_one_notes: meeting.coaching_notes?.trim() || null,
    activity_results: {
      last_week: weekBrief(comparison.last_week),
      this_week: weekBrief(comparison.this_week),
    },
    gold_list: goldList,
    commitments: { made_in_this_1_1: made, carried_over: carried },
    goal_changes: (meeting.goal_changes ?? []).map((g) => ({
      takes_effect: g.effective_from,
      goals: g.values,
    })),
  };
  assertShareable(context);

  // Fingerprint of what the MEETING owns. Live numbers (activity results, the
  // agents' next-scheduled dates) are left out: they drift with the AE's own
  // day and would make every email look stale.
  const owned = {
    wins: context.wins,
    activity_notes: context.activity_notes,
    one_on_one_notes: context.one_on_one_notes,
    gold_list: context.gold_list.map(({ next_activity: _n, ...rest }) => {
      void _n;
      return rest;
    }),
    commitments: context.commitments,
    goal_changes: context.goal_changes,
  };
  const contentHash = createHash("sha256").update(JSON.stringify(owned)).digest("hex");
  return { context, contentHash };
}

/** True when a generated email no longer matches the meeting's shareable content. */
export function isFollowupStale(
  stored: { followup_body: string | null; followup_context_hash: string | null },
  currentHash: string,
): boolean {
  if (!stored.followup_body || !stored.followup_context_hash) return false;
  return stored.followup_context_hash !== currentHash;
}
