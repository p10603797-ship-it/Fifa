/**
 * TCH-09 touch overlay in a real browser with real touch input (CDP touch events -> PointerEvents 'touch'). Harness
 * page: tests/e2e/tch-09-harness.ts (createTouchInput with the overlay bound to the cluster controller, a pad-drive
 * watcher over a mocked navigator.getGamepads), bundled with esbuild.
 *  - the pressed state is in the DOM synchronously in the pointerdown task and painted by the next frame;
 *  - labels swap with possession (the mapper's mode from the real sim state);
 *  - the controls hide when the mocked pad drives the side and return on the next screen touch;
 *  - layout inside the safe area and off the HUD regions at 4:3, 16:10 (iPad) and 21:9;
 *  - no layout thrash: dragging the stick and holding buttons runs no layout per frame (CDP LayoutCount).
 *   npx vite build --outDir dist-e2e/tch-08 --emptyOutDir
 *   PW_DIST=dist-e2e/tch-08 PW_PORT=4208 npx playwright test tests/e2e/tch-09-overlay.spec.ts
 */
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import { ClusterMode, ClusterSlot, TouchButtonId } from '../../src/contracts/touch';

type Pt = { x: number; y: number; id: number };

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function touches(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', pts: Pt[]): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p) => ({ x: p.x, y: p.y, id: p.id })) });
}

const MOCK_PAD = `
  window.__tch09pad = {
    id: 'Mock Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', index: 0, connected: true, mapping: 'standard',
    timestamp: 0, axes: [0, 0, 0, 0], vibrationActuator: null,
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
`;

test.describe('TCH-09 touch overlay with real touches', () => {
  let js = '';
  let css = '';
  test.beforeAll(async () => {
    const r = await build({
      entryPoints: [path.resolve('tests/e2e/tch-09-harness.ts')],
      bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent', outdir: 'tch09-out',
      define: { __DEV_BUILD__: 'true' },
    });
    for (const f of r.outputFiles) {
      if (f.path.endsWith('.js')) js = f.text;
      else if (f.path.endsWith('.css')) css = f.text;
    }
  });

  async function open(page: Page): Promise<CDPSession> {
    await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body></body></html>');
    await page.addScriptTag({ content: MOCK_PAD });
    if (css) await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: js });
    await page.waitForFunction(() => !!window.__tch09);
    return page.context().newCDPSession(page);
  }
  const slot = (page: Page, s: ClusterSlot): Promise<{ x: number; y: number }> => page.evaluate((k) => window.__tch09!.slot(k), s);
  const labels = (page: Page): Promise<string[]> => page.evaluate(() =>
    [0, 1, 2, 3].map((s) => document.querySelector(`.dk-tbtn[data-slot="${s}"] .dk-tbtn-label`)?.textContent ?? ''));

  test('pressed state: in the DOM inside the pointerdown task and painted by the next animation frame', async ({ page }) => {
    const errors = collectErrors(page);
    const cdp = await open(page);
    await page.evaluate(() => {
      const w = window as unknown as { __probe: { sync: boolean; frame: boolean; dt: number } };
      w.__probe = { sync: false, frame: false, dt: -1 };
      window.addEventListener('pointerdown', (e) => {
        const el = document.querySelector('.dk-tbtn[data-slot="0"]')!;
        w.__probe.sync = el.classList.contains('is-pressed');
        const t0 = e.timeStamp;
        requestAnimationFrame((ts) => {
          w.__probe.frame = el.classList.contains('is-pressed');
          w.__probe.dt = ts - t0;
        });
      }, { once: true });
    });
    const big = await slot(page, ClusterSlot.BIG);
    await touches(cdp, 'touchStart', [{ ...big, id: 1 }]);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const probe = await page.evaluate(() => (window as unknown as { __probe: { sync: boolean; frame: boolean; dt: number } }).__probe);
    expect(probe.sync).toBe(true);
    expect(probe.frame).toBe(true);
    expect(probe.dt).toBeLessThan(50);
    await expect(page.locator(`.dk-tbtn[data-btn="${TouchButtonId.SPRINT_SKILL}"]`)).toHaveClass(/is-pressed/);
    await touches(cdp, 'touchEnd', []);
    await expect(page.locator('.dk-tbtn[data-slot="0"]')).not.toHaveClass(/is-pressed/);
    expect(errors).toEqual([]);
  });

  test('labels swap with possession; a held thumb keeps its label until it lifts', async ({ page }) => {
    const errors = collectErrors(page);
    const cdp = await open(page);
    await page.evaluate(() => window.__tch09!.sample());
    expect(await labels(page)).toEqual(['SPRINT', 'PASS', 'THROUGH', 'SHOOT']);
    const high = await slot(page, ClusterSlot.HIGH);
    await touches(cdp, 'touchStart', [{ ...high, id: 2 }]);
    await page.evaluate(() => { window.__tch09!.setContext('defence'); window.__tch09!.sample(); });
    expect(await page.evaluate(() => window.__tch09!.mode())).toBe(ClusterMode.DEFENCE);
    expect(await labels(page)).toEqual(['TACKLE', 'SWITCH', '2ND DEF', 'SHOOT']);
    await touches(cdp, 'touchEnd', []);
    await page.evaluate(() => window.__tch09!.sample());
    expect(await labels(page)).toEqual(['TACKLE', 'SWITCH', '2ND DEF', 'SLIDE']);
    await page.evaluate(() => { window.__tch09!.setContext('attack'); window.__tch09!.sample(); });
    expect(await labels(page)).toEqual(['SPRINT', 'PASS', 'THROUGH', 'SHOOT']);
    expect(errors).toEqual([]);
  });

  test('hides while the mocked pad drives the side and returns on the next screen touch', async ({ page }) => {
    const errors = collectErrors(page);
    const cdp = await open(page);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.evaluate(() => {
      const b = window.__tch09pad!.buttons[0]!;
      b.pressed = true; b.touched = true; b.value = 1;
    });
    await expect(page.locator('.dk-touch')).toHaveClass(/is-pad-hidden/);
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.dk-touch-vis')!).opacity)).toBe('0');
    await page.evaluate(() => { const b = window.__tch09pad!.buttons[0]!; b.pressed = false; b.touched = false; b.value = 0; });
    await touches(cdp, 'touchStart', [{ x: 300, y: 400, id: 3 }]);
    await touches(cdp, 'touchEnd', []);
    await expect(page.locator('.dk-touch')).not.toHaveClass(/is-pad-hidden/);
    expect(await page.evaluate(() => window.__tch09!.hidden())).toBe(false);
    await expect.poll(() => page.evaluate(() => Number(getComputedStyle(document.querySelector('.dk-touch-vis')!).opacity))).toBeGreaterThan(0.8);
    expect(errors).toEqual([]);
  });

  test('layout: inside the safe area, 24 pt clear of the edges and off the HUD at 4:3, 16:10 and 21:9', async ({ page }) => {
    const errors = collectErrors(page);
    await open(page);
    const VIEWPORTS: [number, number, [number, number, number, number]][] = [
      [1024, 768, [20, 0, 20, 0]], [1180, 820, [24, 0, 20, 0]], [1680, 720, [0, 44, 21, 44]], [1260, 540, [0, 0, 0, 0]],
    ];
    for (const [w, h, s] of VIEWPORTS) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate((ins) => { window.__tch09!.setSafe(...ins); window.__tch09!.relayout(); }, s);
      const r = await page.evaluate(() => {
        const hud = window.__tch09!.hud();
        const safe = window.__tch09!.safe();
        const rects = [...document.querySelectorAll('.dk-tbtn')].map((e) => e.getBoundingClientRect());
        return { hud, safe, rects: rects.map((b) => ({ l: b.left, t: b.top, r: b.right, b: b.bottom })), w: innerWidth, h: innerHeight };
      });
      expect(r.rects).toHaveLength(5);
      for (const b of r.rects) {
        const tag = `${w}x${h} ${JSON.stringify(b)}`;
        expect(b.l, tag).toBeGreaterThanOrEqual(r.safe.left - 0.5);
        expect(b.r, tag).toBeLessThanOrEqual(r.w - r.safe.right + 0.5);
        expect(b.t, tag).toBeGreaterThanOrEqual(r.safe.top + 24 - 0.5);
        expect(b.b, tag).toBeLessThanOrEqual(r.h - r.safe.bottom - 24 + 0.5);
        for (const z of r.hud) {
          const overlap = b.l < z.x + z.w && b.r > z.x && b.t < z.y + z.h && b.b > z.y;
          expect(overlap, `${tag} overlaps HUD ${JSON.stringify(z)}`).toBe(false);
        }
      }
      // Buttons never overlap each other.
      for (let i = 0; i < 4; i++) {
        for (let j = i + 1; j < 4; j++) {
          const a = r.rects[i]!, c = r.rects[j]!;
          const ax = (a.l + a.r) / 2, ay = (a.t + a.b) / 2, cx = (c.l + c.r) / 2, cy = (c.t + c.b) / 2;
          expect(Math.hypot(ax - cx, ay - cy)).toBeGreaterThanOrEqual((a.r - a.l) / 2 + (c.r - c.l) / 2 + 12 - 0.5);
        }
      }
    }
    expect(errors).toEqual([]);
  });

  test('no layout thrash: a stick drag and held buttons cause no layout per frame and write the DOM only on change', async ({ page }) => {
    const errors = collectErrors(page);
    const cdp = await open(page);
    await cdp.send('Performance.enable');
    const layouts = async (): Promise<number> => {
      const m = await cdp.send('Performance.getMetrics');
      return m.metrics.find((x) => x.name === 'LayoutCount')!.value;
    };
    const big = await slot(page, ClusterSlot.BIG);
    await touches(cdp, 'touchStart', [{ x: 200, y: 500, id: 1 }]);
    await touches(cdp, 'touchStart', [{ x: 200, y: 500, id: 1 }, { ...big, id: 2 }]);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const l0 = await layouts();
    for (let i = 0; i < 30; i++) {
      await touches(cdp, 'touchMove', [{ x: 200 + (i % 10) * 6, y: 500 - (i % 7) * 5, id: 1 }, { ...big, id: 2 }]);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
    }
    const l1 = await layouts();
    expect(l1 - l0).toBeLessThanOrEqual(3);
    // Idle frames: nothing changes, nothing is written.
    const w0 = await page.evaluate(() => window.__tch09!.domWrites());
    await page.evaluate(() => new Promise((r) => { let n = 0; const f = (): void => { if (++n >= 20) r(null); else requestAnimationFrame(f); }; requestAnimationFrame(f); }));
    expect(await page.evaluate(() => window.__tch09!.domWrites())).toBe(w0);
    await touches(cdp, 'touchEnd', []);
    expect(errors).toEqual([]);
  });
});
