/**
 * TCH-04 attack-defence swap in a real browser with real touch input (CDP touch events produce PointerEvents with
 * pointerType 'touch'), iPad-like 1180 x 820. Harness page (tests/e2e/tch-04-harness.ts, bundled here with esbuild):
 * the real pointer manager + attack cluster + defence cluster + cluster controller, plus a minimal slot-label DOM.
 *  - possession changes mid-hold: the held thumb keeps its meaning (events, held bit, label) until it lifts, while a
 *    second finger already gets the new meaning; the slot relabels on the lift;
 *  - a CLEAR press survives a swap and a touchcancel releases it without an action; SWITCH swipes carry direction.
 *   npx vite build --outDir dist-e2e/tch-04 --emptyOutDir
 *   PW_DIST=dist-e2e/tch-04 PW_PORT=4204 npx playwright test tests/e2e/tch-04-swap.spec.ts
 */
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import { ClusterMode, ClusterSlot, SwipeDir, TouchButtonId, TouchEdge } from '../../src/contracts/touch';
import { T_TOUCHUI } from '../../src/contracts/tuning';

type Pt = { x: number; y: number; id: number };
const { ATTACK, DEFENCE } = ClusterMode;
const { SPRINT_SKILL, SPRINT_TACKLE, SLIDE, SWITCH } = TouchButtonId;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function touches(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', pts: Pt[]): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p) => ({ x: p.x, y: p.y, id: p.id })) });
}

const ev = (button: number, edge: TouchEdge, dir: SwipeDir, mode: ClusterMode): string => `${button}:${edge}:${dir}:${mode}`;

test.describe('TCH-04 harness: the attack-defence swap with real touches', () => {
  let bundle = '';
  test.beforeAll(async () => {
    const r = await build({
      entryPoints: [path.resolve('tests/e2e/tch-04-harness.ts')],
      bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent',
      define: { __DEV_BUILD__: 'true' },
    });
    bundle = r.outputFiles[0]!.text;
  });

  async function open(page: Page): Promise<CDPSession> {
    await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body></body></html>');
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => !!window.__tch04);
    return page.context().newCDPSession(page);
  }
  const log = (page: Page): Promise<string[]> => page.evaluate(() => window.__tch04!.log.slice());
  const centre = (page: Page, s: ClusterSlot): Promise<{ x: number; y: number }> => page.evaluate((x) => window.__tch04!.centre(x), s);
  const held = (page: Page): Promise<number> => page.evaluate(() => window.__tch04!.held());
  const domText = (page: Page): Promise<string[]> => page.evaluate(() => window.__tch04!.dom().map((d) => d.text));
  const setMode = (page: Page, m: ClusterMode): Promise<void> => page.evaluate((x) => window.__tch04!.setMode(x), m);
  /** Resolve after the page's next animation frame (the controller's update has run). */
  const nextFrame = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

  test('possession change mid-hold keeps the held meaning until release', async ({ page }) => {
    const errors = collectErrors(page);
    const cdp = await open(page);
    const big = await centre(page, ClusterSlot.BIG);
    const low = await centre(page, ClusterSlot.LOW);
    // Attacking: thumb down on the big button = SPRINT; the pressed slot shows within the same frame.
    await touches(cdp, 'touchStart', [{ ...big, id: 1 }]);
    const now = await page.evaluate(() => ({ held: window.__tch04!.held(), dom: window.__tch04!.dom()[0] }));
    expect(now.held).toBe(1 << SPRINT_SKILL);
    expect(now.dom).toEqual({ text: 'SPRINT', pressed: true });
    // Possession lost while the thumb is down: the other slots swap at once, the held one keeps SPRINT.
    await setMode(page, DEFENCE);
    await nextFrame(page);
    expect(await domText(page)).toEqual(['SPRINT', 'SWITCH', '2ND DEF', 'SLIDE']);
    expect(await page.evaluate(() => window.__tch04!.modes())).toEqual([ATTACK, DEFENCE, DEFENCE, DEFENCE]);
    await page.waitForTimeout(T_TOUCHUI.hintHoldMs);
    expect(await log(page)).toContain(ev(SPRINT_SKILL, TouchEdge.HOLD, SwipeDir.NONE, ATTACK));
    // A second finger already gets the new meaning (SWITCH); the held thumb's swipe left is still SPRINT & SKILL's.
    await touches(cdp, 'touchStart', [{ ...big, id: 1 }, { ...low, id: 2 }]);
    expect(await log(page)).toContain(ev(SWITCH, TouchEdge.DOWN, SwipeDir.NONE, DEFENCE));
    expect(await held(page)).toBe((1 << SPRINT_SKILL) | (1 << SWITCH));
    await touches(cdp, 'touchMove', [{ x: big.x - 40, y: big.y, id: 1 }, { ...low, id: 2 }]);
    expect(await log(page)).toContain(ev(SPRINT_SKILL, TouchEdge.SWIPE, SwipeDir.LEFT, ATTACK));
    await touches(cdp, 'touchEnd', [{ ...low, id: 2 }]); // lift SWITCH only (CDP: the listed points end)
    expect(await held(page)).toBe(1 << SPRINT_SKILL);
    await nextFrame(page);
    expect((await domText(page))[ClusterSlot.BIG]).toBe('SPRINT');
    // The lift: SPRINT ends as SPRINT, and only now does the slot become SPRINT & TACKLE.
    await touches(cdp, 'touchEnd', []);
    expect(await held(page)).toBe(0);
    await nextFrame(page);
    expect(await page.evaluate(() => window.__tch04!.dom())).toEqual([
      { text: 'TACKLE', pressed: false }, { text: 'SWITCH', pressed: false }, { text: '2ND DEF', pressed: false }, { text: 'SLIDE', pressed: false },
    ]);
    const l = await log(page);
    expect(l.filter((e) => e.startsWith(`${SPRINT_SKILL}:`))).toEqual([
      ev(SPRINT_SKILL, TouchEdge.DOWN, SwipeDir.NONE, ATTACK), ev(SPRINT_SKILL, TouchEdge.HOLD, SwipeDir.NONE, ATTACK),
      ev(SPRINT_SKILL, TouchEdge.SWIPE, SwipeDir.LEFT, ATTACK), ev(SPRINT_SKILL, TouchEdge.UP, SwipeDir.NONE, ATTACK),
    ]);
    expect(l.filter((e) => e.startsWith(`${SWITCH}:`))).toEqual([
      ev(SWITCH, TouchEdge.DOWN, SwipeDir.NONE, DEFENCE), ev(SWITCH, TouchEdge.UP, SwipeDir.NONE, DEFENCE), ev(SWITCH, TouchEdge.TAP, SwipeDir.NONE, DEFENCE),
    ]);
    expect(l.some((e) => e.startsWith(`${SPRINT_TACKLE}:`))).toBe(false);
    // The next touch on the big button tackles.
    await page.evaluate(() => window.__tch04!.clear());
    await touches(cdp, 'touchStart', [{ ...big, id: 3 }]);
    await touches(cdp, 'touchEnd', []);
    expect(await log(page)).toEqual([
      ev(SPRINT_TACKLE, TouchEdge.DOWN, SwipeDir.NONE, DEFENCE), ev(SPRINT_TACKLE, TouchEdge.UP, SwipeDir.NONE, DEFENCE),
      ev(SPRINT_TACKLE, TouchEdge.TAP, SwipeDir.NONE, DEFENCE),
    ]);
    expect(errors).toEqual([]);
  });

  test('CLEAR held through a swap is released by touchcancel without an action; SWITCH swipes carry direction', async ({ page }) => {
    const errors = collectErrors(page);
    const cdp = await open(page);
    await setMode(page, DEFENCE);
    await page.evaluate(() => window.__tch04!.setClear(true));
    await nextFrame(page);
    expect(await domText(page)).toEqual(['TACKLE', 'SWITCH', '2ND DEF', 'CLEAR']);
    const high = await centre(page, ClusterSlot.HIGH);
    await touches(cdp, 'touchStart', [{ ...high, id: 1 }]);
    await page.evaluate(() => window.__tch04!.setClear(false));
    await setMode(page, ATTACK); // ball won while the thumb is on CLEAR
    await nextFrame(page);
    expect(await domText(page)).toEqual(['SPRINT', 'PASS', 'THROUGH', 'CLEAR']);
    await touches(cdp, 'touchCancel', []);
    expect(await held(page)).toBe(0);
    expect(await log(page)).toEqual([ev(SLIDE, TouchEdge.DOWN, SwipeDir.NONE, DEFENCE), ev(SLIDE, TouchEdge.CANCEL, SwipeDir.NONE, DEFENCE)]);
    await nextFrame(page);
    expect(await domText(page)).toEqual(['SPRINT', 'PASS', 'THROUGH', 'SHOOT']);
    // SWITCH swipe up-left (dominant up): the event says UP, the aim keeps the exact angle.
    await setMode(page, DEFENCE);
    await page.evaluate(() => window.__tch04!.clear());
    const low = await centre(page, ClusterSlot.LOW);
    await touches(cdp, 'touchStart', [{ ...low, id: 2 }]);
    for (let k = 1; k <= 4; k++) await touches(cdp, 'touchMove', [{ x: low.x - 6 * k, y: low.y - 8 * k, id: 2 }]);
    await touches(cdp, 'touchEnd', []);
    expect((await log(page)).filter((e) => e.split(':')[1] === String(TouchEdge.SWIPE))).toEqual([ev(SWITCH, TouchEdge.SWIPE, SwipeDir.UP, DEFENCE)]);
    const aim = await page.evaluate((b) => window.__tch04!.aim(b), SWITCH);
    expect(aim.dir).toBe(SwipeDir.UP);
    expect(aim.dx).toBeCloseTo(-0.6, 1);
    expect(aim.dy).toBeCloseTo(-0.8, 1);
    expect(errors).toEqual([]);
  });
});
