import { describe, expect, it } from "vitest";

import {
  SWAG_METRIC_KEYS,
  applyFilters,
  computeMetrics,
  leadAttention,
  matchesMetric,
  sortLeads,
  type SwagLead,
  type SwagLeadView,
} from "@/lib/swag-leads";
import { createLeadSchema, transferSchema, updateLeadSchema } from "@/lib/swag-leads-validation";

let n = 0;
function lead(over: Partial<SwagLead> = {}): SwagLeadView {
  n += 1;
  const base: SwagLead = {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name: `Lead ${n}`,
    contact_info: null,
    confirmed_realtor: false,
    transactions_last_12_months: null,
    date_lead_received: "2026-09-01",
    date_first_contact: null,
    follow_up_attempts: 0,
    swag_delivered: false,
    met_in_person: false,
    orders_received: false,
    orders_count: null,
    notes: null,
    assigned_to: "11111111-1111-4111-8111-111111111111",
    is_ooa: false,
    is_test_data: false,
    revision: 0,
    created_by: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...over,
  };
  return { ...base, assigned_label: base.is_ooa ? "OOA" : "Hilary", territories: [], attention: leadAttention(base) };
}

describe("metric predicates", () => {
  const pool = [
    lead(),
    lead({ date_first_contact: "2026-09-02" }),
    lead({ date_first_contact: "2026-09-02", follow_up_attempts: 2, met_in_person: true }),
    lead({ date_first_contact: "2026-09-02", follow_up_attempts: 1, swag_delivered: true, orders_received: true, orders_count: 3 }),
    lead({ orders_received: true }), // yes, count unknown
    lead({ assigned_to: null, is_ooa: true }),
    lead({ assigned_to: null, is_ooa: true, date_first_contact: "2026-09-04", met_in_person: true }),
  ];

  it("contacted and needs-first-contact partition the leads (each lead in exactly one)", () => {
    for (const l of pool) {
      expect(matchesMetric(l, "needs_first_contact")).toBe(!matchesMetric(l, "contacted"));
    }
    const m = computeMetrics(pool);
    expect(m.needs_first_contact + m.contacted).toBe(m.total);
  });

  it("every metric's count equals the number of leads its predicate selects", () => {
    const m = computeMetrics(pool);
    const counts: Record<string, number> = {
      total: m.total, needs_first_contact: m.needs_first_contact, contacted: m.contacted,
      followed_up: m.followed_up, no_follow_up: m.no_follow_up, met_in_person: m.met_in_person,
      swag_delivered: m.swag_delivered, with_orders: m.agents_with_orders, ooa: m.ooa,
    };
    for (const key of SWAG_METRIC_KEYS) {
      expect(pool.filter((l) => matchesMetric(l, key)).length, key).toBe(counts[key]);
    }
  });

  it("orders: agents-with-orders follows 'Any orders received?', total follows 'How many?'", () => {
    const m = computeMetrics(pool);
    expect(m.agents_with_orders).toBe(2);
    expect(m.total_orders).toBe(3); // the "yes, unknown count" lead adds 0
  });

  it("no_follow_up is 'contacted, zero follow-ups'; follow-up activity sums the attempts", () => {
    const m = computeMetrics(pool);
    expect(m.no_follow_up).toBe(2); // the contacted lead with 0 follow-ups, and the contacted OOA lead
    expect(m.follow_up_attempts).toBe(3);
    expect(m.followed_up).toBe(2);
  });

  it("an empty set is all zeros, never NaN", () => {
    expect(Object.values(computeMetrics([])).every((v) => v === 0)).toBe(true);
  });

  it("attention: never contacted, then contacted-without-follow-up, then nothing", () => {
    expect(leadAttention({ date_first_contact: null, follow_up_attempts: 0 })).toBe("needs_first_contact");
    expect(leadAttention({ date_first_contact: null, follow_up_attempts: 5 })).toBe("needs_first_contact");
    expect(leadAttention({ date_first_contact: "2026-09-02", follow_up_attempts: 0 })).toBe("needs_follow_up");
    expect(leadAttention({ date_first_contact: "2026-09-02", follow_up_attempts: 1 })).toBeNull();
  });
});

describe("filters and ordering", () => {
  it("search is case-insensitive over name and contact info; yes/no filters and date range work", () => {
    const a = lead({ name: "Dana Whitaker", contact_info: "dana@x.com", met_in_person: true, date_lead_received: "2026-09-10" });
    const b = lead({ name: "Sam", contact_info: "801-555-0100", date_lead_received: "2026-09-20" });
    expect(applyFilters([a, b], { q: "WHITAKER" })).toEqual([a]);
    expect(applyFilters([a, b], { q: "555-0100" })).toEqual([b]);
    expect(applyFilters([a, b], { met_in_person: "yes" })).toEqual([a]);
    expect(applyFilters([a, b], { met_in_person: "no" })).toEqual([b]);
    expect(applyFilters([a, b], { from: "2026-09-15" })).toEqual([b]);
    expect(applyFilters([a, b], { to: "2026-09-15" })).toEqual([a]);
    expect(applyFilters([a, b], {})).toEqual([a, b]);
  });

  it("territory matches the lead's (derived) territories", () => {
    const a = { ...lead(), territories: ["Davis"] };
    const b = { ...lead(), territories: [] };
    expect(applyFilters([a, b], { territory: "Davis" })).toEqual([a]);
  });

  it("attention leads first (oldest waiting first), then the rest newest first", () => {
    const worked = lead({ name: "worked", date_first_contact: "2026-09-02", follow_up_attempts: 1, date_lead_received: "2026-09-01" });
    const fresh = lead({ name: "fresh", date_lead_received: "2026-09-20" });
    const old = lead({ name: "old", date_lead_received: "2026-09-03" });
    const nofu = lead({ name: "nofu", date_first_contact: "2026-09-06", date_lead_received: "2026-09-05" });
    const done = lead({ name: "done", date_first_contact: "2026-09-12", follow_up_attempts: 2, date_lead_received: "2026-09-11" });
    expect(sortLeads([worked, fresh, old, nofu, done]).map((l) => l.name)).toEqual(["old", "fresh", "nofu", "done", "worked"]);
  });
});

describe("request validation", () => {
  const ok = { name: "Dana" };
  it("accepts a name alone; trims it; rejects blanks and unknown keys (no order-workflow fields)", () => {
    expect(createLeadSchema.safeParse(ok).success).toBe(true);
    expect(createLeadSchema.safeParse({ name: "  Dana  " }).data?.name).toBe("Dana");
    expect(createLeadSchema.safeParse({ name: " " }).success).toBe(false);
    for (const extra of ["status", "tracking_number", "vendor", "shipped", "quantity", "approved"]) {
      expect(createLeadSchema.safeParse({ ...ok, [extra]: "x" }).success, extra).toBe(false);
    }
  });

  it("rejects negative / fractional counts and orders counted without 'received'", () => {
    expect(createLeadSchema.safeParse({ ...ok, orders_count: -1 }).success).toBe(false);
    expect(createLeadSchema.safeParse({ ...ok, orders_count: 1.5 }).success).toBe(false);
    expect(createLeadSchema.safeParse({ ...ok, follow_up_attempts: -1 }).success).toBe(false);
    expect(createLeadSchema.safeParse({ ...ok, orders_count: 2, orders_received: false }).success).toBe(false);
    expect(createLeadSchema.safeParse({ ...ok, orders_count: 2, orders_received: true }).success).toBe(true);
    expect(createLeadSchema.safeParse({ ...ok, orders_received: true }).success).toBe(true); // yes, count unknown
  });

  it("rejects impossible dates and first contact before received", () => {
    expect(createLeadSchema.safeParse({ ...ok, date_lead_received: "2026-02-30" }).success).toBe(false);
    expect(createLeadSchema.safeParse({ ...ok, date_lead_received: "yesterday" }).success).toBe(false);
    expect(
      createLeadSchema.safeParse({ ...ok, date_lead_received: "2026-09-10", date_first_contact: "2026-09-09" }).success,
    ).toBe(false);
    expect(
      createLeadSchema.safeParse({ ...ok, date_lead_received: "2026-01-10", date_first_contact: "2026-01-10" }).success,
    ).toBe(true);
  });

  it("update: needs a revision and at least one editable field; assignment is not a field", () => {
    expect(updateLeadSchema.safeParse({ expected_revision: 0, patch: { notes: "x" } }).success).toBe(true);
    expect(updateLeadSchema.safeParse({ patch: { notes: "x" } }).success).toBe(false);
    expect(updateLeadSchema.safeParse({ expected_revision: 0, patch: {} }).success).toBe(false);
    for (const f of ["assigned_to", "is_ooa", "revision", "created_by", "is_test_data"]) {
      expect(updateLeadSchema.safeParse({ expected_revision: 0, patch: { [f]: "x" } }).success, f).toBe(false);
    }
  });

  it("transfer: exactly one destination", () => {
    const ae = "11111111-1111-4111-8111-111111111111";
    expect(transferSchema.safeParse({ to_assigned_to: ae }).success).toBe(true);
    expect(transferSchema.safeParse({ to_ooa: true }).success).toBe(true);
    expect(transferSchema.safeParse({}).success).toBe(false);
    expect(transferSchema.safeParse({ to_ooa: true, to_assigned_to: ae }).success).toBe(false);
    expect(transferSchema.safeParse({ to_assigned_to: "nope" }).success).toBe(false);
    expect(transferSchema.safeParse({ to_ooa: true, reason: "x".repeat(501) }).success).toBe(false);
  });
});
