/**
 * TCH-07 touch input source (createTouchInput: pointer manager + stick + attack / defence clusters + gestures + mapper +
 * overlay) in a real browser with real touch input (CDP touch events -> PointerEvents with pointerType 'touch'),
 * iPad-like 1180 x 820. Harness page: tests/e2e/tch-07-harness.ts, bundled here with esbuild.
 *  - glitch: stuck sprint or stick after pointercancel (and the pressed state shows within the same frame);
 *  - glitch: button swipe read as a pitch gesture (a swipe from PASS is a lob, never a gesture);
 *  - five simultaneous touches; window blur releases everything; a late lift re-presses nothing; PAUSE;
 *  - cut-scenes: any tap skips.
 *   npx vite build --outDir dist-e2e/tch-07 --emptyOutDir
 *   PW_DIST=dist-e2e/tch-07 PW_PORT=4207 npx playwright test tests/e2e/tch-07-touch-input.spec.ts
 */
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import { GestureKind } from '../../src/contracts/enums';
import { Btn } from '../../src/contracts/input';
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

test.describe('TCH-07 createTouchInput with real touches', () => {
  let js = '';
  let css = '';
  test.beforeAll(async () => {
    const r = await build({
      entryPoints: [path.resolve('tests/e2e/tch-07-harness.ts')],
      bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent', outdir: 'tch07-out',
      define: { __DEV_BUILD__: 'true' },
    });
    for (const f of r.outputFiles) {
      if (f.path.endsWith('.js')) js = f.text;
      else if (f.path.endsWith('.css')) css = f.text;
    }
  });

  async function open(page: Page): Promise<CDPSession> {
    await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body></body></html>');
    if (css) await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: js });
    await page.waitForFunction(() => !!window.__tch07);
    return page.context().newCDPSession(page);
  }
  const slot = (page: Page, s: ClusterSlot): Promise<{ x: number; y: number }> => page.evaluate((k) => window.__tch07!.slot(k), s);
  const sample = (page: Page, n = 1): Promise<{ buttons: number; mx: number; mz: number; power: number; gesture: number }[]> =>
    page.evaluate((k) => Array.from({ length: k }, () => window.__tch07!.sample()), n);

  test('glitch: stuck sprint or stick after pointercancel; the pressed state shows within the same frame', async ({ page }) => {
    const errors = collectErrors(page);
    const cdp = await open(page);
    const big = await slot(page, ClusterSlot.BIG);
    const stick: Pt = { x: 200, y: 500, id: 1 };
    await touches(cdp, 'touchStart', [stick]);
    await touches(cdp, 'touchMove', [{ ...stick, x: 270 }]);
    await touches(cdp, 'touchStart', [{ ...stick, x: 270 }, { ...big, id: 2 }]);
    // Synchronously after the pointerdown: held bit and the overlay's pressed class.
    const pressed = await page.evaluate((id) => ({
      held: window.__tch07!.held(),
      css: document.querySelector(`[data-btn="${id}"]`)?.classList.contains('is-pressed') ?? false,
    }), TouchButtonId.SPRINT_SKILL);
    expect(pressed.held).toBe(1 << TouchButtonId.SPRINT_SKILL);
    expect(pressed.css).toBe(true);
    let f = await sample(page, 2);
    expect(f[1]!.buttons & Btn.SPRINT).toBe(Btn.SPRINT); // the stick is pushed: sprint at once
    expect(f[1]!.mx).toBeGreaterThan(100);
    await touches(cdp, 'touchCancel', []);
    f = await sample(page, 3);
    for (const x of f) {
      expect(x.buttons).toBe(0);
      expect([x.mx, x.mz]).toEqual([0, 0]);
    }
    expect(await page.evaluate(() => window.__tch07!.held())).toBe(0);
    expect(await page.evaluate(() => window.__tch07!.stickActive())).toBe(false);
    expect(errors).toEqual([]);
  });

  test('glitch: button swipe read as a pitch gesture - a swipe up from PASS is a lob press, never a gesture', async ({ page }) => {
    const errors = collectErrors(page);
    const cdp = await open(page);
    const pass = await slot(page, ClusterSlot.LOW);
    await sample(page);
    await touches(cdp, 'touchStart', [{ ...pass, id: 3 }]);
    await touches(cdp, 'touchMove', [{ x: pass.x, y: pass.y - 15, id: 3 }]);
    await touches(cdp, 'touchMove', [{ x: pass.x, y: pass.y - 40, id: 3 }]);
    await touches(cdp, 'touchEnd', []);
    expect(await page.evaluate(() => window.__tch07!.gestureEvents())).toBe(0);
    const f = await sample(page, 12);
    const lob = f.filter((x) => (x.buttons & Btn.LOB) !== 0);
    expect(lob.length).toBeGreaterThan(0);
    expect(f.some((x) => (x.buttons & Btn.PASS) !== 0)).toBe(false); // no ground pass on the way
    expect(f.every((x) => x.gesture === GestureKind.NONE)).toBe(true);
    expect(errors).toEqual([]);
  });

  test('five simultaneous touches; blur releases everything; a late lift re-presses nothing; PAUSE pauses', async ({ page }) => {
    const errors = collectErrors(page);
    const cdp = await open(page);
    const pts: Pt[] = [{ x: 200, y: 500, id: 1 }];
    for (const [k, s] of [[2, ClusterSlot.BIG], [3, ClusterSlot.LOW], [4, ClusterSlot.MID], [5, ClusterSlot.HIGH]] as const) {
      pts.push({ ...(await slot(page, s)), id: k });
      await touches(cdp, 'touchStart', pts);
    }
    expect(await page.evaluate(() => window.__tch07!.held())).toBe(0b1111);
    expect(await page.evaluate(() => window.__tch07!.stickActive())).toBe(true);
    await sample(page, 2);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    expect(await page.evaluate(() => window.__tch07!.held())).toBe(0);
    expect(await page.evaluate(() => window.__tch07!.stickActive())).toBe(false);
    let f = await sample(page, 3);
    expect(f.map((x) => x.buttons)).toEqual([0, 0, 0]);
    await touches(cdp, 'touchEnd', []);
    f = await sample(page, 12);
    expect(f.every((x) => x.buttons === 0 && x.mx === 0 && x.mz === 0)).toBe(true);
    // PAUSE: a tap on the pause button (top right) calls onPause once.
    const p = await page.evaluate(() => window.__tch07!.pause());
    await touches(cdp, 'touchStart', [{ ...p, id: 9 }]);
    await touches(cdp, 'touchEnd', []);
    expect(await page.evaluate(() => window.__tch07!.pauses())).toBe(1);
    expect(errors).toEqual([]);
  });

  test('cut-scene (HIDDEN): a tap anywhere on the pitch skips', async ({ page }) => {
    const errors = collectErrors(page);
    const cdp = await open(page);
    await page.evaluate(() => window.__tch07!.setContext('cutscene'));
    await sample(page);
    expect(await page.evaluate(() => window.__tch07!.mode())).toBe(ClusterMode.HIDDEN);
    await touches(cdp, 'touchStart', [{ x: 800, y: 300, id: 7 }]);
    await touches(cdp, 'touchEnd', []);
    const f = await sample(page, 3);
    expect(f.map((x) => x.buttons & Btn.SKIP)).toEqual([Btn.SKIP, 0, 0]);
    expect(f.every((x) => x.gesture === GestureKind.NONE)).toBe(true);
    expect(errors).toEqual([]);
  });
});
