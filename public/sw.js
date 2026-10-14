/*
 * [PLT-01] DotKick service worker: offline play after the first load (brief section 3) and the update flow.
 * The game never requires this file: index.html runs without it (and without the manifest and icons).
 *
 * Caches
 * - One versioned cache, `dotkick-shell-<BUILD>`. tools/postbuild.mjs writes the build id (package version + a hash
 *   of dist/index.html) into the BUILD line below, so every build that changes the game is a byte-different sw.js:
 *   the browser installs it as a new worker and the page offers "Update available - reload".
 * - install: precache the app shell. index.html ('./') is required (install fails without it, so a broken deploy
 *   never replaces a working offline copy); the manifest and icons are cached when present.
 * - activate: delete every older dotkick-shell-* cache, then claim the open pages.
 *
 * Fetch (GET, same origin, inside the scope only)
 * - Navigations (and index.html itself): network first, so an online player gets the latest build at once; a
 *   network error, or no answer within NAV_TIMEOUT_MS, falls back to the cached shell (offline). Query strings
 *   (?bench=1) share the one cached shell. A good network copy refreshes the cached shell.
 * - Manifest and icons: cache first, then network (cached when fetched).
 * - Everything else is not touched. Cross-origin requests are never intercepted or cached: the PeerJS broker, STUN /
 *   TURN and anything else online 1v1 talks to go straight to the network (WebSockets never reach a service worker),
 *   and a same-origin /peerjs path is skipped too.
 *
 * Messages from the page (src/platform/pwa.ts)
 * - { type: 'SKIP_WAITING' }: the player accepted the update; this waiting worker activates (the page reloads on
 *   controllerchange).
 * - { type: 'STATUS' }: replies on the message port with { type, build, cache, lastNavigation } (diagnostics, tests).
 */
const BUILD = 'dev'; // dotkick-build: tools/postbuild.mjs replaces the quoted value
const PREFIX = 'dotkick-shell-';
const CACHE = PREFIX + BUILD;
const SHELL_KEY = './';
const EXTRAS = [
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon-180.png',
  './icons/icon-32.png',
];
const NAV_TIMEOUT_MS = 4000;

/** Where the last navigation was answered from: 'none' | 'network' | 'cache' | 'cache-timeout' | 'error'. */
let lastNavigation = 'none';

function scopeUrl() {
  return self.registration ? self.registration.scope : new URL('./', self.location.href).href;
}

function shellUrl() {
  return new URL(SHELL_KEY, scopeUrl()).href;
}

function isCacheable(res) {
  return !!res && res.ok && res.status === 200 && (res.type === 'basic' || res.type === 'default');
}

async function precache() {
  const cache = await caches.open(CACHE);
  const shell = await fetch(new Request(shellUrl(), { cache: 'reload', credentials: 'same-origin' }));
  if (!isCacheable(shell)) throw new Error(`app shell not available (${shell.status})`);
  await cache.put(shellUrl(), shell);
  await Promise.all(EXTRAS.map(async (path) => {
    const url = new URL(path, scopeUrl()).href;
    try {
      const res = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }));
      if (isCacheable(res)) await cache.put(url, res);
    } catch {
      /* optional extra */
    }
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith(PREFIX) && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

function isShellRequest(req, url) {
  if (req.mode === 'navigate') return true;
  const scope = new URL(scopeUrl());
  return url.pathname === scope.pathname || url.pathname === `${scope.pathname}index.html`;
}

function isExtra(url) {
  return EXTRAS.some((p) => new URL(p, scopeUrl()).pathname === url.pathname);
}

async function cachedShell() {
  const cache = await caches.open(CACHE);
  return cache.match(shellUrl());
}

async function networkFirst(event) {
  const req = event.request;
  const network = fetch(req).then(async (res) => {
    if (isCacheable(res) && req.mode === 'navigate') {
      const cache = await caches.open(CACHE);
      await cache.put(shellUrl(), res.clone());
    }
    return res;
  });
  event.waitUntil(network.then(() => undefined, () => undefined));
  let timer = 0;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), NAV_TIMEOUT_MS);
  });
  try {
    const first = await Promise.race([network, timeout]);
    if (first !== 'timeout') {
      clearTimeout(timer);
      lastNavigation = 'network';
      return first;
    }
    const cached = await cachedShell();
    if (cached) {
      lastNavigation = 'cache-timeout';
      return cached;
    }
    const late = await network;
    lastNavigation = 'network';
    return late;
  } catch {
    clearTimeout(timer);
    const cached = await cachedShell();
    if (cached) {
      lastNavigation = 'cache';
      return cached;
    }
    lastNavigation = 'error';
    return Response.error();
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (isCacheable(res)) await cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return; // PeerJS broker, STUN/TURN, CDNs: never intercepted
  if (!url.href.startsWith(scopeUrl())) return;
  if (/\/peerjs(\/|$)/.test(url.pathname)) return;
  if (isShellRequest(req, url)) {
    event.respondWith(networkFirst(event));
    return;
  }
  if (isExtra(url)) event.respondWith(cacheFirst(req));
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'STATUS') {
    const reply = { type: 'STATUS', build: BUILD, cache: CACHE, lastNavigation };
    if (event.ports && event.ports[0]) event.ports[0].postMessage(reply);
    else if (event.source) event.source.postMessage(reply);
  }
});
