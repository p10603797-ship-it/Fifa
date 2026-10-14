/**
 * [GFX-01] Renderer setup in a real browser (Chromium + SwiftShader WebGL2):
 *  - resize across 4:3, 16:10, 21:9 and the iPad window keeps rendering; the drawing buffer is CSS size x DPR x
 *    resolution scale (0.75), the camera keeps the vertical framing and shows more pitch on wider windows;
 *    window.__dotkickRendererStats is readable and sane;
 *  - simulated context loss (WEBGL_lose_context): the match pauses, the context is restored, GPU resources are
 *    rebuilt and the same frozen frame draws again with all objects (same draw calls / triangles, same image),
 *    then the match resumes from the pause menu.
 * Build first: npx vite build --outDir dist-e2e/gfx-01 --emptyOutDir
 * Run:         PW_DIST=dist-e2e/gfx-01 PW_PORT=4291 npx playwright test tests/e2e/gfx-01-renderer.spec.ts
 * Optional:    GFX01_SHOT_DIR=<dir> also writes the screenshots there (for looking at them).
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

/** Messages Chromium prints about the software GPU or about WEBGL_lose_context itself (not page bugs). */
const GPU_ENVIRONMENT_NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/, /CONTEXT_LOST_WEBGL/];
/** Hide the DOM layers so screenshots show the 3D canvas only. */
const CANVAS_ONLY = '#ui, #hud, #touch { visibility: hidden !important; }';
const SCALE = 0.75; // T_PERF.resScaleInitial

interface Stats { drawCalls: number; triangles: number; textures: number; geometries: number; resolutionScale: number; qualityTier: number }
interface Image { w: number; h: number; ch: number; px: Uint8Array }

function collectConsole(page: Page): string[] {
  const out: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const text = m.text();
    if (GPU_ENVIRONMENT_NOISE.some((re) => re.test(text))) return;
    out.push(`${m.type()}: ${text}`);
  });
  page.on('pageerror', (e) => out.push(`pageerror: ${e.message}`));
  return out;
}

async function tick(page: Page): Promise<number> {
  return page.evaluate(() => window.__dotkick!.ctx.session.getState()?.tick ?? -1);
}

async function waitTicks(page: Page, n: number): Promise<void> {
  const t0 = await tick(page);
  await page.waitForFunction((t) => (window.__dotkick!.ctx.session.getState()?.tick ?? 0) >= t, t0 + n, { timeout: 30_000 });
}

async function kickOff(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('splash-start').tap();
  await page.getByTestId('main-kickoff').tap();
  await page.waitForFunction(() => {
    const d = window.__dotkick;
    return !!d && d.ctx.router.current === 'match' && d.app.session.loaded;
  }, null, { timeout: 30_000 });
  await page.waitForFunction(() => (window.__dotkick!.ctx.session.getState()?.tick ?? 0) > 10, null, { timeout: 20_000 });
}

/** Two animation frames (a frame requested now has been drawn and presented). */
async function frames(page: Page, n = 2): Promise<void> {
  await page.evaluate((k) => new Promise<void>((res) => {
    let left = k;
    const f = (): void => { if (--left <= 0) res(); else requestAnimationFrame(f); };
    requestAnimationFrame(f);
  }), n);
}

/** Redraw while paused (the loop draws a paused match only when invalidated). */
async function redraw(page: Page, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.evaluate(() => window.__dotkick!.app.loop.invalidate());
    await frames(page, 2);
  }
}

async function rendererStats(page: Page): Promise<Stats> {
  return page.evaluate(() => window.__dotkickRendererStats!());
}

async function contextLost(page: Page): Promise<boolean> {
  return page.evaluate(() => (document.getElementById('game') as HTMLCanvasElement).getContext('webgl2')!.isContextLost());
}

/** Decode an 8-bit, non-interlaced PNG (what Playwright writes): RGB or RGBA, filters 0..4. */
function decodePng(buf: Buffer): Image {
  let off = 8;
  let w = 0, h = 0, ch = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      const depth = data[8]!, colour = data[9]!, interlace = data[12]!;
      if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) throw new Error(`unsupported PNG ${depth}/${colour}/${interlace}`);
      ch = colour === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const px = new Uint8Array(w * h * ch);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[dst + x - ch]! : 0;
      const b = y > 0 ? px[dst - stride + x]! : 0;
      const c = x >= ch && y > 0 ? px[dst - stride + x - ch]! : 0;
      let v = raw[src + x]!;
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[dst + x] = v & 255;
    }
  }
  return { w, h, ch, px };
}

/** Mean luminance and its standard deviation (a blank or single-colour frame has a tiny deviation). */
function lumaStats(img: Image): { mean: number; std: number } {
  let s = 0, s2 = 0;
  const n = img.w * img.h;
  for (let i = 0; i < n; i++) {
    const o = i * img.ch;
    const l = 0.299 * img.px[o]! + 0.587 * img.px[o + 1]! + 0.114 * img.px[o + 2]!;
    s += l;
    s2 += l * l;
  }
  const mean = s / n;
  return { mean, std: Math.sqrt(Math.max(0, s2 / n - mean * mean)) };
}

/** Mean absolute RGB difference per channel (0..255) and the fraction of pixels differing by more than 24. */
function imageDiff(a: Image, b: Image): { mad: number; changed: number } {
  expect([a.w, a.h]).toEqual([b.w, b.h]);
  let sum = 0, changed = 0;
  const n = a.w * a.h;
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let k = 0; k < 3; k++) d += Math.abs(a.px[i * a.ch + k]! - b.px[i * b.ch + k]!);
    sum += d;
    if (d > 24) changed++;
  }
  return { mad: sum / (n * 3), changed: changed / n };
}

async function canvasShot(page: Page, info: TestInfo, name: string): Promise<Image> {
  const png = await page.screenshot({ style: CANVAS_ONLY });
  await info.attach(name, { body: png, contentType: 'image/png' });
  const dir = process.env.GFX01_SHOT_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.png`), png);
  }
  return decodePng(png);
}

test.describe('GFX-01 renderer', () => {
  test('resize across 4:3, 16:10, 21:9 keeps rendering; buffer = CSS x DPR x 0.75; framing; stats readable', async ({ page }, info) => {
    test.setTimeout(240_000);
    const messages = collectConsole(page);
    await kickOff(page);
    // [QF-4] Measure the broadcast camera: past PRE_MATCH, whose establishing orbit (GFX-15) circles the bowl at
    // changing distances (the spans compared below were taken from it and read 4:3 wider than 16:10).
    await page.waitForFunction(() => {
      const st = window.__dotkick!.ctx.session.getState();
      const c = (window as unknown as { __dotkickCinematic?: { shot?: number } }).__dotkickCinematic;
      return !!st && st.match.phase !== 0 && (c?.shot ?? 0) === 0;
    }, null, { timeout: 60_000 });
    const spans: Record<string, { xSpan: number; ySpan: number }> = {};
    for (const [label, w, h] of [['4x3', 1024, 768], ['16x10', 1280, 800], ['21x9', 1680, 720], ['ipad', 1180, 820]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await waitTicks(page, 6);
      await frames(page, 2);
      const m = await page.evaluate(() => {
        const c = document.getElementById('game') as HTMLCanvasElement;
        const r = c.getBoundingClientRect();
        const proj = window.__dotkick!.app.renderer.projector;
        const W = window.innerWidth, H = window.innerHeight;
        // Horizontal pitch span visible at mid-height, and the vertical screen span of the halfway line
        // touchline-to-touchline (vertical framing).
        const left = { x: 0, z: 0 }, right = { x: 0, z: 0 };
        const okL = proj.screenToPitch(0, H * 0.5, left);
        const okR = proj.screenToPitch(W, H * 0.5, right);
        const s = window.__dotkick!.ctx.session.getState()!;
        const camX = s.ball.x; // the camera follows the ball; measure the touchlines at the ball's x
        const near = { x: 0, y: 0 }, far = { x: 0, y: 0 };
        proj.pitchToScreen(camX, 0, 34, near);
        proj.pitchToScreen(camX, 0, -34, far);
        return {
          bw: c.width, bh: c.height, cw: r.width, ch: r.height, W, H, dpr: window.devicePixelRatio,
          okL, okR, xSpan: right.x - left.x, ySpan: (near.y - far.y) / H,
          stats: window.__dotkickRendererStats!(),
          paused: window.__dotkick!.ctx.session.paused,
        };
      });
      // The canvas fills the window, its buffer is CSS size x DPR x scale (no stretching, aspect kept).
      expect(m.paused).toBe(false);
      expect([m.cw, m.ch]).toEqual([w, h]);
      // [QF-4] At the scale in use: GFX-02's dynamic resolution may lower it from 0.75 when frames run slow (SwiftShader
      // under load read 0.7 at 21:9, on a HEAD build too); the buffer follows it exactly.
      const sc = m.stats.resolutionScale;
      expect(sc).toBeLessThanOrEqual(SCALE + 1e-9);
      expect(sc).toBeGreaterThanOrEqual(0.6);
      expect(m.bw).toBe(Math.floor(w * m.dpr * sc));
      expect(m.bh).toBe(Math.floor(h * m.dpr * sc));
      expect(m.bw / m.bh).toBeCloseTo(w / h, 2);
      // Still rendering: draw calls and triangles of the last frame, live GPU resources.
      expect(m.stats.drawCalls).toBeGreaterThan(3);
      expect(m.stats.triangles).toBeGreaterThan(100);
      expect(m.stats.geometries).toBeGreaterThan(0);
      for (const v of Object.values(m.stats)) expect(Number.isFinite(v)).toBe(true);
      expect(m.okL && m.okR).toBe(true);
      spans[label] = { xSpan: m.xSpan, ySpan: m.ySpan };
      const img = await canvasShot(page, info, `gfx01-resize-${label}`);
      expect(lumaStats(img).std).toBeGreaterThan(8); // a real scene, not a blank or single-colour buffer
    }
    // Wider windows show more pitch; the vertical framing (touchline to touchline) stays the same.
    expect(spans['21x9']!.xSpan).toBeGreaterThan(spans['16x10']!.xSpan);
    expect(spans['16x10']!.xSpan).toBeGreaterThan(spans['4x3']!.xSpan);
    const ys = Object.values(spans).map((s) => s.ySpan);
    expect(Math.max(...ys) / Math.min(...ys)).toBeLessThan(1.1);
    console.log(`[gfx-01] spans ${JSON.stringify(spans)}`);
    expect(messages).toEqual([]);
  });

  test('context loss pauses; restore rebuilds and the same frame draws with all objects; resume from the pause menu', async ({ page }, info) => {
    test.setTimeout(240_000);
    const messages = collectConsole(page);
    await kickOff(page);
    const hasExt = await page.evaluate(() => {
      const gl = (document.getElementById('game') as HTMLCanvasElement).getContext('webgl2');
      const ext = gl?.getExtension('WEBGL_lose_context') ?? null;
      (window as unknown as { __gfx01Ext: WEBGL_lose_context | null }).__gfx01Ext = ext;
      return ext !== null;
    });
    test.skip(!hasExt, 'WEBGL_lose_context unavailable');
    const lose = (): Promise<void> => page.evaluate(() => (window as unknown as { __gfx01Ext: WEBGL_lose_context }).__gfx01Ext.loseContext());
    const restore = (): Promise<void> => page.evaluate(() => (window as unknown as { __gfx01Ext: WEBGL_lose_context }).__gfx01Ext.restoreContext());

    await test.step('loss during play pauses the match (system pause) and shows the pause menu', async () => {
      await waitTicks(page, 10);
      await lose();
      await page.waitForFunction(() => window.__dotkick!.ctx.session.paused, null, { timeout: 10_000 });
      expect(await page.evaluate(() => window.__dotkick!.ctx.session.pausedBy)).toBe(-1);
      await expect(page.getByTestId('pause-menu')).toBeVisible();
      expect(await contextLost(page)).toBe(true);
      // Stats stay readable while lost; the paused sim does not advance.
      const st = await rendererStats(page);
      for (const v of Object.values(st)) expect(Number.isFinite(v)).toBe(true);
      const t0 = await tick(page);
      await frames(page, 5);
      expect(await tick(page)).toBe(t0);
      await restore();
      await page.waitForFunction(() => !(document.getElementById('game') as HTMLCanvasElement).getContext('webgl2')!.isContextLost(), null, { timeout: 10_000 });
      await frames(page, 3);
      // Still paused until the player resumes from the pause menu.
      expect(await page.evaluate(() => window.__dotkick!.ctx.session.paused)).toBe(true);
      await page.getByTestId('pause-resume').tap();
      await waitTicks(page, 10);
      expect((await rendererStats(page)).drawCalls).toBeGreaterThan(3);
    });

    await test.step('a frozen frame draws the same after loss + restore: same draw calls, triangles and image', async () => {
      await page.evaluate(() => window.__dotkick!.ctx.session.pause(0));
      await expect(page.getByTestId('pause-menu')).toBeVisible();
      await redraw(page, 12); // let the camera settle on the frozen state
      const before = await rendererStats(page);
      const a = await canvasShot(page, info, 'gfx01-before-loss');
      const la = lumaStats(a);
      expect(la.std).toBeGreaterThan(8);

      await lose();
      await page.waitForFunction(() => (document.getElementById('game') as HTMLCanvasElement).getContext('webgl2')!.isContextLost());
      await frames(page, 3);
      await restore();
      await page.waitForFunction(() => !(document.getElementById('game') as HTMLCanvasElement).getContext('webgl2')!.isContextLost(), null, { timeout: 10_000 });
      await redraw(page, 12);
      const after = await rendererStats(page);
      const b = await canvasShot(page, info, 'gfx01-after-restore');
      console.log(`[gfx-01] before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
      expect(after.drawCalls).toBe(before.drawCalls);
      expect(after.triangles).toBe(before.triangles);
      expect(after.geometries).toBeGreaterThan(0);
      // Textures re-upload lazily on first use: those of the frozen frame are back (others come back when drawn).
      if (before.textures > 0) expect(after.textures).toBeGreaterThan(0);
      expect(after.textures).toBeLessThanOrEqual(before.textures);
      const d = imageDiff(a, b);
      console.log(`[gfx-01] image diff ${JSON.stringify(d)} luma ${JSON.stringify(la)} -> ${JSON.stringify(lumaStats(b))}`);
      expect(d.mad).toBeLessThan(2);
      expect(d.changed).toBeLessThan(0.01);
    });

    await test.step('resume from the pause menu: the match ticks and draws again', async () => {
      await page.getByTestId('pause-resume').tap();
      await waitTicks(page, 20);
      expect(await page.evaluate(() => window.__dotkick!.ctx.router.current)).toBe('match');
      expect((await rendererStats(page)).drawCalls).toBeGreaterThan(3);
      const img = await canvasShot(page, info, 'gfx01-resumed');
      expect(lumaStats(img).std).toBeGreaterThan(8);
    });
    expect(messages).toEqual([]);
  });
});
