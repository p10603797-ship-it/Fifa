/**
 * [QF-5] Install, offline, update and storage QA (QA-40) plus the build's licence notices (PLT-06 CR 2):
 *  - the service worker (public/sw.js run in a vm with fake caches / fetch): the cached shell is refreshed only by the
 *    shell itself, redirected responses are stored plain, a full cache never costs the page its network copy;
 *  - the update flow never offers the page as an update of itself and offers a reload when a newer build took
 *    control elsewhere (no mixed versions);
 *  - tools/postbuild.mjs writes the third-party notices and the build meta idempotently; src/platform/licences.ts
 *    reads them back for the Credits and licences view and the diagnostics report.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { askWorkerBuild, gateUpdatePrompt, pageBuildId, watchForUpdates, type ContainerLike, type RegistrationLike, type WorkerLike } from '../../src/platform/pwa';
import { BUNDLED_CREDITS, creditsSummary, parseNotices, readNotices } from '../../src/platform/licences';

const root = fileURLToPath(new URL('../../', import.meta.url));
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

// ============================================================ service worker in a vm

interface FakeEvent {
  request?: unknown;
  data?: unknown;
  ports?: unknown[];
  responded?: Promise<Response>;
  waits: Promise<unknown>[];
  respondWith(p: Promise<Response>): void;
  waitUntil(p: Promise<unknown>): void;
}

function makeEvent(extra: Partial<FakeEvent> = {}): FakeEvent {
  return {
    waits: [],
    respondWith(p) { this.responded = Promise.resolve(p); },
    waitUntil(p) { this.waits.push(p.catch(() => undefined)); },
    ...extra,
  };
}

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
  const shellText = async (): Promise<string | null> => {
    for (const m of caches.values()) {
      const r = m.get(SCOPE);
      if (r) return r.clone().text();
    }
    return null;
  };
  return { fire, caches, shellText, setPutFails: (v: boolean) => { putFails = v; } };
}

const html = (body: string): Response => new Response(`<!doctype html><title>${body}</title>`, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const png = (): Response => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { 'content-type': 'image/png' } });
const navigate = (url: string) => makeEvent({ request: { method: 'GET', url, mode: 'navigate' } });

describe('QF-5 service worker shell cache', () => {
  async function installed(version = 'v1') {
    let online = true;
    let current = version;
    const sw = loadSw(async (url) => {
      if (!online) throw new TypeError('Failed to fetch');
      if (url === SCOPE || url.startsWith(`${SCOPE}?`) || url === `${SCOPE}index.html`) return html(current);
      if (url.endsWith('.png')) return png();
      if (url.endsWith('other.html')) return html('another page');
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    });
    const ev = sw.fire('install', makeEvent());
    await Promise.all(ev.waits);
    return { sw, setOnline: (v: boolean) => { online = v; }, deploy: (v: string) => { current = v; } };
  }

  it('an icon or another page opened in the tab never replaces the cached shell (offline still boots the game)', async () => {
    const { sw, setOnline } = await installed('v1');
    expect(await sw.shellText()).toContain('v1');
    for (const url of [`${SCOPE}icons/icon-192.png`, `${SCOPE}other.html`, `${SCOPE}manifest.webmanifest`]) {
      const e = sw.fire('fetch', navigate(url));
      await e.responded;
      await Promise.all(e.waits);
    }
    expect(await sw.shellText()).toContain('v1');
    setOnline(false);
    const off = sw.fire('fetch', navigate(SCOPE));
    expect(await (await off.responded!).text()).toContain('v1');
  });

  it('the shell itself (scope URL, index.html, a query string) refreshes the cache', async () => {
    const { sw, deploy } = await installed('v1');
    deploy('v2');
    const e = sw.fire('fetch', navigate(`${SCOPE}?bench=1`));
    expect(await (await e.responded!).text()).toContain('v2');
    await Promise.all(e.waits);
    expect(await sw.shellText()).toContain('v2');
  });

  it('a full cache (quota) never costs the page its network copy', async () => {
    const { sw, deploy } = await installed('v1');
    deploy('v3');
    sw.setPutFails(true);
    const e = sw.fire('fetch', navigate(SCOPE));
    const res = await e.responded!;
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('v3');
  });

  it('a redirected shell is stored as a plain copy (Safari refuses redirected responses for navigations)', async () => {
    const sw = loadSw(async (url) => {
      if (url === SCOPE) {
        const r = html('redirected');
        Object.defineProperty(r, 'redirected', { value: true });
        return r;
      }
      return new Response('', { status: 404 });
    });
    const ev = sw.fire('install', makeEvent());
    await Promise.all(ev.waits);
    const stored = [...sw.caches.values()][0]!.get(SCOPE)!;
    expect(stored.redirected).toBe(false);
    expect(await stored.clone().text()).toContain('redirected');
  });
});

// ============================================================ update flow with build ids

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

function updateRig(page: string | null, controller: FakeWorker | null) {
  const reg = new FakeReg();
  const container = new FakeContainer();
  container.controller = controller;
  const offers: (() => void)[] = [];
  let reloads = 0;
  const w = watchForUpdates(reg, {
    container, reload: () => { reloads++; }, onUpdateAvailable: (a) => offers.push(a),
    pageBuild: page, buildOf: async (wk) => (wk as FakeWorker).build,
  });
  return { reg, container, offers, w, reloads: () => reloads };
}

describe('QF-5 update flow: no false prompts, no mixed versions', () => {
  it('a waiting worker of the page\'s own build (page fetched fresh under the old worker) activates quietly: no toast, no reload', async () => {
    const t = updateRig('0.1.0-bbbb', new FakeWorker('activated', '0.1.0-aaaa'));
    const next = new FakeWorker('installed', '0.1.0-bbbb');
    t.reg.waiting = next;
    t.w.scan();
    await flush();
    expect(t.offers).toHaveLength(0);
    expect(next.posted).toEqual([{ type: 'SKIP_WAITING' }]);
    t.container.controller = next;
    t.container.dispatchEvent(new Event('controllerchange'));
    await flush();
    expect(t.reloads()).toBe(0);
    expect(t.offers).toHaveLength(0);
  });

  it('a waiting worker of another build, or one that does not answer, is offered', async () => {
    for (const build of ['0.1.0-cccc', null]) {
      const t = updateRig('0.1.0-bbbb', new FakeWorker('activated', '0.1.0-bbbb'));
      const next = new FakeWorker('installed', build);
      t.reg.waiting = next;
      t.w.scan();
      await flush();
      expect(t.offers).toHaveLength(1);
      expect(next.posted).toEqual([]);
      t.offers[0]!();
      expect(next.posted).toEqual([{ type: 'SKIP_WAITING' }]);
      t.container.dispatchEvent(new Event('controllerchange'));
      expect(t.reloads()).toBe(1);
    }
  });

  it('a newer build that took control elsewhere (another tab accepted) offers a reload; the first install claim does not', async () => {
    const first = updateRig('0.1.0-bbbb', null);
    first.container.controller = new FakeWorker('activated', '0.1.0-bbbb');
    first.container.dispatchEvent(new Event('controllerchange'));
    await flush();
    expect(first.offers).toHaveLength(0);
    const t = updateRig('0.1.0-bbbb', new FakeWorker('activated', '0.1.0-bbbb'));
    t.container.controller = new FakeWorker('activated', '0.1.0-dddd');
    t.container.dispatchEvent(new Event('controllerchange'));
    await flush();
    expect(t.offers).toHaveLength(1);
    t.offers[0]!();
    t.offers[0]!();
    expect(t.reloads()).toBe(1);
  });

  it('without a page build (dev build) the PLT-01 behaviour is unchanged', async () => {
    const t = updateRig(null, new FakeWorker('activated', 'x'));
    t.reg.waiting = new FakeWorker('installed', 'x');
    t.w.scan();
    expect(t.offers).toHaveLength(1);
    t.container.controller = new FakeWorker('activated', 'y');
    t.container.dispatchEvent(new Event('controllerchange'));
    await flush();
    expect(t.offers).toHaveLength(1);
  });

  it('pageBuildId reads the meta; askWorkerBuild asks over a message port and gives up after the timeout', async () => {
    const doc = { querySelector: (s: string) => (s === 'meta[name="dotkick-build"]' ? { getAttribute: () => '0.1.0-abcd' } : null) };
    expect(pageBuildId(doc as unknown as Document)).toBe('0.1.0-abcd');
    expect(pageBuildId(null)).toBeNull();
    const answering = { state: 'installed', addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
      postMessage(m: unknown, t?: Transferable[]) {
        const port = t![0] as MessagePort;
        if ((m as { type: string }).type === 'STATUS') port.postMessage({ type: 'STATUS', build: '0.1.0-ffff' });
      } } as unknown as WorkerLike;
    expect(await askWorkerBuild(answering, 1000)).toBe('0.1.0-ffff');
    const silent = { ...answering, postMessage() {} } as unknown as WorkerLike;
    expect(await askWorkerBuild(silent, 20)).toBeNull();
  });
});

describe('QF-5 update prompt never shows during live play', () => {
  function gateRig() {
    let busy = true;
    const shown: { isConnected: boolean; remove(): void; accept: () => void }[] = [];
    let pending: (() => void) | null = null;
    let accepted = 0;
    const dispose = gateUpdatePrompt(() => { accepted++; }, {
      show: (accept) => {
        const el = { isConnected: true, remove() { this.isConnected = false; }, accept };
        shown.push(el);
        return el as unknown as HTMLElement;
      },
      isBusy: () => busy,
      setTimeout: (fn) => { pending = fn; return 1; },
      clearTimeout: () => { pending = null; },
    });
    const poll = (): void => {
      const fn = pending;
      pending = null;
      fn?.();
    };
    return { shown, poll, setBusy: (b: boolean) => { busy = b; }, accepted: () => accepted, pending: () => pending !== null, dispose };
  }

  it('waits while a match is played, shows in the pause menu, steps aside when play resumes, and accepts once', () => {
    const g = gateRig();
    expect(g.shown).toHaveLength(0); // found mid-match: nothing on screen
    g.poll();
    expect(g.shown).toHaveLength(0);
    g.setBusy(false); // pause menu / menus
    g.poll();
    expect(g.shown).toHaveLength(1);
    expect(g.shown[0]!.isConnected).toBe(true);
    g.setBusy(true); // play resumes: the toast leaves the scoreboard alone
    g.poll();
    expect(g.shown[0]!.isConnected).toBe(false);
    g.setBusy(false);
    g.poll();
    expect(g.shown).toHaveLength(2);
    g.shown[1]!.accept();
    g.shown[1]!.accept();
    expect(g.accepted()).toBe(1);
    expect(g.pending()).toBe(false); // no more polling
  });

  it('a toast whose life ended stops the polling; dispose removes a visible toast', () => {
    const g = gateRig();
    g.setBusy(false);
    g.poll();
    g.shown[0]!.isConnected = false; // its 10-minute life ended
    g.poll();
    expect(g.pending()).toBe(false);
    const h = gateRig();
    h.setBusy(false);
    h.poll();
    h.dispose();
    expect(h.shown[0]!.isConnected).toBe(false);
    expect(h.pending()).toBe(false);
  });
});

// ============================================================ licence notices (postbuild + runtime)

interface Postbuild {
  runPostbuild(dist: string, opts?: { publicDir?: string }): { ok: boolean; errors: string[]; build: string | null; notes: string[] };
  readNotices(nm?: string): { entries: { name: string; version: string; license: string; text: string }[]; errors: string[] };
  noticesComment(entries: unknown[]): string;
  commentSafe(t: string): string;
  NOTICE_PACKAGES: { pkg: string }[];
}
const loadPostbuild = async (): Promise<Postbuild> => (await import(/* @vite-ignore */ new URL('../../tools/postbuild.mjs', import.meta.url).href)) as Postbuild;

describe('QF-5 third-party notices in dist/index.html', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('every bundled library and both fonts, with version, licence id and full text, from node_modules', async () => {
    const pb = await loadPostbuild();
    const { entries, errors } = pb.readNotices();
    expect(errors).toEqual([]);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { dependencies: Record<string, string> };
    for (const [name, version] of Object.entries(pkg.dependencies)) expect(byName[name]?.version).toBe(version);
    expect(byName['three']!.license).toBe('MIT');
    expect(byName['peerjs']!.license).toBe('MIT');
    expect(byName['webrtc-adapter']!.license).toBe('BSD-3-Clause');
    expect(byName['@msgpack/msgpack']!.license).toBe('ISC');
    for (const n of ['sdp', 'eventemitter3', 'peerjs-js-binarypack']) expect(byName[n]!.license).toBe('MIT');
    expect(byName['@fontsource/space-grotesk']!.license).toBe('OFL-1.1');
    expect(byName['@fontsource/jetbrains-mono']!.license).toBe('OFL-1.1');
    for (const e of entries) expect(e.text.length).toBeGreaterThan(300);
    // The runtime fallback list names the same packages.
    expect(BUNDLED_CREDITS.map((c) => c.name).sort()).toEqual(entries.map((e) => e.name).sort());
    // Nothing in the comment can end it early.
    const c = pb.noticesComment(entries);
    expect(c.startsWith('<!-- dotkick-notices\n')).toBe(true);
    expect(c.slice(4, -4)).not.toMatch(/--|<!-/);
    expect(pb.commentSafe('a---->b<!--c--!>')).not.toMatch(/--|<!-/);
  });

  it('runPostbuild puts one notices comment after the doctype and the build meta in the head, idempotently', async () => {
    const pb = await loadPostbuild();
    const base = mkdtempSync(join(tmpdir(), 'qf5-'));
    dirs.push(base);
    const dist = join(base, 'dist');
    const pub = join(base, 'public');
    mkdirSync(dist, { recursive: true });
    mkdirSync(pub, { recursive: true });
    const page = '<!doctype html>\n<html><head><meta charset="utf-8" /><title>x</title></head><body><script type="module">console.log(1)</script></body></html>';
    writeFileSync(join(dist, 'index.html'), page);
    writeFileSync(join(pub, 'sw.js'), "const BUILD = 'dev'; // dotkick-build\n");
    const r = pb.runPostbuild(dist, { publicDir: pub });
    expect(r.errors).toEqual([]);
    const out = readFileSync(join(dist, 'index.html'), 'utf8');
    expect(out.startsWith('<!doctype html>\n<!-- dotkick-notices\n')).toBe(true);
    expect(out.split('<!-- dotkick-notices').length).toBe(2);
    expect(out).toContain(`<meta name="dotkick-build" content="${r.build}" />`);
    expect(readFileSync(join(dist, 'sw.js'), 'utf8')).toContain(`const BUILD = '${r.build}';`);
    const again = pb.runPostbuild(dist, { publicDir: pub });
    expect(again.build).toBe(r.build);
    expect(readFileSync(join(dist, 'index.html'), 'utf8')).toBe(out);
    // A changed game is a new build id in both places.
    writeFileSync(join(dist, 'index.html'), out.replace('<title>x</title>', '<title>y</title>'));
    const next = pb.runPostbuild(dist, { publicDir: pub });
    expect(next.build).not.toBe(r.build);
    expect(readFileSync(join(dist, 'index.html'), 'utf8')).toContain(`content="${next.build}"`);
  });

  it('a missing licence file fails the build', async () => {
    const pb = await loadPostbuild();
    const nm = mkdtempSync(join(tmpdir(), 'qf5-nm-'));
    dirs.push(nm);
    const r = pb.readNotices(nm);
    expect(r.errors.length).toBe(pb.NOTICE_PACKAGES.length);
  });

  it('licences.ts reads the build comment back (Credits and licences view data, diagnostics line)', async () => {
    const pb = await loadPostbuild();
    const { entries } = pb.readNotices();
    const comment = pb.noticesComment(entries);
    const data = comment.slice(4, -4); // what the DOM gives as Comment.data
    const doc = { childNodes: [{ nodeType: 10 }, { nodeType: 8, data }, { nodeType: 1 }] } as unknown as Document;
    const read = readNotices(doc);
    expect(read.fromBuild).toBe(true);
    expect(read.entries.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    const ofl = read.entries.find((e) => e.name === '@fontsource/space-grotesk')!;
    expect(ofl.text).toContain('SIL Open Font License');
    expect(ofl.text).toContain(entries.find((e) => e.name === '@fontsource/space-grotesk')!.text.split('\n')[0]);
    expect(parseNotices('junk\n=== a 1.0.0 (MIT) - x ===\nline\n')).toEqual([{ name: 'a', version: '1.0.0', license: 'MIT', use: 'x', text: 'line' }]);
    expect(creditsSummary(doc)).toMatch(/^three \d+\.\d+\.\d+ \(MIT\), peerjs/);
    // Dev build (no comment): the fallback list, never a throw.
    const dev = readNotices({ childNodes: [] } as unknown as Document);
    expect(dev.fromBuild).toBe(false);
    expect(dev.entries).toHaveLength(BUNDLED_CREDITS.length);
    expect(creditsSummary(null)).toContain('docs/ASSETS.md');
  });
});

describe('QF-5 benchmark measures play only', () => {
  it('a paused match or a hidden page during the run is not sampled and extends the window (no 30 s "longest frame")', async () => {
    const { vi: v } = await import('vitest');
    const { startBench } = await import('../../src/platform/benchHook');
    const { MatchPhase } = await import('../../src/contracts/enums');
    let cb: ((t: number) => void) | null = null;
    let vis = 'visible';
    const visListeners: (() => void)[] = [];
    v.stubGlobal('window', { innerWidth: 1180, innerHeight: 820, devicePixelRatio: 1 });
    v.stubGlobal('requestAnimationFrame', (f: (t: number) => void) => { cb = f; return 1; });
    v.stubGlobal('document', {
      get visibilityState() { return vis; },
      addEventListener: (_t: string, f: () => void) => visListeners.push(f),
      removeEventListener: (_t: string, f: () => void) => { const i = visListeners.indexOf(f); if (i >= 0) visListeners.splice(i, 1); },
    });
    const state = { tick: 5000, match: { phase: MatchPhase.IN_PLAY } };
    const session = { paused: false, active: true, getState: () => state, start: v.fn() };
    let result: { frames: number; longestFrameMs: number; seconds: number; error?: string } | null = null;
    startBench({ session, diagnostics: { log: v.fn() } } as never, {
      seconds: 2, warmupSeconds: 0, panel: false, onDone: (r) => { result = r as never; },
    });
    let t = 0;
    const frame = (dt: number): void => {
      t += dt;
      const f = cb!;
      cb = null;
      f(t);
    };
    frame(16); // waiting -> warm-up
    frame(16); // warm-up -> measuring
    for (let i = 0; i < 60; i++) frame(1000 / 60);
    session.paused = true; // rotate card / pause menu
    for (let i = 0; i < 120; i++) frame(1000 / 60);
    session.paused = false;
    vis = 'hidden'; // background for 30 s: no frames at all
    for (const l of visListeners) l();
    vis = 'visible';
    frame(30_000);
    for (let i = 0; i < 200 && result === null; i++) frame(1000 / 60);
    expect(result).not.toBeNull();
    const r = result!;
    expect(r.error).toBeUndefined();
    expect(r.longestFrameMs).toBeLessThan(20);
    expect(r.frames).toBeGreaterThanOrEqual(118);
    expect(r.frames).toBeLessThanOrEqual(122);
    expect(visListeners).toHaveLength(0); // listener removed at the end
    v.unstubAllGlobals();
  });
});

describe('QF-5 install: index.html, manifest, icons and the offline cache agree', () => {
  it('every install asset index.html and the manifest name exists, has its stated size, and is precached by sw.js', () => {
    const html = readFileSync(`${root}index.html`, 'utf8');
    const manifest = JSON.parse(readFileSync(`${root}public/manifest.webmanifest`, 'utf8')) as {
      icons: { src: string; sizes: string; purpose: string }[]; theme_color: string; background_color: string; display: string;
      orientation: string; start_url: string; scope: string; name: string; short_name: string;
    };
    const sw = readFileSync(`${root}public/sw.js`, 'utf8');
    const extras = JSON.parse(/const EXTRAS = (\[[^\]]*\]);/.exec(sw)![1]!.replace(/'/g, '"').replace(/,\s*\]/, ']')) as string[];
    const pngSize = (rel: string): string => {
      const b = readFileSync(`${root}public/${rel}`);
      expect([...b.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
      return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
    };
    // Apple / install tags.
    const meta = (name: string): string | null => new RegExp(`<meta name="${name}" content="([^"]*)"`).exec(html)?.[1] ?? null;
    expect(meta('viewport')).toMatch(/viewport-fit=cover/);
    expect(meta('viewport')).toMatch(/user-scalable=no/);
    expect(meta('apple-mobile-web-app-capable')).toBe('yes');
    expect(meta('mobile-web-app-capable')).toBe('yes');
    expect(meta('apple-mobile-web-app-title')).toBe(manifest.short_name);
    expect(meta('apple-mobile-web-app-status-bar-style')).toBe('black-translucent');
    expect(meta('theme-color')!.toLowerCase()).toBe(manifest.theme_color.toLowerCase());
    expect(manifest.display).toBe('fullscreen');
    expect(manifest.orientation).toBe('landscape');
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
    // Links in index.html point at real files, with the size they claim, and are cached for offline.
    const links = [...html.matchAll(/<link rel="([^"]+)"([^>]*)href="([^"]+)"/g)].map((m) => ({ rel: m[1]!, attrs: m[2]!, href: m[3]! }));
    expect(links.map((l) => l.rel).sort()).toEqual(['apple-touch-icon', 'icon', 'icon', 'manifest']);
    for (const l of links) {
      expect(extras).toContain(`./${l.href}`);
      if (l.rel === 'manifest') continue;
      const size = pngSize(l.href);
      const claimed = /sizes="(\d+x\d+)"/.exec(l.attrs)?.[1];
      if (claimed) expect(size).toBe(claimed);
      if (l.rel === 'apple-touch-icon') expect(size).toBe('180x180');
    }
    for (const icon of manifest.icons) {
      expect(pngSize(icon.src)).toBe(icon.sizes);
      expect(extras).toContain(`./${icon.src}`);
    }
    expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
    expect(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'any')).toBe(true);
  });
});
