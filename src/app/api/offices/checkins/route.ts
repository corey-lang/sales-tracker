import { addDays, format } from "date-fns";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  ApiError,
  badRequest,
  forbidden,
  handleApiError,
  requireAeToolAccess,
} from "@/lib/server/auth";
import {
  appTimezoneMidnightUtc,
  todayInAppTimezone,
} from "@/lib/dates";
import {
  CHECKINS_LIMIT,
  isCheckinRange,
  officeEnvironmentFor,
  OFFICES_TABLE,
  OFFICE_VISITS_TABLE,
  type CheckinItem,
  type CheckinRange,
  type CheckinScope,
} from "@/lib/offices";

// GET /api/offices/checkins?range=<today|yesterday|7d|custom>&scope=<mine|team>&from=&to=
//
// "Today's Check-ins" feed — the office_visits log for a date window,
// flattened with office name + (team view) the AE who logged each visit.
// Powers the Check-ins tab on /offices.
//
// AUDIENCE / VISIBILITY
//   `requireAeToolAccess` — every signed-in salesperson except
//   juice_box_only. Two scopes:
//     * scope=mine (default) — `salesperson_id = me.id`. The everyday
//       rule and the ONLY scope a non-admin may use. Matches the rest
//       of the office surface: a rep sees their own activity.
//     * scope=team — admin-only. Returns every AE's check-ins in the
//       caller's environment (production for real admins). A non-admin
//       asking for team is rejected (403) rather than silently
//       downgraded so a tampered request is loud, not quietly wrong.
//   Environment is always `officeEnvironmentFor(me)` (test stays in the
//   sandbox, production AEs/admins in production) so the two slices
//   never bleed together.
//
// DATE WINDOW
//   Ranges are computed in the app's business timezone (America/Denver)
//   so an 11pm check-in counts on the right calendar day for everyone.
//   today / yesterday / 7d are relative; custom takes from+to
//   (YYYY-MM-DD, inclusive). The window is [midnight(from), midnight(to+1))
//   against the timestamptz column.
//
// SHAPE
//   200  CheckinsResponse
//   400  invalid range / scope / custom dates
//   401  no session
//   403  non-admin requested scope=team
//   500  sanitized — raw DB error logged with the `[checkins]` prefix
//   502  office/AE-name enrichment failed (feed would be misleading)

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Upper bound on a custom window so one request can't pull an
 *  unbounded history. A year is generous for "what got checked in." */
const MAX_CUSTOM_SPAN_DAYS = 366;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Resolved inclusive calendar-day bounds for a requested range. */
type DayBounds = { fromDay: string; toDay: string };

/**
 * Turns the requested range into inclusive YYYY-MM-DD (Denver) bounds.
 * Throws a 400 ApiError for a malformed/oversized custom window.
 */
function resolveDayBounds(
  range: CheckinRange,
  fromParam: string | null,
  toParam: string | null,
): DayBounds {
  const today = todayInAppTimezone();
  const todayStr = format(today, "yyyy-MM-dd");

  if (range === "today") return { fromDay: todayStr, toDay: todayStr };
  if (range === "yesterday") {
    const y = format(addDays(today, -1), "yyyy-MM-dd");
    return { fromDay: y, toDay: y };
  }
  if (range === "7d") {
    return { fromDay: format(addDays(today, -6), "yyyy-MM-dd"), toDay: todayStr };
  }

  // custom — both bounds required + sane.
  if (!fromParam || !toParam) {
    throw badRequest("Custom range needs both from and to dates.");
  }
  if (!DATE_ONLY.test(fromParam) || !DATE_ONLY.test(toParam)) {
    throw badRequest("from and to must be YYYY-MM-DD dates.");
  }
  if (Number.isNaN(Date.parse(fromParam)) || Number.isNaN(Date.parse(toParam))) {
    throw badRequest("from or to is not a real date.");
  }
  if (fromParam > toParam) {
    throw badRequest("from date must be on or before the to date.");
  }
  // Span guard (string dates compare lexicographically only within the
  // same length — they're all YYYY-MM-DD here, so the day math is exact).
  const spanDays =
    Math.round(
      (Date.parse(`${toParam}T00:00:00Z`) -
        Date.parse(`${fromParam}T00:00:00Z`)) /
        (24 * 60 * 60 * 1000),
    ) + 1;
  if (spanDays > MAX_CUSTOM_SPAN_DAYS) {
    throw badRequest(`Custom range can span at most ${MAX_CUSTOM_SPAN_DAYS} days.`);
  }
  return { fromDay: fromParam, toDay: toParam };
}

type VisitRow = {
  id: string;
  office_id: string;
  salesperson_id: string;
  note: string | null;
  visited_at: string;
};

export async function GET(req: Request) {
  try {
    const me = await requireAeToolAccess(req);
    const environment = officeEnvironmentFor(me);

    const url = new URL(req.url);
    const rawRange = url.searchParams.get("range") ?? "today";
    if (!isCheckinRange(rawRange)) {
      throw badRequest("Invalid range.");
    }
    const range: CheckinRange = rawRange;

    // scope=team is admin-only. Default + any non-admin → mine.
    const rawScope = url.searchParams.get("scope") ?? "mine";
    const scope: CheckinScope = rawScope === "team" ? "team" : "mine";
    if (scope === "team" && me.role !== "admin") {
      throw forbidden("Team check-ins are available to admins only.");
    }

    const { fromDay, toDay } = resolveDayBounds(
      range,
      url.searchParams.get("from"),
      url.searchParams.get("to"),
    );

    // [midnight(fromDay), midnight(toDay + 1 day)) in UTC, derived from
    // Denver-local calendar days so the window lines up with how the
    // team reads "today".
    const startIso = appTimezoneMidnightUtc(fromDay);
    const endIso = appTimezoneMidnightUtc(
      format(addDays(new Date(`${toDay}T00:00:00`), 1), "yyyy-MM-dd"),
    );

    const supabase = getServerSupabase();

    // Fetch one extra row past the cap so we can flag truncation without
    // a separate COUNT. The visited_at range + environment match the
    // idx_office_visits_salesperson_env_recent index for the mine path.
    let visitsQuery = supabase
      .from(OFFICE_VISITS_TABLE)
      .select("id, office_id, salesperson_id, note, visited_at")
      .eq("environment", environment)
      .gte("visited_at", startIso)
      .lt("visited_at", endIso)
      .order("visited_at", { ascending: false })
      .limit(CHECKINS_LIMIT + 1);
    if (scope === "mine") {
      visitsQuery = visitsQuery.eq("salesperson_id", me.id);
    }

    const visitsRes = await visitsQuery;
    if (visitsRes.error) {
      console.warn(
        `[checkins] visits fetch failed caller=${me.id} scope=${scope} range=${range} code=${visitsRes.error.code ?? "?"} msg=${visitsRes.error.message}`,
      );
      throw new ApiError(500, "Could not load check-ins.");
    }

    const allRows = (visitsRes.data ?? []) as VisitRow[];
    const truncated = allRows.length > CHECKINS_LIMIT;
    const rows = truncated ? allRows.slice(0, CHECKINS_LIMIT) : allRows;

    if (rows.length === 0) {
      return Response.json(
        {
          checkins: [],
          scope,
          range,
          from: fromDay,
          to: toDay,
          truncated: false,
        },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }

    // Enrich office names. Archived offices are intentionally NOT filtered
    // out here — a check-in against an office that was later archived is
    // still a real activity record and should show its name in the feed.
    const officeIds = [...new Set(rows.map((r) => r.office_id))];
    const officesRes = await supabase
      .from(OFFICES_TABLE)
      .select("id, name")
      .eq("environment", environment)
      .in("id", officeIds);
    if (officesRes.error) {
      console.warn(
        `[checkins] office-name enrichment failed caller=${me.id} code=${officesRes.error.code ?? "?"} msg=${officesRes.error.message}`,
      );
      throw new ApiError(502, "Could not load office names for check-ins.");
    }
    const officeNameById = new Map<string, string>();
    for (const o of (officesRes.data ?? []) as Array<{ id: string; name: string }>) {
      officeNameById.set(o.id, o.name);
    }

    // Enrich AE names. For the mine path it's always the caller; for the
    // team path resolve every distinct salesperson_id to a first_name.
    const nameById = new Map<string, string>();
    if (scope === "mine") {
      nameById.set(me.id, me.first_name);
    } else {
      const personIds = [...new Set(rows.map((r) => r.salesperson_id))];
      const peopleRes = await supabase
        .from("salespeople")
        .select("id, first_name")
        .in("id", personIds);
      if (peopleRes.error) {
        console.warn(
          `[checkins] AE-name enrichment failed caller=${me.id} code=${peopleRes.error.code ?? "?"} msg=${peopleRes.error.message}`,
        );
        throw new ApiError(502, "Could not load AE names for check-ins.");
      }
      for (const p of (peopleRes.data ?? []) as Array<{
        id: string;
        first_name: string;
      }>) {
        nameById.set(p.id, p.first_name);
      }
    }

    const checkins: CheckinItem[] = rows.map((r) => ({
      id: r.id,
      office_id: r.office_id,
      office_name: officeNameById.get(r.office_id) ?? "Unknown office",
      salesperson_id: r.salesperson_id,
      salesperson_name: nameById.get(r.salesperson_id) ?? "Unknown",
      note: r.note,
      visited_at: r.visited_at,
    }));

    return Response.json(
      {
        checkins,
        scope,
        range,
        from: fromDay,
        to: toDay,
        truncated,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return handleApiError(err);
  }
}
