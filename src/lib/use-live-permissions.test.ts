/**
 * Tests for the access-gate decision behind the dashboard's fail-closed state.
 *
 * THE BUG THIS PINS
 *   A stale localhost session token (expired, or signed with a different
 *   SESSION_SECRET / service-role key than the local env now uses) makes
 *   GET /api/me/permissions answer 401. The dashboard then rendered
 *   "Couldn't verify your access." and stopped — technically honest, but a dead
 *   end: nothing was wrong except that the user needed to sign in again.
 *
 *   401 is now routed to the sign-in screen, while a NON-auth failure (5xx,
 *   offline) still shows an error — because telling someone to sign in again
 *   when the server is erroring sends them in a circle. Neither case hides a
 *   genuine authentication failure; they just get told the right thing.
 */

import { describe, expect, it } from "vitest";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const { accessGateFrom } = await import("@/lib/use-live-permissions");

const OK = { role: "ae" as const, can_import_offices: false };

describe("accessGateFrom", () => {
  it("waits while the check is in flight", () => {
    expect(accessGateFrom({ loaded: false, permissions: null, status: null })).toBe(
      "loading",
    );
    // Even a resolved-looking status doesn't count until loaded flips.
    expect(accessGateFrom({ loaded: false, permissions: null, status: 401 })).toBe(
      "loading",
    );
  });

  it("is ok when permissions came back", () => {
    expect(accessGateFrom({ loaded: true, permissions: OK, status: 200 })).toBe(
      "ok",
    );
  });

  it("treats 401 as an EXPIRED session (→ sign in again)", () => {
    expect(accessGateFrom({ loaded: true, permissions: null, status: 401 })).toBe(
      "expired",
    );
  });

  it("treats a server failure as an ERROR, not an auth problem", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(accessGateFrom({ loaded: true, permissions: null, status })).toBe(
        "error",
      );
    }
  });

  it("treats a request that never completed (offline) as an ERROR", () => {
    // status stays null when fetch throws — redirecting to sign-in here would
    // be wrong: the session may be perfectly valid.
    expect(accessGateFrom({ loaded: true, permissions: null, status: null })).toBe(
      "error",
    );
  });

  it("does not treat 403 as expired", () => {
    // 403 means "signed in, not allowed" — a different situation from a dead
    // session, and re-signing in wouldn't change it.
    expect(accessGateFrom({ loaded: true, permissions: null, status: 403 })).toBe(
      "error",
    );
  });

  it("prefers permissions over any status", () => {
    // Defensive: if a payload arrived, use it regardless of a stale status.
    expect(accessGateFrom({ loaded: true, permissions: OK, status: 401 })).toBe(
      "ok",
    );
  });
});
