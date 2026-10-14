/**
 * TCH-06 set-piece swipe in a real browser with real touch input (CDP touch events -> PointerEvents with pointerType
 * 'touch'), through the whole touch source (createTouchInput: pointer routing, set-piece control, rAF-driven preview
 * refresh, mapper) and the real sim (RUL-11 / RUL-05 free kick). Harness page: tests/e2e/tch-07-harness.ts.
 *  - a free-kick swipe from the ball shows the dotted flight preview during the drag (ball dot at touch-down), clears it
 *    at the lift, and the lift shoots (FREE_KICK_SHOT);
 *  - pointercancel mid-drag drops the swipe and the preview (no stuck preview, no kick).
 *   npx vite build --outDir dist-e2e/tch-06 --emptyOutDir
 *   PW_DIST=dist-e2e/tch-06 PW_PORT=4206 npx playwright test tests/e2e/tch-06-setpiece.spec.ts
 */
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import { GestureFlag } from '../../src/contracts/input';
import { ClusterMode } from '../../src/contracts/touch';

type Pt = { x: number; y: number; id: number };
/** PreviewKind.FLIGHT (src/input/touch/setpiece.ts). */
const FLIGHT = 2;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function touches(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', pts: Pt[]): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p) => ({ x: p.x, y: p.y, id: p.id })) });
}

test.describe('TCH-06 set-piece swipe with real touches', () => {
  let js = '';
  let css = '';
  test.beforeAll(async () => {
    const r = await build({
      entryPoints: [path.resolve('tests/e2e/tch-07-harness.ts')],
      bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent', outdir: 'tch06-out',
      define: { __DEV_BUILD__: 'true' },
    });
    for (const f of r.outputFiles) {
      if (f.path.endsWith('.js')) js = f.text;
      else if (f.path.endsWith('.css')) css = f.text;
    }
  });

  async function openFreeKick(page: Page): Promise<{ cdp: CDPSession; ball: { x: number; y: number } }> {
    await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body></body></html>');
    if (css) await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: js });
    await page.waitForFunction(() => !!window.__tch07);
    await page.evaluate(() => { window.__tch07!.setContext('freekick'); window.__tch07!.sample(); });
    expect(await page.evaluate(() => window.__tch07!.mode())).toBe(ClusterMode.SET_PIECE);
    const ball = await page.evaluate(() => window.__tch07!.ballScreen());
    return { cdp: await page.context().newCDPSession(page), ball };
  }

  test('a free-kick swipe from the ball previews the flight while dragging and shoots at the lift', async ({ page }) => {
    const errors = collectErrors(page);
    const { cdp, ball } = await openFreeKick(page);
    const start: Pt = { x: ball.x + 2, y: ball.y + 1, id: 1 };
    await touches(cdp, 'touchStart', [start]);
    // Pressed state within the same event: the ball dot (plus the touch point once a frame refreshed the trail).
    let pv = await page.evaluate(() => window.__tch07!.preview());
    expect(pv.active).toBe(true);
    expect(pv.count).toBeGreaterThanOrEqual(1);
    expect(pv.count).toBeLessThanOrEqual(2);
    expect(pv.first[0]).toBeCloseTo(ball.x, 3);
    // Drag toward the goal mouth (goal centre on screen: x 1115, y 410) in 10 moves.
    const end = { x: ball.x + 150, y: ball.y + 25 };
    let flightSeen = 0;
    for (let k = 1; k <= 10; k++) {
      await touches(cdp, 'touchMove', [{ x: start.x + ((end.x - start.x) * k) / 10, y: start.y + ((end.y - start.y) * k) / 10 - Math.sin((k / 10) * Math.PI) * 6, id: 1 }]);
      pv = await page.evaluate(() => window.__tch07!.preview());
      if (pv.kind === FLIGHT && pv.count > 5) flightSeen++;
    }
    // The finger rests: the rAF-driven refresh keeps the preview on the final swipe.
    await page.waitForTimeout(80);
    pv = await page.evaluate(() => window.__tch07!.preview());
    expect(flightSeen).toBeGreaterThan(0);
    expect(pv.kind).toBe(FLIGHT);
    expect(pv.count).toBeGreaterThan(10);
    expect(pv.first[0]).toBeCloseTo(ball.x, 3);
    expect(pv.last[0]).toBeGreaterThan(ball.x + 60); // the dots run toward the goal
    await touches(cdp, 'touchEnd', []);
    pv = await page.evaluate(() => window.__tch07!.preview());
    expect(pv.count).toBe(0);
    expect(await page.evaluate(() => window.__tch07!.gestureEvents())).toBe(1);
    const r = await page.evaluate(() => window.__tch07!.play(90));
    expect(r.gestures.length).toBe(1);
    expect(r.gestures[0]!.flags & GestureFlag.FROM_BALL).toBe(GestureFlag.FROM_BALL);
    expect(r.gestures[0]!.gdx).toBeGreaterThan(100);
    expect(r.taken).toBe(true);
    expect(r.kick).toBe('FREE_KICK_SHOT');
    expect(errors).toEqual([]);
  });

  test('glitch: stuck preview after pointercancel - the drag is dropped with its preview and nothing is kicked', async ({ page }) => {
    const errors = collectErrors(page);
    const { cdp, ball } = await openFreeKick(page);
    await touches(cdp, 'touchStart', [{ x: ball.x, y: ball.y, id: 4 }]);
    for (let k = 1; k <= 6; k++) await touches(cdp, 'touchMove', [{ x: ball.x + 20 * k, y: ball.y + 3 * k, id: 4 }]);
    await page.waitForTimeout(50);
    expect((await page.evaluate(() => window.__tch07!.preview())).count).toBeGreaterThan(1);
    await touches(cdp, 'touchCancel', []);
    const pv = await page.evaluate(() => window.__tch07!.preview());
    expect(pv.count).toBe(0);
    expect(pv.active).toBe(false);
    await page.waitForTimeout(50);
    expect((await page.evaluate(() => window.__tch07!.preview())).count).toBe(0);
    const r = await page.evaluate(() => window.__tch07!.play(20));
    expect(r.gestures).toEqual([]);
    expect(r.taken).toBe(false);
    expect(errors).toEqual([]);
  });
});
