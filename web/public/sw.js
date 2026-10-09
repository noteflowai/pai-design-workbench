// Retired service worker. A registered worker made the browser send an extra background request to "/" during
// sign-in; on the hosted site the ALB answers it with a new login nonce cookie, which replaced the one belonging to the
// login in progress, so the callback /oauth2/idpresponse failed with 401. Browsers that still have the old worker
// fetch this script on their next visit: it activates at once, deletes the shell caches and unregisters itself.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith("pai-shell-")) await caches.delete(key);
  await self.registration.unregister();
})()));
