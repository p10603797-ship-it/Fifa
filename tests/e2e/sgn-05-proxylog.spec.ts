/**
 * [SGN-05, second auditor] Runtime network audit from outside the page (BRIEF section 2 "No network requests at runtime,
 * except the peer-to-peer connection for online 1v1"; definition of done 9).
 *
 * The first audit spec (sgn-05-network.spec.ts) logs requests from inside Playwright (context events and page-side API
 * wrappers). This one does not trust the page or Playwright's event plumbing at all:
 *   - the browser is launched with every request forced through a logging forward proxy started here, loopback
 *     included (`--proxy-bypass-list=<-loopback>`), so every HTTP request, HTTPS / WSS tunnel (CONNECT) and WebSocket
 *     upgrade from any page, worker or service worker is seen at the socket level; only this build's own server is
 *     forwarded, anything else is refused;
 *   - Chromium also writes its own NetLog, and every URL in it is checked after the browser closes.
 * It drives other paths than the first spec, by controller where it can: boot by pad and service-worker install,
 * team select browsing, a same-iPad 1v1 (pad vs pad) to half time and quit from the pause menu, an 8-team Cup tie
 * played to its result, a Shoot-out to the final screen, Diagnostics, the online screen's Join room path (keypad
 * code: silent until the sixth character joins), a friend's share link before and after "Tap to start", and an offline launch in a brand-new tab that starts a
 * Kick-Off match. Only the two online steps may contact anything, and only the PeerJS broker.
 *
 *   npx vite build --outDir dist-e2e/sgn-05 --emptyOutDir && node tools/postbuild.mjs dist-e2e/sgn-05
 *   PW_DIST=dist-e2e/sgn-05 PW_PORT=4455 npx playwright test tests/e2e/sgn-05-proxylog.spec.ts
 */
import { chromium, expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectConsole, fastForward, frames, PAD, padActivate, padInit, padTap, route, stopFastForward, Touch, touchTestId,
  waitMatch, waitRoute,
} from './int-b-harness';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Hit { step: string; kind: 'http' | 'connect' | 'upgrade'; target: string }

/** The only host the online 1v1 steps may reach (src/net/config.ts NET_CONFIG; its STUN / TURN need a peer first). */
const BROKER = '0.peerjs.com';
const ONLINE_STEPS = new Set(['online-join', 'share-link-started']);

/**
 * Counts of the page's peer-to-peer objects (RTCPeerConnection is UDP and never passes an HTTP proxy). ICE gathering
 * (the STUN / TURN traffic) starts only with setLocalDescription; PeerJS's own feature probe constructs and closes one
 * connection when its module loads, which sends nothing.
 */
const RTC_COUNTER = `
  (() => {
    const log = { rtc: 0, setLocal: 0 };
    window.__sgn05b = log;
    const C = window.RTCPeerConnection;
    if (typeof C === 'function') {
      const sld = C.prototype.setLocalDescription;
      C.prototype.setLocalDescription = function (...a) { log.setLocal++; return sld.apply(this, a); };
      window.RTCPeerConnection = new Proxy(C, { construct(t, a, n) { log.rtc++; return Reflect.construct(t, a, n); } });
    }
  })();
`;

/** Wait for `target` while playing; a kick-off the human side must take is taken with Cross on either pad. */
async function playUntil(page: Page, target: string, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const k = await page.evaluate(() => {
      const d = (window as any).__dotkick;
      const st = d.ctx.session.getState();
      return {
        route: d.ctx.router.current, finished: d.ctx.session.finished,
        phase: st ? st.match.phase : -1, phaseT: st ? st.match.phaseT : 0, team: st ? st.match.restart.team : -1,
      };
    });
    if (target === 'finished' ? k.finished : k.route === target) return;
    if (k.phase === 1 && k.phaseT > 90 && (k.team === 0 || k.team === 1)) await padTap(page, k.team, PAD.CROSS);
    await frames(page, 10);
  }
  throw new Error(`timed out waiting for ${target}`);
}

/** Every URL-like string anywhere in a NetLog event's params. */
function netLogUrls(file: string): string[] {
  let text = readFileSync(file, 'utf8').trim();
  if (!text.endsWith('}')) text = text.replace(/,\s*$/, '') + ']}';
  let log: { events?: { params?: Record<string, unknown> }[] };
  try {
    log = JSON.parse(text);
  } catch {
    log = JSON.parse(text.replace(/,?\s*\]\}$/, '') + ']}');
  }
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (/^(https?|wss?):\/\//i.test(v)) out.push(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  for (const e of log.events ?? []) walk(e.params);
  return out;
}

test.describe('SGN-05 network audit through a logging proxy and the NetLog', () => {
  let proxy: Server;
  let proxyPort = 0;
  let appPort = 0;
  let step = 'boot';
  const hits: Hit[] = [];
  const sockets = new Set<Socket>();

  const isApp = (host: string, port: number): boolean => (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') && port === appPort;
  /** Host a hit leaves for, or null when it goes to this build's own server (no local HTTPS here: any tunnel leaves). */
  const foreignHost = (h: Hit): string | null => {
    if (h.kind === 'connect') return h.target.replace(/:\d+$/, '');
    const u = new URL(h.target);
    return isApp(u.hostname, Number(u.port || 80)) ? null : u.hostname;
  };
  const foreignIn = (steps: readonly string[]): Hit[] => hits.filter((h) => steps.includes(h.step) && foreignHost(h) !== null);

  test.beforeAll(async ({ baseURL }) => {
    appPort = Number(new URL(baseURL!).port);
    proxy = createServer((req, res) => {
      const u = new URL(req.url ?? '', 'http://invalid');
      hits.push({ step, kind: 'http', target: u.href });
      if (!isApp(u.hostname, Number(u.port || 80))) {
        res.writeHead(403).end();
        return;
      }
      const headers = { ...req.headers };
      delete headers['proxy-connection'];
      const fwd = httpRequest({ host: 'localhost', port: appPort, method: req.method, path: u.pathname + u.search, headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      fwd.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(fwd);
    });
    const tunnel = (req: IncomingMessage, sock: Socket, head: Buffer, host: string, port: number, kind: Hit['kind']): void => {
      hits.push({ step, kind, target: kind === 'connect' ? `${host}:${port}` : `ws://${req.headers.host}${req.url}` });
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
      sock.on('error', () => undefined);
      if (!isApp(host, port)) {
        sock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const up = netConnect(appPort, 'localhost', () => {
        if (kind === 'connect') sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        else up.write(`${req.method} ${new URL(req.url ?? '/', 'http://x').pathname} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${String(v)}`).join('\r\n')}\r\n\r\n`);
        if (head.length) up.write(head);
        up.pipe(sock);
        sock.pipe(up);
      });
      up.on('error', () => sock.destroy());
    };
    proxy.on('connect', (req: IncomingMessage, sock: Socket, head: Buffer) => {
      const [host = '', port = '443'] = (req.url ?? '').split(/:(?=\d+$)/);
      tunnel(req, sock, head, host, Number(port), 'connect');
    });
    proxy.on('upgrade', (req: IncomingMessage, sock: Socket, head: Buffer) => {
      const u = new URL(req.url ?? '', 'http://invalid');
      tunnel(req, sock, head, u.hostname, Number(u.port || 80), 'upgrade');
    });
    await new Promise<void>((res) => proxy.listen(0, '127.0.0.1', res));
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  test.afterAll(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((res) => proxy.close(() => res()));
  });

  test('only the online 1v1 steps leave the page origin, and only to the PeerJS broker', async ({ baseURL }) => {
    test.setTimeout(600_000);
    const netlog = join(mkdtempSync(join(tmpdir(), 'sgn05-')), 'netlog.json');
    const browser = await chromium.launch({
      proxy: { server: `http://127.0.0.1:${proxyPort}`, bypass: '<-loopback>' },
      args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', `--log-net-log=${netlog}`],
    });
    const context = await browser.newContext({
      baseURL, viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
    });
    await context.addInitScript(padInit(2));
    await context.addInitScript(RTC_COUNTER);
    const page = await context.newPage();
    const errors = collectConsole(page);
    const t0 = Date.now();
    const lap = (what: string): void => console.log(`[sgn-05b] ${what} at ${((Date.now() - t0) / 1000).toFixed(1)} s, ${hits.length} proxied`);

    // ---- boot by controller, service-worker install
    step = 'boot';
    await page.goto('/');
    await expect(page.getByTestId('splash-start')).toBeVisible({ timeout: 30_000 });
    for (let i = 0; i < 6 && (await route(page)) !== 'main'; i++) await padTap(page, 0, PAD.CROSS);
    await waitRoute(page, 'main', 15_000);
    await expect.poll(() => page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return !!reg?.active && reg.active.state === 'activated';
    }), { timeout: 30_000 }).toBe(true);
    await page.evaluate(() => (window as any).__dotkick.ctx.settings.update((s: any) => { s.match.halfMinutes = 2; }));
    await padTap(page, 1, PAD.R2); // controller 2 appears
    lap('booted by pad, worker installed');

    // ---- same-iPad 1v1, pad vs pad: browse the clubs, play to half time, quit from the pause menu
    step = 'friend-local';
    await padActivate(page, 0, 'main-friend');
    await waitRoute(page, 'mode-setup');
    await padActivate(page, 0, 'mode-friend-local');
    await waitRoute(page, 'team-select');
    for (let i = 0; i < 6; i++) { await padTap(page, 0, PAD.RIGHT); await frames(page, 4); }
    await padActivate(page, 0, 'team-continue');
    await waitRoute(page, 'side-select');
    await padActivate(page, 0, 'side-continue');
    await waitRoute(page, 'match-settings');
    await padActivate(page, 0, 'settings-start');
    await waitMatch(page);
    await fastForward(page);
    await playUntil(page, 'half-time', 120_000);
    await stopFastForward(page);
    await padActivate(page, 0, 'ht-continue');
    await waitRoute(page, 'match');
    await frames(page, 30);
    await padTap(page, 0, PAD.OPTIONS);
    await expect.poll(() => page.evaluate(() => (window as any).__dotkick.ctx.session.paused)).toBe(true);
    await padActivate(page, 0, 'pause-quit');
    await padActivate(page, 0, 'pause-quit-confirm');
    await expect.poll(() => route(page)).not.toBe('match');
    await page.evaluate(() => (window as any).__dotkick.ctx.router.resetTo('main'));
    await waitRoute(page, 'main');
    lap('friend match');

    // ---- Cup: 8 teams, draw, play the human tie to its result
    step = 'cup';
    const t = await Touch.open(page);
    await page.evaluate(() => (window as any).__dotkick.ctx.settings.clearProgress());
    await touchTestId(page, t, 'main-cup');
    await waitRoute(page, 'cup');
    await touchTestId(page, t, 'cup-size-8');
    await touchTestId(page, t, 'cup-draw');
    await expect(page.getByTestId('cup-bracket')).toBeVisible();
    await touchTestId(page, t, 'cup-play');
    await waitMatch(page);
    const side = await page.evaluate(() => (window as any).__dotkick.ctx.session.getSetup().config.humans[0].side);
    await page.evaluate((sd) => { (window as any).__dotkick.ctx.session.getState().teams[sd].goals = 2; }, side);
    await fastForward(page);
    const cupEnd = Date.now() + 240_000;
    while ((await route(page)) !== 'cup' && Date.now() < cupEnd) {
      const r = await route(page);
      if (r === 'half-time' && await page.getByTestId('ht-continue').isVisible()) await touchTestId(page, t, 'ht-continue');
      if (r === 'full-time') {
        const id = (await page.getByTestId('ft-cup').isVisible()) ? 'ft-cup' : 'ft-continue';
        if (await page.getByTestId(id).isVisible()) await touchTestId(page, t, id);
      }
      await playUntil(page, 'cup', 3000).catch(() => undefined);
    }
    await stopFastForward(page);
    await waitRoute(page, 'cup');
    await expect(page.getByTestId('cup-result')).toBeVisible();
    await page.evaluate(() => (window as any).__dotkick.ctx.router.resetTo('main'));
    await waitRoute(page, 'main');
    lap('cup tie');

    // ---- Shoot-out to the final screen (decided by state after the first kicks; see int-b-modes)
    step = 'shootout';
    await touchTestId(page, t, 'main-shootout');
    await waitRoute(page, 'mode-setup');
    await touchTestId(page, t, 'mode-continue');
    await waitRoute(page, 'team-select');
    await touchTestId(page, t, 'team-continue');
    await waitRoute(page, 'side-select');
    await touchTestId(page, t, 'side-continue');
    await waitRoute(page, 'match-settings');
    await touchTestId(page, t, 'settings-start');
    await waitMatch(page);
    await page.waitForFunction(() => (window as any).__dotkick.ctx.session.getState()?.match.phase === 14, null, { timeout: 60_000 });
    await page.evaluate(() => {
      const so = (window as any).__dotkick.ctx.session.getState().match.shootout;
      so.goals[0] = 3; so.goals[1] = 0; so.taken[0] = 3; so.taken[1] = 3;
    });
    await page.waitForFunction(() => (window as any).__dotkick.ctx.session.finished === true, null, { timeout: 240_000 });
    await waitRoute(page, 'full-time');
    await touchTestId(page, t, 'ft-quit');
    await waitRoute(page, 'main');
    lap('shoot-out');

    // ---- Diagnostics
    step = 'diagnostics';
    await touchTestId(page, t, 'main-diagnostics');
    await waitRoute(page, 'diagnostics');
    await expect(page.getByTestId('diagnostics-report')).toBeVisible();
    await page.evaluate(() => (window as any).__dotkick.ctx.router.resetTo('main'));
    await waitRoute(page, 'main');

    // Everything so far: the build's own server only, and no peer-to-peer object at all.
    expect(await page.evaluate(() => (window as any).__sgn05b), 'no RTCPeerConnection on the offline paths').toEqual({ rtc: 0, setLocal: 0 });
    const offlineHits = hits.filter((h) => !ONLINE_STEPS.has(h.step));
    expect(offlineHits.filter((h) => foreignHost(h) !== null), 'offline paths reach only the page origin').toEqual([]);
    expect(offlineHits.length, 'the proxy really sees the page traffic').toBeGreaterThan(3);
    const paths = [...new Set(offlineHits.map((h) => new URL(h.target).pathname))].sort();
    console.log(`[sgn-05b] offline steps: ${offlineHits.length} proxied requests, all to the app: ${paths.join(' ')}`);

    // ---- online: the screen itself is silent; Join room with a typed code reaches the broker only
    step = 'online-open';
    await touchTestId(page, t, 'main-friend');
    await waitRoute(page, 'mode-setup');
    await touchTestId(page, t, 'mode-friend-online');
    await waitRoute(page, 'online-lobby');
    await frames(page, 30);
    await touchTestId(page, t, 'net-join');
    await expect(page.getByTestId('net-keypad')).toBeVisible();
    await page.keyboard.type('K7QWM');
    await frames(page, 5);
    expect(foreignIn(['online-open']), 'opening the online screen and typing five characters').toEqual([]);
    // The sixth character joins straight away (online.ts typeChar), like the keypad's Join key.
    step = 'online-join';
    await page.keyboard.type('Z');
    await expect.poll(() => foreignIn(['online-join']).length, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(3000);
    step = 'online-left';
    await page.evaluate(() => (window as any).__dotkick.ctx.router.resetTo('main'));
    await waitRoute(page, 'main');

    // ---- a friend's share link: nothing before "Tap to start"; afterwards the broker only
    step = 'share-link-loaded';
    await page.goto('/?room=K7QWMZ');
    await expect(page.getByTestId('splash-start')).toBeVisible({ timeout: 30_000 });
    await frames(page, 30);
    expect(foreignIn(['share-link-loaded']), 'a share link before Tap to start').toEqual([]);
    step = 'share-link-started';
    await touchTestId(page, t, 'splash-start');
    await expect.poll(() => foreignIn(['share-link-started']).length, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(3000);
    step = 'share-link-left';
    const rtc = await page.evaluate(() => (window as any).__sgn05b as { rtc: number; setLocal: number });
    console.log(`[sgn-05b] share link: ${rtc.rtc} RTCPeerConnection constructed (PeerJS feature probe), ${rtc.setLocal} setLocalDescription`);
    expect(rtc.setLocal, 'no ICE gathering (STUN / TURN) without a reachable broker').toBe(0);
    await t.detach();

    // ---- offline: a brand-new tab, network off, launches from the service worker and starts a Kick-Off match
    step = 'offline-tab';
    await context.setOffline(true);
    const tab = await context.newPage();
    const tabErrors = collectConsole(tab);
    await tab.goto('/');
    await expect(tab.getByTestId('splash-start')).toBeVisible({ timeout: 30_000 });
    const t2 = await Touch.open(tab);
    await touchTestId(tab, t2, 'splash-start');
    await waitRoute(tab, 'main', 15_000);
    await touchTestId(tab, t2, 'main-mode-kickoff');
    await waitRoute(tab, 'mode-setup');
    await touchTestId(tab, t2, 'mode-continue');
    await waitRoute(tab, 'team-select');
    await touchTestId(tab, t2, 'team-continue');
    await waitRoute(tab, 'side-select');
    await touchTestId(tab, t2, 'side-continue');
    await waitRoute(tab, 'match-settings');
    await touchTestId(tab, t2, 'settings-start');
    await waitMatch(tab);
    await frames(tab, 60);
    await tab.evaluate(() => (window as any).__dotkick.ctx.session.quit());
    await t2.detach();
    await context.setOffline(false);
    lap('offline tab');

    await browser.close();

    // ---- verdict from the proxy: online steps reached the broker and nothing else; no stray anywhere
    const onlineHosts = [...new Set(foreignIn([...ONLINE_STEPS]).map((h) => foreignHost(h)!))];
    console.log(`[sgn-05b] online steps contacted: ${onlineHosts.join(', ')}`);
    expect(onlineHosts).toEqual([BROKER]);
    // Right after leaving a room the app may still be closing its broker socket (a late retry goes to the same broker).
    expect(foreignIn(['online-left', 'share-link-left']).filter((h) => foreignHost(h) !== BROKER), 'after leaving a room').toEqual([]);
    // Playwright's offline switch covers pages, not the service worker's own fetches or its update check: those still
    // reach the proxy here (to this origin only). On a device without network they fail and the cache answers.
    expect(foreignIn(['offline-tab']), 'the offline tab reaches nothing outside the origin').toEqual([]);

    // ---- verdict from Chromium's own NetLog: every network URL is the app's origin or the broker
    const origin = new URL(baseURL!).origin;
    const urls = [...new Set(netLogUrls(netlog))];
    const appHost = new URL(origin).host;
    const allowedHost = (tok: string): boolean => {
      // Host and port straight from the text (NetLog also holds URL-like strings that URL() rejects, and network
      // isolation keys such as "http://localhost http://localhost": a schemeful site has no port).
      const host = (/^[a-z]+:\/\/([^/?#\s]*)/i.exec(tok)?.[1] ?? '').replace(/^.*@/, '').toLowerCase();
      const name = host.replace(/:\d+$/, '');
      if (host === appHost || host === appHost.replace('localhost', '127.0.0.1')) return true;
      if (host === 'localhost' || host === '127.0.0.1') return true;
      if (name === BROKER) return true;
      return host === `127.0.0.1:${proxyPort}`;
    };
    const foreign = urls.filter((u) => !u.split(/\s+/).every(allowedHost));
    console.log(`[sgn-05b] NetLog: ${urls.length} distinct URL strings; foreign: ${foreign.length}\n  ${urls.join('\n  ')}`);
    expect(foreign, 'NetLog URLs outside the origin and the broker').toEqual([]);

    const unexpected = [...errors, ...tabErrors].filter((e) => !/peerjs|broker|net::ERR_|WebSocket|Failed to fetch|Could not get an ID|403|Lost connection|Tunnel/i.test(e));
    expect(unexpected).toEqual([]);
  });
});
