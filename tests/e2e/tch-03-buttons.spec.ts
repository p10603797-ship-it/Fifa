/**
 * TCH-03 touch buttons and the attack cluster in a real browser with real touch input (CDP touch events produce
 * PointerEvents with pointerType 'touch'), iPad-like 1180 x 820:
 *  - harness page (tests/e2e/tch-03-harness.ts, bundled here with esbuild: the real pointer manager + attack
 *    cluster): every attack button recognises swipes in all four directions at 24 pt while shorter travel is no
 *    swipe; HOLD and the 250 ms direction hint come from the frame loop on time; a slow slide off the button keeps
 *    the hold without a swipe; touchCancel releases; double tap; five simultaneous touches; DEFENCE mode yields;
 *  - the real app: the pressed state shows within one frame of the touch-down (checked synchronously after the
 *    pointerdown and again in the next requestAnimationFrame) and survives a slide off the button.
 *   npx vite build --outDir dist-e2e/tch-03 --emptyOutDir
 *   PW_DIST=dist-e2e/tch-03 PW_PORT=4203 npx playwright test tests/e2e/tch-03-buttons.spec.ts
 */
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import { ClusterMode, SwipeDir, TouchButtonId, TouchEdge } from '../../src/contracts/touch';
import { T_TOUCHUI } from '../../src/contracts/tuning';

type Pt = { x: number; y: number; id: number };
const BUTTONS = [TouchButtonId.PASS, TouchButtonId.THROUGH, TouchButtonId.SHOOT, TouchButtonId.SPRINT_SKILL];
const VEC: Record<number, [number, number]> = {
  [SwipeDir.UP]: [0, -1], [SwipeDir.DOWN]: [0, 1], [SwipeDir.LEFT]: [-1, 0], [SwipeDir.RIGHT]: [1, 0],
};
const KICK_OFF = 1;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function touches(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', pts: Pt[]): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p) => ({ x: p.x, y: p.y, id: p.id })) });
}

const ev = (button: number, edge: TouchEdge, dir = 0, mode: ClusterMode = ClusterMode.ATTACK): string => `${button}:${edge}:${dir}:${mode}`;

test.describe('TCH-03 harness: real touches through the pointer manager into the attack cluster', () => {
  let bundle = '';
  test.beforeAll(async () => {
    const r = await build({
      entryPoints: [path.resolve('tests/e2e/tch-03-harness.ts')],
      bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent',
      define: { __DEV_BUILD__: 'true' },
    });
    bundle = r.outputFiles[0]!.text;
  });

  async function open(page: Page): Promise<CDPSession> {
    await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body></body></html>');
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => !!window.__tch03);
    return page.context().newCDPSession(page);
  }
  const log = (page: Page): Promise<string[]> => page.evaluate(() => window.__tch03!.log.slice());
  const centre = (page: Page, id: TouchButtonId): Promise<{ x: number; y: number }> => page.evaluate((b) => window.__tch03!.centre(b), id);
  const clear = (page: Page): Promise<void> => page.evaluate(() => window.__tch03!.clear());

  test('swipes in all four directions on every attack button are recognised at 24 pt; 18 pt is no swipe', async ({ page }) => {
    const errors = collectErrors(page);
    const cdp = await open(page);
    for (const id of BUTTONS) {
      const c = await centre(page, id);
      for (const dir of [SwipeDir.UP, SwipeDir.DOWN, SwipeDir.LEFT, SwipeDir.RIGHT]) {
        const [vx, vy] = VEC[dir]!;
        await clear(page);
        await touches(cdp, 'touchStart', [{ ...c, id: 1 }]);
        await touches(cdp, 'touchMove', [{ x: c.x + vx * 12, y: c.y + vy * 12, id: 1 }]);
        expect(await log(page)).not.toContain(ev(id, TouchEdge.SWIPE, dir));
        await touches(cdp, 'touchMove', [{ x: c.x + vx * (T_TOUCHUI.buttonSwipePt + 1), y: c.y + vy * (T_TOUCHUI.buttonSwipePt + 1), id: 1 }]);
        // Recognised while the finger is still down.
        expect(await log(page)).toContain(ev(id, TouchEdge.SWIPE, dir));
        expect(await page.evaluate(() => window.__tch03!.held())).toBe(1 << id);
        await touches(cdp, 'touchEnd', []);
        const l = await log(page);
        expect(l[0]).toBe(ev(id, TouchEdge.DOWN));
        expect(l[l.length - 1]).toBe(ev(id, TouchEdge.UP));
        expect(l.filter((e) => e.split(':')[1] === String(TouchEdge.SWIPE))).toEqual([ev(id, TouchEdge.SWIPE, dir)]);
        expect(l.some((e) => e.split(':')[1] === String(TouchEdge.TAP))).toBe(false);
      }
      // 18 pt of travel: no swipe (a quick one is a tap).
      await clear(page);
      await touches(cdp, 'touchStart', [{ ...c, id: 2 }]);
      await touches(cdp, 'touchMove', [{ x: c.x - 18, y: c.y, id: 2 }]);
      await touches(cdp, 'touchEnd', []);
      const l = await log(page);
      expect(l.some((e) => e.split(':')[1] === String(TouchEdge.SWIPE))).toBe(false);
      expect(l).toContain(ev(id, TouchEdge.UP));
    }
    expect(await page.evaluate(() => window.__tch03!.held())).toBe(0);
    expect(errors).toEqual([]);
  });

  test('hold: HOLD and the 250 ms hint come from the frame loop; a slow slide off keeps the hold; touchCancel releases', async ({ page }) => {
    const errors = collectErrors(page);
    const cdp = await open(page);
    const c = await centre(page, TouchButtonId.SHOOT);
    await touches(cdp, 'touchStart', [{ ...c, id: 1 }]);
    await page.waitForTimeout(450);
    let l = await log(page);
    expect(l).toEqual([ev(TouchButtonId.SHOOT, TouchEdge.DOWN), ev(TouchButtonId.SHOOT, TouchEdge.HOLD)]);
    const t = await page.evaluate(() => ({ times: window.__tch03!.times.slice(), hints: window.__tch03!.hints.slice() }));
    const holdAfter = t.times[1]! - t.times[0]!;
    expect(holdAfter).toBeGreaterThan(10 * 1000 / 60); // past the tap time...
    expect(holdAfter).toBeLessThan(10 * 1000 / 60 + 120); // ...noticed by the frame loop, not at the lift
    expect(t.hints.length).toBe(1);
    expect(t.hints[0]![1]).toBe(1 << TouchButtonId.SHOOT);
    expect(t.hints[0]![0] - t.times[0]!).toBeGreaterThanOrEqual(T_TOUCHUI.hintHoldMs);
    // Slide 120 pt off the button at about 50 pt/s: no swipe, the hold (and the hint) stay.
    for (let k = 1; k <= 40; k++) {
      await touches(cdp, 'touchMove', [{ x: c.x - k * 3, y: c.y - k, id: 1 }]);
      await page.waitForTimeout(60);
    }
    expect(await page.evaluate(() => window.__tch03!.held())).toBe(1 << TouchButtonId.SHOOT);
    l = await log(page);
    expect(l).toEqual([ev(TouchButtonId.SHOOT, TouchEdge.DOWN), ev(TouchButtonId.SHOOT, TouchEdge.HOLD)]);
    // The system takes the touch (iPadOS gesture): release without an action.
    await touches(cdp, 'touchCancel', []);
    await expect.poll(() => log(page)).toEqual([
      ev(TouchButtonId.SHOOT, TouchEdge.DOWN), ev(TouchButtonId.SHOOT, TouchEdge.HOLD), ev(TouchButtonId.SHOOT, TouchEdge.CANCEL),
    ]);
    expect(await page.evaluate(() => window.__tch03!.held())).toBe(0);
    expect(await page.evaluate(() => window.__tch03!.hintMask())).toBe(0);
    expect(errors).toEqual([]);
  });

  test('double tap, five simultaneous touches, and the attack set yields in DEFENCE mode', async ({ page }) => {
    const errors = collectErrors(page);
    const cdp = await open(page);
    const pass = await centre(page, TouchButtonId.PASS);
    for (let k = 0; k < 2; k++) {
      await touches(cdp, 'touchStart', [{ ...pass, id: 1 + k }]);
      await touches(cdp, 'touchEnd', []);
    }
    const taps = (await log(page)).filter((e) => [TouchEdge.TAP, TouchEdge.DOUBLE_TAP].map(String).includes(e.split(':')[1]!));
    expect(taps).toEqual([ev(TouchButtonId.PASS, TouchEdge.TAP), ev(TouchButtonId.PASS, TouchEdge.DOUBLE_TAP)]);
    // Four buttons and a fifth finger on the pitch, all at once.
    await clear(page);
    const pts: Pt[] = [];
    for (const id of BUTTONS) pts.push({ ...(await centre(page, id)), id: 10 + id });
    pts.push({ x: 400, y: 300, id: 20 });
    const down: Pt[] = [];
    for (const p of pts) {
      down.push(p);
      await touches(cdp, 'touchStart', down);
    }
    expect(await page.evaluate(() => window.__tch03!.held())).toBe(0b1111);
    await touches(cdp, 'touchEnd', down.filter((p) => p.id === 10 + TouchButtonId.SHOOT)); // lift SHOOT only (CDP: the listed points end)
    expect(await page.evaluate(() => window.__tch03!.held())).toBe(0b1011);
    await touches(cdp, 'touchEnd', []);
    expect(await page.evaluate(() => window.__tch03!.held())).toBe(0);
    // Possession lost: the defence set owns the slots; the attack buttons claim nothing.
    await clear(page);
    await page.evaluate((m) => window.__tch03!.setMode(m), ClusterMode.DEFENCE);
    const big = await centre(page, TouchButtonId.SPRINT_SKILL);
    await touches(cdp, 'touchStart', [{ ...big, id: 30 }]);
    expect(await page.evaluate(() => window.__tch03!.held())).toBe(0);
    await touches(cdp, 'touchEnd', []);
    expect(await log(page)).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test.describe('TCH-03 in the real app', () => {
  test('pressed state within one frame of the touch-down (sync and next rAF), kept while the thumb slides off', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await page.getByTestId('splash-start').click();
    await page.getByTestId('main-kickoff').click();
    // Play while our side kicks off (the attack set is live); restart the match until it does.
    let ours = false;
    for (let i = 0; i < 8 && !ours; i++) {
      await page.waitForFunction((k) => {
        const s = window.__dotkick?.ctx.session.getState();
        return !!s && !(s as unknown as { __tch03Old?: number }).__tch03Old && s.match.phase === k && s.ctrl[0]!.side >= 0;
      }, KICK_OFF, { timeout: 60_000 });
      ours = await page.evaluate(() => {
        const s = window.__dotkick!.ctx.session.getState()!;
        if (s.match.kickoffTeam === s.ctrl[0]!.side) return true;
        (s as unknown as { __tch03Old?: number }).__tch03Old = 1;
        window.__dotkick!.ctx.session.restart();
        return false;
      });
    }
    expect(ours).toBe(true);
    const sel = `#touch .dk-tbtn[data-btn="${TouchButtonId.SPRINT_SKILL}"]`;
    const box = (await page.locator(sel).boundingBox())!;
    const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const cdp = await page.context().newCDPSession(page);
    for (let k = 0; k < 3; k++) {
      await page.evaluate((s) => {
        const w = window as unknown as { __tch03Frame?: { sync: boolean; raf: boolean; ms: number } | null };
        w.__tch03Frame = null;
        const layer = document.querySelector('#touch .dk-touch')!;
        // Registered after the touch layer's own listener: runs right after the press is routed.
        layer.addEventListener('pointerdown', () => {
          const t0 = performance.now();
          const sync = document.querySelector(s)!.classList.contains('is-pressed');
          requestAnimationFrame(() => {
            w.__tch03Frame = { sync, raf: document.querySelector(s)!.classList.contains('is-pressed'), ms: performance.now() - t0 };
          });
        }, { once: true });
      }, sel);
      await touches(cdp, 'touchStart', [{ ...c, id: 40 + k }]);
      const f = await page.waitForFunction(() => (window as unknown as { __tch03Frame?: unknown }).__tch03Frame ?? null).then((h) => h.jsonValue()) as { sync: boolean; raf: boolean; ms: number };
      expect(f.sync).toBe(true);
      expect(f.raf).toBe(true);
      // The thumb slides far off the button: still pressed until it lifts.
      await touches(cdp, 'touchMove', [{ x: c.x - 260, y: c.y - 200, id: 40 + k }]);
      await expect(page.locator(sel)).toHaveClass(/is-pressed/);
      await touches(cdp, 'touchEnd', []);
      await expect(page.locator(sel)).not.toHaveClass(/is-pressed/);
    }
    expect(errors).toEqual([]);
  });
});
