import { getServerSupabase } from "@/lib/supabase/server";
import {
  goalScopeOr,
  selectAllPages,
  selectAllPagesForIds,
} from "@/lib/server/paginate";
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

    // 1) REPORTING roster first (real AEs only — never test accounts, for
    //    any viewer). A single-AE filter narrows it; it can't widen it.
    const peopleRes = await supabase
      .from("salespeople")
      .select("id, first_name")
      .eq("role", "ae")
      .eq("is_test", false)
      .is("deactivated_at", null)
      .order("first_name", { ascending: true });
    if (peopleRes.error) {
      console.error(
        `[activity-totals] roster read failed code=${peopleRes.error.code ?? "?"} msg=${peopleRes.error.message}`,
      );
      return Response.json({ error: "Could not load activity totals." }, { status: 500 });
    }
    const roster = (peopleRes.data ?? []) as Array<{ id: string; first_name: string }>;
    const scopeIds = roster
      .map((p) => p.id)
      .filter((id) => salesperson === "all" || id === salesperson);

    // 2) Only those ids' rows, filtered in-query and paged to completion —
    //    a custom range can legitimately exceed one response (a year of
    //    team activity), and no other account's rows can displace them.
    const [entriesRes, goalsRes, adj] = await Promise.all([
      selectAllPagesForIds<Partial<ActivityValues> & { salesperson_id: string; entry_date: string }>(
        scopeIds,
        (chunk) =>
          supabase
            .from("activity_entries")
            .select(["id", "salesperson_id", "entry_date", ...ACTIVITY_KEYS].join(","))
            .in("salesperson_id", chunk)
            .gte("entry_date", from)
            .lte("entry_date", to)
            .order("id"),
      ),
      selectAllPages<WeeklyGoal>(() =>
        supabase.from("weekly_goals").select("*").or(goalScopeOr(scopeIds)).order("id"),
      ),
      fetchRangeAdjustments(supabase, from, to, scopeIds),
    ]);

    if (entriesRes.error ?? goalsRes.error) {
      const provider = entriesRes.error ?? goalsRes.error;
      console.error(
        `[activity-totals] read failed [${from}..${to}] code=${provider?.code ?? "?"} msg=${provider?.message ?? "?"}`,
      );
      return Response.json(
        { error: "Could not load activity totals." },
        { status: 500 },
      );
    }
    if (adj.error) {
      return Response.json({ error: adj.error }, { status: 502 });
    }

    const people = roster.filter((p) => scopeIds.includes(p.id));
    const goals = goalsRes.data;
    const entries = entriesRes.data;

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
