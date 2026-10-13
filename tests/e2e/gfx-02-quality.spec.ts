/**
 * [GFX-02] Quality tiers and dynamic resolution in a real browser (Chromium + SwiftShader WebGL2):
 *  - AUTO runs the startup test during the loading screen and applies its pick (window.__dotkickQuality());
 *  - changing settings.graphics.tier in a running match applies at once (renderer stats, tier parameters, the
 *    shadow-map switch) and a fixed resolution scale sizes the drawing buffer; back to AUTO + automatic returns to
 *    the tested tier and the initial 0.75 scale;
 *  - the dynamic controller keeps the scale on the 0.05 grid inside 0.6..1.0 while the match plays.
 * Build first: npx vite build --outDir dist-e2e/gfx-02 --emptyOutDir
 * Run:         PW_DIST=dist-e2e/gfx-02 PW_PORT=4202 npx playwright test tests/e2e/gfx-02-quality.spec.ts
 * Optional:    GFX02_SHOT_DIR=<dir> also writes the screenshots there (for looking at them).
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const GPU_ENVIRONMENT_NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/];
const CANVAS_ONLY = '#ui, #hud, #touch { visibility: hidden !important; }';

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

async function kickOff(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('splash-start').tap();
  await page.getByTestId('main-kickoff').tap();
  await page.waitForFunction(() => {
    const d = window.__dotkick;
    return !!d && d.ctx.router.current === 'match' && d.app.session.loaded;
  }, null, { timeout: 60_000 });
  await page.waitForFunction(() => (window.__dotkick!.ctx.session.getState()?.tick ?? 0) > 10, null, { timeout: 30_000 });
}

async function waitFrames(page: Page, n: number): Promise<void> {
  const f0 = await page.evaluate(() => window.__dotkickFrameStats!.frame);
  await page.waitForFunction((f) => window.__dotkickFrameStats!.frame >= f, f0 + n, { timeout: 30_000 });
}

interface Probe {
  requested: number; tier: number; scale: number; fixedScale: number; statsTier: number; statsScale: number;
  shadowMapEnabled: boolean; msaa: boolean; crowdDensity: number; bufW: number; cssW: number; dpr: number;
  test: { samples: number; tier: number; conclusive: boolean; medianMs: number; warmupMs: number; elapsedMs: number } | null;
  fps: number; scaleChanges: number;
}

async function probe(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    const q = window.__dotkickQuality!();
    const st = window.__dotkickRendererStats!();
    const c = document.getElementById('game') as HTMLCanvasElement;
    return {
      requested: q.requested, tier: q.tier, scale: q.scale, fixedScale: q.fixedScale, statsTier: st.qualityTier,
      statsScale: st.resolutionScale, shadowMapEnabled: q.shadowMapEnabled, msaa: q.params.msaa,
      crowdDensity: q.params.crowdDensity, bufW: c.width, cssW: c.clientWidth, dpr: window.devicePixelRatio,
      test: q.startupTest ? { ...q.startupTest } : null, fps: q.fps, scaleChanges: q.scaleChanges,
    };
  });
}

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  const png = await page.screenshot({ style: CANVAS_ONLY });
  await info.attach(name, { body: png, contentType: 'image/png' });
  const dir = process.env.GFX02_SHOT_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.png`), png);
  }
}

const onGrid = (s: number): boolean => Math.abs(s * 20 - Math.round(s * 20)) < 1e-9;

test.describe('GFX-02 quality', () => {
  test('AUTO startup test during loading; settings tier and fixed scale apply mid-match; dynamic scale stays in bounds', async ({ page }, info) => {
    test.setTimeout(240_000);
    const messages = collectConsole(page);
    await kickOff(page);

    // AUTO: the startup test ran during loading and its pick is applied.
    const a = await probe(page);
    expect(a.requested).toBe(0);
    expect(a.test).not.toBeNull();
    expect(a.test!.samples).toBeGreaterThan(0);
    // The measured phase is capped at 2 s (plus the one frame in flight); warm-up draws link the shaders.
    expect(a.test!.elapsedMs - a.test!.warmupMs).toBeLessThan(2000 + 1500);
    expect([1, 2, 3]).toContain(a.tier);
    if (a.test!.conclusive) expect(a.tier).toBe(a.test!.tier);
    expect(a.statsTier).toBe(a.tier);
    expect(a.scale).toBeGreaterThanOrEqual(0.6);
    expect(a.scale).toBeLessThanOrEqual(1);
    console.log(`GFX-02 startup test: ${JSON.stringify(a.test)} -> tier ${a.tier}`);

    // Settings screen: QUALITY + fixed 100 %.
    await page.evaluate(() => window.__dotkick!.ctx.settings.update((s) => {
      s.graphics.tier = 3;
      s.graphics.resolutionScale = 1;
    }));
    await waitFrames(page, 3);
    const q = await probe(page);
    expect(q.tier).toBe(3);
    expect(q.statsTier).toBe(3);
    expect(q.shadowMapEnabled).toBe(true);
    expect(q.msaa).toBe(true);
    expect(q.crowdDensity).toBe(1);
    expect(q.scale).toBe(1);
    expect(q.statsScale).toBe(1);
    expect(Math.abs(q.bufW - q.cssW * q.dpr)).toBeLessThanOrEqual(1);
    await shot(page, info, 'gfx02-quality-100');

    // PERFORMANCE + fixed 60 %.
    await page.evaluate(() => window.__dotkick!.ctx.settings.update((s) => {
      s.graphics.tier = 1;
      s.graphics.resolutionScale = 0.6;
    }));
    await waitFrames(page, 3);
    const p = await probe(page);
    expect(p.tier).toBe(1);
    expect(p.statsTier).toBe(1);
    expect(p.shadowMapEnabled).toBe(false);
    expect(p.crowdDensity).toBe(0.5);
    expect(p.scale).toBeCloseTo(0.6, 9);
    expect(Math.abs(p.bufW - Math.floor(p.cssW * p.dpr * 0.6))).toBeLessThanOrEqual(1);
    await shot(page, info, 'gfx02-performance-60');

    // Back to AUTO + automatic: the tested tier, the dynamic controller restarts at 0.75.
    await page.evaluate(() => window.__dotkick!.ctx.settings.update((s) => {
      s.graphics.tier = 0;
      s.graphics.resolutionScale = 0;
    }));
    await waitFrames(page, 3);
    const b = await probe(page);
    expect(b.requested).toBe(0);
    expect(b.tier).toBe(a.tier);
    expect(b.fixedScale).toBe(0);
    expect(b.scale).toBeCloseTo(0.75, 9);

    // Let the match play: the controller adapts on the 0.05 grid inside 0.6..1.0 and the buffer follows. Software
    // WebGL here runs far below 45 fps, so the scale must come down (on a fast machine it may stay or go up).
    await page.waitForFunction((c) => window.__dotkickQuality!().scaleChanges > c, b.scaleChanges, { timeout: 90_000 })
      .catch(() => undefined);
    await waitFrames(page, 2);
    const d = await probe(page);
    console.log(`GFX-02 after play: fps ${d.fps.toFixed(1)} scale ${d.scale} changes ${d.scaleChanges} tier ${d.tier}`);
    expect(onGrid(d.scale)).toBe(true);
    expect(d.scale).toBeGreaterThanOrEqual(0.6);
    expect(d.scale).toBeLessThanOrEqual(1);
    expect(d.statsScale).toBe(d.scale);
    expect(Math.abs(d.bufW - Math.floor(d.cssW * d.dpr * d.scale))).toBeLessThanOrEqual(1);
    if (d.fps < 45) expect(d.scale).toBeLessThan(0.75); // software WebGL is slow: the scale went down
    await shot(page, info, 'gfx02-auto-dynamic');
    expect(messages).toEqual([]);
  });
});
