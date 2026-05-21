import { z } from "zod";

import { getServerSupabase } from "@/lib/supabase/server";
import {
  badRequest,
  handleApiError,
  parseBody,
  requireSalesperson,
} from "@/lib/server/auth";
import { isTrustedPushEndpoint } from "@/lib/server/push";

// Juice Box push subscriptions — register / unregister a browser.
//
//   POST   /api/juice-box/push/subscribe   body: { endpoint, keys, user_agent? }
//     -> { ok: true }
//   DELETE /api/juice-box/push/subscribe   body: { endpoint }
//     -> { ok: true }
//
// SEMANTICS
//   * POST upserts by endpoint. The push service returns the same
//     endpoint URL every time the same browser re-subscribes, so a
//     repeated opt-in (e.g. user re-enabled after revoking) safely
//     refreshes the keys / user_agent and re-binds to the current
//     salesperson_id.
//   * DELETE removes a single endpoint. The CLIENT-side helper also
//     calls `subscription.unsubscribe()` to free the browser-side
//     registration; this route just cleans up the server-side row so
//     fan-out doesn't keep trying to send to it.
//
// ACCESS
//   Any signed-in salesperson (requireSalesperson). Identity comes
//   from the signed session, never from the body, so a user can never
//   register a subscription as a teammate.
//
// ENDPOINT ALLOWLIST
//   `endpoint` is validated against isTrustedPushEndpoint before
//   upsert — only well-known browser push services (FCM, Mozilla,
//   Apple) are accepted. Without this, an eligible user could
//   register an arbitrary HTTPS URL and the fan-out would POST to
//   that URL on every Juice Box message (server-side request
//   forgery / push-credits abuse).
//
// DELETE OWNERSHIP
//   The DELETE handler scopes its WHERE clause to (endpoint,
//   salesperson_id = me.id). Endpoint URLs are pseudo-random and
//   non-enumerable, but defense in depth: a user can only remove a
//   subscription that was registered under their own session.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PUSH_SUBSCRIPTIONS_TABLE = "push_subscriptions";

const SubscribeSchema = z.object({
  endpoint: z.url(),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(128),
  }),
  user_agent: z.string().max(512).optional(),
});

const UnsubscribeSchema = z.object({
  endpoint: z.url(),
});

export async function POST(req: Request) {
  try {
    const me = await requireSalesperson(req);
    const body = await parseBody(req, SubscribeSchema);

    // Allowlist the endpoint host. Single error message regardless of
    // which check failed (parse / scheme / host) so we don't leak
    // internal validation specifics.
    if (!isTrustedPushEndpoint(body.endpoint)) {
      throw badRequest("Unsupported push endpoint.");
    }

    const supabase = getServerSupabase();

    // Upsert on endpoint (the natural identity from the push service).
    // Re-subscribing from the same browser rebinds to the current
    // signed-in user — useful when a shared device account-switches.
    const res = await supabase
      .from(PUSH_SUBSCRIPTIONS_TABLE)
      .upsert(
        {
          salesperson_id: me.id,
          endpoint: body.endpoint,
          p256dh: body.keys.p256dh,
          auth: body.keys.auth,
          user_agent: body.user_agent ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "endpoint" },
      );

    if (res.error) {
      throw new Error(`Failed to save subscription: ${res.error.message}`);
    }
    return Response.json({ ok: true }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(req: Request) {
  try {
    const me = await requireSalesperson(req);
    const body = await parseBody(req, UnsubscribeSchema);
    const supabase = getServerSupabase();

    // Scope the delete to BOTH endpoint and the caller's id. Endpoint
    // URLs are pseudo-random and non-enumerable, but tying the delete
    // to the authenticated identity is defense in depth: a session
    // can only remove subscriptions registered by itself. If the
    // browser changed accounts mid-session, the re-subscribe path
    // (POST upsert) already rebinds the row to the new user.
    const res = await supabase
      .from(PUSH_SUBSCRIPTIONS_TABLE)
      .delete()
      .eq("endpoint", body.endpoint)
      .eq("salesperson_id", me.id);

    if (res.error) {
      throw new Error(`Failed to remove subscription: ${res.error.message}`);
    }
    return Response.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
