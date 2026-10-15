/**
 * [SGN-05] Runtime network audit (BRIEF section 2 "No network requests at runtime, except the peer-to-peer connection
 * for online 1v1"; "No accounts, ads, analytics or tracking. No API keys anywhere"; definition of done 9).
 *
 * One page plays through every offline path of the shipped build while the context logs every request the browser
 * makes (service worker included) and the page logs every WebSocket, RTCPeerConnection, sendBeacon, fetch, XHR and
 * EventSource it opens: boot and install (service worker), the menus, every settings tab, Diagnostics > Credits and
 * licences, a full Kick-Off match by touch (clock fast-forwarded), practice free play, the tutorial, and an offline
 * reload from the cache. Nothing may leave the page's origin. Last, the online screen: opening it is silent, and only
 * "Create room" reaches out, to the PeerJS broker alone (aborted here, so no traffic leaves the container).
 * The shipped index.html is also scanned for analytics, tracker, font-CDN and API-key patterns.
 *
 *   npx vite build --outDir dist-e2e/sgn-05 --emptyOutDir && node tools/postbuild.mjs dist-e2e/sgn-05
 *   PW_DIST=dist-e2e/sgn-05 PW_PORT=4455 npx playwright test tests/e2e/sgn-05-network.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import {
  centreOf, collectConsole, fastForward, frames, route, stopFastForward, Touch, touchTestId, waitMatch, waitRoute,
} from './int-b-harness';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Page-side instrumentation: every network-capable API the page could use is wrapped and logged. */
const INSTRUMENT = `
  (() => {
    const log = { rtc: [], ws: [], beacon: [], fetch: [], xhr: [], es: [] };
    window.__sgn05 = log;
    const abs = (u) => { try { return new URL(String(u && u.url ? u.url : u), location.href).href; } catch { return String(u); } };
    const wrapCtor = (name, rec) => {
      const C = window[name];
      if (typeof C !== 'function') return;
      window[name] = new Proxy(C, { construct(t, args, nt) { rec(args); return Reflect.construct(t, args, nt); } });
    };
    wrapCtor('RTCPeerConnection', (a) => log.rtc.push(JSON.stringify((a[0] && a[0].iceServers) || null)));
    wrapCtor('webkitRTCPeerConnection', (a) => log.rtc.push(JSON.stringify((a[0] && a[0].iceServers) || null)));
    wrapCtor('WebSocket', (a) => log.ws.push(abs(a[0])));
    wrapCtor('EventSource', (a) => log.es.push(abs(a[0])));
    if (navigator.sendBeacon) {
      const b = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = (u, d) => { log.beacon.push(abs(u)); return b(u, d); };
    }
    const f = window.fetch.bind(window);
    window.fetch = (input, init) => { log.fetch.push(abs(input)); return f(input, init); };
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u, ...rest) { log.xhr.push(abs(u)); return open.call(this, m, u, ...rest); };
  })();
`;

interface PageNet { rtc: string[]; ws: string[]; beacon: string[]; fetch: string[]; xhr: string[]; es: string[] }

const pageNet = (page: Page): Promise<PageNet> => page.evaluate(() => (window as any).__sgn05 as PageNet);

/** Network URLs (http, https, ws, wss) that leave `origin`; data: and blob: URLs never touch the network. */
function leaving(urls: readonly string[], origin: string): string[] {
  return urls.filter((u) => /^(https?|wss?):/i.test(u) && new URL(u).origin !== origin);
}

function mergeNet(a: PageNet, b: PageNet): PageNet {
  return {
    rtc: [...a.rtc, ...b.rtc], ws: [...a.ws, ...b.ws], beacon: [...a.beacon, ...b.beacon], fetch: [...a.fetch, ...b.fetch],
    xhr: [...a.xhr, ...b.xhr], es: [...a.es, ...b.es],
  };
}

/** Wait for `target` while playing by touch; a kick-off the human's side must take is taken with a tap on PASS. */
async function playUntil(page: Page, t: Touch, target: string, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (target === 'finished') {
      if (await page.evaluate(() => (window as any).__dotkick.ctx.session.finished === true)) return;
    } else if ((await route(page)) === target) return;
    const k = await page.evaluate(() => {
      const st = (window as any).__dotkick.ctx.session.getState();
      return st ? { phase: st.match.phase, phaseT: st.match.phaseT, team: st.match.restart.team } : null;
    });
    if (k && k.phase === 1 && k.team === 0 && k.phaseT > 90) {
      const pass = await centreOf(page, '.dk-tbtn[data-btn="0"]');
      if (pass) await t.tap(pass.x, pass.y);
    }
    await frames(page, 10);
  }
  throw new Error(`timed out waiting for ${target}`);
}

async function toMain(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__dotkick.ctx.router.go('main'));
  await waitRoute(page, 'main');
}

/** Patterns that must never appear in the shipped page: trackers, analytics, font / script CDNs, API keys. */
const FORBIDDEN_IN_BUNDLE: readonly RegExp[] = [
  /google-analytics\.com/i, /googletagmanager\.com/i, /\bgtag\(/, /\bga\('create'/, /doubleclick\.net/i,
  /sentry\.io/i, /\bSentry\.init\b/, /mixpanel/i, /amplitude\.com/i, /hotjar/i, /segment\.(io|com)/i,
  /plausible\.io/i, /matomo/i, /clarity\.ms/i, /fullstory/i, /posthog/i, /bugsnag/i, /newrelic/i, /datadoghq/i,
  /fonts\.googleapis\.com/i, /fonts\.gstatic\.com/i, /use\.typekit\.net/i, /cdn\.jsdelivr\.net/i, /unpkg\.com/i,
  /cdnjs\.cloudflare\.com/i, /\bAIza[0-9A-Za-z_-]{20,}/, /\bsk-[A-Za-z0-9]{20,}/, /\bghp_[A-Za-z0-9]{20,}/,
  /\bapi[_-]?key\s*[:=]/i, /navigator\.sendBeacon/,
];

test.describe('SGN-05 runtime network', () => {
  // Chromium service-worker requests (install, cache refresh) reach context.on('request') and context.route only with
  // this Playwright flag, read when a worker starts: set for this file, restored after it.
  const SW_FLAG = 'PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS';
  let swFlagBefore: string | undefined;
  test.beforeAll(() => {
    swFlagBefore = process.env[SW_FLAG];
    process.env[SW_FLAG] = '1';
  });
  test.afterAll(() => {
    if (swFlagBefore === undefined) delete process.env[SW_FLAG];
    else process.env[SW_FLAG] = swFlagBefore;
  });

  test('shipped page: licence notices inside, no tracker, analytics, font CDN, API key or dev-only package', async ({ request }) => {
    const html = await (await request.get('/index.html')).text();
    expect(html.length).toBeGreaterThan(100_000);
    // Third-party notices (tools/postbuild.mjs): one comment right after the doctype with every licence text.
    expect(html).toMatch(/^<!doctype html>\s*<!-- dotkick-notices/i);
    for (const n of ['three', 'peerjs', 'webrtc-adapter', 'sdp', 'peerjs-js-binarypack', '@msgpack/msgpack', 'eventemitter3',
      '@fontsource/space-grotesk', '@fontsource/jetbrains-mono']) expect(html, n).toContain(`=== ${n} `);
    expect(html).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(html).toContain('Permission is hereby granted');
    expect(html).toContain('Redistribution and use in source and binary forms');
    // Dev-only packages stay out (the local PeerServer `peer` and its express server, test tools).
    expect(html).not.toMatch(/peerjs-server|\bexpress\b|vitest|@playwright|typescript-eslint/);
    for (const re of FORBIDDEN_IN_BUNDLE) expect(html, String(re)).not.toMatch(re);
    // The only network endpoints in the bundle are the online 1v1 ones (PeerJS broker, its STUN / TURN defaults).
    for (const m of html.matchAll(/\b(?:wss?|stun|turn):[/]{0,2}([a-z0-9.-]+)/gi)) {
      expect(['0.peerjs.com', 'stun.l.google.com', 'eu-0.turn.peerjs.com', 'us-0.turn.peerjs.com'], m[0]).toContain(m[1]!);
    }
  });

  test('every offline path stays inside the page origin; only Create room reaches out, to the PeerJS broker', async ({ page, context, baseURL }) => {
    test.setTimeout(600_000);
    const origin = new URL(baseURL!).origin;
    const external: string[] = [];
    const allRequests: string[] = [];
    const sockets: string[] = [];
    context.on('request', (r) => allRequests.push(r.url()));
    page.on('websocket', (ws) => sockets.push(ws.url()));
    await context.route((u) => /^(https?|wss?):$/.test(u.protocol) && u.origin !== origin, async (r) => {
      external.push(r.request().url());
      await r.abort();
    });
    await context.routeWebSocket(() => true, (ws) => {
      sockets.push(ws.url());
      void ws.close();
    });
    await page.addInitScript(INSTRUMENT);
    const errors = collectConsole(page);
    const t0 = Date.now();
    const lap = (what: string): void => console.log(`[sgn-05] ${what} at ${((Date.now() - t0) / 1000).toFixed(1)} s, ${allRequests.length} requests`);

    // ---- boot, install (service worker), main menu
    await page.goto('/');
    const t = await Touch.open(page);
    await touchTestId(page, t, 'splash-start');
    await waitRoute(page, 'main', 15_000);
    await expect.poll(() => page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return !!reg && !!reg.active && reg.active.state === 'activated';
    }), { timeout: 30_000 }).toBe(true);
    lap('booted and installed');

    // ---- settings: every tab, a few toggles; Diagnostics > Credits and licences
    await touchTestId(page, t, 'main-settings');
    await waitRoute(page, 'settings');
    const tabs = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid^="settings-tab-"]')].map((e) => e.dataset.testid!));
    expect(tabs.length).toBeGreaterThan(2);
    for (const id of tabs) {
      await touchTestId(page, t, id);
      await frames(page, 3);
    }
    await page.evaluate(() => (window as any).__dotkick.ctx.settings.update((s: any) => { s.match.halfMinutes = 2; s.match.night = !s.match.night; }));
    await page.evaluate(() => (window as any).__dotkick.ctx.router.go('diagnostics'));
    await waitRoute(page, 'diagnostics');
    await touchTestId(page, t, 'diagnostics-credits');
    await expect(page.getByTestId('credits-view')).toContainText('three');
    await expect(page.getByTestId('credits-view')).toContainText('SIL Open Font License');
    await toMain(page);
    lap('settings and credits');

    // ---- full Kick-Off match by touch, clock fast-forwarded
    await touchTestId(page, t, 'main-mode-kickoff');
    await waitRoute(page, 'mode-setup');
    await touchTestId(page, t, 'mode-continue');
    await waitRoute(page, 'team-select');
    await touchTestId(page, t, 'team-continue');
    await waitRoute(page, 'side-select');
    await touchTestId(page, t, 'side-continue');
    await waitRoute(page, 'match-settings');
    await touchTestId(page, t, 'settings-start');
    await waitMatch(page);
    lap('match loaded');
    await fastForward(page);
    await playUntil(page, t, 'half-time', 180_000);
    await touchTestId(page, t, 'ht-continue');
    await waitRoute(page, 'match');
    await playUntil(page, t, 'full-time', 180_000);
    if (!(await page.evaluate(() => (window as any).__dotkick.ctx.session.finished))) await touchTestId(page, t, 'ft-continue');
    await playUntil(page, t, 'finished', 90_000);
    await stopFastForward(page);
    await touchTestId(page, t, 'ft-quit');
    await waitRoute(page, 'main');
    lap('full match');

    // ---- practice free play and the tutorial
    await touchTestId(page, t, 'main-practice');
    await waitRoute(page, 'practice');
    await touchTestId(page, t, 'practice-free-play');
    await touchTestId(page, t, 'practice-start');
    await waitMatch(page);
    await frames(page, 60);
    const pp = await centreOf(page, '.dk-tbtn--pause');
    await t.tap(pp!.x, pp!.y);
    await touchTestId(page, t, 'pause-quit');
    await touchTestId(page, t, 'pause-quit-confirm');
    await waitRoute(page, 'practice');
    await touchTestId(page, t, 'practice-tutorial');
    await touchTestId(page, t, 'practice-start');
    await waitRoute(page, 'tutorial');
    await touchTestId(page, t, 'tut-start');
    await waitMatch(page);
    await frames(page, 60);
    await page.evaluate(() => (window as any).__dotkick.ctx.session.quit());
    await waitRoute(page, 'tutorial');
    await toMain(page);
    lap('practice and tutorial');

    // ---- offline: reload from the service worker cache with the network off (the reload resets the page log)
    const beforeReload = await pageNet(page);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('splash-start')).toBeVisible({ timeout: 30_000 });
    await touchTestId(page, t, 'splash-start');
    await waitRoute(page, 'main', 15_000);
    await context.setOffline(false);
    lap('offline reload');

    // Nothing so far may have left the origin; the service worker's own requests were observed too.
    expect(allRequests.some((u) => u.endsWith('/manifest.webmanifest')), 'service-worker install requests are logged').toBe(true);
    const offlineNet = mergeNet(beforeReload, await pageNet(page));
    const offlineReport = {
      external, sockets, rtc: offlineNet.rtc, beacon: offlineNet.beacon, es: offlineNet.es, ws: offlineNet.ws,
      fetch: leaving(offlineNet.fetch, origin), xhr: leaving(offlineNet.xhr, origin), requests: leaving(allRequests, origin),
    };
    expect(offlineReport).toEqual({ external: [], sockets: [], rtc: [], beacon: [], es: [], ws: [], fetch: [], xhr: [], requests: [] });
    const httpRequests = allRequests.filter((u) => /^https?:/i.test(u));
    const paths = new Set(httpRequests.map((u) => new URL(u).pathname));
    console.log(`[sgn-05] offline paths: ${httpRequests.length} http requests, all to ${origin}: ${[...paths].sort().join(' ')}`);

    // ---- online screen: opening it is silent; Create room contacts the PeerJS broker and nothing else
    await touchTestId(page, t, 'main-friend');
    await waitRoute(page, 'mode-setup');
    await touchTestId(page, t, 'mode-friend-online');
    await waitRoute(page, 'online-lobby');
    await frames(page, 30);
    expect(external, 'opening the online screen').toEqual([]);
    expect(sockets, 'opening the online screen').toEqual([]);
    await page.getByTestId('net-nickname').fill('Audit');
    await touchTestId(page, t, 'net-create');
    await expect.poll(() => external.length + sockets.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(3000);
    const hosts = new Set([...external, ...sockets].map((u) => new URL(u).hostname));
    console.log(`[sgn-05] Create room contacted: ${[...hosts].join(', ')} (${external.length} requests, ${sockets.length} sockets)`);
    expect([...hosts]).toEqual(['0.peerjs.com']);
    const rtc = (await pageNet(page)).rtc;
    for (const ice of rtc) {
      for (const m of ice.matchAll(/(?:stun|turn)s?:([a-z0-9.-]+)/gi)) {
        expect(['stun.l.google.com', 'eu-0.turn.peerjs.com', 'us-0.turn.peerjs.com']).toContain(m[1]!);
      }
    }
    await t.detach();
    // The broker is unreachable by design here; the app reports it (expected console noise from that path only).
    const unexpected = errors.filter((e) => !/peerjs|broker|net::ERR_FAILED|ERR_INTERNET_DISCONNECTED|WebSocket|Failed to fetch|Could not get an ID/i.test(e));
    expect(unexpected).toEqual([]);
  });
});
