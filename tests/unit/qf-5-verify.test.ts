/**
 * [QF-5] Second QA pass (independent skeptic) over build / install / offline / audio / app lifecycle:
 *  - the update prompt's Reload always does something, also when the offered worker moved on while it waited;
 *  - the service worker answers a host error page for the shell with the cached shell, and a full cache never costs
 *    the page an icon or the manifest;
 *  - a lost WebGL context blocks the match (no Resume into a match nobody can see) until the context is rebuilt.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { AppContext, DeviceRegistry, MatchSetup, Screen, ScreenId } from '../../src/contracts/app';
import { ControllerKind } from '../../src/contracts/enums';
import { createMatchConfig } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { createBlockers, isPlayBusy } from '../../src/app/blockers';
import { createLoop } from '../../src/app/loop';
import { createNullRenderer } from '../../src/app/nullRenderer';
import { createRouter } from '../../src/app/router';
import { createSession } from '../../src/app/session';
import { watchForUpdates, type ContainerLike, type RegistrationLike, type WorkerLike } from '../../src/platform/pwa';

const root = fileURLToPath(new URL('../../', import.meta.url));
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// ============================================================ update flow

class FakeWorker extends EventTarget implements WorkerLike {
  posted: unknown[] = [];
  constructor(public state: string, public build: string | null = null) { super(); }
  postMessage(m: unknown): void { this.posted.push(m); }
  set(state: string): void { this.state = state; this.dispatchEvent(new Event('statechange')); }
}
class FakeReg extends EventTarget implements RegistrationLike {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  active: FakeWorker | null = null;
  update(): Promise<unknown> { return Promise.resolve(); }
}
class FakeContainer extends EventTarget implements ContainerLike {
  controller: FakeWorker | null = null;
}

function updateRig(page: string | null, controller: FakeWorker) {
  const reg = new FakeReg();
  const container = new FakeContainer();
  container.controller = controller;
  reg.active = controller;
  const offers: (() => void)[] = [];
  let reloads = 0;
  const w = watchForUpdates(reg, {
    container, reload: () => { reloads++; }, onUpdateAvailable: (a) => offers.push(a),
    pageBuild: page, buildOf: async (wk) => (wk as FakeWorker).build,
  });
  /** Another tab (or the browser) activates `next`: it claims this page too. */
  const activateElsewhere = (next: FakeWorker): void => {
    reg.waiting = null;
    next.set('activating');
    container.controller = next;
    reg.active = next;
    container.dispatchEvent(new Event('controllerchange'));
    next.set('activated');
  };
  return { reg, container, offers, w, reloads: () => reloads, activateElsewhere };
}

describe('QF-5 verify: the update prompt\'s Reload always does something', () => {
  for (const page of ['0.1.0-aaaa', null]) {
    it(`another tab activated the offered build while the prompt waited: Reload reloads this page at once (page build ${page ?? 'unknown'})`, async () => {
      const old = new FakeWorker('activated', '0.1.0-aaaa');
      const t = updateRig(page, old);
      const next = new FakeWorker('installed', '0.1.0-bbbb');
      t.reg.waiting = next;
      t.w.scan();
      await flush();
      expect(t.offers).toHaveLength(1); // this tab (build A) is offered B
      t.activateElsewhere(next); // the other tab accepted: B controls this page now (mixed versions until reload)
      await flush();
      expect(t.reloads()).toBe(0); // never a reload the player did not ask for
      t.offers[0]!(); // the player taps Reload on the toast that is still up
      expect(t.reloads()).toBe(1);
      t.offers[0]!();
      t.container.dispatchEvent(new Event('controllerchange'));
      expect(t.reloads()).toBe(1);
    });
  }

  it('a newer deploy replaced the offered worker (redundant): Reload activates its successor, then reloads once', async () => {
    const t = updateRig('0.1.0-aaaa', new FakeWorker('activated', '0.1.0-aaaa'));
    const b = new FakeWorker('installed', '0.1.0-bbbb');
    t.reg.waiting = b;
    t.w.scan();
    await flush();
    expect(t.offers).toHaveLength(1);
    const c = new FakeWorker('installed', '0.1.0-cccc');
    b.set('redundant');
    t.reg.waiting = c;
    t.offers[0]!(); // the old toast
    expect(b.posted).toEqual([]);
    expect(c.posted).toEqual([{ type: 'SKIP_WAITING' }]);
    expect(t.reloads()).toBe(0);
    t.container.controller = c;
    t.container.dispatchEvent(new Event('controllerchange'));
    expect(t.reloads()).toBe(1);
  });

  it('a redundant offered worker with nothing waiting: Reload reloads (the network-first shell is the newest build)', async () => {
    const t = updateRig('0.1.0-aaaa', new FakeWorker('activated', '0.1.0-aaaa'));
    const b = new FakeWorker('installed', '0.1.0-bbbb');
    t.reg.waiting = b;
    t.w.scan();
    await flush();
    b.set('redundant');
    t.reg.waiting = null;
    t.offers[0]!();
    expect(t.reloads()).toBe(1);
  });

  it('accepted while the offered worker is still activating (claim pending): the controllerchange reloads, once', async () => {
    const t = updateRig('0.1.0-aaaa', new FakeWorker('activated', '0.1.0-aaaa'));
    const b = new FakeWorker('installed', '0.1.0-bbbb');
    t.reg.waiting = b;
    t.w.scan();
    await flush();
    t.reg.waiting = null;
    b.set('activating');
    t.offers[0]!();
    expect(t.reloads()).toBe(0);
    t.container.controller = b;
    t.container.dispatchEvent(new Event('controllerchange'));
    expect(t.reloads()).toBe(1);
  });

  it('the normal path is unchanged: accept posts SKIP_WAITING to the waiting worker and the controllerchange reloads once', async () => {
    const t = updateRig('0.1.0-aaaa', new FakeWorker('activated', '0.1.0-aaaa'));
    const b = new FakeWorker('installed', '0.1.0-bbbb');
    t.reg.waiting = b;
    t.w.scan();
    await flush();
    t.offers[0]!();
    expect(b.posted).toEqual([{ type: 'SKIP_WAITING' }]);
    expect(t.reloads()).toBe(0);
    t.container.controller = b;
    t.container.dispatchEvent(new Event('controllerchange'));
    t.container.dispatchEvent(new Event('controllerchange'));
    expect(t.reloads()).toBe(1);
  });
});

// ============================================================ service worker in a vm

interface FakeEvent {
  request?: unknown;
  responded?: Promise<Response>;
  waits: Promise<unknown>[];
  respondWith(p: Promise<Response>): void;
  waitUntil(p: Promise<unknown>): void;
}

const makeEvent = (extra: Partial<FakeEvent> = {}): FakeEvent => ({
  waits: [],
  respondWith(p) { this.responded = Promise.resolve(p); },
  waitUntil(p) { this.waits.push(p.catch(() => undefined)); },
  ...extra,
});

const SCOPE = 'https://game.example/dk/';

function loadSw(net: (url: string) => Promise<Response>) {
  const caches = new Map<string, Map<string, Response>>();
  let putFails = false;
  const handlers: Record<string, ((e: FakeEvent) => void)[]> = {};
  const self = {
    location: { href: `${SCOPE}sw.js`, origin: 'https://game.example' },
    registration: { scope: SCOPE },
    clients: { claim: () => Promise.resolve() },
    skipWaiting: () => Promise.resolve(),
    addEventListener: (t: string, fn: (e: FakeEvent) => void) => { (handlers[t] ??= []).push(fn); },
  };
  const cacheObj = (name: string) => {
    if (!caches.has(name)) caches.set(name, new Map());
    const m = caches.get(name)!;
    const key = (r: unknown): string => (typeof r === 'string' ? r : (r as { url: string }).url).split('?')[0]!;
    return {
      put: async (r: unknown, res: Response) => {
        if (putFails) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
        m.set(key(r), res);
      },
      match: async (r: unknown) => m.get(key(r))?.clone(),
    };
  };
  const ctx = {
    self, URL, Request, Response, setTimeout, clearTimeout, Promise,
    fetch: (r: unknown) => net(typeof r === 'string' ? r : (r as { url: string }).url),
    caches: {
      open: async (n: string) => cacheObj(n),
      keys: async () => [...caches.keys()],
      delete: async (n: string) => caches.delete(n),
    },
  };
  runInNewContext(readFileSync(`${root}public/sw.js`, 'utf8'), ctx);
  const fire = (type: string, e: FakeEvent): FakeEvent => {
    for (const fn of handlers[type] ?? []) fn(e);
    return e;
  };
  return { fire, caches, setPutFails: (v: boolean) => { putFails = v; } };
}

const html = (body: string): Response => new Response(`<!doctype html><title>${body}</title>`, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const png = (): Response => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { 'content-type': 'image/png' } });
const navigate = (url: string) => makeEvent({ request: { method: 'GET', url, mode: 'navigate' } });
const get = (url: string) => makeEvent({ request: { method: 'GET', url, mode: 'no-cors' } });

describe('QF-5 verify: service worker against host errors and a full cache', () => {
  async function installed() {
    let answer: (url: string) => Response | null = () => null;
    const sw = loadSw(async (url) => {
      const custom = answer(url);
      if (custom) return custom;
      if (url === SCOPE || url.startsWith(`${SCOPE}?`) || url === `${SCOPE}index.html`) return html('v1');
      if (url.endsWith('.png')) return png();
      if (url.endsWith('.webmanifest')) return new Response('{}', { status: 200, headers: { 'content-type': 'application/manifest+json' } });
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    });
    const ev = sw.fire('install', makeEvent());
    await Promise.all(ev.waits);
    return { sw, setAnswer: (f: (url: string) => Response | null) => { answer = f; } };
  }

  it('the host answers the game with an error page (503 outage, 404 / 410 mid-deploy): the cached game boots, like offline', async () => {
    for (const status of [500, 502, 503, 504, 404, 410]) {
      const { sw, setAnswer } = await installed();
      setAnswer(() => new Response(`<h1>${status} host error</h1>`, { status, headers: { 'content-type': 'text/html' } }));
      for (const url of [SCOPE, `${SCOPE}index.html`, `${SCOPE}?bench=1`]) {
        const e = sw.fire('fetch', navigate(url));
        const res = await e.responded!;
        expect(res.status, `${status} ${url}`).toBe(200);
        expect(await res.text()).toContain('v1');
        await Promise.all(e.waits);
      }
      // The error page never replaced the cached shell.
      setAnswer(() => { throw new TypeError('Failed to fetch'); });
      const off = sw.fire('fetch', navigate(SCOPE));
      expect(await (await off.responded!).text()).toContain('v1');
    }
  });

  it('a host error on another page, a redirect, or a 4xx that is not "gone" passes through untouched', async () => {
    const { sw, setAnswer } = await installed();
    setAnswer((url) => (url.endsWith('missing.html') ? new Response('nope', { status: 503 }) : null));
    const other = await sw.fire('fetch', navigate(`${SCOPE}missing.html`)).responded!;
    expect(other.status).toBe(503);
    setAnswer(() => {
      const r = new Response(null, { status: 200 });
      Object.defineProperty(r, 'type', { value: 'opaqueredirect' });
      Object.defineProperty(r, 'status', { value: 0 });
      return r;
    });
    const redirect = await sw.fire('fetch', navigate(SCOPE)).responded!;
    expect(redirect.type).toBe('opaqueredirect'); // the browser follows it (captive portal login, moved host)
    setAnswer(() => new Response('forbidden', { status: 403 }));
    expect((await sw.fire('fetch', navigate(SCOPE)).responded!).status).toBe(403);
  });

  it('without a cached shell a host error page is still shown (nothing better to serve)', async () => {
    const sw = loadSw(async () => new Response('down', { status: 503, headers: { 'content-type': 'text/html' } }));
    const res = await sw.fire('fetch', navigate(SCOPE)).responded!;
    expect(res.status).toBe(503);
  });

  it('a full cache (quota) never costs the page an icon or the manifest', async () => {
    const sw = loadSw(async (url) => {
      if (url === SCOPE) return html('v1');
      if (url.endsWith('.png')) return png();
      if (url.endsWith('.webmanifest')) return new Response('{"name":"DotKick"}', { status: 200, headers: { 'content-type': 'application/manifest+json' } });
      return new Response('', { status: 404 });
    });
    // Nothing cached yet (the extras failed at install), and the cache is full now.
    sw.setPutFails(true);
    for (const path of ['icons/icon-192.png', 'manifest.webmanifest', 'icons/apple-touch-icon-180.png']) {
      const e = sw.fire('fetch', get(`${SCOPE}${path}`));
      expect(e.responded, path).toBeDefined();
      const res = await e.responded!;
      expect(res.status, path).toBe(200);
    }
  });
});

// ============================================================ WebGL context loss blocks the match

function sessionRig() {
  const focus = { attach: vi.fn(), detach: vi.fn(), handle: vi.fn(), focus: vi.fn(), onAction: vi.fn(() => () => undefined) };
  const rootEl = { appendChild: () => undefined } as unknown as HTMLElement;
  const router = createRouter(rootEl, () => ({ focus } as unknown as AppContext), {
    listen: false,
    createContainer: () => ({ remove() {} }) as unknown as HTMLElement,
  });
  for (const id of ['main', 'loading', 'match', 'half-time', 'full-time', 'recovery'] as ScreenId[]) {
    router.register(id, (): Screen => ({ id, mount() {}, unmount() {} }));
  }
  router.go('main');
  const renderer = createNullRenderer();
  const hud = { mount: vi.fn(), setMatch: vi.fn(), update: vi.fn(), onEvents: vi.fn(), setVisible: vi.fn(), dispose: vi.fn() };
  const audio = {
    unlock: vi.fn(), unlocked: true, setVolumes: vi.fn(), onEvents: vi.fn(), update: vi.fn(), playUi: vi.fn(),
    matchStart: vi.fn(), matchEnd: vi.fn(), setPaused: vi.fn(), suspend: vi.fn(), resume: vi.fn(),
  };
  const devices: DeviceRegistry = {
    list: () => [], subscribe: () => () => undefined, lastActive: () => null,
    createSource: ((id: string) => ({ id, kind: 'pad', sample() {}, releaseAll() {}, dispose() {} })) as never,
  };
  const diagnostics = { log: vi.fn(), recent: () => [], debug: false, setDebug: vi.fn(), report: () => '' };
  const onError = vi.fn();
  let now = 0;
  const session = createSession({
    router, renderer, hud, audio, devices, diagnostics, clubs: CLUBS, getProjector: () => null, onError,
    yieldFrame: () => Promise.resolve(), now: () => now,
  });
  const loop = createLoop({
    session, renderer, hud, audio, router, getProjector: () => null, onError,
    raf: () => 1, caf: () => undefined, now: () => 0,
  });
  const run = (ms: number): number => {
    let ticks = 0;
    const end = now + ms;
    while (now < end - 1e-9) {
      now += 1000 / 60;
      loop.frame(now);
      ticks += loop.info.ticks;
    }
    return ticks;
  };
  // boot.ts wiring: portrait, too small and a lost WebGL context share the session's blocked flag.
  const blockers = createBlockers((b) => session.setBlocked(b));
  const contextLost = (): void => {
    session.pause(-1);
    blockers.set('gpu', true);
  };
  const contextRestored = (): void => blockers.set('gpu', false);
  return { router, session, loop, run, blockers, contextLost, contextRestored, onError };
}

function botSetup(seed = 11): MatchSetup {
  const config = createMatchConfig();
  config.seed = seed;
  config.humans[0]!.kind = ControllerKind.NONE;
  config.humans[0]!.side = -1;
  return { config, bindings: [] };
}

describe('QF-5 verify: a lost WebGL context keeps the match paused until it is rebuilt', () => {
  it('Resume is refused while the context is lost (no match running unseen); after the restore the pause menu resumes', async () => {
    const r = sessionRig();
    r.loop.start();
    r.session.start(botSetup());
    await tick();
    await tick();
    expect(r.session.loaded).toBe(true);
    expect(r.run(500)).toBeGreaterThan(25);
    r.contextLost();
    expect(r.session.paused).toBe(true);
    expect(r.session.pausedBy).toBe(-1);
    // The pause menu shows; a player taps Resume (any human, the pause is a system pause) while nothing can be drawn.
    expect(r.session.resume(0)).toBe(false);
    expect(r.session.resume(-1)).toBe(false);
    r.session.requestPause(0);
    expect(r.session.paused).toBe(true);
    expect(r.session.ticking).toBe(false);
    const t0 = r.session.getState()!.tick;
    expect(r.run(2000)).toBe(0);
    expect(r.session.getState()!.tick).toBe(t0);
    r.contextRestored();
    expect(r.session.paused).toBe(true); // never auto-resume: the pause menu stays
    expect(r.session.resume(0)).toBe(true);
    expect(r.run(500)).toBeGreaterThan(25);
    expect(r.onError).not.toHaveBeenCalled();
  });

  it('a context lost in the menus or during loading: the match loads paused and waits for the restore', async () => {
    const r = sessionRig();
    r.loop.start();
    r.contextLost(); // menus: nothing to pause yet
    r.session.start(botSetup(12));
    await tick();
    await tick();
    expect(r.session.loaded).toBe(true);
    expect(r.session.paused).toBe(true);
    expect(r.session.resume(-1)).toBe(false);
    expect(r.run(1000)).toBe(0);
    r.contextRestored();
    expect(r.session.resume(-1)).toBe(true);
    expect(r.run(500)).toBeGreaterThan(25);
  });

  it('portrait and a lost context overlap: the match stays blocked until both are clear, in either order', () => {
    for (const order of [['gpu', 'portrait'], ['portrait', 'gpu']] as const) {
      const seen: boolean[] = [];
      const b = createBlockers((v) => seen.push(v));
      b.set('portrait', true);
      b.set('gpu', true);
      b.set('tooSmall', false);
      b.set(order[0], false);
      expect(b.blocked).toBe(true);
      b.set(order[1], false);
      expect(b.blocked).toBe(false);
      expect(seen).toEqual([true, false]); // applied only on change
    }
  });
});

// ============================================================ the update toast waits for kick-off too

describe('QF-5 verify: the update toast never lands on a match that is starting', () => {
  it('busy on the loading screen and in live play; not busy paused, at half-time / full-time or in the menus', async () => {
    const r = sessionRig();
    r.loop.start();
    expect(isPlayBusy(r.session, r.router)).toBe(false); // menus
    r.session.start(botSetup(13));
    expect(r.session.loading).toBe(true);
    expect(r.router.current).toBe('loading');
    expect(isPlayBusy(r.session, r.router)).toBe(true); // a toast found now would sit on the scoreboard at kick-off
    await tick();
    await tick();
    expect(r.session.loaded).toBe(true);
    expect(isPlayBusy(r.session, r.router)).toBe(true);
    r.session.pause(0);
    expect(isPlayBusy(r.session, r.router)).toBe(false); // the pause menu: the toast may show
    expect(r.session.resume(0)).toBe(true);
    expect(isPlayBusy(r.session, r.router)).toBe(true);
    r.session.quit();
    expect(isPlayBusy(r.session, r.router)).toBe(false);
  });
});

// ============================================================ hidden page during the loading screen

describe('QF-5 verify: the page hidden while a match loads', () => {
  it('the match loads paused (pause menu on return), runs nothing while hidden and never fast-forwards', async () => {
    const r = sessionRig();
    r.loop.start();
    r.session.start(botSetup(14));
    r.session.setHidden(true); // switched away on the loading screen
    r.loop.stop();
    await tick();
    await tick();
    expect(r.session.loaded).toBe(true);
    expect(r.router.current).toBe('match');
    expect(r.session.paused).toBe(true);
    expect(r.session.pausedBy).toBe(-1);
    expect(r.session.getState()!.tick).toBe(0);
    r.session.setHidden(false);
    r.loop.start();
    r.loop.resetTiming();
    expect(r.run(1000)).toBe(0); // the pause menu waits for the player
    expect(r.session.resume(1)).toBe(true); // a system pause: anyone may resume
    const ticks = r.run(1000);
    expect(ticks).toBeGreaterThanOrEqual(59);
    expect(ticks).toBeLessThanOrEqual(61);
    expect(r.onError).not.toHaveBeenCalled();
  });
});
