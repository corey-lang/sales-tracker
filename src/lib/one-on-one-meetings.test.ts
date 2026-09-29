import { describe, expect, it } from "vitest";

import {
  carryoverFor,
  endOfActivityWeek,
  goldListReviewBucket,
  matchesGoldListReviewFilter,
  resolutionFor,
  sortGoldListForReview,
  summarizeGoldListForReview,
  type MeetingCommitmentWithOrigin,
} from "@/lib/one-on-one-meetings";

// Pure rules behind the 1:1 workspace: Gold List review order and commitment
// carryover/resolution. (The completion snapshot is SQL — see
// supabase/one-on-one-meetings-db.test.ts.)

const TODAY = "2026-09-29"; // Tuesday; activity week ends Sat 2026-10-03

const agent = (name: string, due: string | null) => ({
  id: name,
  agent_name: name,
  next_activity: due ? { scheduled_for: due } : null,
});

describe("Gold List review ordering", () => {
  it("ends the review week on the activity week's Saturday", () => {
    expect(endOfActivityWeek("2026-09-29")).toBe("2026-10-03");
    expect(endOfActivityWeek("2026-10-03")).toBe("2026-10-03");
    expect(endOfActivityWeek("2026-09-27")).toBe("2026-10-03"); // Sunday
  });

  it("buckets overdue, no-next, due-this-week and later", () => {
    expect(goldListReviewBucket(agent("a", "2026-09-28"), TODAY)).toBe("overdue");
    expect(goldListReviewBucket(agent("a", null), TODAY)).toBe("no_next");
    expect(goldListReviewBucket(agent("a", TODAY), TODAY)).toBe("due_this_week");
    expect(goldListReviewBucket(agent("a", "2026-10-03"), TODAY)).toBe("due_this_week");
    expect(goldListReviewBucket(agent("a", "2026-10-04"), TODAY)).toBe("later");
  });

  it("orders overdue → no next activity → due this week → the rest", () => {
    const sorted = sortGoldListForReview(
      [
        agent("Later", "2026-10-20"),
        agent("Soon", "2026-10-01"),
        agent("NoNext", null),
        agent("Overdue2", "2026-09-25"),
        agent("Overdue1", "2026-09-10"),
        agent("Today", TODAY),
      ],
      TODAY,
    ).map((a) => a.agent_name);
    expect(sorted).toEqual([
      "Overdue1",
      "Overdue2",
      "NoNext",
      "Today",
      "Soon",
      "Later",
    ]);
  });

  it("summarizes the counts shown at the top of the section", () => {
    expect(
      summarizeGoldListForReview(
        [
          agent("a", "2026-09-01"),
          agent("b", null),
          agent("c", null),
          agent("d", "2026-10-02"),
          agent("e", "2026-11-01"),
        ],
        TODAY,
      ),
    ).toEqual({ total: 5, overdue: 1, no_next: 2, due_this_week: 1 });
  });

  it("filters Needs attention / Upcoming / All", () => {
    const rows = [agent("o", "2026-09-01"), agent("n", null), agent("u", "2026-10-01"), agent("l", "2026-12-01")];
    const names = (f: "attention" | "upcoming" | "all") =>
      rows.filter((r) => matchesGoldListReviewFilter(r, f, TODAY)).map((r) => r.id);
    expect(names("attention")).toEqual(["o", "n"]);
    expect(names("upcoming")).toEqual(["u"]);
    expect(names("all")).toEqual(["o", "n", "u", "l"]);
  });
});

function commitment(over: Partial<MeetingCommitmentWithOrigin>): MeetingCommitmentWithOrigin {
  return {
    id: "c1",
    ae_id: "ae",
    origin_meeting_id: "m1",
    origin_meeting_date: "2026-09-15",
    description: "Follow up with Sarah",
    owner: "ae",
    due_date: null,
    status: "open",
    completed_at: null,
    resolved_in_meeting_id: null,
    created_at: "2026-09-15T16:00:00Z",
    updated_at: "2026-09-15T16:00:00Z",
    ...over,
  };
}

describe("commitment carryover", () => {
  it("carries open commitments from earlier meetings, not this meeting's own", () => {
    const rows = [
      commitment({ id: "old-open" }),
      commitment({ id: "old-done", status: "completed", completed_at: "x" }),
      commitment({ id: "mine", origin_meeting_id: "m2" }),
    ];
    expect(carryoverFor(rows, "m2").map((c) => c.id)).toEqual(["old-open"]);
  });

  it("keeps a carryover resolved IN this meeting on the list (checked off)", () => {
    const rows = [
      commitment({ id: "resolved-here", status: "completed", completed_at: "x", resolved_in_meeting_id: "m2" }),
      commitment({ id: "resolved-elsewhere", status: "completed", completed_at: "x", resolved_in_meeting_id: "m9" }),
    ];
    expect(carryoverFor(rows, "m2").map((c) => c.id)).toEqual(["resolved-here"]);
  });

  it("before a meeting starts, carryover is simply everything open", () => {
    const rows = [commitment({ id: "a" }), commitment({ id: "b", status: "dropped" })];
    expect(carryoverFor(rows, null).map((c) => c.id)).toEqual(["a"]);
  });

  it("records the resolving meeting only for carryover, and clears it on reopen", () => {
    expect(resolutionFor({ origin_meeting_id: "m1" }, "completed", "m2")).toBe("m2");
    expect(resolutionFor({ origin_meeting_id: "m1" }, "dropped", "m2")).toBe("m2");
    expect(resolutionFor({ origin_meeting_id: "m2" }, "completed", "m2")).toBeNull();
    expect(resolutionFor({ origin_meeting_id: "m1" }, "open", "m2")).toBeNull();
  });
});
