/**
 * Regression tests for the sign-in ⇄ dashboard redirect loop.
 *
 * THE BUG
 *   The sign-in screen redirected whenever a stored session OBJECT existed,
 *   without checking that it still worked, and the dashboard redirected back on
 *   401 without deleting the dead session. With a stale token the two bounced
 *   off each other forever and the name picker never became usable.
 *
 * WHAT IS PINNED HERE
 *   1. Presence alone never redirects — only a server-confirmed (200 + role)
 *      session does.
 *   2. A 401 clears the session exactly once and stays on sign-in.
 *   3. A non-401 failure neither clears nor redirects.
 *   4. The two screens cannot ping-pong: the loop is simulated end-to-end below.
 *   5. Only the auth key is removed from localStorage.
 */

import { beforeEach, describe, expect, it } from "vitest";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

// ---------------------------------------------------------------------------
// Minimal localStorage stand-in (jsdom is not configured in this project)
// ---------------------------------------------------------------------------

class FakeStorage {
  private map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  get keys() {
    return [...this.map.keys()].sort();
  }
}

let storage: FakeStorage;
beforeEach(() => {
  storage = new FakeStorage();
  (globalThis as { window?: unknown }).window = {
    localStorage: storage,
  } as unknown as Window & typeof globalThis;
});

const { sessionVerdict, verdictShouldClearSession, verdictShouldRedirect } =
  await import("@/lib/session-verification");
const { STORAGE_KEY, clearStoredSalesperson } = await import(
  "@/lib/use-salesperson"
);
const { accessGateFrom } = await import("@/lib/use-live-permissions");
const { landingPathFor } = await import("@/lib/role-routing");

const SESSION_JSON = JSON.stringify({
  id: "11111111-1111-4111-8111-111111111111",
  first_name: "Camille",
  role: "ae",
  token: "stale.token",
});

// ---------------------------------------------------------------------------

describe("sessionVerdict — presence is not proof", () => {
  it("shows a stable loading state before hydration", () => {
    expect(
      sessionVerdict({
        loaded: false,
        hasStoredSession: false,
        settled: false,
        status: null,
        role: null,
      }),
    ).toEqual({ kind: "verifying" });
  });

  it("shows the picker when nothing is stored", () => {
    expect(
      sessionVerdict({
        loaded: true,
        hasStoredSession: false,
        settled: false,
        status: null,
        role: null,
      }),
    ).toEqual({ kind: "no-session" });
  });

  it("waits — never redirects — while a stored session is unverified", () => {
    const verdict = sessionVerdict({
      loaded: true,
      hasStoredSession: true,
      settled: false,
      status: null,
      role: null,
    });
    expect(verdict).toEqual({ kind: "verifying" });
    // THE ORIGINAL BUG: this is the moment the old code redirected.
    expect(verdictShouldRedirect(verdict)).toBe(false);
  });

  it("redirects only on a server-confirmed session", () => {
    const verdict = sessionVerdict({
      loaded: true,
      hasStoredSession: true,
      settled: true,
      status: 200,
      role: "ae",
    });
    expect(verdict).toEqual({ kind: "valid", role: "ae" });
    expect(verdictShouldRedirect(verdict)).toBe(true);
    expect(verdictShouldClearSession(verdict)).toBe(false);
    expect(landingPathFor({ role: "ae" })).toBe("/dashboard");
  });

  it("sends a confirmed juice_box_only session to /juice-box", () => {
    const verdict = sessionVerdict({
      loaded: true,
      hasStoredSession: true,
      settled: true,
      status: 200,
      role: "juice_box_only",
    });
    expect(verdict).toEqual({ kind: "valid", role: "juice_box_only" });
    expect(landingPathFor({ role: "juice_box_only" })).toBe("/juice-box");
  });

  it("treats 401 as invalid: clear, do NOT redirect", () => {
    const verdict = sessionVerdict({
      loaded: true,
      hasStoredSession: true,
      settled: true,
      status: 401,
      role: null,
    });
    expect(verdict).toEqual({ kind: "invalid" });
    expect(verdictShouldClearSession(verdict)).toBe(true);
    expect(verdictShouldRedirect(verdict)).toBe(false);
  });

  it("treats a non-401 failure as unknown: neither clear nor redirect", () => {
    for (const status of [500, 502, 503, null]) {
      const verdict = sessionVerdict({
        loaded: true,
        hasStoredSession: true,
        settled: true,
        status,
        role: null,
      });
      expect(verdict).toEqual({ kind: "unknown" });
      expect(verdictShouldClearSession(verdict)).toBe(false);
      expect(verdictShouldRedirect(verdict)).toBe(false);
    }
  });

  it("does not redirect on a 200 with no usable role", () => {
    const verdict = sessionVerdict({
      loaded: true,
      hasStoredSession: true,
      settled: true,
      status: 200,
      role: null,
    });
    expect(verdict).toEqual({ kind: "unknown" });
    expect(verdictShouldRedirect(verdict)).toBe(false);
  });
});

describe("clearStoredSalesperson — scope and synchrony", () => {
  it("removes ONLY the auth session key", () => {
    storage.setItem(STORAGE_KEY, SESSION_JSON);
    storage.setItem("juice-box:feed:abc:general", '{"messages":[]}');
    storage.setItem("sales-tracker:map-visit-filter:abc", '{"filter":"all"}');
    storage.setItem("juice-box:quotes-seen", "[1,2]");
    storage.setItem("some-other-app", "keep me");

    clearStoredSalesperson();

    expect(storage.getItem(STORAGE_KEY)).toBeNull();
    expect(storage.keys).toEqual([
      "juice-box:feed:abc:general",
      "juice-box:quotes-seen",
      "sales-tracker:map-visit-filter:abc",
      "some-other-app",
    ]);
  });

  it("completes synchronously — the key is gone on the next line", () => {
    storage.setItem(STORAGE_KEY, SESSION_JSON);
    clearStoredSalesperson();
    // No await, no tick: a caller may navigate immediately after this.
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("is idempotent and safe when nothing is stored", () => {
    expect(() => {
      clearStoredSalesperson();
      clearStoredSalesperson();
    }).not.toThrow();
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end loop simulation
// ---------------------------------------------------------------------------

/**
 * Drives the two screens against each other the way the browser did, using the
 * REAL decision functions and a REAL storage stand-in. `permissionsStatus` is
 * what the server answers for the stored token.
 *
 * Returns the navigation trail, so a ping-pong shows up as a long trail.
 */
function simulate(opts: {
  storedSession: string | null;
  permissionsStatus: number | null;
  role?: "ae" | "juice_box_only" | "admin" | null;
  maxSteps?: number;
}) {
  const { storedSession, permissionsStatus, role = null } = opts;
  const maxSteps = opts.maxSteps ?? 12;
  if (storedSession) storage.setItem(STORAGE_KEY, storedSession);

  const trail: string[] = [];
  let route = "/";
  // Per-mount one-shot guards, reset on every navigation (a new mount).
  let redirected = false;
  let expiredHandled = false;

  for (let step = 0; step < maxSteps; step += 1) {
    const stored = storage.getItem(STORAGE_KEY);
    const hasStoredSession = stored !== null;

    if (route === "/") {
      const verdict = sessionVerdict({
        loaded: true,
        hasStoredSession,
        settled: true,
        status: hasStoredSession ? permissionsStatus : null,
        role,
      });
      if (verdictShouldClearSession(verdict)) clearStoredSalesperson();
      if (verdictShouldRedirect(verdict) && !redirected) {
        redirected = true;
        route = landingPathFor({ role: role ?? "ae" });
        trail.push(route);
        redirected = false; // new mount
        expiredHandled = false;
        continue;
      }
      // Settled on sign-in.
      return { trail, finalRoute: route, storageKeys: storage.keys, verdict };
    }

    // /dashboard
    if (!hasStoredSession) {
      route = "/";
      trail.push(route);
      continue;
    }
    const gate = accessGateFrom({
      loaded: true,
      permissions:
        permissionsStatus === 200 && role
          ? { role, can_import_offices: false }
          : null,
      status: permissionsStatus,
    });
    if (gate === "expired" && !expiredHandled) {
      expiredHandled = true;
      clearStoredSalesperson(); // BEFORE navigating — the fix
      route = "/";
      trail.push(route);
      continue;
    }
    return { trail, finalRoute: route, storageKeys: storage.keys, gate };
  }
  return { trail, finalRoute: route, storageKeys: storage.keys, loop: true };
}

describe("the sign-in ⇄ dashboard loop cannot happen", () => {
  it("stale token: 401 → cleared once → settles on sign-in", () => {
    const out = simulate({
      storedSession: SESSION_JSON,
      permissionsStatus: 401,
    });
    expect(out.finalRoute).toBe("/");
    expect(out.loop).toBeUndefined();
    // The dead session is gone, so nothing can trigger another redirect.
    expect(out.storageKeys).not.toContain(STORAGE_KEY);
    // ONE navigation at most — the old behaviour produced an endless trail.
    expect(out.trail.length).toBeLessThanOrEqual(1);
  });

  it("stale token entering from /dashboard also settles on sign-in", () => {
    storage.setItem(STORAGE_KEY, SESSION_JSON);
    const gate = accessGateFrom({
      loaded: true,
      permissions: null,
      status: 401,
    });
    expect(gate).toBe("expired");
    clearStoredSalesperson();
    // Sign-in now sees nothing at all.
    expect(
      sessionVerdict({
        loaded: true,
        hasStoredSession: storage.getItem(STORAGE_KEY) !== null,
        settled: true,
        status: null,
        role: null,
      }),
    ).toEqual({ kind: "no-session" });
  });

  it("valid token: one hop to the dashboard and it stays there", () => {
    const out = simulate({
      storedSession: SESSION_JSON,
      permissionsStatus: 200,
      role: "ae",
    });
    expect(out.finalRoute).toBe("/dashboard");
    expect(out.trail).toEqual(["/dashboard"]);
    // Session preserved — a working session is never cleared.
    expect(out.storageKeys).toContain(STORAGE_KEY);
  });

  it("no stored token: stays on a stable sign-in screen, no navigation", () => {
    const out = simulate({ storedSession: null, permissionsStatus: null });
    expect(out.finalRoute).toBe("/");
    expect(out.trail).toEqual([]);
  });

  it("server error: stays put, keeps the session, no loop", () => {
    const out = simulate({
      storedSession: SESSION_JSON,
      permissionsStatus: 503,
    });
    expect(out.finalRoute).toBe("/");
    expect(out.trail).toEqual([]);
    expect(out.loop).toBeUndefined();
    // NOT logged out for a server hiccup.
    expect(out.storageKeys).toContain(STORAGE_KEY);
  });

  it("offline: stays put, keeps the session, no loop", () => {
    const out = simulate({
      storedSession: SESSION_JSON,
      permissionsStatus: null,
    });
    expect(out.finalRoute).toBe("/");
    expect(out.trail).toEqual([]);
    expect(out.storageKeys).toContain(STORAGE_KEY);
  });

  it("clearing keeps every non-auth key through the whole flow", () => {
    storage.setItem("juice-box:feed:abc:general", '{"messages":[]}');
    storage.setItem("sales-tracker:map-visit-filter:abc", '{"filter":"30"}');
    const out = simulate({
      storedSession: SESSION_JSON,
      permissionsStatus: 401,
    });
    expect(out.storageKeys).toEqual([
      "juice-box:feed:abc:general",
      "sales-tracker:map-visit-filter:abc",
    ]);
  });
});
