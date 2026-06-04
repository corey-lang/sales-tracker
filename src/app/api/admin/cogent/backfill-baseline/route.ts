import { ApiError, handleApiError, requireAdmin } from "@/lib/server/auth";
import { getServerSupabase } from "@/lib/supabase/server";
import { readOrdersSnapshot, syncOrders } from "@/lib/server/orders";

// POST /api/admin/cogent/backfill-baseline
//
// ⚠️ TEMPORARY ADMIN-ONLY BACKFILL HELPER — NOT FOR PRODUCTION. ⚠️
//
// WHY THIS EXISTS (one-time): the order_today_baseline table was created AFTER
// today's orders had already landed, so the day's first sync captured a baseline
// that already included them and Today shows 0. This helper seeds TODAY's
// baseline row with the TRUSTED June-3 end-of-day month-to-date totals, so the
// normal delta math (current MTD − baseline) then yields the correct Today
// counts. It uses NO desired-delta math — it writes real baseline totals and
// lets Today be computed naturally.
//
// It does NOT change Orders architecture. It writes exactly ONE row — today's
// America/Denver baseline_date — and never touches prior/future dates. The
// normal sync path keeps creating tomorrow's baseline automatically (INSERT …
// ON CONFLICT DO NOTHING); this helper is the only place we deliberately
// overwrite, once, for this validation.
//
// GATING (req 11): admin-only AND blocked on Vercel production
// (VERCEL_ENV === "production"). Allowed on preview + local dev only.
//
// TO REMOVE: delete this route directory at/ before production cutover.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BASELINE_TABLE = "order_today_baseline";

// Trusted June-3 end-of-day MTD totals, keyed by AE first name (case-insensitive;
// matches AeOrdersSummary.salespersonName). These become today's baseline.
const JUNE3_EOD_BASELINE: Record<string, number> = {
  camille: 17,
  lia: 18,
  vivian: 12,
  jocelyn: 3,
  chanel: 2,
  hilary: 1,
  james: 0,
  shannon: 15,
  carli: 39,
  kennedy: 30,
  heather: 30,
};
const COMPANY_BASELINE = 167;

// Operational Today values we expect AFTER refresh, for the verification block
// only (the real source of truth is current MTD − baseline). Company is the sum
// of clamped per-AE deltas.
const EXPECTED_TODAY: Record<string, number> = { carli: 2, kennedy: 2, heather: 5 };
const EXPECTED_COMPANY = 9;

export async function POST(req: Request) {
  try {
    await requireAdmin(req);

    // Hard block on production — preview/testing-only backfill.
    if (process.env.VERCEL_ENV === "production") {
      throw new ApiError(
        403,
        "Baseline backfill is disabled on production (preview/testing only).",
      );
    }

    // 1. Current MTD totals — prefer the cached snapshot; if none yet, sync to
    //    populate it. Used only to resolve AE names → ids for the baseline JSON.
    let current = (await readOrdersSnapshot())?.data ?? null;
    if (!current) {
      current = (await syncOrders()).data;
    }

    const baselineDate = current.endDate; // Denver "today" (window end)

    // 2. Build the baseline ae_totals keyed by salespersonId (the reader keys by
    //    id). For a present AE in the trusted list → use the trusted total; for
    //    any other present AE → use their CURRENT total (neutral, Today delta 0)
    //    so a stray/non-listed AE can't surface a bogus Today.
    const aeBaselines: Record<string, number> = {};
    const matchedNames = new Set<string>();
    for (const it of current.items) {
      const key = it.salespersonName.trim().toLowerCase();
      if (key in JUNE3_EOD_BASELINE) {
        aeBaselines[it.salespersonId] = JUNE3_EOD_BASELINE[key];
        matchedNames.add(key);
      } else {
        aeBaselines[it.salespersonId] = it.orderCount; // neutral → delta 0
      }
    }

    // Trusted names with no current item (e.g. an AE with 0 orders so far this
    // month): can't resolve an id, but the reader treats a missing baseline as 0
    // — which equals their trusted value only when that value is 0. Surface any
    // nonzero ones so we know to re-run once they appear.
    const warnings = Object.entries(JUNE3_EOD_BASELINE)
      .filter(([name]) => !matchedNames.has(name))
      .map(([name, total]) =>
        `trusted AE "${name}" (baseline ${total}) not in current snapshot items` +
        (total > 0 ? " — its baseline could not be stored yet" : ""),
      );

    // 3. Overwrite ONLY today's baseline row (the one deliberate overwrite).
    const supabase = getServerSupabase();
    const write = await supabase.from(BASELINE_TABLE).upsert(
      {
        baseline_date: baselineDate,
        company_total: COMPANY_BASELINE,
        ae_totals: aeBaselines,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "baseline_date" },
    );
    if (write.error) {
      throw new ApiError(500, `Could not write baseline: ${write.error.message}`);
    }

    // 4. Refresh the snapshot so Today deltas recompute against the new baseline.
    const refreshed = (await syncOrders()).data;

    // 5. Verify: Today = current MTD − baseline (clamped ≥ 0), per AE + company.
    const todayByName = new Map(
      refreshed.items.map((i) => [
        i.salespersonName.trim().toLowerCase(),
        i.todayOrders,
      ]),
    );
    const aeChecks = Object.entries(EXPECTED_TODAY).map(([name, expected]) => {
      const actual = todayByName.get(name) ?? null;
      return { name, expected, actual, match: actual === expected };
    });
    const companyActual = refreshed.company.todayOrders;
    const ok =
      companyActual === EXPECTED_COMPANY && aeChecks.every((c) => c.match);

    return Response.json({
      ok,
      note: "TEMPORARY backfill helper — preview/testing only.",
      baselineDate,
      applied: { companyBaseline: COMPANY_BASELINE, aeBaselines },
      verify: {
        company: { expected: EXPECTED_COMPANY, actual: companyActual },
        aes: aeChecks,
        // Full per-AE Today after refresh, for transparency.
        allTodayByAe: refreshed.items.map((i) => ({
          name: i.salespersonName,
          monthly: i.orderCount,
          today: i.todayOrders,
        })),
      },
      warnings,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
