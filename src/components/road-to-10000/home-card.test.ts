/**
 * The compact Road to 10,000 HOME card, rendered to real HTML (react-dom/server)
 * from real computed metrics. This is a presentation refinement only: the math is
 * covered in lib/road-to-10000.test.ts and the route tests; here we pin what the
 * Home card SHOWS — it answers three questions: where are we (total, percent), how
 * far to go (Homescriptions to go, bar), how are we doing (pace, ahead/behind),
 * plus when it was updated — and what it deliberately does NOT: projected finish,
 * required pace, "per business day", extra slogans. The detail page keeps all of it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

// The card pulls in the browser API client; these placeholders keep module load quiet.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const { RoadHomeCardBody } = await import("@/components/road-to-10000-card");
const { companyHolidayValues } = await import("@/lib/company-calendar");
const { ROAD_TO_10000_GOAL, computeRoadMetrics } = await import("@/lib/road-to-10000");
import type { RoadView } from "@/lib/road-to-10000";

const holidays = companyHolidayValues("2026-01-01", "2026-12-31").values;

function view(total: number, recordedOn: string, today: string, over: Partial<RoadView> = {}): RoadView {
  const days = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${recordedOn}T12:00:00Z`)) / 86_400_000);
  return {
    configured: true,
    goal: ROAD_TO_10000_GOAL,
    source: "manual",
    latest: {
      id: "r1", total, recordedAt: `${recordedOn}T18:00:00Z`, recordedOn, source: "manual",
      isCorrection: false, note: null, enteredByName: "Corey",
    },
    metrics: computeRoadMetrics({ total, recordedOn, today, holidayValues: holidays }),
    daysSinceUpdate: days,
    history: [],
    holidays: [],
    extraHolidaysUnavailable: false,
    can_update: false,
    ...over,
  };
}

/** Visible text of the rendered card (tags removed, entities decoded, whitespace collapsed). */
function textOf(v: RoadView): string {
  const html = renderToStaticMarkup(createElement(RoadHomeCardBody, { view: v }));
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
const html = (v: RoadView) => renderToStaticMarkup(createElement(RoadHomeCardBody, { view: v }));

describe("Home card content (7,842 recorded and viewed Mon Oct 5)", () => {
  const v = view(7842, "2026-10-05", "2026-10-05");
  const text = textOf(v);

  it("headline, the one supporting line, and the goal statement — in the requested words", () => {
    expect(text).toContain("Road to 10,000"); // shown uppercase by CSS
    expect(text).toContain("🏁");
    expect(text).toContain("We're on our way. 🚀");
    expect(text).toContain("10,000 Homescriptions Sold");
  });

  it("current total / 10,000, percent complete, Homescriptions to go", () => {
    expect(text).toContain("7,842");
    expect(text).toContain("/ 10,000");
    expect(text).toContain("78.4%");
    expect(text).toContain("Complete");
    expect(text).toContain("2,158 Homescriptions to go");
  });

  it("a progress bar filled to the percent complete", () => {
    expect(html(v)).toMatch(/role="progressbar"[^>]*aria-valuenow="78\.4"/);
    expect(html(v)).toMatch(/style="width:78\.42%"/);
  });

  it("ONE pace: the current pace number with /day, and where it stands — 'Ahead of pace +5.1/day'", () => {
    expect(text).toMatch(/Pace 41\.7 ?\/day/);
    expect(text).toContain("Ahead of pace +5.1/day");
  });

  it("when the total was last updated", () => {
    expect(text).toContain("Updated Oct 5");
  });

  it("is a link to the full view", () => {
    expect(html(v)).toMatch(/<a[^>]+href="\/road-to-10000"/);
  });
});

describe("what the AE Home card deliberately leaves out", () => {
  const v = view(7842, "2026-10-05", "2026-10-05");
  const text = textOf(v);

  it("NO projected finish — not the label, not the number", () => {
    expect(text).not.toMatch(/projected/i);
    expect(text).not.toContain("10,303"); // 7,842 + 41.71 x 59
    expect(text).not.toMatch(/finish/i);
  });

  it("no required pace, no 'Current pace' / 'Required pace' pair, no 'per business day'", () => {
    expect(text).not.toMatch(/required pace/i);
    expect(text).not.toMatch(/current pace/i);
    expect(text).not.toMatch(/per business day/i);
    expect(text).not.toMatch(/36\.6|36\.0/); // the required-pace numbers (2,158 / 59 or 60) never appear
  });

  it("only ONE pace figure on the card (plus the ahead/behind difference), not two side by side", () => {
    expect(text.match(/\/day/g)).toHaveLength(2); // "41.7/day" and "+5.1/day"
    expect(text.match(/pace/gi)).toHaveLength(2); // the PACE label and "Ahead of pace" — not "Required pace"
  });

  it("no extra slogans or milestone messages", () => {
    expect(text).not.toMatch(/milestone|halfway|three quarters|almost there|let's go|keep going|crush/i);
    // The only motivational line is the one asked for.
    expect(text.match(/🚀/g)).toHaveLength(1);
    expect(text).not.toContain("Last updated");
  });
});

describe("states", () => {
  it("behind pace: amber status with a real minus sign", () => {
    const text = textOf(view(6000, "2026-10-05", "2026-10-05"));
    expect(text).toMatch(/Behind pace −\d+\.\d\/day/);
    expect(html(view(6000, "2026-10-05", "2026-10-05"))).toContain("text-amber-700");
  });

  it("a stale total is visibly old, but the pace and projection are still the recorded-date ones", () => {
    const fresh = textOf(view(7842, "2026-10-05", "2026-10-05"));
    const stale = textOf(view(7842, "2026-10-05", "2026-10-08"));
    expect(stale).toContain("Updated Oct 5 · 3 days ago");
    expect(html(view(7842, "2026-10-05", "2026-10-08"))).toContain("text-amber-700");
    expect(stale).toMatch(/Pace 41\.7 ?\/day/); // the same historical pace
    expect(fresh).not.toContain("days ago");
  });

  it("goal reached", () => {
    const text = textOf(view(10000, "2026-10-05", "2026-10-05"));
    expect(text).toContain("10,000");
    expect(text).toContain("0 Homescriptions to go");
    expect(text).toContain("🎉 Goal reached");
  });

  it("pace unavailable (too early in the year): a neutral 'Pace status —', never 'Ahead of pace'", () => {
    const text = textOf(view(40, "2026-01-02", "2026-01-02"));
    expect(text).toContain("Pace status —");
    expect(text).not.toContain("Ahead of pace");
    expect(text).toMatch(/Pace — Pace status —/); // pace "—" with no "/day", then the neutral state
  });

  it("no total recorded yet: the goal and an empty bar, no invented numbers", () => {
    const empty: RoadView = { ...view(0, "2026-10-05", "2026-10-05"), latest: null, metrics: null, daysSinceUpdate: null };
    const text = textOf(empty);
    expect(text).toContain("No total recorded yet.");
    expect(text).toContain("We're on our way. 🚀");
    expect(text).not.toMatch(/Projected finish|Pace/);
    expect(textOf({ ...empty, can_update: true })).toContain("Tap to enter the first one.");
  });
});

describe("projected finish is absent in EVERY state of the Home card", () => {
  const states: Array<[string, RoadView]> = [
    ["ahead", view(7842, "2026-10-05", "2026-10-05")],
    ["behind", view(6000, "2026-10-05", "2026-10-05")],
    ["stale", view(7842, "2026-10-05", "2026-10-08")],
    ["goal reached", view(10000, "2026-10-05", "2026-10-05")],
    ["pace unavailable", view(40, "2026-01-02", "2026-01-02")],
    ["no total", { ...view(0, "2026-10-05", "2026-10-05"), latest: null, metrics: null, daysSinceUpdate: null }],
  ];
  it.each(states)("%s", (_name, v) => {
    const text = textOf(v);
    expect(text).not.toMatch(/projected|finish/i);
    expect(text).not.toMatch(/required pace|per business day/i);
    if (v.metrics?.projectedFinish != null && !v.metrics.complete) {
      expect(text).not.toContain(Math.round(v.metrics.projectedFinish).toLocaleString("en-US"));
    }
  });
});

describe("the card is shorter than before", () => {
  it("fewer text rows than the previous Home card (which had a two-column footer with the projection and a separate stat block)", () => {
    const h = html(view(7842, "2026-10-05", "2026-10-05"));
    // Previous layout: 12 <p> rows. Now: headline, supporting line, goal line, total, percent, to go, pace, status.
    const rows = (h.match(/<p[ >]/g) ?? []).length;
    expect(rows).toBeLessThanOrEqual(9);
    // ONE footer row (a single divider), not a multi-line grid.
    expect((h.match(/border-t/g) ?? []).length).toBe(1);
    expect(h).not.toMatch(/grid-cols-2/);
    // Tight chrome: smaller vertical gap/padding than the default small card.
    expect(h).toMatch(/gap-1\.5/);
    expect(h).toMatch(/py-2\.5/);
  });

  it("stays prominent: the orange ring and gradient, the large total, the orange bar", () => {
    const h = html(view(7842, "2026-10-05", "2026-10-05"));
    expect(h).toContain("ring-primary/30");
    expect(h).toContain("from-primary/10");
    expect(h).toContain("text-3xl");
    expect(h).toContain("from-primary/80 to-primary");
    expect(h).toContain("text-primary");
  });
});

describe("the detail page keeps the full math", () => {
  const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
  it("still shows current pace, required pace, per-business-day units, business days and the explanation", () => {
    const page = read("src/components/road-to-10000/road-page-content.tsx");
    for (const keep of ["Current pace", "Required pace", "Projected finish", "per business day", "Business days elapsed", "Business days remaining", "reportingLagBusinessDays", "How this is calculated", "UpdateTotalForm", "History"]) {
      expect(page, keep).toContain(keep);
    }
  });
});
