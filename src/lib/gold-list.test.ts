/**
 * Pure-logic tests for the Gold List display rules.
 *
 * These three functions decide what the page says and in what order — the
 * header count, the overdue/today/upcoming tone on a scheduled activity, and
 * the order agents appear in. They are exported as pure functions precisely so
 * the rules can be pinned down without mounting the board (this project has no
 * jsdom/testing-library setup).
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_GOLD_LIST_SORT,
  DEFAULT_GOLD_LIST_STATUS_FILTER,
  activeAgents,
  agentCountLabel,
  matchesAgentSearch,
  matchesStatusFilter,
  scheduleToneFor,
  searchableDigits,
  sortAgents,
  sortAgentsByFollowUp,
  sortAgentsByName,
  visibleAgents,
} from "@/lib/gold-list";

describe("agentCountLabel", () => {
  it("renders the header phrase, singular at one", () => {
    expect(agentCountLabel(18)).toBe("18 agents");
    expect(agentCountLabel(1)).toBe("1 agent");
    expect(agentCountLabel(0)).toBe("0 agents");
  });
});

describe("activeAgents", () => {
  it("counts only non-archived agents — what the header reports", () => {
    const agents = [
      { archived_at: null },
      { archived_at: "2026-09-05T00:00:00Z" },
      { archived_at: null },
    ];
    expect(activeAgents(agents)).toHaveLength(2);
  });
});

describe("scheduleToneFor", () => {
  const today = "2026-09-18";

  it("flags a past date as overdue", () => {
    expect(scheduleToneFor("2026-09-17", today)).toBe("overdue");
  });

  it("flags today as due today", () => {
    expect(scheduleToneFor(today, today)).toBe("today");
  });

  it("treats anything later as upcoming", () => {
    expect(scheduleToneFor("2026-09-19", today)).toBe("upcoming");
  });

  it("compares calendar dates, not instants — no timezone drift", () => {
    // Both arguments are yyyy-mm-dd in the app timezone, so a rep in a
    // different zone sees the same tone as the server would compute.
    expect(scheduleToneFor("2026-12-31", "2027-01-01")).toBe("overdue");
    expect(scheduleToneFor("2027-01-01", "2026-12-31")).toBe("upcoming");
  });
});

describe("sortAgentsByFollowUp", () => {
  const agent = (name: string, date: string | null) => ({
    agent_name: name,
    next_activity: date ? { scheduled_for: date } : null,
  });

  it("puts the soonest follow-up first and unscheduled agents last", () => {
    const sorted = sortAgentsByFollowUp([
      agent("Nothing Scheduled", null),
      agent("Next Week", "2026-09-25"),
      agent("Overdue", "2026-09-01"),
      agent("Today", "2026-09-18"),
    ]);
    expect(sorted.map((a) => a.agent_name)).toEqual([
      "Overdue",
      "Today",
      "Next Week",
      "Nothing Scheduled",
    ]);
  });

  it("breaks ties by name so the order is stable between renders", () => {
    const sorted = sortAgentsByFollowUp([
      agent("Zoe", "2026-09-20"),
      agent("Adam", "2026-09-20"),
      agent("Mia", null),
      agent("Bo", null),
    ]);
    expect(sorted.map((a) => a.agent_name)).toEqual([
      "Adam",
      "Zoe",
      "Bo",
      "Mia",
    ]);
  });

  it("does not mutate the input array", () => {
    const input = [agent("Zoe", "2026-09-20"), agent("Adam", "2026-09-19")];
    sortAgentsByFollowUp(input);
    expect(input.map((a) => a.agent_name)).toEqual(["Zoe", "Adam"]);
  });
});

// Regression coverage for validation and date-only rendering across time zones.
describe("Gold List validation", () => {
  it("accepts leap days only in leap years and requires descriptions", async () => {
    const { dateSchema, descriptionSchema } =
      await import("./gold-list-validation");
    expect(dateSchema.safeParse("2024-02-29").success).toBe(true);
    expect(dateSchema.safeParse("2025-02-29").success).toBe(false);
    expect(dateSchema.safeParse("2026-02-30").success).toBe(false);
    expect(descriptionSchema.safeParse("  ").success).toBe(false);
  });

  it("normalizes contact matches without claiming uncertain names are unique", async () => {
    const { possibleDuplicate } = await import("./gold-list-validation");
    expect(
      possibleDuplicate(
        { agent_name: "Dana Reed", phone: "+1 (303) 555-1234" },
        { agent_name: "D. Reed", phone: "3035551234" },
      ),
    ).toBe(true);
    expect(
      possibleDuplicate(
        { agent_name: "Dána Reed" },
        { agent_name: "Reed, Dana" },
      ),
    ).toBe(true);
    expect(
      possibleDuplicate(
        { agent_name: "Dana Reed", email: " DANA@example.com " },
        { agent_name: "Someone else", email: "dana@example.com" },
      ),
    ).toBe(true);
    expect(
      possibleDuplicate(
        { agent_name: "Dana Reed" },
        { agent_name: "Alex Smith" },
      ),
    ).toBe(false);
  });

  it("keeps due dates on the same calendar day in eastern and western time zones", async () => {
    const { formatDateMDY } = await import("./dates");
    const original = process.env.TZ;
    try {
      for (const zone of [
        "America/Denver",
        "Pacific/Honolulu",
        "Pacific/Kiritimati",
        "UTC",
      ]) {
        process.env.TZ = zone;
        expect(formatDateMDY("2026-03-08")).toBe("03-08-2026");
        expect(formatDateMDY("2026-11-01")).toBe("11-01-2026");
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** A board row, trimmed to the fields the controls actually read. */
function agentRow(over: Partial<Row> = {}): Row {
  return {
    id: "agent-1",
    agent_name: "Dana Reed",
    brokerage: "Summit Realty",
    phone: "(303) 555-0147",
    email: "dana@summitrealty.com",
    next_activity: null,
    ...over,
  };
}

type Row = {
  id: string;
  agent_name: string;
  brokerage: string | null;
  phone: string | null;
  email: string | null;
  next_activity: { scheduled_for: string } | null;
};

describe("searchableDigits", () => {
  it("reduces common phone formats to the same digits", () => {
    const canonical = "3035550147";
    for (const written of [
      "(303) 555-0147",
      "303-555-0147",
      "303.555.0147",
      "303 555 0147",
      "+1 303 555 0147",
      "1-303-555-0147",
      "3035550147",
    ]) {
      expect(searchableDigits(written)).toBe(canonical);
    }
  });

  it("keeps a leading 1 that is part of a shorter fragment", () => {
    // Only a full 11-digit US number sheds its country code; "1555" is a
    // fragment someone typed and must stay intact for substring matching.
    expect(searchableDigits("1555")).toBe("1555");
  });
});

describe("matchesAgentSearch", () => {
  const agent = agentRow();

  it("matches an empty or whitespace query — no search means no filter", () => {
    expect(matchesAgentSearch(agent, "")).toBe(true);
    expect(matchesAgentSearch(agent, "   ")).toBe(true);
  });

  it("matches the agent name, case-insensitively and partially", () => {
    expect(matchesAgentSearch(agent, "dana")).toBe(true);
    expect(matchesAgentSearch(agent, "REED")).toBe(true);
    expect(matchesAgentSearch(agent, "na re")).toBe(true);
  });

  it("matches the brokerage", () => {
    expect(matchesAgentSearch(agent, "summit")).toBe(true);
    expect(matchesAgentSearch(agent, "REALTY")).toBe(true);
  });

  it("matches the email", () => {
    expect(matchesAgentSearch(agent, "dana@summit")).toBe(true);
    expect(matchesAgentSearch(agent, "SUMMITREALTY.COM")).toBe(true);
  });

  it("matches the phone however either side is punctuated", () => {
    for (const typed of [
      "3035550147",
      "303-555-0147",
      "(303) 555-0147",
      "+1 303 555 0147",
      "5550147",
      "303",
    ]) {
      expect(matchesAgentSearch(agent, typed)).toBe(true);
    }
  });

  it("does not match an unrelated term", () => {
    expect(matchesAgentSearch(agent, "kennedy")).toBe(false);
    expect(matchesAgentSearch(agent, "7185551234")).toBe(false);
  });

  it("handles agents with missing contact fields", () => {
    const sparse = agentRow({ brokerage: null, phone: null, email: null });
    expect(matchesAgentSearch(sparse, "dana")).toBe(true);
    expect(matchesAgentSearch(sparse, "summit")).toBe(false);
    expect(matchesAgentSearch(sparse, "303")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Status filters
// ---------------------------------------------------------------------------

describe("matchesStatusFilter", () => {
  const today = "2026-09-18";
  const overdue = agentRow({ next_activity: { scheduled_for: "2026-09-10" } });
  const dueToday = agentRow({ next_activity: { scheduled_for: today } });
  const upcoming = agentRow({ next_activity: { scheduled_for: "2026-09-25" } });
  const unscheduled = agentRow({ next_activity: null });

  it("passes everything through on All — the default", () => {
    expect(DEFAULT_GOLD_LIST_STATUS_FILTER).toBe("all");
    for (const agent of [overdue, dueToday, upcoming, unscheduled]) {
      expect(matchesStatusFilter(agent, "all", today)).toBe(true);
    }
  });

  it("Overdue keeps only past due dates", () => {
    expect(matchesStatusFilter(overdue, "overdue", today)).toBe(true);
    expect(matchesStatusFilter(dueToday, "overdue", today)).toBe(false);
    expect(matchesStatusFilter(upcoming, "overdue", today)).toBe(false);
    expect(matchesStatusFilter(unscheduled, "overdue", today)).toBe(false);
  });

  it("Due Today keeps only today's date, by business-timezone calendar day", () => {
    expect(matchesStatusFilter(dueToday, "today", today)).toBe(true);
    expect(matchesStatusFilter(overdue, "today", today)).toBe(false);
    expect(matchesStatusFilter(upcoming, "today", today)).toBe(false);
    expect(matchesStatusFilter(unscheduled, "today", today)).toBe(false);
  });

  it("No Next Activity keeps only agents with nothing scheduled", () => {
    expect(matchesStatusFilter(unscheduled, "none", today)).toBe(true);
    expect(matchesStatusFilter(overdue, "none", today)).toBe(false);
    expect(matchesStatusFilter(dueToday, "none", today)).toBe(false);
    expect(matchesStatusFilter(upcoming, "none", today)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe("sortAgentsByName", () => {
  it("sorts A–Z ignoring case", () => {
    const sorted = sortAgentsByName([
      agentRow({ id: "1", agent_name: "zoe adams" }),
      agentRow({ id: "2", agent_name: "Adam Zeller" }),
      agentRow({ id: "3", agent_name: "mia Brooks" }),
    ]);
    expect(sorted.map((a) => a.agent_name)).toEqual([
      "Adam Zeller",
      "mia Brooks",
      "zoe adams",
    ]);
  });

  it("is stable for identical names, keyed on id", () => {
    const sorted = sortAgentsByName([
      agentRow({ id: "b", agent_name: "Dana Reed" }),
      agentRow({ id: "a", agent_name: "dana reed" }),
    ]);
    expect(sorted.map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("ignores due dates entirely", () => {
    const sorted = sortAgentsByName([
      agentRow({
        id: "1",
        agent_name: "Zoe",
        next_activity: { scheduled_for: "2026-01-01" },
      }),
      agentRow({ id: "2", agent_name: "Adam", next_activity: null }),
    ]);
    expect(sorted.map((a) => a.agent_name)).toEqual(["Adam", "Zoe"]);
  });

  it("does not mutate the input", () => {
    const input = [
      agentRow({ id: "1", agent_name: "Zoe" }),
      agentRow({ id: "2", agent_name: "Adam" }),
    ];
    sortAgentsByName(input);
    expect(input.map((a) => a.agent_name)).toEqual(["Zoe", "Adam"]);
  });
});

describe("sortAgents", () => {
  const rows = [
    agentRow({
      id: "1",
      agent_name: "Zoe",
      next_activity: { scheduled_for: "2026-09-10" },
    }),
    agentRow({ id: "2", agent_name: "Adam", next_activity: null }),
  ];

  it("defaults to due date, which keeps the urgent row first", () => {
    expect(DEFAULT_GOLD_LIST_SORT).toBe("due_date");
    expect(
      sortAgents(rows, DEFAULT_GOLD_LIST_SORT).map((a) => a.agent_name),
    ).toEqual(["Zoe", "Adam"]);
  });

  it("switches to alphabetical on request", () => {
    expect(sortAgents(rows, "agent_name").map((a) => a.agent_name)).toEqual([
      "Adam",
      "Zoe",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The three controls together
// ---------------------------------------------------------------------------

describe("visibleAgents", () => {
  const today = "2026-09-18";
  const roster = [
    agentRow({
      id: "1",
      agent_name: "Dana Reed",
      brokerage: "Summit Realty",
      phone: "(303) 555-0147",
      next_activity: { scheduled_for: "2026-09-10" }, // overdue
    }),
    agentRow({
      id: "2",
      agent_name: "Alex Stone",
      brokerage: "Summit Realty",
      phone: null,
      email: "alex@stone.example",
      next_activity: { scheduled_for: today }, // due today
    }),
    agentRow({
      id: "3",
      agent_name: "Kelly Nguyen",
      brokerage: "Peak Group",
      phone: "720-555-9000",
      email: null,
      next_activity: { scheduled_for: "2026-10-02" }, // upcoming
    }),
    agentRow({
      id: "4",
      agent_name: "Bo Carter",
      brokerage: null,
      phone: null,
      email: null,
      next_activity: null, // nothing scheduled
    }),
  ];
  const base = {
    query: "",
    status: DEFAULT_GOLD_LIST_STATUS_FILTER,
    sort: DEFAULT_GOLD_LIST_SORT,
    todayIso: today,
  } as const;

  it("defaults to overdue, today, upcoming, then unscheduled", () => {
    expect(visibleAgents(roster, base).map((a) => a.agent_name)).toEqual([
      "Dana Reed",
      "Alex Stone",
      "Kelly Nguyen",
      "Bo Carter",
    ]);
  });

  it("combines a brokerage search with alphabetical sort", () => {
    const shown = visibleAgents(roster, {
      ...base,
      query: "summit",
      sort: "agent_name",
    });
    expect(shown.map((a) => a.agent_name)).toEqual(["Alex Stone", "Dana Reed"]);
  });

  it("combines a status filter with a search", () => {
    expect(
      visibleAgents(roster, {
        ...base,
        query: "summit",
        status: "overdue",
      }).map((a) => a.agent_name),
    ).toEqual(["Dana Reed"]);
    expect(
      visibleAgents(roster, { ...base, query: "summit", status: "today" }).map(
        (a) => a.agent_name,
      ),
    ).toEqual(["Alex Stone"]);
  });

  it("finds an agent by a differently formatted phone number", () => {
    expect(
      visibleAgents(roster, { ...base, query: "(720) 555-9000" }).map(
        (a) => a.agent_name,
      ),
    ).toEqual(["Kelly Nguyen"]);
  });

  it("returns nothing when a search matches no one — without changing the roster", () => {
    expect(visibleAgents(roster, { ...base, query: "nobody" })).toEqual([]);
    // The full list is untouched, which is what the header count reports.
    expect(
      activeAgents(roster.map((a) => ({ ...a, archived_at: null }))),
    ).toHaveLength(4);
  });

  it("keeps the header count independent of what is visible", () => {
    const withArchiveFlag = roster.map((a) => ({ ...a, archived_at: null }));
    const shown = visibleAgents(withArchiveFlag, {
      ...base,
      status: "overdue",
    });
    expect(shown).toHaveLength(1);
    // The board reads activeAgents(...) for the header, never the filtered set.
    expect(agentCountLabel(activeAgents(withArchiveFlag).length)).toBe(
      "4 agents",
    );
  });
});

describe("enhancement review regressions", () => {
  it("does not treat digits embedded in unrelated email/text as a phone query", () => {
    const agent = { agent_name: "Dana", phone: "303-555-0147" };
    expect(matchesAgentSearch(agent, "unrelated303@example.com")).toBe(false);
    expect(matchesAgentSearch(agent, "address 555")).toBe(false);
    expect(matchesAgentSearch(agent, "(303) 555")).toBe(true);
  });

  it("searches punctuation literally and sorts blank and unusual names safely", () => {
    const rows = ["", "Élodie", "李 四", "[Dana]", "  "].map(
      (agent_name, id) => ({ id: String(id), agent_name, next_activity: null }),
    );
    expect(sortAgentsByName(rows)).toHaveLength(5);
    expect(rows.filter((a) => matchesAgentSearch(a, "["))).toHaveLength(1);
    expect(rows.filter((a) => matchesAgentSearch(a, ".*"))).toHaveLength(0);
  });

  it("uses the Denver business day across UTC and local midnight boundaries", async () => {
    const { todayInAppTimezone } = await import("./dates");
    const { format } = await import("date-fns");
    const row = { next_activity: { scheduled_for: "2026-09-18" } };
    for (const [now, expected] of [
      ["2026-09-19T05:59:59Z", "today"],
      ["2026-09-19T06:00:00Z", "overdue"],
    ] as const) {
      const today = format(todayInAppTimezone(new Date(now)), "yyyy-MM-dd");
      expect(matchesStatusFilter(row, expected, today)).toBe(true);
    }
  });
});
