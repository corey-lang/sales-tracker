import webpush from "web-push";

import { getServerSupabase } from "@/lib/supabase/server";

// Server-only Web Push helper.
//
// WHAT THIS IS
//   Loads VAPID credentials from env, signs and sends Web Push payloads
//   to every subscription belonging to a Juice Box-eligible salesperson
//   except the sender. Subscriptions that come back 404 / 410 from the
//   push service are removed from the DB on the way through so they
//   don't keep generating retries.
//
// FIRE-AND-FORGET
//   Call from the create-message route AFTER the insert resolves; do
//   NOT await the return value if you want the POST response to stay
//   snappy. Each send is wrapped in its own try/catch so one failure
//   never sinks the whole batch.

const PUSH_SUBSCRIPTIONS_TABLE = "push_subscriptions";

type VapidConfig = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

let cachedConfig: VapidConfig | null | undefined;

/**
 * Resolves VAPID config from env at first call. Returns null when any
 * required value is missing — the fan-out then no-ops so a half-
 * configured deployment never throws on a POST.
 */
function getVapidConfig(): VapidConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  // Per the VAPID spec, the subject must be a mailto: or https URL.
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) {
    cachedConfig = null;
    return null;
  }
  cachedConfig = { publicKey, privateKey, subject };
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return cachedConfig;
}

/** Public: is the server set up to send push notifications? */
export function isPushConfigured(): boolean {
  return getVapidConfig() !== null;
}

// Hostnames where legitimate browser-issued PushSubscription.endpoint
// values land. Conservative on purpose — without this allowlist an
// eligible user could register an arbitrary HTTPS URL and the
// fan-out would happily POST to it on every Juice Box message (a
// server-side request forgery / push-credits abuse vector).
//
//   * fcm.googleapis.com                  Chrome, Edge, Brave, Opera,
//                                         Android Chrome, Samsung Internet
//   * updates.push.services.mozilla.com   Firefox (desktop + Android)
//   * web.push.apple.com                  Safari (macOS 16+ / iOS 16.4+),
//                                         standalone Home Screen PWAs
//
// New browsers / push services would need to be added here explicitly.
// Skipping wildcard subdomains keeps the surface tight; if a vendor
// ever shards their CDN under a subdomain we'll add the new host
// after verifying it's the official endpoint.
const TRUSTED_PUSH_HOSTS: ReadonlySet<string> = new Set([
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
]);

/**
 * Returns true when `endpoint` is an HTTPS URL whose host is one of
 * the known browser push services. The subscribe route calls this
 * before persisting so an eligible user can't smuggle a custom host
 * onto the fan-out's send list.
 */
export function isTrustedPushEndpoint(endpoint: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return TRUSTED_PUSH_HOSTS.has(parsed.hostname);
}

export type FanOutPayload = {
  title: string;
  body: string;
  url: string;
};

type SubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  salesperson_id: string;
};

type SalespersonRow = {
  id: string;
  role: string | null;
  is_test: boolean | null;
};

function isJuiceBoxEligible(person: SalespersonRow): boolean {
  // Matches requireJuiceBoxAccess: admin OR test account. Widening the
  // Juice Box rollout to all AEs later means relaxing this in lockstep
  // with requireJuiceBoxAccess — single point of truth.
  return person.role === "admin" || person.is_test === true;
}

/**
 * Sends a single Web Push and, on 404/410 from the push service,
 * deletes the subscription row by id. Returns true on success, false
 * on permanent failure (subscription was removed).
 */
async function sendOne(
  sub: SubscriptionRow,
  payloadJson: string,
): Promise<void> {
  try {
    await webpush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      },
      payloadJson,
    );
  } catch (err: unknown) {
    const status = (err as { statusCode?: number })?.statusCode;
    if (status === 404 || status === 410) {
      // Subscription is gone for good (user uninstalled the PWA,
      // revoked permission, browser cleared data, etc.). Drop the row
      // so we don't keep generating dead requests for it.
      const supabase = getServerSupabase();
      try {
        await supabase
          .from(PUSH_SUBSCRIPTIONS_TABLE)
          .delete()
          .eq("id", sub.id);
      } catch {
        // Best-effort cleanup; don't escalate.
      }
    }
    // Other failures (5xx, network) are transient — we don't retry
    // here; the next post will re-attempt naturally.
  }
}

/**
 * Sends `payload` as a Web Push notification to every Juice Box-
 * eligible salesperson's subscriptions except the sender's own. Safe
 * to fire-and-forget — internal errors are swallowed.
 */
export async function fanOutJuiceBoxPush(opts: {
  excludeSalespersonId: string;
  payload: FanOutPayload;
}): Promise<void> {
  if (!getVapidConfig()) return; // not configured — silently skip

  const supabase = getServerSupabase();

  // Two-step query because push_subscriptions.salesperson_id is TEXT
  // (no FK; see team_messages.sql rationale), and PostgREST can't
  // auto-join without FK metadata. For an 11-person team this is
  // negligible.
  const subsRes = await supabase
    .from(PUSH_SUBSCRIPTIONS_TABLE)
    .select("id, endpoint, p256dh, auth, salesperson_id")
    .neq("salesperson_id", opts.excludeSalespersonId);
  if (subsRes.error || !subsRes.data || subsRes.data.length === 0) return;
  const subs = subsRes.data as SubscriptionRow[];

  const peopleRes = await supabase
    .from("salespeople")
    .select("id, role, is_test")
    .in(
      "id",
      Array.from(new Set(subs.map((s) => s.salesperson_id))),
    );
  if (peopleRes.error || !peopleRes.data) return;
  const peopleById = new Map<string, SalespersonRow>(
    (peopleRes.data as SalespersonRow[]).map((p) => [p.id, p]),
  );

  // Filter to the Juice Box gate: admin OR test account. This matches
  // requireJuiceBoxAccess, so widening the gate later (rolling Juice
  // Box out to all AEs) requires no change here — just relax the
  // check in lockstep with the rollout decision.
  const eligible = subs.filter((s) => {
    const p = peopleById.get(s.salesperson_id);
    return p ? isJuiceBoxEligible(p) : false;
  });
  if (eligible.length === 0) return;

  const payloadJson = JSON.stringify(opts.payload);
  await Promise.allSettled(eligible.map((s) => sendOne(s, payloadJson)));
}
