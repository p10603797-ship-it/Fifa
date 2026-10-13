/**
 * TCH-05 pitch gestures, end to end in the built app (iPad-like 1180 x 820 viewport with touch):
 *  - a quick swipe on the pitch (right half, away from the cluster) produces one SWIPE gesture event in the touch
 *    source's intent queue, in screen space, pointing the way the finger went, and never activates the stick;
 *  - a tap on the pitch produces one TAP once its double-tap window has closed (the recogniser's timer path: the
 *    Wave 0 wiring never calls update());
 *  - a real (CDP) touch dragged across the pitch never activates the stick.
 * Timing: with software WebGL each CDP touch event reaches the page more than a second after the previous one, so a
 * CDP "swipe" is a slow drag by the time the page sees it (correctly ignored). The gesture tests therefore dispatch
 * real PointerEvents (pointerType 'touch') at the element under the finger inside one page task, which runs the same
 * pointer manager, router and recogniser as a finger.
 * The touch source is captured by wrapping ctx.devices.createSource before the match starts; its sample() is wrapped
 * to copy the gesture queue before the mapper drains it each tick.
 * Build first: npx vite build --outDir dist-e2e/tch-05 --emptyOutDir; then
 *   PW_DIST=dist-e2e/tch-05 PW_PORT=4205 npx playwright test tests/e2e/tch-05-gestures.spec.ts
 */
import { expect, test, type CDPSession, type Page } from '@playwright/test';

interface Logged { kind: number; sx: number; sy: number; ex: number; ey: number; vx: number; vy: number; curve: number }
interface Probe { log: Logged[]; stickSeen: number; captured: boolean }
type Win = { __tch05: Probe; __tch05src?: { state: { stickActive: boolean } } };

const TAP = 1;
const SWIPE = 3;

test.describe.configure({ mode: 'serial' });

let page: Page;
let cdp: CDPSession;
const errors: string[] = [];

async function probe(): Promise<Probe> {
  return page.evaluate(() => (window as unknown as Win).__tch05);
}

async function resetProbe(): Promise<void> {
  await page.evaluate(() => { const w = window as unknown as Win; w.__tch05.log.length = 0; w.__tch05.stickSeen = 0; });
}

/**
 * Dispatch a touch pointer path at the element under the first point, all in one task. Returns whether the stick
 * was active after the touch-down or after any move, and the class of the element that received the events.
 */
async function pointerPath(points: [number, number][], id: number): Promise<{ stickDuring: boolean; target: string }> {
  return page.evaluate(({ pts, pid }) => {
    const w = window as unknown as Win;
    const target = document.elementFromPoint(pts[0]![0], pts[0]![1]) as HTMLElement;
    const fire = (type: string, x: number, y: number): void => {
      target.dispatchEvent(new PointerEvent(type, {
        pointerId: pid, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, button: 0,
        buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true, composed: true,
      }));
    };
    let stickDuring = false;
    fire('pointerdown', pts[0]![0], pts[0]![1]);
    stickDuring ||= !!w.__tch05src?.state.stickActive;
    for (let i = 1; i < pts.length; i++) {
      fire('pointermove', pts[i]![0], pts[i]![1]);
      stickDuring ||= !!w.__tch05src?.state.stickActive;
    }
    const last = pts[pts.length - 1]!;
    fire('pointerup', last[0], last[1]);
    return { stickDuring, target: target.className };
  }, { pts: points, pid: id });
}

async function waitForLog(): Promise<void> {
  await page.waitForFunction(() => (window as unknown as Win).__tch05.log.length > 0, null, { timeout: 20_000 });
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
  await page.waitForFunction(() => !!window.__dotkick, null, { timeout: 30_000 });
  await page.evaluate(() => {
    type Src = { sample(out: unknown, ctx: unknown): void; state: { gestureEvents: Logged[]; gestureEventCount: number; stickActive: boolean } };
    type Logged = { kind: number; sx: number; sy: number; ex: number; ey: number; vx: number; vy: number; curve: number };
    const w = window as unknown as { __tch05: { log: Logged[]; stickSeen: number; captured: boolean }; __tch05src?: Src };
    w.__tch05 = { log: [], stickSeen: 0, captured: false };
    const devices = window.__dotkick!.ctx.devices as unknown as { createSource(id: string, human: number): unknown };
    const orig = devices.createSource.bind(devices);
    devices.createSource = (id: string, human: number) => {
      const src = orig(id, human) as Src;
      if (id === 'touch') {
        w.__tch05src = src;
        w.__tch05.captured = true;
        const sample = src.sample.bind(src);
        src.sample = (out, c) => {
          const st = src.state;
          for (let i = 0; i < st.gestureEventCount; i++) {
            const e = st.gestureEvents[i]!;
            w.__tch05.log.push({ kind: e.kind, sx: e.sx, sy: e.sy, ex: e.ex, ey: e.ey, vx: e.vx, vy: e.vy, curve: e.curve });
          }
          if (st.stickActive) w.__tch05.stickSeen++;
          sample(out, c);
        };
      }
      return src;
    };
  });
  await page.getByTestId('splash-start').click();
  await page.getByTestId('main-kickoff').click();
  await page.waitForFunction(() => {
    const d = window.__dotkick;
    return !!d && d.ctx.router.current === 'match' && d.ctx.session.getState() !== null;
  }, null, { timeout: 30_000 });
  cdp = await page.context().newCDPSession(page);
  expect((await probe()).captured, 'touch source captured').toBe(true);
});

test.afterAll(async () => {
  await page.context().close();
});

test('a swipe on the pitch produces one SWIPE gesture event and never moves the stick', async () => {
  await resetProbe();
  const x0 = 700, y0 = 300;
  const r = await pointerPath([[x0, y0], [x0 + 60, y0 + 2], [x0 + 130, y0 + 4], [x0 + 200, y0 + 6], [x0 + 280, y0 + 8]], 71);
  expect(r.target, 'events land on the touch layer').toContain('dk-touch');
  expect(r.stickDuring, 'stick never active during the pitch swipe').toBe(false);
  await waitForLog();
  const p = await probe();
  expect(p.log.map((e) => e.kind), JSON.stringify(p.log)).toEqual([SWIPE]);
  const e = p.log[0]!;
  expect(e.sx).toBeCloseTo(x0, 0);
  expect(e.sy).toBeCloseTo(y0, 0);
  expect(e.ex).toBeCloseTo(x0 + 280, 0);
  expect(e.ey).toBeCloseTo(y0 + 8, 0);
  expect(e.vx).toBeGreaterThan(0);
  expect(Math.abs(e.vy)).toBeLessThan(e.vx);
  expect(p.stickSeen, 'stick never active in any tick').toBe(0);
  await expect(page.locator('#touch .dk-stick.is-active')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a tap on the pitch produces one TAP after the double-tap window (timer path)', async () => {
  await resetProbe();
  await pointerPath([[820, 260], [821, 261]], 72);
  await waitForLog();
  await page.waitForTimeout(500);
  const p = await probe();
  expect(p.log.map((e) => e.kind), JSON.stringify(p.log)).toEqual([TAP]);
  expect(p.log[0]!.sx).toBeCloseTo(820, 0);
  expect(p.log[0]!.sy).toBeCloseTo(260, 0);
  expect(p.stickSeen).toBe(0);
  expect(errors).toEqual([]);
});

test('a real touch dragged across the pitch never activates the stick', async () => {
  await resetProbe();
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0): Promise<unknown> =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 3 }] });
  await send('touchStart', 760, 320);
  await send('touchMove', 900, 330);
  await expect(page.locator('#touch .dk-stick.is-active')).toHaveCount(0);
  await send('touchEnd');
  await page.waitForTimeout(300);
  expect((await probe()).stickSeen).toBe(0);
  await expect(page.locator('#touch .dk-stick.is-active')).toHaveCount(0);
  expect(errors).toEqual([]);
});
