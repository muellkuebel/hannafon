const VERSION = "V1.04";
const CACHE = "hannafon-v1.04";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./js/app.js",
  "./js/api.js",
  "./js/config.js",
  "./js/signaling.js",
  "./js/webrtc.js",
  "./js/audio.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
  "./icons/favicon.ico",
  "./icons/family-heads.svg",
  "./fonts/Fraunces-Variable.ttf",
  "./fonts/Fraunces-Italic-Variable.ttf",
  "./fonts/Nunito-Variable.ttf",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE && !k.startsWith("hannafon-media-")).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (url.pathname.includes("/api/")) return;
  event.respondWith(
    caches.match(event.request).then((hit) => hit || fetch(event.request))
  );
});

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let data = {};
    try {
      data = event.data ? event.data.json() : {};
    } catch {
      try {
        data = { body: event.data ? event.data.text() : "" };
      } catch {
        data = {};
      }
    }
    const title = data.title || "Hannafon";
    const body = data.body || "Eingehender Anruf";
    const extra = data.data || {};
    if (!extra.url) extra.url = "/hannafon/";
    await self.registration.showNotification(title, {
      body,
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      data: extra,
      lang: "de",
      requireInteraction: true,
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = data.url || "/hannafon/";
  event.waitUntil(
    (async () => {
      const all = await clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        const href = client.url || "";
        if (href.includes("/hannafon") && "focus" in client) {
          try { client.postMessage({ type: "incoming", data }); } catch { /* ignore */ }
          if ("navigate" in client) {
            try { await client.navigate(target); } catch { /* ignore */ }
          }
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(target);
    })()
  );
});
