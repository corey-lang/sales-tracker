/**
 * Tests for the stored-session hydration in src/lib/use-salesperson.ts.
 *
 * THE VULNERABILITY THESE COVER
 *   The client session lives in localStorage, which the user can edit. The old
 *   hydration trusted the `role` field in that blob, so a `juice_box_only`
 *   guest could set `"role": "ae"` in devtools and the client would render (and
 *   route to) the AE dashboard.
 *
 *   Two things changed. Server-side, every AE endpoint re-reads the role from
 *   the `salespeople` row (proved in src/app/api/me/activity/routes.test.ts) —
 *   that is the actual boundary. Client-side, the role now comes from the
 *   SIGNED token's payload claim rather than the sibling field, so tampering
 *   with the easy knob doesn't even change the chrome. Editing the token
 *   instead breaks its HMAC, and then every request 401s.
 */

import { describe, expect, it } from "vitest";

process.env.SESSION_SECRET = "test-session-secret";
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const { hydrateStoredSalesperson, sessionRoleFromToken } = await import(
  "@/lib/use-salesperson"
);
const { signSessionToken } = await import("@/lib/server/auth");

const LEAH_ID = "33333333-3333-4333-8333-333333333333";
const AE_ID = "11111111-1111-4111-8111-111111111111";

const leahToken = signSessionToken({
  sub: LEAH_ID,
  role: "juice_box_only",
  name: "Leah",
});
const aeToken = signSessionToken({ sub: AE_ID, role: "ae", name: "Carli" });

describe("sessionRoleFromToken", () => {
  it("reads the role claim out of a signed token", () => {
    expect(sessionRoleFromToken(leahToken)).toBe("juice_box_only");
    expect(sessionRoleFromToken(aeToken)).toBe("ae");
  });

  it("returns null for malformed tokens", () => {
    for (const bad of ["", ".", "abc", "abc.", ".abc", "not-base64.sig"]) {
      expect(sessionRoleFromToken(bad)).toBeNull();
    }
  });

  it("returns null when the payload carries an unknown role", () => {
    const body = Buffer.from(
      JSON.stringify({ sub: LEAH_ID, role: "superuser", name: "Leah" }),
    ).toString("base64url");
    expect(sessionRoleFromToken(`${body}.signature`)).toBeNull();
  });
});

describe("hydrateStoredSalesperson ignores the editable role field", () => {
  it("keeps juice_box_only when localStorage claims 'ae'", () => {
    // Exactly the devtools attack: flip the role, keep the real token.
    const tampered = {
      id: LEAH_ID,
      first_name: "Leah",
      role: "ae",
      token: leahToken,
    };
    expect(hydrateStoredSalesperson(tampered)?.role).toBe("juice_box_only");
  });

  it("keeps juice_box_only when localStorage claims 'admin'", () => {
    const tampered = {
      id: LEAH_ID,
      first_name: "Leah",
      role: "admin",
      token: leahToken,
    };
    expect(hydrateStoredSalesperson(tampered)?.role).toBe("juice_box_only");
  });

  it("does not grant can_import_offices-style flags any authority", () => {
    // The flag is carried for UX only; the server re-reads it per request. We
    // simply assert it round-trips without changing the role decision.
    const tampered = {
      id: LEAH_ID,
      first_name: "Leah",
      role: "admin",
      can_import_offices: true,
      token: leahToken,
    };
    const hydrated = hydrateStoredSalesperson(tampered);
    expect(hydrated?.role).toBe("juice_box_only");
    expect(hydrated?.can_import_offices).toBe(true);
  });

  it("honours the real role for a genuine AE session", () => {
    const stored = {
      id: AE_ID,
      first_name: "Carli",
      role: "ae",
      token: aeToken,
    };
    const hydrated = hydrateStoredSalesperson(stored);
    expect(hydrated?.role).toBe("ae");
    expect(hydrated?.id).toBe(AE_ID);
  });

  it("treats a session with no token as signed out", () => {
    expect(
      hydrateStoredSalesperson({
        id: AE_ID,
        first_name: "Carli",
        role: "ae",
      }),
    ).toBeNull();
  });

  it("treats a session whose token has no readable role as signed out", () => {
    expect(
      hydrateStoredSalesperson({
        id: AE_ID,
        first_name: "Carli",
        role: "admin",
        token: "garbage.token",
      }),
    ).toBeNull();
  });

  it("rejects non-object / incomplete blobs", () => {
    expect(hydrateStoredSalesperson(null)).toBeNull();
    expect(hydrateStoredSalesperson("nope")).toBeNull();
    expect(hydrateStoredSalesperson({ id: AE_ID, token: aeToken })).toBeNull();
  });
});
