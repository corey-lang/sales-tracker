"use client";

import { useEffect, useState } from "react";
import { Bell, BellOff, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  detectPushSupport,
  getExistingSubscription,
  subscribeToPush,
  unsubscribeFromPush,
  type PushSupport,
} from "@/lib/push-client";

// Compact opt-in for Juice Box push notifications. Rendered inside the
// More page's Notifications card. The component owns its own state —
// just drop it in.
//
// STATES
//   * support detection: unsupported / needs-install / permission-denied /
//     supported (and within "supported" we have subscribed yes/no)
//   * pending: a subscribe/unsubscribe call in flight
//
// SAFETY
//   * All failure paths land back on the unsubscribed state. We don't
//     surface raw error messages — they read as scary on a "settings"
//     surface and the underlying APIs return enough ambient signal
//     (browser permission popup, OS prompt, etc.).
//   * Reads NEXT_PUBLIC_VAPID_PUBLIC_KEY at the module level via the
//     push-client helper. Missing key → subscribeToPush returns null and
//     we show "Not configured yet."

export function NotificationOptIn() {
  // `null` while support detection / subscription lookup is in flight
  // on the very first render. After that, the UI never flashes a
  // wrong state.
  const [support, setSupport] = useState<PushSupport | null>(null);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [configured, setConfigured] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const detected = detectPushSupport();
      const sub = await getExistingSubscription();
      const cfg = Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY);
      if (cancelled) return;
      setSupport(detected);
      setSubscribed(sub !== null);
      setConfigured(cfg);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleEnable = async () => {
    if (pending) return;
    setPending(true);
    const sub = await subscribeToPush();
    if (!sub) {
      // Could be a permission denial that just happened — refresh
      // support state so the UI updates accordingly.
      setSupport(detectPushSupport());
      setSubscribed(false);
    } else {
      setSubscribed(true);
    }
    setPending(false);
  };

  const handleDisable = async () => {
    if (pending) return;
    setPending(true);
    await unsubscribeFromPush();
    setSubscribed(false);
    setPending(false);
  };

  // -----------------------------------------------------------------
  // Render branches — each one is intentionally a tiny self-contained
  // block so the user reads exactly one state, not a complicated
  // matrix.
  // -----------------------------------------------------------------

  if (support === null || subscribed === null) {
    return (
      <p className="text-sm text-muted-foreground">Checking notifications…</p>
    );
  }

  if (!configured) {
    return (
      <p className="text-sm text-muted-foreground">
        Notifications aren&apos;t configured for this deployment yet.
      </p>
    );
  }

  if (support === "unsupported") {
    return (
      <p className="text-sm text-muted-foreground">
        Notifications aren&apos;t supported on this browser. Try Chrome,
        Edge, or Safari 16.4+ on an installed Home Screen app.
      </p>
    );
  }

  if (support === "needs-install") {
    return (
      <p className="text-sm text-muted-foreground">
        Add this app to your Home Screen first — iPhone push only works
        from the installed app.
      </p>
    );
  }

  if (support === "permission-denied") {
    // A user can revoke permission AFTER having subscribed — the
    // PushSubscription remains in browser storage and on our server,
    // but the browser will never show another notification. Offer a
    // cleanup path so they can fully remove the stale subscription
    // without first having to re-grant permission (which the OS
    // settings dialog is the only place to do).
    return (
      <div className="space-y-1.5">
        <p className="text-sm text-muted-foreground">
          Notifications are blocked. Enable them in your browser settings
          for this site to receive Juice Box alerts.
        </p>
        {subscribed && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleDisable}
            disabled={pending}
            className="gap-2"
          >
            {pending ? (
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
            ) : (
              <BellOff aria-hidden="true" className="size-3.5" />
            )}
            {pending ? "Cleaning up…" : "Clean up old subscription"}
          </Button>
        )}
      </div>
    );
  }

  // support === "supported" — show the toggle button.
  if (subscribed) {
    return (
      <div className="space-y-1.5">
        <p className="text-sm text-muted-foreground">
          You&apos;ll get a ping for new Juice Box posts on this device.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={handleDisable}
          disabled={pending}
          className="gap-2"
        >
          {pending ? (
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
          ) : (
            <BellOff aria-hidden="true" className="size-3.5" />
          )}
          {pending ? "Turning off…" : "Disable notifications"}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <p className="text-sm text-muted-foreground">
        Get a ping when teammates drop a Juice Box post.
      </p>
      <Button size="sm" onClick={handleEnable} disabled={pending} className="gap-2">
        {pending ? (
          <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
        ) : (
          <Bell aria-hidden="true" className="size-3.5" />
        )}
        {pending ? "Turning on…" : "Enable notifications"}
      </Button>
    </div>
  );
}
