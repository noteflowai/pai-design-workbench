// Static application shell only. Native work, private API data and videos stay network-only.
const VERSION = "pai-shell-0.1.0";
self.addEventListener("install", event => event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"]))));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("pai-shell-") && key !== VERSION).map(key => caches.delete(key))))));
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok && (url.pathname.startsWith("/assets/") || ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"].includes(url.pathname))) {
      const copy = response.clone(); event.waitUntil(caches.open(VERSION).then(cache => cache.put(event.request, copy)));
    }
    return response;
  }).catch(async () => (await caches.match(event.request)) ?? Response.error()));
});
