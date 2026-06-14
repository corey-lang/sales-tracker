import { getServerSupabase } from "@/lib/supabase/server";
import { badRequest, handleApiError, requireAdmin } from "@/lib/server/auth";
import {
  ACTIVITIES,
  ZERO_ACTIVITY,
  type ActivityValues,
} from "@/lib/activities";
import { averagePercent, type WeeklyGoal } from "@/lib/goals";
import { buildRangeTargets } from "@/lib/range-targets";
import { fetchRangeAdjustments } from "@/lib/server/working-days";

// GET /api/admin/activity-totals?from=YYYY-MM-DD&to=YYYY-MM-DD&salesperson=<id|all>
//
// Admin-only. Drives the admin Dashboard "Activity totals" card with the shared
// Range Goal Engine: for any range (this week, last week, MTD, last month,
// custom) it returns each AE's actuals plus the RANGE goal — the sum of each
// week's prorated, time-off-adjusted weekly goals — so percentages are scored
// against the right denominator instead of a single weekly goal.
//
// SECURITY: working_day_adjustments is server-only; the card reads its targets
// through this admin-gated route, so neither raw PTO rows nor (now) raw goals
// cross the wire — only the computed totals do. Fails closed on adjustment-read
// failure (502, safe message); raw provider text is logged server-side only.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIVITY_KEYS = ACTIVITIES.map((a) => a.key);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  try {
    await requireAdmin(req);

    const url = new URL(req.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const salesperson = url.searchParams.get("salesperson") ?? "all";

    if (!from || !DATE_RE.test(from) || !to || !DATE_RE.test(to)) {
      throw badRequest("from and to are required (YYYY-MM-DD).");
    }
    if (from > to) {
      throw badRequest("from must not be after to.");
    }

    const supabase = getServerSupabase();

    let entriesQuery = supabase
      .from("activity_entries")
      .select(["salesperson_id", "entry_date", ...ACTIVITY_KEYS].join(","))
      .gte("entry_date", from)
      .lte("entry_date", to);
    if (salesperson !== "all") {
      entriesQuery = entriesQuery.eq("salesperson_id", salesperson);
    }

    const [peopleRes, entriesRes, goalsRes, adj] = await Promise.all([
      supabase
        .from("salespeople")
        .select("id, first_name")
        .eq("role", "ae")
        .eq("is_test", false)
        .order("first_name", { ascending: true }),
      entriesQuery,
      supabase.from("weekly_goals").select("*"),
      fetchRangeAdjustments(supabase, from, to),
    ]);

    if (peopleRes.error ?? entriesRes.error ?? goalsRes.error) {
      const provider = peopleRes.error ?? entriesRes.error ?? goalsRes.error;
      console.error(
        `[activity-totals] read failed [${from}..${to}] code=${provider?.code ?? "?"} msg=${provider?.message ?? "?"}`,
      );
      return Response.json(
        { error: "Could not load activity totals." },
        { status: 500 },
      );
    }
    // Fail closed — never score against unadjusted targets.
    if (adj.error) {
      return Response.json({ error: adj.error }, { status: 502 });
    }

    let people = (peopleRes.data ?? []) as Array<{
      id: string;
      first_name: string;
    }>;
    if (salesperson !== "all") {
      people = people.filter((p) => p.id === salesperson);
    }
    const goals = (goalsRes.data ?? []) as WeeklyGoal[];
    const entries = (entriesRes.data ?? []) as unknown as Array<
      Partial<ActivityValues> & { salesperson_id: string; entry_date: string }
    >;

    // Sum each AE's logged activity over the range, weekends INCLUDED —
    // activity totals are the Sun-Sat numerator. Targets stay business-day
    // (Mon-Fri) based via the Range Goal Engine, so weekend work counts toward
    // the totals without changing the working-day target.
    const actualsByPerson = new Map<string, ActivityValues>();
    for (const p of people) actualsByPerson.set(p.id, { ...ZERO_ACTIVITY });
    for (const e of entries) {
      const bucket = actualsByPerson.get(e.salesperson_id);
      if (!bucket) continue;
      for (const k of ACTIVITY_KEYS) bucket[k] += Number(e[k] ?? 0);
    }

    let isHolidayWeek = false;
    let anyAdjusted = false;
    let businessDays = 0;

    const rows = people.map((p) => {
      const actuals = actualsByPerson.get(p.id) ?? { ...ZERO_ACTIVITY };
      const range = buildRangeTargets({
        salespersonId: p.id,
        startDate: from,
        endDate: to,
        goals,
        adjustments: adj.adjustments,
      });
      if (range.isHolidayWeek) isHolidayWeek = true;
      if (range.availableDays < range.businessDaysInRange) anyAdjusted = true;
      businessDays = range.businessDaysInRange; // same range → same for all
      return {
        id: p.id,
        first_name: p.first_name,
        actuals,
        originalTargets: range.originalTargets,
        adjustedTargets: range.adjustedTargets,
        availableDays: range.availableDays,
        businessDaysInRange: range.businessDaysInRange,
        percent: averagePercent(actuals, range.adjustedTargets, ACTIVITY_KEYS),
      };
    });

    return Response.json(
      { from, to, isHolidayWeek, anyAdjusted, businessDays, rows },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
