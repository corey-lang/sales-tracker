import { getServerSupabase } from "@/lib/supabase/server";
import { handleApiError, requireAdmin } from "@/lib/server/auth";
import { requireCoachableAe } from "@/lib/server/coaching";
import {
  ARCHIVED_RELATIONSHIPS_LIMIT,
  COACHING_RELATIONSHIPS_TABLE,
  TRAINING_COMMITMENTS_TABLE,
  WEEKLY_FOCUS_COMMITMENTS_TABLE,
  LEGACY_WEEKS_LIMIT,
  WEEKLY_FOCUS_PRIVATE_NOTES_TABLE,
  WEEKLY_FOCUS_TABLE,
  type CoachingRelationship,
  type LegacyWeeklyFocusDetail,
  type TrainingCommitment,
  type WeeklyFocus,
  type WeeklyFocusCommitment,
} from "@/lib/one-on-ones";

// GET /api/admin/coaching/[ae_id]/legacy  -> LegacyWeeklyFocusDetail
//
// Admin-only, READ-ONLY view of the legacy Weekly Focus record for one AE:
//   * relationships / archived_relationships (legacy coaching relationships)
//   * training (standing training commitments)
//   * weeks (every Weekly Focus row newest-first, with commitments and the
//     manager-only private notes)
//
// Unlike the original GET /api/admin/coaching/[ae_id] (kept unchanged for
// old clients, and which auto-creates the current week's row), this view
// never writes anything. It exists so legacy data stays visible on the 1:1
// workspace and the legacy relationship/training/commitment routes stay
// usable. No legacy row is modified or hidden.

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
    const ae = await requireCoachableAe(supabase, ae_id);

    const [relationshipsRes, archivedRes, trainingRes, weeksRes] =
      await Promise.all([
        supabase
          .from(COACHING_RELATIONSHIPS_TABLE)
          .select("*")
          .eq("ae_id", ae.id)
          .is("archived_at", null)
          .order("updated_at", { ascending: false }),
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
          .order("completed", { ascending: true })
          .order("updated_at", { ascending: false }),
        supabase
          .from(WEEKLY_FOCUS_TABLE)
          .select("*")
          .eq("ae_id", ae.id)
          .order("week_start", { ascending: false })
          .limit(LEGACY_WEEKS_LIMIT),
      ]);

    const firstErr =
      relationshipsRes.error ??
      archivedRes.error ??
      trainingRes.error ??
      weeksRes.error;
    if (firstErr) {
      return Response.json({ error: firstErr.message }, { status: 500 });
    }

    const weeks = (weeksRes.data ?? []) as WeeklyFocus[];
    const weekIds = weeks.map((w) => w.id);
    const [commitmentsRes, privateRes] = weekIds.length
      ? await Promise.all([
          supabase
            .from(WEEKLY_FOCUS_COMMITMENTS_TABLE)
            .select("*")
            .in("one_on_one_id", weekIds)
            .order("created_at", { ascending: true }),
          supabase
            .from(WEEKLY_FOCUS_PRIVATE_NOTES_TABLE)
            .select("weekly_focus_id, notes")
            .in("weekly_focus_id", weekIds),
        ])
      : [
          { data: [], error: null },
          { data: [], error: null },
        ];
    const childErr = commitmentsRes.error ?? privateRes.error;
    if (childErr) {
      return Response.json({ error: childErr.message }, { status: 500 });
    }

    const byWeek = new Map<string, WeeklyFocusCommitment[]>();
    for (const c of (commitmentsRes.data ?? []) as WeeklyFocusCommitment[]) {
      const bucket = byWeek.get(c.one_on_one_id) ?? [];
      bucket.push(c);
      byWeek.set(c.one_on_one_id, bucket);
    }
    const notesByWeek = new Map<string, string | null>();
    for (const n of (privateRes.data ?? []) as Array<{
      weekly_focus_id: string;
      notes: string | null;
    }>) {
      notesByWeek.set(n.weekly_focus_id, n.notes);
    }

    const payload: LegacyWeeklyFocusDetail = {
      relationships: (relationshipsRes.data ?? []) as CoachingRelationship[],
      archived_relationships: (archivedRes.data ?? []) as CoachingRelationship[],
      training: (trainingRes.data ?? []) as TrainingCommitment[],
      weeks: weeks.map((w) => ({
        ...w,
        commitments: byWeek.get(w.id) ?? [],
        manager_notes: notesByWeek.get(w.id) ?? null,
      })),
    };
    return Response.json(payload, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
