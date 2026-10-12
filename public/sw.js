/*
 * DotKick service worker. WAVE 0 PLACEHOLDER (FND-04): installs and activates but caches nothing yet.
 * PLT-01 implements offline play (precache index.html, manifest and icons; network-first update flow).
 * The game never requires this file.
 */
self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
