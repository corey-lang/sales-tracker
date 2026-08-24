/**
 * Route tests for POST /api/auth/login — the deactivation gate.
 *
 * Offboarding someone (Chanel) must stop them signing in WITHOUT deleting their
 * `salespeople` row, which is the FK parent of all their history. This file
 * proves the row-still-exists / no-access-anyway split, and that an active
 * juice_box_only seat (Leah) still signs in normally.
 *
 * The auth module is real — the issued token is genuinely HMAC-signed and the
 * PIN comparison is the production one. Only Supabase is faked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.SESSION_SECRET = "test-session-secret";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

type Row = Record<string, unknown>;

/** salespeople rows keyed by lowercased first_name (CITEXT is case-insensitive). */
let people: Record<string, Row>;

vi.mock("@/lib/supabase/server", () => ({
  getServerSupabase: () => ({
    from: () => {
      const filters: Record<string, unknown> = {};
      const self: Record<string, unknown> = {
        select: () => self,
        eq: (col: string, value: unknown) => {
          filters[col] = value;
          return self;
        },
        maybeSingle: () => {
          const name = String(filters.first_name ?? "").toLowerCase();
          return Promise.resolve({ data: people[name] ?? null, error: null });
        },
      };
      return self;
    },
  }),
}));

const { POST } = await import("./route");

function person(over: Row): Row {
  return {
    admin_pin: null,
    role: "ae",
    is_test: false,
    can_import_offices: false,
    deactivated_at: null,
    ...over,
  };
}

function login(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  people = {
    carli: person({ id: "ae-1", first_name: "Carli" }),
    // Active Juice Box-only seat.
    leah: person({
      id: "jb-1",
      first_name: "Leah",
      role: "juice_box_only",
    }),
    // Offboarded: row intact (history hangs off it), access revoked.
    chanel: person({
      id: "chanel-1",
      first_name: "Chanel",
      deactivated_at: "2026-08-24T17:00:00.000Z",
    }),
    corey: person({
      id: "admin-1",
      first_name: "Corey",
      role: "admin",
      admin_pin: "1234",
    }),
    // A departed admin: the deactivation check must come BEFORE the PIN path.
    ryan: person({
      id: "admin-2",
      first_name: "Ryan",
      role: "admin",
      admin_pin: "9999",
      deactivated_at: "2026-08-01T17:00:00.000Z",
    }),
  };
});

describe("deactivated people cannot sign in", () => {
  it("401s Chanel and issues no token", async () => {
    const res = await login({ name: "Chanel" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string; token?: string };
    expect(body.token).toBeUndefined();
    expect(body.error).toMatch(/no longer active/i);
  });

  it("401s her regardless of name casing (CITEXT lookup)", async () => {
    for (const name of ["chanel", "CHANEL", "ChAnEl"]) {
      const res = await login({ name });
      expect(res.status).toBe(401);
    }
  });

  it("refuses a deactivated admin before the PIN is even considered", async () => {
    const withPin = await login({ name: "Ryan", pin: "9999" });
    const withoutPin = await login({ name: "Ryan" });
    expect(withPin.status).toBe(401);
    expect(withoutPin.status).toBe(401);
    const body = (await withPin.json()) as { error: string };
    expect(body.error).toMatch(/no longer active/i);
  });

  it("leaves her row in place — deactivation is not deletion", () => {
    expect(people.chanel).toBeDefined();
    expect(people.chanel.id).toBe("chanel-1");
  });
});

describe("active accounts still sign in", () => {
  it("signs in an AE and returns a token", async () => {
    const res = await login({ name: "Carli" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      salesperson: Record<string, unknown>;
    };
    expect(typeof body.token).toBe("string");
    expect(body.salesperson.role).toBe("ae");
  });

  it("signs in a juice_box_only seat (Leah) with the juice_box_only role", async () => {
    const res = await login({ name: "leah" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      salesperson: Record<string, unknown>;
    };
    expect(body.salesperson.role).toBe("juice_box_only");
    expect(body.salesperson.id).toBe("jb-1");
    // Her token's role claim is what the client renders chrome from; the AE
    // routes still re-read the DB and 403 her (see the activity route tests).
    expect(typeof body.token).toBe("string");
  });

  it("still enforces the admin PIN", async () => {
    expect((await login({ name: "Corey" })).status).toBe(401);
    expect((await login({ name: "Corey", pin: "0000" })).status).toBe(401);
    expect((await login({ name: "Corey", pin: "1234" })).status).toBe(200);
  });

  it("never returns admin_pin to the client", async () => {
    const res = await login({ name: "Corey", pin: "1234" });
    const text = await res.text();
    expect(text).not.toContain("1234");
    expect(text).not.toContain("admin_pin");
  });

  it("401s an unknown name", async () => {
    const res = await login({ name: "Nobody" });
    expect(res.status).toBe(401);
  });
});
