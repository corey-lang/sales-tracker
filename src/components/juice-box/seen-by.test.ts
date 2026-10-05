/**
 * The presentational half of "Seen by X of Y" (no jsdom in this project, so it is
 * rendered with react-dom/server). Network behaviour — one batched request, the
 * 403 handling — is covered by the route tests; here: what appears for whom.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const { SeenByContext, SeenByLine, SeenByLists } = await import("@/components/juice-box/seen-by");
import type { SeenDetail } from "@/lib/juice-box-seen";

const line = (ctx: Parameters<typeof SeenByContext.Provider>[0]["value"]) =>
  renderToStaticMarkup(createElement(SeenByContext.Provider, { value: ctx }, createElement(SeenByLine, { messageId: "m1" })));

describe("the line under a post", () => {
  it("authorized: a subtle 'Seen by 8 of 11' that opens the list", () => {
    const html = line({ summaryFor: () => ({ seen: 8, total: 11 }), open: () => {} });
    expect(html).toContain("Seen by 8 of 11");
    expect(html).toContain("👁");
    expect(html).toMatch(/<button/);
    expect(html).toMatch(/text-\[11px\]/); // small and quiet, not a badge
    expect(html).not.toMatch(/read receipt/i);
  });

  it("everyone else (no context): nothing at all — no line, no count, no button", () => {
    expect(line(null)).toBe("");
  });

  it("nothing while the count hasn't loaded, or when nobody is expected to see it", () => {
    expect(line({ summaryFor: () => undefined, open: () => {} })).toBe("");
    expect(line({ summaryFor: () => ({ seen: 0, total: 0 }), open: () => {} })).toBe("");
  });

  it("dynamic numbers", () => {
    expect(line({ summaryFor: () => ({ seen: 1, total: 3 }), open: () => {} })).toContain("Seen by 1 of 3");
  });
});

describe("the 'Who has seen this' lists", () => {
  const detail: SeenDetail = {
    id: "m1", seen: 2, total: 5,
    seen_people: [{ id: "1", name: "Heather" }, { id: "2", name: "Carli" }],
    not_seen_people: [{ id: "3", name: "James" }, { id: "4", name: "Lia" }, { id: "5", name: "Vivian" }],
  };
  const text = renderToStaticMarkup(createElement(SeenByLists, { detail })).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  it("Seen — N and Not seen — N, each with its people", () => {
    expect(text).toContain("Seen — 2");
    expect(text).toContain("Not seen — 3");
    for (const n of ["Heather", "Carli", "James", "Lia", "Vivian"]) expect(text).toContain(n);
    expect(renderToStaticMarkup(createElement(SeenByLists, { detail }))).toContain("🟢");
    expect(renderToStaticMarkup(createElement(SeenByLists, { detail }))).toContain("⚪");
  });

  it("empty sides say so plainly", () => {
    const html = renderToStaticMarkup(createElement(SeenByLists, { detail: { ...detail, seen_people: [], not_seen_people: [] } }));
    expect(html).toContain("No one yet.");
    expect(html).toContain("Everyone has seen this.");
  });
});
