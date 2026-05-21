import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError, requireAdmin } from "@/lib/server/auth";
import {
  buildSnapshots,
  ensureCurrentWeeklyFocus,
  fetchAeWeeklyGoals,
  requireCoachableAe,
} from "@/lib/server/coaching";
import { mondayOfWeek } from "@/lib/goals";
import {
  ARCHIVED_RELATIONSHIPS_LIMIT,
  COACHING_RELATIONSHIPS_TABLE,
  TRAINING_COMMITMENTS_TABLE,
  WEEKLY_FOCUS_COMMITMENTS_TABLE,
  WEEKLY_FOCUS_HISTORY_LIMIT,
  WEEKLY_FOCUS_PRIVATE_NOTES_TABLE,
  WEEKLY_FOCUS_TABLE,
  type CoachingDetail,
  type CoachingRelationship,
  type TrainingCommitment,
  type WeeklyFocus,
  type WeeklyFocusCommitment,
} from "@/lib/one-on-ones";

// GET /api/admin/coaching/[ae_id]
//
// Admin-only. Returns the full Weekly Focus coaching state for ONE AE:
//   * snapshot (current week % + rank + week totals + 4-week trend)
//   * relationships (persistent Gold List — archived rows excluded)
//   * training (standing per-AE training assignments)
//   * current_week (auto-created Weekly Focus row for the current week,
//     with its own commitments inline)
//   * manager_notes (the manager-only "Manager Notes" pane — fetched
//     from a SEPARATE private-notes table so it's structurally
//     impossible to leak to a future AE-facing route)
//   * carried_commitments (open commitments from prior weeks, surfaced
//     as motivational carryover; excludes completed AND dropped)
//   * history (past Weekly Focus rows newest-first, EXCLUDING the
//     current week; CAPPED to WEEKLY_FOCUS_HISTORY_LIMIT)
//
// Auto-create: the moment a manager opens an AE's coaching surface in a
// new business week, the upsert in `ensureCurrentWeeklyFocus` guarantees
// a current-week row exists. There is no manual "create" flow.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ ae_id: string }> },
) {
  try {
    const me = await requireAdmin(req);
    const { ae_id } = await params;
    const supabase = getServerSupabase();

    // Pin to role='ae' so juice_box_only / assistant / admin ids
    // returning here are treated as not-found rather than silently
    // returning empty coaching state for an unsupported role.
    const ae = await requireCoachableAe(supabase, ae_id);

    // First: make sure the current week's focus row exists. Stamp the
    // signed-in admin as the manager on first creation.
    const currentWeek = await ensureCurrentWeeklyFocus(supabase, ae.id, me.id);
    const currentWeekStart = mondayOfWeek();

    const [
      snapshots,
      relationshipsRes,
      archivedRelationshipsRes,
      trainingRes,
      weeksRes,
      privateNotesRes,
      goalsRes,
    ] = await Promise.all([
      buildSnapshots(supabase, [ae.id]),
      supabase
        .from(COACHING_RELATIONSHIPS_TABLE)
        .select("*")
        // Active (non-archived) relationships only. Archived rows stay
        // queryable for longitudinal context but don't surface in the
        // active Gold List.
        .eq("ae_id", ae.id)
        .is("archived_at", null)
        .order("updated_at", { ascending: false }),
      // Recently-archived relationships, surfaced in the collapsed
      // "Archived" section so the Restore affordance is reachable.
      // Newest archive first; capped to avoid shipping a long tail.
      supabase
        .from(COACHING_RELATIONSHIPS_TABLE)
        .select("*")
        .eq("ae_id", ae.id)
        .not("archived_at", "is", null)
        .order("archived_at", { ascending: false })
        .limit(ARCHIVED_RELATIONSHIPS_LIMIT),
      supabase
        .from(TRAINING_COMMITMENTS_TABLE)
        .select("*")
        .eq("ae_id", ae.id)
        // Open first, then completed — within each bucket, most recent first.
        .order("completed", { ascending: true })
        .order("updated_at", { ascending: false }),
      supabase
        .from(WEEKLY_FOCUS_TABLE)
        .select("*")
        .eq("ae_id", ae.id)
        .order("week_start", { ascending: false })
        .order("created_at", { ascending: false })
        // Current + last N history weeks. The cap is intentional — for an
        // AE with a year of coaching, we don't ship 52 weeks down on every
        // page load. The carryover commitments query below is NOT
        // window-bounded by week (it filters on status='open') so
        // unfinished items from weeks outside the visible window still
        // surface as carryover.
        .limit(WEEKLY_FOCUS_HISTORY_LIMIT + 1),
      // Manager-only notes: pulled from the separate private-notes table.
      // Lives in its own table so AE-facing reads (future) can never
      // accidentally include it — those routes simply will not query
      // this table.
      supabase
        .from(WEEKLY_FOCUS_PRIVATE_NOTES_TABLE)
        .select("notes")
        .eq("weekly_focus_id", currentWeek.id)
        .maybeSingle(),
      // Current + next-week goal resolution, sharing the same goal-row
      // sort the leaderboard uses so progress %s here can never disagree
      // with the leaderboard's.
      fetchAeWeeklyGoals(supabase, ae.id),
    ]);

    const firstErr =
      relationshipsRes.error ??
      archivedRelationshipsRes.error ??
      trainingRes.error ??
      weeksRes.error ??
      // private-notes "no row" is fine (maybeSingle returns null), but
      // a real error should surface
      (privateNotesRes.error && privateNotesRes.error.code !== "PGRST116"
        ? privateNotesRes.error
        : null);
    if (firstErr) {
      return Response.json({ error: firstErr.message }, { status: 500 });
    }

    const relationships =
      (relationshipsRes.data ?? []) as CoachingRelationship[];
    const archived_relationships =
      (archivedRelationshipsRes.data ?? []) as CoachingRelationship[];
    const training = (trainingRes.data ?? []) as TrainingCommitment[];
    const visibleWeeks = (weeksRes.data ?? []) as WeeklyFocus[];

    // Build the visible week id set (current + history window). Used both
    // for the second commitments query AND for filtering history below.
    const visibleWeekIds = new Set<string>();
    for (const w of visibleWeeks) visibleWeekIds.add(w.id);
    visibleWeekIds.add(currentWeek.id);

    // Commitments query — fetch (a) anything attached to a visible week
    // (for the timeline + current week) and (b) anything still open (for
    // carryover, regardless of whether its source week made the history
    // window). One round-trip via an `or` filter.
    const idsList = Array.from(visibleWeekIds).join(",");
    const orFilter = `status.eq.open,one_on_one_id.in.(${idsList})`;
    const commitmentsRes = await supabase
      .from(WEEKLY_FOCUS_COMMITMENTS_TABLE)
      .select("*")
      .eq("ae_id", ae.id)
      .or(orFilter)
      .order("created_at", { ascending: true });
    if (commitmentsRes.error) {
      return Response.json(
        { error: commitmentsRes.error.message },
        { status: 500 },
      );
    }
    const allCommitments =
      (commitmentsRes.data ?? []) as WeeklyFocusCommitment[];

    // Bucket commitments by parent week id.
    const byWeek = new Map<string, WeeklyFocusCommitment[]>();
    for (const c of allCommitments) {
      const bucket = byWeek.get(c.one_on_one_id) ?? [];
      bucket.push(c);
      byWeek.set(c.one_on_one_id, bucket);
    }

    // Map week id -> week_start so carried commitments can carry a label.
    const weekStartById = new Map<string, string>();
    for (const w of visibleWeeks) weekStartById.set(w.id, w.week_start);
    // Current week row may not be in `visibleWeeks` if the upsert just
    // landed; ensure it's known either way.
    weekStartById.set(currentWeek.id, currentWeek.week_start);

    // Carryover = open commitments NOT attached to the current week.
    // `status === 'open'` is the source of truth — `completed` and
    // `dropped` items never carry forward (completed = done, dropped =
    // removed from active focus, both stay in history).
    const carried_commitments: CoachingDetail["carried_commitments"] = [];
    for (const c of allCommitments) {
      if (c.status !== "open") continue;
      if (c.one_on_one_id === currentWeek.id) continue;
      carried_commitments.push({
        ...c,
        source_week_start:
          weekStartById.get(c.one_on_one_id) ?? c.created_at.slice(0, 10),
      });
    }
    // Newest source week first so the manager sees last week's items at the top.
    carried_commitments.sort((a, b) =>
      b.source_week_start.localeCompare(a.source_week_start),
    );

    // History = visibleWeeks minus the current week, capped to the limit.
    const history: CoachingDetail["history"] = visibleWeeks
      .filter(
        (w) =>
          w.id !== currentWeek.id && w.week_start !== currentWeekStart,
      )
      .slice(0, WEEKLY_FOCUS_HISTORY_LIMIT)
      .map((w) => ({ ...w, commitments: byWeek.get(w.id) ?? [] }));

    const payload: CoachingDetail = {
      ae,
      snapshot:
        snapshots.get(ae.id) ??
        ({
          percent: null,
          rank: null,
          total_ranked: 0,
          week_totals: {
            office_visits: 0,
            service_requests: 0,
            ones_scheduled: 0,
            ones_held: 0,
            presentations: 0,
            impressions: 0,
            team_meetings: 0,
            gold_list_touches: 0,
            business_cards: 0,
          },
          trend: [],
        } as CoachingDetail["snapshot"]),
      relationships,
      archived_relationships,
      training,
      weekly_goal_current: goalsRes.current,
      weekly_goal_next_override: goalsRes.nextOverride,
      next_week_start: goalsRes.nextMonday,
      current_week: {
        ...currentWeek,
        commitments: byWeek.get(currentWeek.id) ?? [],
      },
      manager_notes:
        (privateNotesRes.data as { notes: string | null } | null)?.notes ?? null,
      carried_commitments,
      history,
    };
    return Response.json(payload);
  } catch (err) {
    return handleApiError(err);
  }
}
