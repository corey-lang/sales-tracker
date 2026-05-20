import { apiFetch } from "@/lib/api-client";

// Client-side helpers for the Juice Box push opt-in.
//
// Browser-only — only imported from "use client" components.
//
// LIFECYCLE
//   * `detectPushSupport()` is a pure read of feature flags + the
//     user's prior permission decision. Used to render the right UI
//     state (supported / denied / unsupported / needs-install).
//   * `subscribeToPush()` walks the full opt-in: registers the
//     service worker, asks for permission, subscribes to the push
//     manager, then POSTs the subscription to our server. Returns
//     null on any failure (no exceptions surface to the caller).
//   * `unsubscribeFromPush()` mirrors the above: tells the browser
//     to unsubscribe locally, then DELETEs the row server-side.

/** Possible support states from `detectPushSupport`. */
export type PushSupport =
  | "supported"
  | "permission-denied"
  | "needs-install"
  | "unsupported";

/**
 * Best-effort detection of whether the current browser/device can
 * receive Web Push for THIS app.
 *
 * iOS quirk: push only works when the PWA is installed to the Home
 * Screen and running in standalone display mode (iOS 16.4+). If the
 * user is in Safari proper on an iPhone we surface `needs-install` so
 * the UI can prompt them to add to Home Screen first.
 */
export function detectPushSupport(): PushSupport {
  if (typeof window === "undefined") return "unsupported";
  if (!("serviceWorker" in navigator)) return "unsupported";
  if (!("PushManager" in window)) {
    // iOS Safari proper exposes Notification but NOT PushManager
    // outside standalone mode — treat that case as "install first."
    if (isProbablyIos() && !isStandalone()) return "needs-install";
    return "unsupported";
  }
  if (!("Notification" in window)) return "unsupported";
  if (typeof Notification.permission === "string") {
    if (Notification.permission === "denied") return "permission-denied";
  }
  if (isProbablyIos() && !isStandalone()) return "needs-install";
  return "supported";
}

function isProbablyIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/.test(navigator.userAgent);
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  if (
    window.matchMedia &&
    window.matchMedia("(display-mode: standalone)").matches
  ) {
    return true;
  }
  // Older iOS uses a non-standard navigator.standalone boolean.
  const navAny = navigator as Navigator & { standalone?: boolean };
  return navAny.standalone === true;
}

async function ensureRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }
  try {
    // Re-registering with the same script + scope is idempotent —
    // returns the existing registration if one is already active.
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

/** Returns the current PushSubscription for this device, or null. */
export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }
  try {
    const reg = await navigator.serviceWorker.getRegistration("/sw.js");
    if (!reg) return null;
    return (await reg.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Decodes the URL-safe base64 VAPID public key into the Uint8Array
 * shape pushManager.subscribe expects. (The Web Crypto API doesn't
 * have a built-in for this exact format.)
 */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = (4 - (base64.length % 4)) % 4;
  const padded = base64 + "=".repeat(padding);
  const safe = padded.replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(safe);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf;
}

/**
 * Walks the full opt-in flow. Returns the resulting PushSubscription
 * on success, or null on any failure (permission denied, unsupported,
 * VAPID key missing, network error). The caller renders the right UI
 * state based on the return value + a follow-up call to
 * detectPushSupport().
 *
 * The VAPID public key is read from NEXT_PUBLIC_VAPID_PUBLIC_KEY,
 * which is baked at build time. If the env var is unset, push is
 * considered not-configured for this deployment and we no-op.
 */
export async function subscribeToPush(): Promise<PushSubscription | null> {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!publicKey) return null;
  if (typeof Notification === "undefined") return null;

  const reg = await ensureRegistration();
  if (!reg) return null;

  // Notification.requestPermission must be triggered from a user
  // gesture on every browser — the caller is expected to invoke this
  // from a click handler. We don't re-prompt if the user already
  // granted, but we DO bail if denied (only browser settings can flip
  // that).
  let permission = Notification.permission;
  if (permission === "default") {
    permission = await Notification.requestPermission();
  }
  if (permission !== "granted") return null;

  let sub: PushSubscription | null = null;
  try {
    // Reuse an existing subscription if one is already minted for
    // this browser — calling subscribe again with the same key just
    // returns the existing record.
    sub = await reg.pushManager.getSubscription();
    if (!sub) {
      // Cast the Uint8Array's buffer to ArrayBuffer to satisfy TS5's
      // tightened BufferSource type (Uint8Array<ArrayBufferLike> isn't
      // assignable to BufferSource without this). The underlying value
      // is always a real ArrayBuffer here — atob output never lands
      // in a SharedArrayBuffer.
      const key = urlBase64ToUint8Array(publicKey);
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key.buffer as ArrayBuffer,
      });
    }
  } catch {
    return null;
  }

  // POST to our server. JSON shape mirrors PushSubscription.toJSON().
  const payload = sub.toJSON();
  const userAgent =
    typeof navigator !== "undefined" ? navigator.userAgent : undefined;
  try {
    const res = await apiFetch("/api/juice-box/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: payload.endpoint,
        keys: payload.keys,
        user_agent: userAgent,
      }),
    });
    if (!res.ok) return null;
  } catch {
    return null;
  }
  return sub;
}

/**
 * Local + server unsubscribe. Silent on all failure modes (returns
 * true regardless) because the user-visible signal is "you're not
 * subscribed anymore" and the cleanup runs as best-effort.
 */
export async function unsubscribeFromPush(): Promise<boolean> {
  const sub = await getExistingSubscription();
  if (!sub) return true;
  const endpoint = sub.endpoint;
  try {
    await sub.unsubscribe();
  } catch {
    // Browser couldn't unsubscribe — we'll still try to GC the row.
  }
  try {
    await apiFetch("/api/juice-box/push/subscribe", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
  } catch {
    // Server best-effort; if it fails the subscription is still gone
    // locally and the dead-row cleanup in fanOutJuiceBoxPush will GC
    // it on the next send.
  }
  return true;
}
