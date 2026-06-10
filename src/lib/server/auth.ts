/**
 * Phase 0 — shared server-side auth + request-validation toolkit.
 *
 * The Sales Tracker has no Supabase Auth: reps "log in" by picking their name
 * (admins also enter a PIN). Before CRM expansion the service-role API routes
 * need a consistent, server-trusted way to answer "who is calling, and are
 * they allowed?". This module is that one place.
 *
 * IDENTITY MODEL
 *   `/api/auth/login` validates credentials server-side (PIN check against the
 *   service-role-only `admin_pin` column) and issues a signed session token:
 *
 *       base64url(payload) + "." + base64url(HMAC-SHA256(payload, secret))
 *
 *   The browser stores the token (see src/lib/api-client.ts) and sends it as
 *   `Authorization: Bearer <token>` on every API request. requireSalesperson()
 *   verifies the HMAC, then re-reads the row from `salespeople` so identity
 *   and role are always server-trusted — never taken from localStorage, a
 *   request body, or the token's own claims.
 *
 * KNOWN LIMITATION (durable fix deferred — see supabase/README.md)
 *   The token proves "this client completed a login" but, lacking real auth,
 *   it is bearer-only: anyone who copies a token holds that session until it
 *   expires. This is strictly stronger than the previous state (routes had no
 *   identity check at all, and admin UUIDs were already public via the login
 *   screen). Real per-user Supabase Auth remains the durable fix.
 *
 * Server-only. Never import from a "use client" component.
 */

import { createHmac, timingSafeEqual } from "crypto";

import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import { isUserRole, isTestAccount, type UserRole } from "@/lib/permissions";

// ---------------------------------------------------------------------------
// JSON error helpers
// ---------------------------------------------------------------------------

/** An error carrying the HTTP status the route should respond with. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

export const badRequest = (message: string) => new ApiError(400, message);
export const unauthorized = (message = "Authentication required.") =>
  new ApiError(401, message);
export const forbidden = (message = "You are not allowed to do that.") =>
  new ApiError(403, message);
export const notFound = (message = "Not found.") => new ApiError(404, message);

/**
 * Converts a thrown error into a JSON Response. ApiError keeps its status;
 * anything else becomes a 500. Use in a route's outer catch:
 *
 *   try { ... } catch (err) { return handleApiError(err); }
 */
export function handleApiError(err: unknown): Response {
  if (err instanceof ApiError) {
    // ApiError messages are author-written and safe to surface.
    return Response.json({ error: err.message }, { status: err.status });
  }
  // Anything else is an UNEXPECTED failure. Its message can carry internal
  // detail (stack-adjacent text, provider errors, query fragments), so it is
  // logged server-side but never returned — the caller gets a generic 500.
  console.error(
    `[api] unhandled error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
  );
  return Response.json(
    { error: "Something went wrong. Please try again." },
    { status: 500 },
  );
}

// ---------------------------------------------------------------------------
// Signed session tokens
// ---------------------------------------------------------------------------

/** Sessions older than this must sign in again. */
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

/**
 * Secret used to sign session tokens. Prefers an explicit SESSION_SECRET, and
 * falls back to the service-role key (always present server-side — see
 * supabase/server.ts) so login never breaks for a missing env var. Setting an
 * explicit SESSION_SECRET is recommended so rotating the Supabase key does not
 * silently invalidate every session.
 */
function sessionSecret(): string {
  const secret =
    process.env.SESSION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) {
    throw new Error(
      "Cannot sign session tokens: set SESSION_SECRET (or SUPABASE_SERVICE_ROLE_KEY) in the environment.",
    );
  }
  return secret;
}

type SessionPayload = {
  /** salespeople.id */
  sub: string;
  /** Role at issue time. Authoritative role is always re-read from the DB. */
  role: UserRole;
  /** salespeople.first_name at issue time (display only). */
  name: string;
  /** Issued-at, epoch ms. */
  iat: number;
};

function hmac(body: string): Buffer {
  return createHmac("sha256", sessionSecret()).update(body).digest();
}

/** Issues a signed session token for a salesperson. Called only by /api/auth/login. */
export function signSessionToken(input: {
  sub: string;
  role: UserRole;
  name: string;
}): string {
  const payload: SessionPayload = { ...input, iat: Date.now() };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = hmac(body).toString("base64url");
  return `${body}.${sig}`;
}

/** Verifies a token's signature + age. Returns the payload, or null if invalid. */
function verifySessionToken(token: string): SessionPayload | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;

  const body = token.slice(0, dot);
  const providedSig = Buffer.from(token.slice(dot + 1), "base64url");
  const expectedSig = hmac(body);
  if (
    providedSig.length !== expectedSig.length ||
    !timingSafeEqual(providedSig, expectedSig)
  ) {
    return null;
  }

  let payload: SessionPayload;
  try {
    payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as SessionPayload;
  } catch {
    return null;
  }

  if (typeof payload.sub !== "string" || !payload.sub) return null;
  if (!isUserRole(payload.role)) return null;
  if (typeof payload.iat !== "number") return null;
  if (Date.now() - payload.iat > SESSION_MAX_AGE_MS) return null;

  return payload;
}

// ---------------------------------------------------------------------------
// Identity + authorization guards
// ---------------------------------------------------------------------------

/** A request's caller, validated against the live `salespeople` table. */
export type AuthedSalesperson = {
  id: string;
  first_name: string;
  role: UserRole;
  /** True for the seeded test account — routes use this to stay test-safe. */
  is_test: boolean;
  /** The AE's assigned USPS state code (UPPER, e.g. "UT"), or null when unset.
   *  Ask Smitty uses this as the default state for Coverage Intelligence
   *  lookups; null means it declines coverage questions (it never guesses a
   *  state). See supabase/salespeople_state_code.sql. */
  state_code: string | null;
  /** Scoped permission for the office-import surface (migration #26).
   *  Admins (role === 'admin') bypass this flag entirely; non-admins must
   *  have it set to reach `/api/admin/offices/import`. See
   *  `requireOfficeImporter`. */
  can_import_offices: boolean;
};

function extractToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header && header.toLowerCase().startsWith("bearer ")) {
    const value = header.slice(7).trim();
    if (value) return value;
  }
  const alt = req.headers.get("x-session-token");
  return alt && alt.trim() ? alt.trim() : null;
}

/**
 * Resolves and validates the caller of an API request.
 *
 * Verifies the signed session token, then re-reads the row from `salespeople`
 * so the caller is confirmed to still exist and the role is current. Throws an
 * ApiError (401) when no valid identity is present.
 */
export async function requireSalesperson(
  req: Request,
): Promise<AuthedSalesperson> {
  const token = extractToken(req);
  if (!token) {
    throw unauthorized("Missing session token. Please sign in again.");
  }

  const payload = verifySessionToken(token);
  if (!payload) {
    throw unauthorized("Invalid or expired session. Please sign in again.");
  }

  // role + is_test + can_import_offices are re-read from the DB — never
  // trusted from the token or the client. is_test is the authoritative
  // test-account flag; can_import_offices is the scoped grant for the
  // office-import surface.
  const supabase = getServerSupabase();
  const res = await supabase
    .from("salespeople")
    .select("id, first_name, role, is_test, can_import_offices, state_code")
    .eq("id", payload.sub)
    .maybeSingle();

  if (res.error) {
    // Provider error text never reaches the caller — it can include
    // schema names, connection state, or query fragments. Logged
    // server-side with the `[auth]` prefix; caller sees a sanitized
    // 500. Matches the posture in /api/admin/offices/import and
    // /api/offices/[id].
    console.warn(
      `[auth] identity lookup failed sub=${payload.sub} code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    throw new ApiError(500, "Could not verify your session.");
  }
  if (!res.data) {
    throw unauthorized("This account no longer exists. Please sign in again.");
  }

  const row = res.data as {
    id: string;
    first_name: string;
    role: unknown;
    is_test: boolean | null;
    can_import_offices: boolean | null;
    state_code: string | null;
  };
  const role: UserRole = isUserRole(row.role) ? row.role : "ae";
  // Normalize to UPPER so it matches plan_brochures.state_code / the
  // authoritative_* views; an empty/whitespace value reads as "unset".
  const stateCode =
    typeof row.state_code === "string" && row.state_code.trim()
      ? row.state_code.trim().toUpperCase()
      : null;

  return {
    id: row.id,
    first_name: row.first_name,
    role,
    is_test: isTestAccount(row),
    can_import_offices: row.can_import_offices === true,
    state_code: stateCode,
  };
}

/** Requires the caller to be an admin. Throws 401/403 otherwise. */
export async function requireAdmin(req: Request): Promise<AuthedSalesperson> {
  const me = await requireSalesperson(req);
  if (me.role !== "admin") {
    throw forbidden("Admin access is required for this action.");
  }
  return me;
}

/**
 * Requires the caller to be allowed to use the AE app's everyday tools
 * (To-Dos, business-card scanning, the AE leaderboard, the daily-entry
 * activity log, etc.).
 *
 * The current rule is simple: any signed-in salesperson EXCEPT the
 * `juice_box_only` role qualifies. Those accounts (Travis, Rizz, …)
 * are guests in the team chat with no AE surface — the UI redirects
 * them away from those pages and this helper enforces the same gate
 * server-side so a direct fetch can't bypass the client.
 *
 * Future AE-only endpoints should reach for this helper rather than
 * `requireSalesperson` so the gate stays consistent.
 */
export async function requireAeToolAccess(
  req: Request,
): Promise<AuthedSalesperson> {
  const me = await requireSalesperson(req);
  if (me.role === "juice_box_only") {
    throw forbidden("This action is not available for your account.");
  }
  return me;
}

/**
 * Requires the caller to be the seeded test account (`salespeople.is_test`).
 *
 * Gate for isolated, opt-in beta surfaces — currently the AI Assistant proxy
 * at `/api/ai/chat`. The check lives here, server-side, re-read from the DB by
 * requireSalesperson, so a real production AE cannot reach a beta endpoint by
 * crafting a direct POST even though the UI also hides the entry point. When a
 * beta graduates to more users, widen this gate (or move callers onto a
 * role/flag check) in ONE place rather than per route.
 */
export async function requireTestAccount(
  req: Request,
): Promise<AuthedSalesperson> {
  const me = await requireSalesperson(req);
  if (!me.is_test) {
    throw forbidden("This feature isn't available for your account yet.");
  }
  return me;
}

/** True for roles that may act on ANY salesperson's business-card scan. */
function isReviewerRole(role: UserRole): boolean {
  return role === "admin" || role === "assistant";
}

/**
 * Requires the caller to be able to review contacts — an admin or the
 * assistant (Tonja). This gates the business-card verification + export
 * routes, which the assistant operates day to day.
 */
export async function requireReviewer(
  req: Request,
): Promise<AuthedSalesperson> {
  const me = await requireSalesperson(req);
  if (!isReviewerRole(me.role)) {
    throw forbidden(
      "Reviewer access (admin or assistant) is required for this action.",
    );
  }
  return me;
}

/**
 * Requires the caller to be allowed to import offices.
 *
 * Gate: `role === "admin"` OR `can_import_offices === true`.
 *   * Admins always pass (bypass the per-user flag).
 *   * Non-admins must have the scoped `salespeople.can_import_offices`
 *     permission set (see migration #26).
 *   * `juice_box_only` is rejected outright as belt-and-braces, even if
 *     `can_import_offices` were ever misconfigured on such a row.
 *   * Plain assistants without the flag are rejected — assistant role
 *     alone is NOT enough anymore (Tonja gets in via the flag).
 *
 * Replaces the prior `requireAdminOrAssistant` helper, which granted
 * the import surface to ALL assistants by role. The narrower per-user
 * permission keeps role membership and capabilities orthogonal so we
 * can grant import access to specific users without granting the rest
 * of the assistant capability bundle.
 */
export async function requireOfficeImporter(
  req: Request,
): Promise<AuthedSalesperson> {
  const me = await requireSalesperson(req);
  if (me.role === "juice_box_only") {
    throw forbidden("This action is not available for your account.");
  }
  if (me.role !== "admin" && !me.can_import_offices) {
    throw forbidden(
      "Office import access is required for this action.",
    );
  }
  return me;
}

/** A business-card scan, resolved + access-checked for the request's caller. */
export type ScanAccess = {
  me: AuthedSalesperson;
  scan: { id: string; salesperson_id: string | null };
};

/**
 * Authorizes a request to act on a specific business-card scan.
 *
 * Access rule:
 *   - reviewers (admin / assistant) may act on ANY scan;
 *   - an AE may act only on a scan they own (scan.salesperson_id === me.id);
 *   - juice_box_only accounts are forbidden outright (no scan surface);
 *   - everyone else is forbidden.
 *
 * Identity is the signed-token salesperson — `scanId` is the only thing taken
 * from the caller, and it is resolved against the DB here. Throws ApiError
 * (401 / 403 / 404 / 500) on any failure; returns the caller + the resolved
 * scan row on success.
 */
export async function requireScanAccess(
  req: Request,
  scanId: string,
): Promise<ScanAccess> {
  // Route through requireAeToolAccess so juice_box_only callers are
  // rejected on the role check instead of relying on the "they can
  // never own a scan" data invariant.
  const me = await requireAeToolAccess(req);

  const supabase = getServerSupabase();
  const res = await supabase
    .from("business_card_scans")
    .select("id, salesperson_id")
    .eq("id", scanId)
    .maybeSingle();

  if (res.error) {
    console.warn(
      `[auth] scan lookup failed scan_id=${scanId} caller=${me.id} code=${res.error.code ?? "?"} msg=${res.error.message}`,
    );
    throw new ApiError(500, "Could not load that scan.");
  }
  if (!res.data) {
    throw notFound("Scan not found.");
  }

  const scan = res.data as { id: string; salesperson_id: string | null };
  if (!isReviewerRole(me.role) && scan.salesperson_id !== me.id) {
    throw forbidden("You can only act on your own business card scans.");
  }

  return { me, scan };
}

// ---------------------------------------------------------------------------
// Request body validation
// ---------------------------------------------------------------------------

/**
 * Parses + validates a JSON request body against a zod schema. Throws an
 * ApiError (400) on invalid JSON or a schema mismatch, with a readable message.
 */
export async function parseBody<T>(
  req: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw badRequest("Request body is not valid JSON.");
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => {
        const path = issue.path.join(".") || "(body)";
        return `${path}: ${issue.message}`;
      })
      .join("; ");
    throw badRequest(`Invalid request body — ${detail}`);
  }
  return result.data;
}
