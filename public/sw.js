/* eslint-disable */
// Juice Box service worker — push delivery only.
//
// WHAT THIS DOES
//   * Receives Web Push events from our server (via the platform push
//     service: APNs on iOS, FCM on Chrome/Android, Mozilla Push on
//     Firefox, etc.).
//   * Renders an OS-level notification.
//   * On click/tap, focuses an existing /juice-box tab if open, or
//     opens a new one.
//
// WHAT THIS INTENTIONALLY DOES NOT DO
//   * No fetch caching / offline support — this is push-only by design
//     (per Pass 6 scope).
//   * No version-skew handling — we keep the SW thin so updates are
//     safe to ship without coordination.

self.addEventListener("install", () => {
  // Take over from any prior version immediately. Without this the new
  // SW would wait until every controlled page is closed.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Start controlling already-open pages on activation.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  // Server payload is JSON — defensively parse so a malformed payload
  // still surfaces a generic notification rather than swallowing it.
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_err) {
    data = {};
  }
  const title = (data && data.title) || "Elevate AE";
  const body = (data && data.body) || "New Juice Box post 🍊";
  const url = (data && data.url) || "/juice-box";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      // /icon-192.png is the same asset Pass 4 PWA setup provisions.
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // Collapse repeated Juice Box pings into the same notification
      // tray entry — the latest one replaces the previous.
      tag: "juice-box-post",
      renotify: true,
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetPath =
    (event.notification.data && event.notification.data.url) || "/juice-box";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // Focus any open window already on /juice-box.
        for (const client of clientList) {
          try {
            const u = new URL(client.url);
            if (u.pathname === targetPath && "focus" in client) {
              return client.focus();
            }
          } catch (_err) {
            // Skip malformed urls.
          }
        }
        // Otherwise navigate the first available window to /juice-box,
        // or open a new window if nothing is open.
        if (clientList.length > 0 && "navigate" in clientList[0]) {
          return clientList[0].navigate(targetPath).then((c) =>
            c && "focus" in c ? c.focus() : c,
          );
        }
        return self.clients.openWindow(targetPath);
      }),
  );
});
