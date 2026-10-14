/**
 * [PLT-01] PWA: deterministic icon generator (tools/gen-icons.mjs) and the committed icons, the manifest, the service
 * worker's build-version line, and the update flow (watchForUpdates) with fake workers (Node, no DOM).
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { watchForUpdates, type ContainerLike, type RegistrationLike, type WorkerLike } from '../../src/platform/pwa';

const root = fileURLToPath(new URL('../../', import.meta.url));

interface IconSpec { name: string; size: number; scale: number }
interface GenIcons {
  ICONS: IconSpec[];
  renderIcon(size: number, scale?: number): Uint8Array;
  encodePng(w: number, h: number, rgb: Uint8Array): Buffer;
  generateIcons(): { name: string; size: number; png: Buffer }[];
  crc32(b: Uint8Array): number;
  writeIcons(dir: string, check?: boolean): string[];
}

async function loadGen(): Promise<GenIcons> {
  const url = new URL('../../tools/gen-icons.mjs', import.meta.url).href;
  return (await import(/* @vite-ignore */ url)) as GenIcons;
}

/** Minimal PNG reader for the generator's output (truecolour, filter 0). */
function readPng(buf: Buffer, crcOf: (b: Uint8Array) => number): { w: number; h: number; rgb: Uint8Array; crcOk: boolean } {
  expect([...buf.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let o = 8;
  let w = 0;
  let h = 0;
  const idat: Buffer[] = [];
  let crcOk = true;
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    crcOk = crcOk && buf.readUInt32BE(o + 8 + len) === crcOf(buf.subarray(o + 4, o + 8 + len));
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      expect(data[8]).toBe(8);
      expect(data[9]).toBe(2);
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    expect(raw[y * (w * 3 + 1)]).toBe(0);
    rgb.set(raw.subarray(y * (w * 3 + 1) + 1, (y + 1) * (w * 3 + 1)), y * w * 3);
  }
  return { w, h, rgb, crcOk };
}

describe('PLT-01 icon generator', () => {
  it('is deterministic: two runs give identical bytes, and the committed icons match', async () => {
    const gen = await loadGen();
    const a = gen.generateIcons();
    const b = gen.generateIcons();
    expect(a.map((i) => i.name)).toEqual(['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon-180.png', 'icon-32.png']);
    for (let i = 0; i < a.length; i++) expect(Buffer.compare(a[i]!.png, b[i]!.png)).toBe(0);
    expect(gen.writeIcons(`${root}public/icons`, true)).toEqual([]);
  });

  it('writes valid PNGs whose pixels are the rendered mark (ember dot and chalk ball on ink)', async () => {
    const gen = await loadGen();
    for (const icon of gen.generateIcons()) {
      const png = readPng(icon.png, gen.crc32);
      expect(png.crcOk).toBe(true);
      expect([png.w, png.h]).toEqual([icon.size, icon.size]);
      const spec = gen.ICONS.find((s) => s.name === icon.name)!;
      expect(Buffer.compare(Buffer.from(png.rgb), Buffer.from(gen.renderIcon(icon.size, spec.scale)))).toBe(0);
    }
    const px = gen.renderIcon(100, 1);
    const at = (x: number, y: number): number[] => [...px.subarray((y * 100 + x) * 3, (y * 100 + x) * 3 + 3)];
    expect(at(2, 2)).toEqual([0x07, 0x07, 0x0d]); // ink corner
    expect(at(45, 53)).toEqual([0xff, 0x6b, 0x35]); // ember dot centre
    expect(at(73, 29)).toEqual([0xf4, 0xf1, 0xec]); // chalk ball centre
  });

  it('keeps the maskable mark inside the 80 % safe circle', async () => {
    const gen = await loadGen();
    const n = 128;
    const px = gen.renderIcon(n, 0.8);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const dx = (x + 0.5) / n - 0.5;
        const dy = (y + 0.5) / n - 0.5;
        if (dx * dx + dy * dy <= 0.4 * 0.4) continue;
        const o = (y * n + x) * 3;
        expect([px[o], px[o + 1], px[o + 2]]).toEqual([0x07, 0x07, 0x0d]);
      }
    }
  });
});

describe('PLT-01 manifest and service worker files', () => {
  it('manifest: fullscreen landscape app with relative start_url / scope and existing 192 / 512 / maskable icons', () => {
    const m = JSON.parse(readFileSync(`${root}public/manifest.webmanifest`, 'utf8')) as {
      name: string; short_name: string; start_url: string; scope: string; display: string; orientation: string;
      background_color: string; theme_color: string; icons: { src: string; sizes: string; purpose: string }[];
    };
    expect(m.name).toBe('DotKick');
    expect(m.short_name).toBe('DotKick');
    expect(m.start_url).toBe('./');
    expect(m.scope).toBe('./');
    expect(m.display).toBe('fullscreen');
    expect(m.orientation).toBe('landscape');
    expect(m.background_color).toMatch(/^#[0-9A-F]{6}$/i);
    expect(m.theme_color).toMatch(/^#[0-9A-F]{6}$/i);
    const sizes = m.icons.map((i) => `${i.sizes}:${i.purpose}`);
    expect(sizes).toEqual(expect.arrayContaining(['192x192:any', '512x512:any', '512x512:maskable']));
    for (const i of m.icons) {
      expect(i.src.startsWith('/')).toBe(false);
      expect(existsSync(`${root}public/${i.src}`)).toBe(true);
    }
  });

  it('sw.js has the build-version line postbuild rewrites, a versioned cache and never touches cross-origin requests', () => {
    const sw = readFileSync(`${root}public/sw.js`, 'utf8');
    expect(sw).toMatch(/^const BUILD = '[^']*'; \/\/ dotkick-build/m);
    expect(sw).toContain("const CACHE = PREFIX + BUILD;");
    expect(sw).toContain('if (url.origin !== self.location.origin) return;');
    expect(sw).toContain("data.type === 'SKIP_WAITING'");
    expect(sw).not.toMatch(/skipWaiting\(\)[^]*addEventListener\('install'/); // no unconditional skipWaiting in install
  });
});

// ============================================================ update flow

class FakeWorker extends EventTarget implements WorkerLike {
  posted: unknown[] = [];
  constructor(public state: string) { super(); }
  postMessage(m: unknown): void { this.posted.push(m); }
  set(state: string): void { this.state = state; this.dispatchEvent(new Event('statechange')); }
}

class FakeReg extends EventTarget implements RegistrationLike {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  active: FakeWorker | null = null;
  updates = 0;
  update(): Promise<unknown> { this.updates++; return Promise.resolve(); }
}

class FakeContainer extends EventTarget implements ContainerLike {
  controller: FakeWorker | null = null;
}

function setup(controlled: boolean) {
  const reg = new FakeReg();
  const container = new FakeContainer();
  if (controlled) container.controller = new FakeWorker('activated');
  const offers: (() => void)[] = [];
  let reloads = 0;
  return {
    reg, container, offers,
    reloads: () => reloads,
    watch: () => watchForUpdates(reg, { container, reload: () => { reloads++; }, onUpdateAvailable: (accept) => offers.push(accept) }),
  };
}

describe('PLT-01 update flow', () => {
  it('the first install (no controller) offers nothing', () => {
    const t = setup(false);
    const w = t.watch();
    t.reg.installing = new FakeWorker('installing');
    t.reg.dispatchEvent(new Event('updatefound'));
    t.reg.installing.set('installed');
    expect(t.offers).toHaveLength(0);
    expect(w.offered).toBe(false);
  });

  it('a new worker installed under a controller is offered once; accepting sends SKIP_WAITING and reloads once on controllerchange', () => {
    const t = setup(true);
    const w = t.watch();
    const next = new FakeWorker('installing');
    t.reg.installing = next;
    t.reg.dispatchEvent(new Event('updatefound'));
    next.set('installed');
    t.reg.waiting = next;
    t.reg.installing = null;
    w.scan(); // a later check sees the same waiting worker: no second toast
    expect(t.offers).toHaveLength(1);
    expect(w.offered).toBe(true);
    expect(next.posted).toEqual([]);
    t.offers[0]!();
    expect(w.accepted).toBe(true);
    expect(next.posted).toEqual([{ type: 'SKIP_WAITING' }]);
    t.container.dispatchEvent(new Event('controllerchange'));
    t.container.dispatchEvent(new Event('controllerchange'));
    expect(t.reloads()).toBe(1);
  });

  it('a worker already waiting at registration is offered at once', () => {
    const t = setup(true);
    t.reg.waiting = new FakeWorker('installed');
    t.watch();
    expect(t.offers).toHaveLength(1);
  });

  it('a controller change without acceptance (another tab updated) does not reload', () => {
    const t = setup(true);
    const w = t.watch();
    t.container.dispatchEvent(new Event('controllerchange'));
    expect(t.reloads()).toBe(0);
    w.dispose();
    t.reg.waiting = new FakeWorker('installed');
    t.reg.dispatchEvent(new Event('updatefound'));
    expect(t.offers).toHaveLength(0);
  });
});
