import { addDays, format, getDay, parseISO } from "date-fns";

import type { WorkingDayAdjustment } from "@/lib/working-days";

// Business-day counting over a date range, minus COMPANY holidays.
//
// Extracted UNCHANGED from the Orders pace code (src/lib/server/orders.ts), so
// the Orders card and Road to 10,000 share one definition of "business day":
//   Monday through Friday, minus company-wide holidays. Individual PTO is
//   deliberately NOT part of it (orders and company goals keep moving while one
//   AE is out).
//
// Pure and dependency-light (date-fns only) — safe for the browser, the server
// and tests. The holiday SET is data, supplied by the caller (see
// lib/company-calendar.ts); nothing here knows any holiday date.

/** Company-holiday day-off value per date — applies_to_all rows ONLY (never
 *  individual PTO). day_value is 1.0 (full) or 0.5 (half), capped at 1. */
export function companyHolidayValueByDate(
  adjustments: WorkingDayAdjustment[],
): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of adjustments) {
    if (!a.applies_to_all) continue; // company holidays only
    const v = Math.min(1, Math.max(0, Number(a.day_value) || 0));
    m.set(a.adjustment_date, Math.min(1, (m.get(a.adjustment_date) ?? 0) + v));
  }
  return m;
}

/** Weekdays (Mon–Fri) in [start, end] inclusive, minus company-holiday values.
 *  Returns 0 when start > end. Bounded loop (≤ 400 days). */
export function businessDaysBetween(
  startInclusive: string,
  endInclusive: string,
  holidayValues: Map<string, number>,
): number {
  if (startInclusive > endInclusive) return 0;
  const last = parseISO(endInclusive).getTime();
  let total = 0;
  let d = parseISO(startInclusive);
  let guard = 0;
  while (d.getTime() <= last && guard < 400) {
    const dow = getDay(d); // 0 Sun .. 6 Sat
    if (dow >= 1 && dow <= 5) {
      const ds = format(d, "yyyy-MM-dd");
      total += 1 - (holidayValues.get(ds) ?? 0);
    }
    d = addDays(d, 1);
    guard += 1;
  }
  return Math.round(total * 10) / 10;
}
