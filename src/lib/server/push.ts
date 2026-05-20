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
 * Returns the hostname portion of a push endpoint URL — used in logs so
 * we never write the auth-bearing path segment to Vercel function logs.
 */
function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "<invalid-url>";
  }
}

/**
 * Sends a single Web Push and, on 404/410 from the push service,
 * deletes the subscription row by id. Logs are tagged
 * `[juice-box-push]` so they're grep-friendly in Vercel function logs.
 * Endpoint host is logged; the auth-bearing path is NOT.
 */
async function sendOne(
  sub: SubscriptionRow,
  payloadJson: string,
): Promise<"ok" | "error" | "gc"> {
  const host = endpointHost(sub.endpoint);
  try {
    await webpush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      },
      payloadJson,
    );
    console.log(`[juice-box-push] send host=${host} status=ok`);
    return "ok";
  } catch (err: unknown) {
    const status = (err as { statusCode?: number })?.statusCode;
    // web-push attaches the upstream response body on errors; truncate
    // because some push services return very chatty diagnostic JSON.
    const body = (err as { body?: string })?.body;
    const message =
      typeof body === "string" && body.length > 0
        ? body.slice(0, 240).replace(/\s+/g, " ")
        : err instanceof Error
          ? err.message
          : "(no message)";
    console.error(
      `[juice-box-push] send host=${host} status=error code=${status ?? "?"} body=${message}`,
    );
    if (status === 404 || status === 410) {
      // Subscription is gone for good (user uninstalled the PWA,
      // revoked permission, browser cleared data, etc.). Drop the row
      // so we don't keep generating dead requests for it.
      console.log(
        `[juice-box-push] gc host=${host} reason=${status} subscription_id=${sub.id}`,
      );
      const supabase = getServerSupabase();
      try {
        await supabase
          .from(PUSH_SUBSCRIPTIONS_TABLE)
          .delete()
          .eq("id", sub.id);
      } catch (gcErr) {
        console.error(
          `[juice-box-push] gc-failed subscription_id=${sub.id} err=${String(gcErr)}`,
        );
      }
      return "gc";
    }
    // Other failures (5xx, network) are transient — we don't retry
    // here; the next post will re-attempt naturally.
    return "error";
  }
}

/**
 * Sends `payload` as a Web Push notification to every Juice Box-
 * eligible salesperson's subscriptions except the sender's own. Safe
 * to fire-and-forget — internal errors are swallowed.
 *
 * DIAGNOSTICS (Pass 6 troubleshooting)
 *   Every step emits a `[juice-box-push] …` log line on Vercel
 *   function logs so we can prove the send was attempted, what the
 *   push service responded, and how long the whole fan-out took.
 *   Endpoint hosts are logged; the auth-bearing path segment is not.
 */
export async function fanOutJuiceBoxPush(opts: {
  excludeSalespersonId: string;
  payload: FanOutPayload;
}): Promise<void> {
  const startedAt = Date.now();
  console.log(
    `[juice-box-push] fan-out start sender=${opts.excludeSalespersonId}`,
  );

  if (!getVapidConfig()) {
    console.warn(
      "[juice-box-push] vapid-not-configured — skipping fan-out. Set NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT to enable.",
    );
    return;
  }

  const supabase = getServerSupabase();

  // Two-step query because push_subscriptions.salesperson_id is TEXT
  // (no FK; see team_messages.sql rationale), and PostgREST can't
  // auto-join without FK metadata. For an 11-person team this is
  // negligible.
  const subsRes = await supabase
    .from(PUSH_SUBSCRIPTIONS_TABLE)
    .select("id, endpoint, p256dh, auth, salesperson_id")
    .neq("salesperson_id", opts.excludeSalespersonId);
  if (subsRes.error) {
    console.error(
      `[juice-box-push] subscriptions-fetch-error: ${subsRes.error.message}`,
    );
    return;
  }
  const subs = (subsRes.data ?? []) as SubscriptionRow[];
  console.log(
    `[juice-box-push] subscriptions-found count=${subs.length} (after sender-exclude)`,
  );
  if (subs.length === 0) return;

  const peopleRes = await supabase
    .from("salespeople")
    .select("id, role, is_test")
    .in(
      "id",
      Array.from(new Set(subs.map((s) => s.salesperson_id))),
    );
  if (peopleRes.error || !peopleRes.data) {
    console.error(
      `[juice-box-push] people-fetch-error: ${peopleRes.error?.message ?? "no data"}`,
    );
    return;
  }
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
  const hostList = Array.from(
    new Set(eligible.map((s) => endpointHost(s.endpoint))),
  ).join(",");
  console.log(
    `[juice-box-push] eligible count=${eligible.length} hosts=${hostList || "(none)"}`,
  );
  if (eligible.length === 0) return;

  const payloadJson = JSON.stringify(opts.payload);
  const results = await Promise.allSettled(
    eligible.map((s) => sendOne(s, payloadJson)),
  );

  // Aggregate per-status counts so the summary line is grep-able.
  let ok = 0;
  let gc = 0;
  let error = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      if (r.value === "ok") ok++;
      else if (r.value === "gc") gc++;
      else error++;
    } else {
      // Should be unreachable — sendOne catches internally — but log
      // defensively so a future change doesn't silently swallow errors.
      error++;
      console.error(
        `[juice-box-push] send unexpected-rejection: ${String(r.reason)}`,
      );
    }
  }
  const elapsed = Date.now() - startedAt;
  console.log(
    `[juice-box-push] fan-out complete sender=${opts.excludeSalespersonId} eligible=${eligible.length} ok=${ok} gc=${gc} error=${error} elapsed_ms=${elapsed}`,
  );
}
