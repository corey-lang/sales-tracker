import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError, requireAdmin } from "@/lib/server/auth";
import { buildSnapshots, requireCoachableAe } from "@/lib/server/coaching";
import {
  COACHING_RELATIONSHIPS_TABLE,
  ONE_ON_ONES_TABLE,
  ONE_ON_ONE_COMMITMENTS_TABLE,
  TRAINING_COMMITMENTS_TABLE,
  type CoachingDetail,
  type CoachingRelationship,
  type OneOnOne,
  type OneOnOneCommitment,
  type TrainingCommitment,
} from "@/lib/one-on-ones";

// GET /api/admin/coaching/[ae_id]
//
// Admin-only. Returns the full coaching state for ONE AE:
//   * snapshot (current week % + rank + week totals + 4-week trend)
//   * coaching_relationships (the manager's lens on key relationships)
//   * training_commitments (standing per-AE training assignments)
//   * one_on_ones (newest-first, each with its commitments inline)
//   * previous_commitments (convenience: commitments from the 2nd-most-recent
//     1:1, used to render the "Previous 1:1 Commitments" surface)
//
// Identity always comes from the signed session — `ae_id` is a path
// parameter the manager picks; never trusted as the salesperson identity.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ ae_id: string }> },
) {
  try {
    await requireAdmin(req);
    const { ae_id } = await params;
    const supabase = getServerSupabase();

    // Pin to role='ae' so juice_box_only / assistant / admin ids
    // returning here are treated as not-found rather than silently
    // returning empty coaching state for an unsupported role.
    const ae = await requireCoachableAe(supabase, ae_id);

    const [snapshots, relationshipsRes, trainingRes, oneOnOnesRes, commitmentsRes] =
      await Promise.all([
        buildSnapshots(supabase, [ae.id]),
        supabase
          .from(COACHING_RELATIONSHIPS_TABLE)
          .select("*")
          .eq("ae_id", ae.id)
          .order("updated_at", { ascending: false }),
        supabase
          .from(TRAINING_COMMITMENTS_TABLE)
          .select("*")
          .eq("ae_id", ae.id)
          // Open first, then completed — within each bucket, most recent first.
          .order("completed", { ascending: true })
          .order("updated_at", { ascending: false }),
        supabase
          .from(ONE_ON_ONES_TABLE)
          .select("*")
          .eq("ae_id", ae.id)
          .order("meeting_date", { ascending: false })
          .order("created_at", { ascending: false }),
        supabase
          .from(ONE_ON_ONE_COMMITMENTS_TABLE)
          .select("*")
          .eq("ae_id", ae.id)
          .order("created_at", { ascending: true }),
      ]);

    const firstErr =
      relationshipsRes.error ??
      trainingRes.error ??
      oneOnOnesRes.error ??
      commitmentsRes.error;
    if (firstErr) {
      return Response.json({ error: firstErr.message }, { status: 500 });
    }

    const relationships =
      (relationshipsRes.data ?? []) as CoachingRelationship[];
    const training = (trainingRes.data ?? []) as TrainingCommitment[];
    const meetings = (oneOnOnesRes.data ?? []) as OneOnOne[];
    const allCommitments =
      (commitmentsRes.data ?? []) as OneOnOneCommitment[];

    // Bucket commitments by meeting id. One pass.
    const byMeeting = new Map<string, OneOnOneCommitment[]>();
    for (const c of allCommitments) {
      const bucket = byMeeting.get(c.one_on_one_id) ?? [];
      bucket.push(c);
      byMeeting.set(c.one_on_one_id, bucket);
    }
    const one_on_ones = meetings.map((m) => ({
      ...m,
      commitments: byMeeting.get(m.id) ?? [],
    }));

    // "Previous 1:1 commitments" = commitments from the meeting BEFORE the
    // most recent one. If there's only one meeting (or none), this is empty.
    const previous_commitments =
      meetings.length >= 2 ? byMeeting.get(meetings[1].id) ?? [] : [];

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
            impressions: 0,
            team_meetings: 0,
            gold_list_touches: 0,
            business_cards: 0,
          },
          trend: [],
        } as CoachingDetail["snapshot"]),
      relationships,
      training,
      one_on_ones,
      previous_commitments,
    };
    return Response.json(payload);
  } catch (err) {
    return handleApiError(err);
  }
}
