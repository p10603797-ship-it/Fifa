/**
 * TCH-02 floating virtual stick, end to end (iPad-like 1180 x 820 viewport with touch; CDP touch events produce
 * real PointerEvents with pointerType 'touch'):
 *  - a drag in the left half shows the stick where the thumb lands, drags its base along once the thumb is more than
 *    1.4 radii away, and moves the controlled player; lifting the thumb stops him;
 *  - pointercancel (touchCancel) mid-drag releases the stick and stops him (glitch list: stuck stick after
 *    pointercancel);
 *  - a touch-down inside the bottom 24 pt system-gesture margin never starts the stick.
 * One match is started for the whole file (serial) and moved into IN_PLAY by taking the kick-off with PASS.
 * Build first: npx vite build --outDir dist-e2e/tch-02 --emptyOutDir; then
 *   PW_DIST=dist-e2e/tch-02 PW_PORT=4202 npx playwright test tests/e2e/tch-02-stick.spec.ts
 */
import { expect, test, type CDPSession, type Page } from '@playwright/test';

interface Controlled { slot: number; x: number; z: number; v: number; tick: number; phase: number }

const IN_PLAY = 2;
const KICK_OFF = 1;
const RADIUS = 70; // T_TOUCHUI.stickRadius
const FOLLOW = 1.4; // LOCAL_TUNING.followMul

test.describe.configure({ mode: 'serial' });

let page: Page;
let cdp: CDPSession;
const errors: string[] = [];

async function controlled(): Promise<Controlled> {
  return page.evaluate(() => {
    const s = window.__dotkick!.ctx.session.getState()!;
    const slot = s.ctrl[0]!.slot;
    const p = s.players[Math.max(0, slot)]!;
    return { slot, x: p.x, z: p.z, v: Math.hypot(p.vx, p.vz), tick: s.tick, phase: s.match.phase };
  });
}

/** Wait at least `ms` of wall time and `ticks` sim ticks (software WebGL runs the loop slowly here). */
async function holdFor(startTick: number, ticks: number, ms = 600): Promise<void> {
  await page.waitForTimeout(ms);
  await page.waitForFunction((t) => (window.__dotkick!.ctx.session.getState()?.tick ?? -1) >= t, startTick + ticks, { timeout: 60_000 });
}

async function touch(type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', x = 0, y = 0, id = 1): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y, id }],
  });
}

/** Translate of the stick base element = origin - radius (overlay draws the base at the stick origin). */
async function baseOrigin(): Promise<{ x: number; y: number }> {
  const t = await page.locator('#touch .dk-stick-base').evaluate((e) => (e as HTMLElement).style.transform);
  const m = /translate3d\(([-\d.e]+)px,\s*([-\d.e]+)px/.exec(t);
  expect(m, `base transform "${t}"`).not.toBeNull();
  return { x: Number(m![1]) + RADIUS, y: Number(m![2]) + RADIUS };
}

/** The controlled player comes to rest (no stuck stick). */
async function expectStops(label: string): Promise<void> {
  await holdFor((await controlled()).tick, 45, 300);
  const a = await controlled();
  await holdFor(a.tick, 15, 0);
  const b = await controlled();
  expect(Math.hypot(b.x - a.x, b.z - a.z), `${label}: player at rest`).toBeLessThan(0.2);
}

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext({
    baseURL: `http://localhost:${process.env.PW_PORT ?? 4173}`,
    viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
  });
  page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto('/');
  await page.getByTestId('splash-start').click();
  await page.getByTestId('main-kickoff').click();
  await page.waitForFunction(() => {
    const d = window.__dotkick;
    return !!d && d.ctx.router.current === 'match' && d.ctx.session.getState() !== null;
  }, null, { timeout: 30_000 });
  cdp = await page.context().newCDPSession(page);
  // Take the kick-off with PASS (retrying) until the ball is in play: free movement only happens in IN_PLAY.
  await page.waitForFunction((k) => (window.__dotkick!.ctx.session.getState()?.match.phase ?? -1) >= k, KICK_OFF, { timeout: 30_000 });
  for (let i = 0; i < 6 && (await controlled()).phase !== IN_PLAY; i++) {
    const phase = (await controlled()).phase;
    if (phase === KICK_OFF) {
      const pass = (await page.locator('#touch .dk-tbtn[data-btn="0"]').boundingBox())!;
      await touch('touchStart', pass.x + pass.width / 2, pass.y + pass.height / 2, 9);
      await page.waitForTimeout(250);
      await touch('touchEnd');
    }
    await page.waitForFunction((p) => window.__dotkick!.ctx.session.getState()!.match.phase === p, IN_PLAY, { timeout: 8_000 }).catch(() => {});
  }
  expect((await controlled()).phase).toBe(IN_PLAY);
  expect((await controlled()).slot).toBeGreaterThanOrEqual(0);
});

test.afterAll(async () => {
  await page.context().close();
});

test('drag in the left half: stick appears where the thumb lands, base drags along past 1.4 radii, player moves; release stops him', async () => {
  await expectStops('before');
  const before = await controlled();
  const x0 = 300, y0 = 520;
  await touch('touchStart', x0, y0);
  // Pressed state within the same frame as the touch-down; the base sits where the thumb landed.
  await expect(page.locator('#touch .dk-stick.is-active')).toHaveCount(1);
  expect(await baseOrigin()).toEqual({ x: x0, y: y0 });
  for (let i = 1; i <= 10; i++) await touch('touchMove', x0 + i * 20, y0);
  // Thumb 200 px right: the base was dragged to 1.4 radii behind it.
  const o = await baseOrigin();
  expect(o.x).toBeCloseTo(x0 + 200 - FOLLOW * RADIUS, 1);
  expect(o.y).toBeCloseTo(y0, 1);
  await holdFor(before.tick, 60, 1000);
  const during = await controlled();
  expect(during.slot).toBe(before.slot);
  expect(during.x - before.x, 'screen right moves him toward +x').toBeGreaterThan(1.5);
  expect(Math.abs(during.z - before.z)).toBeLessThan(1);
  await touch('touchEnd');
  await expect(page.locator('#touch .dk-stick.is-active')).toHaveCount(0);
  await expectStops('after release');
  expect(errors).toEqual([]);
});

test('pointercancel mid-drag releases the stick and stops the player (glitch: stuck stick after pointercancel)', async () => {
  const before = await controlled();
  await touch('touchStart', 300, 560);
  for (let i = 1; i <= 5; i++) await touch('touchMove', 300, 560 - i * 20); // screen up = toward -z
  await expect(page.locator('#touch .dk-stick.is-active')).toHaveCount(1);
  await holdFor(before.tick, 45, 800);
  const during = await controlled();
  expect(during.slot).toBe(before.slot);
  expect(during.z - before.z, 'screen up moves him toward -z').toBeLessThan(-1);
  await touch('touchCancel');
  await expect(page.locator('#touch .dk-stick.is-active')).toHaveCount(0);
  await expectStops('after pointercancel');
  expect(errors).toEqual([]);
});

test('a touch-down within 24 pt of the bottom edge never starts the stick', async () => {
  const h = await page.evaluate(() => window.innerHeight);
  await touch('touchStart', 300, h - 10);
  await touch('touchMove', 380, h - 10);
  await expect(page.locator('#touch .dk-stick.is-active')).toHaveCount(0);
  await touch('touchEnd');
  // Just above the margin it does.
  await touch('touchStart', 300, h - 30);
  await expect(page.locator('#touch .dk-stick.is-active')).toHaveCount(1);
  await touch('touchEnd');
  await expect(page.locator('#touch .dk-stick.is-active')).toHaveCount(0);
  expect(errors).toEqual([]);
});
