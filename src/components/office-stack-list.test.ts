/**
 * Stacked-office popup: every office sharing a map location must have the same
 * route-selection and action set as an individual pin.
 *
 * No DOM here (the project has no jsdom/RTL): markup is checked with React's
 * server renderer, and handlers are exercised by walking the element tree the
 * (hook-free) component returns and calling the matching onClick.
 */
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { OfficeStackList, type OfficeStackListProps } from "./office-stack-list";
import type { OfficeMapPinItem } from "@/lib/offices";

function office(id: string, name: string, over: Partial<OfficeMapPinItem> = {}): OfficeMapPinItem {
  return {
    id,
    name,
    street: `40 NE Loop 410 Ste ${id}`,
    city: "San Antonio",
    state: "TX",
    zip: "78216",
    latitude: 29.5,
    longitude: -98.5,
    distance_miles: null,
    last_visit_at: null,
    next_action: null,
    next_action_due_date: null,
    ...over,
  };
}

const ITEMS = [office("1", "Chris Reeves"), office("2", "Signet Mortgage"), office("3", "Wells Fargo Home Mortgage")];

function props(over: Partial<OfficeStackListProps> = {}): OfficeStackListProps {
  return {
    items: ITEMS,
    selectedIds: new Set<string>(),
    onToggleSelect: vi.fn(),
    loggingId: null,
    logNoticeById: new Map(),
    logErrorById: new Map(),
    isLogDisabled: () => false,
    onLogVisit: vi.fn(),
    onLogVisitWithNote: vi.fn(),
    ...over,
  };
}
const html = (p: OfficeStackListProps) => renderToStaticMarkup(createElement(OfficeStackList, p));

type El = ReactElement<{ children?: ReactNode; onClick?: () => void }>;

/** Collects every element in a returned tree (depth-first). */
function walk(node: ReactNode, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => walk(n, out));
  else if (isValidElement(node)) {
    const el = node as El;
    out.push(el);
    walk(el.props.children, out);
  }
  return out;
}
const textOf = (node: ReactNode): string =>
  Array.isArray(node)
    ? node.map(textOf).join("")
    : isValidElement(node)
      ? textOf((node as ReactElement<{ children?: ReactNode }>).props.children)
      : typeof node === "string" || typeof node === "number"
        ? String(node)
        : "";
/** The row <li> for an office, plus its clickable buttons by label. */
function rowFor(p: OfficeStackListProps, id: string) {
  const tree = OfficeStackList(p);
  const li = walk(tree).find((e) => e.type === "li" && e.key === id)!;
  const buttons = walk(li).filter((e) => typeof e.props.onClick === "function");
  const byLabel = (label: string) => buttons.find((b) => textOf(b.props.children).includes(label));
  return { li, byLabel };
}

describe("OfficeStackList — route selection", () => {
  it("gives EVERY office its own Add to route button", () => {
    const out = html(props());
    expect(out.match(/Add to route/g)).toHaveLength(3);
    expect(out).not.toContain("In route");
  });

  it("toggles exactly the office that was tapped", () => {
    const onToggleSelect = vi.fn();
    const p = props({ onToggleSelect });
    rowFor(p, "2").byLabel("Add to route")!.props.onClick!();
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    expect(onToggleSelect).toHaveBeenCalledWith("2");
  });

  it("shows which offices are selected, and only those", () => {
    const out = html(props({ selectedIds: new Set(["1", "3"]) }));
    expect(out.match(/data-selected="true"/g)).toHaveLength(2);
    expect(out.match(/data-selected="false"/g)).toHaveLength(1);
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(out.match(/aria-pressed="false"/g)).toHaveLength(1);
    expect(out.match(/In route/g)).toHaveLength(2); // the two selected offices' buttons
    expect(out).toContain("2 in route");
  });

  it("lets a selected office be deselected through the same handler", () => {
    const onToggleSelect = vi.fn();
    const p = props({ onToggleSelect, selectedIds: new Set(["3"]) });
    const { byLabel } = rowFor(p, "3");
    expect(byLabel("Add to route")).toBeUndefined();
    byLabel("In route")!.props.onClick!();
    expect(onToggleSelect).toHaveBeenCalledWith("3");
  });

  it("omits the route controls when route selection is not offered", () => {
    expect(html(props({ onToggleSelect: undefined }))).not.toContain("Add to route");
  });
});

describe("OfficeStackList — existing actions keep working per office", () => {
  it("Log visit and Log + note act on the office they belong to", () => {
    const onLogVisit = vi.fn();
    const onLogVisitWithNote = vi.fn();
    const p = props({ onLogVisit, onLogVisitWithNote });
    rowFor(p, "2").byLabel("Log visit")!.props.onClick!();
    rowFor(p, "3").byLabel("Log + note")!.props.onClick!();
    expect(onLogVisit).toHaveBeenCalledWith("2");
    expect(onLogVisitWithNote).toHaveBeenCalledWith({ id: "3", name: "Wells Fargo Home Mortgage" });
  });

  it("every office has its own Directions link (to Google Maps, with its name + address) and Open link", () => {
    const out = html(props());
    expect(out.match(/Directions/g)).toHaveLength(3);
    expect(out).toContain("https://www.google.com/maps/search/?api=1&amp;query=");
    expect(out).toContain(encodeURIComponent("Signet Mortgage 40 NE Loop 410 Ste 2"));
    expect(out).toContain('href="/offices/1"');
    expect(out).toContain('href="/offices/2"');
    expect(out).toContain('href="/offices/3"');
  });

  it("shows each office's own address, last-visit state, notices and errors", () => {
    const out = html(
      props({
        items: [office("1", "A", { last_visit_at: "2026-10-19T17:46:00Z" }), office("2", "B")],
        logNoticeById: new Map([["1", "Visit logged."]]),
        logErrorById: new Map([["2", "Could not log."]]),
      }),
    );
    expect(out).toContain("40 NE Loop 410 Ste 1, San Antonio");
    expect(out).toContain("40 NE Loop 410 Ste 2, San Antonio");
    expect(out).toContain("Last visit");
    expect(out).toContain("No visit yet");
    expect(out).toContain("Visit logged.");
    expect(out).toContain("Could not log.");
  });

  it("disables visit buttons while a log is in flight, like a single pin", () => {
    const out = html(props({ loggingId: "1", isLogDisabled: (id) => id !== "1" }));
    expect(out).toContain("Logging…");
    // Offices other than the one being logged are disabled; every Log button is.
    expect(out.match(/disabled=""/g)!.length).toBeGreaterThanOrEqual(4);
  });

  it("shows an office's next action and due date", () => {
    const out = html(
      props({ items: [office("1", "A", { next_action: "Bring brochures", next_action_due_date: "2026-11-02" })] }),
    );
    expect(out).toContain("Bring brochures");
    expect(out).toContain("due");
  });
});
