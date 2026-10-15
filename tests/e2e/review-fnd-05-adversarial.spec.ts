/**
 * REVIEW of FND-05 (independent reviewer): adversarial end-to-end checks of the render + input skeleton in the
 * real app (iPad-like 1180 x 820, touch). Requires `npx vite build` first.
 *  - no WebGL2: the "3D view unavailable" message must not hide the pause menu / touch controls;
 *  - quit and restart twice: one overlay, no leaked window/document listeners, input still works;
 *  - visibility change mid-match while holding a key and the touch stick: released, no stuck input on resume;
 *  - resize mid-match (4:3, 21:9): the cluster relayouts inside the viewport and still responds;
 *  - pad disconnect mid-hold and reconnect at a new index;
 *  - blocked storage + no service worker;
 *  - multi-touch: stick and SPRINT never steal each other's touches;
 *  - Escape and the touch PAUSE button pause exactly once; the touch layer ignores touches while paused.
 */
import { expect, test, type CDPSession, type Page } from '@playwright/test';

interface Controlled { slot: number; x: number; z: number; tick: number }

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function waitMatch(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const d = window.__dotkick;
    return !!d && d.ctx.router.current === 'match' && d.ctx.session.getState() !== null;
  }, null, { timeout: 30_000 });
  await page.waitForFunction(() => {
    const s = window.__dotkick!.ctx.session.getState();
    return !!s && s.tick > 10 && s.ctrl[0]!.slot >= 0;
  }, null, { timeout: 15_000 });
}

async function startMatch(page: Page, live = false): Promise<void> {
  await page.goto('/');
  // [QF-12 refit] `live`: auto-switch off (the checks follow one player) and open play (below).
  if (live) await page.evaluate(() => window.__dotkick!.ctx.settings.update((s) => { s.controls.autoSwitch = 0; }));
  await page.getByTestId('splash-start').click();
  await page.getByTestId('main-kickoff').click();
  await waitMatch(page);
  if (live) await toOpenPlay(page);
}

/**
 * [QF-12 refit] The match opens with the PRE_MATCH intro (touch cluster hidden, nobody moves) and a KICK_OFF whose taker
 * stands at the ball: input checks need open play. The kick-off is taken by the sim's own restart timeout.
 */
async function toOpenPlay(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const st = (window.__dotkick!.ctx.session as unknown as { runtime(): { curr: { match: { phase: number; restart: Record<string, number> } } } | null }).runtime()?.curr;
    if (!st) return false;
    const r = st.match.restart;
    if (st.match.phase === 1 && r.ready === 1 && r.taken === 0) r.timeoutT = 1;
    return st.match.phase === 2;
  }, null, { timeout: 60_000 });
  const t = await page.evaluate(() => window.__dotkick!.ctx.session.getState()!.tick);
  await page.waitForFunction((t0) => window.__dotkick!.ctx.session.getState()!.tick >= t0 + 30, t, { timeout: 30_000 });
}

async function controlled(page: Page): Promise<Controlled> {
  return page.evaluate(() => {
    const s = window.__dotkick!.ctx.session.getState()!;
    const slot = s.ctrl[0]!.slot;
    const p = s.players[slot]!;
    return { slot, x: p.x, z: p.z, tick: s.tick };
  });
}

async function waitTicks(page: Page, from: number, ticks: number): Promise<void> {
  await page.waitForFunction((t) => (window.__dotkick!.ctx.session.getState()?.tick ?? 0) >= t, from + ticks, { timeout: 30_000 });
}

async function waitFrames(page: Page, n: number): Promise<void> {
  const f0 = await page.evaluate(() => window.__dotkickFrameStats!.frame);
  await page.waitForFunction((f) => window.__dotkickFrameStats!.frame >= f, f0 + n, { timeout: 30_000 });
}

type Pt = { x: number; y: number; id: number };
async function touches(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', pts: Pt[]): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p) => ({ x: p.x, y: p.y, id: p.id })) });
}

async function centre(page: Page, sel: string): Promise<{ x: number; y: number; box: { x: number; y: number; width: number; height: number } }> {
  const box = (await page.locator(sel).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

test.describe('REVIEW FND-05 adversarial', () => {
  test('no WebGL2: the unavailable message is shown but does not cover the pause menu or the touch PAUSE button', async ({ page }) => {
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        if (type === 'webgl2') return null;
        return (orig as (...a: unknown[]) => unknown).call(this, type, ...rest);
      } as typeof orig;
    });
    const errors = collectErrors(page);
    await startMatch(page);
    await expect(page.locator('#dk-webgl-missing')).toBeVisible();
    // Which element is VISUALLY on top at a point (the message has pointer-events: none, so hit-test it explicitly).
    const topAt = (sel: string): Promise<string> => page.evaluate((s) => {
      const target = document.querySelector<HTMLElement>(s)!;
      const r = target.getBoundingClientRect();
      const msg = document.getElementById('dk-webgl-missing')!;
      const prev = msg.style.pointerEvents;
      msg.style.pointerEvents = 'auto';
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      msg.style.pointerEvents = prev;
      return el && msg.contains(el) ? 'message' : 'control';
    }, sel);
    expect.soft(await topAt('#touch .dk-tbtn--pause'), 'touch PAUSE button hidden under the message').toBe('control');
    expect.soft(await topAt('#hud > *'), 'HUD hidden under the message').toBe('control');
    await page.evaluate(() => window.__dotkick!.ctx.session.pause(0));
    await expect(page.getByTestId('pause-resume')).toBeVisible();
    expect.soft(await topAt('[data-testid="pause-resume"]'), 'pause menu hidden under the message').toBe('control');
    expect(errors).toEqual([]);
  });

  test('quit and restart twice: one overlay, no leaked window/document listeners, input still works', async ({ page }) => {
    await page.addInitScript(() => {
      const add = EventTarget.prototype.addEventListener;
      const rem = EventTarget.prototype.removeEventListener;
      const sets = new Map<string, Set<unknown>>();
      const key = (t: EventTarget, type: string, opts?: boolean | AddEventListenerOptions | EventListenerOptions): string | null => {
        const who = t === window ? 'win' : t === document ? 'doc' : null;
        if (!who) return null;
        const cap = typeof opts === 'boolean' ? opts : !!(opts && opts.capture);
        return `${who}:${type}:${cap ? 'c' : 'b'}`;
      };
      EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) {
        const k = key(this, type, opts);
        if (k && fn && !(typeof opts === 'object' && opts?.once)) {
          let s = sets.get(k);
          if (!s) sets.set(k, (s = new Set()));
          s.add(fn);
        }
        return add.call(this, type, fn, opts);
      };
      EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions) {
        const k = key(this, type, opts);
        if (k && fn) sets.get(k)?.delete(fn);
        return rem.call(this, type, fn, opts);
      };
      (window as unknown as { __listeners: () => Record<string, number> }).__listeners = () => {
        const o: Record<string, number> = {};
        for (const [k, s] of sets) if (s.size > 0) o[k] = s.size;
        return o;
      };
    });
    const errors = collectErrors(page);
    const listeners = (): Promise<Record<string, number>> => page.evaluate(() => (window as unknown as { __listeners: () => Record<string, number> }).__listeners());
    await page.goto('/');
    await page.evaluate(() => window.__dotkick!.ctx.settings.update((s) => { s.controls.autoSwitch = 0; }));
    await startMatch(page);
    const inMatch1 = await listeners();
    const quit = async (): Promise<void> => {
      await page.evaluate(() => window.__dotkick!.ctx.session.pause(0));
      await page.getByTestId('pause-quit').click();
      await page.getByTestId('pause-quit-confirm').click(); // UIX-08 quit confirmation [QF-12 refit]
      await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'main');
    };
    await quit();
    await expect(page.locator('#touch .dk-touch')).toHaveCount(0);
    const menu1 = await listeners();
    for (let i = 0; i < 2; i++) {
      await page.getByTestId('main-kickoff').click();
      await waitMatch(page);
      await expect(page.locator('#touch .dk-touch')).toHaveCount(1);
      await expect(page.locator('#touch .dk-tbtn')).toHaveCount(5);
      expect(await listeners()).toEqual(inMatch1);
      await quit();
      await expect(page.locator('#touch .dk-touch')).toHaveCount(0);
      expect(await listeners()).toEqual(menu1);
    }
    // Restart twice from inside a match (pause menu -> Restart match).
    await page.getByTestId('main-kickoff').click();
    await waitMatch(page);
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => window.__dotkick!.ctx.session.pause(0));
      await page.getByTestId('pause-restart').click();
      await waitMatch(page);
      await expect(page.locator('#touch .dk-touch')).toHaveCount(1);
      expect(await listeners()).toEqual(inMatch1);
    }
    // Input still drives the player after all that (in open play: the kick-off taken first).
    await toOpenPlay(page);
    const before = await controlled(page);
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(600);
    await waitTicks(page, before.tick, 60);
    const after = await controlled(page);
    await page.keyboard.up('KeyD');
    expect(after.x - before.x).toBeGreaterThan(1.5);
    expect(errors).toEqual([]);
  });

  test('visibility change mid-match while holding D and the touch stick: everything released, nothing stuck after resume', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __vis: string };
      w.__vis = 'visible';
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => w.__vis });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => w.__vis === 'hidden' });
    });
    const errors = collectErrors(page);
    await startMatch(page);
    const cdp = await page.context().newCDPSession(page);
    await page.keyboard.down('KeyD');
    await touches(cdp, 'touchStart', [{ x: 300, y: 520, id: 1 }]);
    await touches(cdp, 'touchMove', [{ x: 300, y: 440, id: 1 }]);
    await expect(page.locator('#touch .dk-stick.is-active')).toHaveCount(1);
    const t0 = (await controlled(page)).tick;
    await waitTicks(page, t0, 20);
    await page.evaluate(() => {
      (window as unknown as { __vis: string }).__vis = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.paused)).toBe(true);
    await expect(page.locator('#touch .dk-stick.is-active')).toHaveCount(0);
    await page.evaluate(() => {
      (window as unknown as { __vis: string }).__vis = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.getByTestId('pause-resume')).toBeVisible();
    await page.getByTestId('pause-resume').click();
    await page.waitForFunction(() => !window.__dotkick!.ctx.session.paused);
    // D is still physically down (no auto-repeat in Playwright) and the finger never lifted: neither may drive the
    // player now. Let it decelerate, then it must stay put.
    const a = await controlled(page);
    await waitTicks(page, a.tick, 90);
    const b = await controlled(page);
    await waitTicks(page, b.tick, 30);
    const c = await controlled(page);
    expect(Math.hypot(c.x - b.x, c.z - b.z)).toBeLessThan(0.15);
    const buttons = await page.evaluate(() => window.__dotkick!.ctx.session.getState()!.ctrl[0]!.buttons);
    expect(buttons).toBe(0);
    await page.keyboard.up('KeyD');
    await touches(cdp, 'touchEnd', []);
    expect(errors).toEqual([]);
  });

  test('resize mid-match (4:3 and 21:9): cluster relayouts inside the viewport and still responds; camera follows', async ({ page }) => {
    const errors = collectErrors(page);
    await startMatch(page, true);
    const cdp = await page.context().newCDPSession(page);
    for (const [w, h] of [[1024, 768], [1600, 686]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await waitFrames(page, 3);
      const big = await centre(page, '#touch .dk-tbtn--big');
      const pause = await centre(page, '#touch .dk-tbtn--pause');
      expect(big.box.x + big.box.width).toBeLessThanOrEqual(w - 24 + 0.5);
      expect(big.box.y + big.box.height).toBeLessThanOrEqual(h - 24 + 0.5);
      expect(pause.box.x + pause.box.width).toBeLessThanOrEqual(w - 24 + 0.5);
      expect(pause.box.y).toBeGreaterThanOrEqual(24 - 0.5);
      for (const sel of ['#touch .dk-tbtn']) {
        const boxes = await page.locator(sel).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
        for (const r of boxes) {
          expect(r.left).toBeGreaterThanOrEqual(0);
          expect(r.top).toBeGreaterThanOrEqual(0);
          expect(r.right).toBeLessThanOrEqual(w);
          expect(r.bottom).toBeLessThanOrEqual(h);
        }
      }
      await touches(cdp, 'touchStart', [{ x: big.x, y: big.y, id: 3 }]);
      await expect(page.locator('#touch .dk-tbtn--big')).toHaveClass(/is-pressed/);
      await touches(cdp, 'touchEnd', []);
      await expect(page.locator('#touch .dk-tbtn--big')).not.toHaveClass(/is-pressed/);
      const proj = await page.evaluate(() => {
        const r = window.__dotkick!.app.renderer;
        const s = window.__dotkick!.ctx.session.getState()!;
        const o = { x: 0, y: 0 };
        const ok = r.projector.pitchToScreen(s.ball.x, s.ball.y, s.ball.z, o);
        const canvas = document.getElementById('game') as HTMLCanvasElement;
        return { ok, ...o, cw: canvas.clientWidth, ch: canvas.clientHeight };
      });
      expect(proj.ok).toBe(true);
      expect(proj.cw).toBe(w);
      expect(proj.ch).toBe(h);
      expect(proj.x).toBeGreaterThan(0);
      expect(proj.x).toBeLessThan(w);
      expect(proj.y).toBeGreaterThan(0);
      expect(proj.y).toBeLessThan(h * 0.85 + 1);
    }
    expect(errors).toEqual([]);
  });

  test('pad: disconnect mid-hold stops the player; reconnect at a new index keeps the binding and drives it again', async ({ page }) => {
    await page.addInitScript(() => {
      const mk = (index: number) => ({
        id: 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', index, connected: true, mapping: 'standard',
        timestamp: 0, axes: [0, 0, 0, 0], vibrationActuator: null,
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
      });
      const w = window as unknown as { __pads: unknown[]; __mkPad: typeof mk };
      w.__mkPad = mk;
      w.__pads = [mk(0), null, null, null];
      Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => w.__pads });
    });
    type W = { __pads: ({ axes: number[]; connected: boolean; buttons: { pressed: boolean; value: number }[] } | null)[]; __mkPad: (i: number) => unknown };
    const errors = collectErrors(page);
    await startMatch(page, true);
    await page.evaluate(() => {
      const p = (window as unknown as W).__pads[0]!;
      p.buttons[2]!.pressed = true; p.buttons[2]!.value = 1;
    });
    await page.waitForFunction(() => window.__dotkick!.ctx.devices.list().some((d) => d.kind === 'pad'));
    await page.evaluate(() => {
      const p = (window as unknown as W).__pads[0]!;
      p.buttons[2]!.pressed = false; p.buttons[2]!.value = 0;
      p.axes[0] = -1;
    });
    const a = await controlled(page);
    await waitTicks(page, a.tick, 45);
    const b = await controlled(page);
    expect(a.x - b.x).toBeGreaterThan(0.8);
    await page.evaluate(() => {
      const w = window as unknown as W;
      w.__pads[0]!.connected = false;
      w.__pads[0] = null;
    });
    // PAD-03: losing the bound pad mid-match pauses with the reconnect card [QF-12 refit: the spec predates it], so the
    // player stops at once and nothing runs on the dead stick.
    await page.waitForFunction(() => window.__dotkick!.ctx.session.paused, null, { timeout: 15_000 });
    const c = await controlled(page);
    await waitFrames(page, 20);
    const d = await controlled(page);
    expect(d.tick).toBe(c.tick);
    expect(Math.abs(d.x - c.x)).toBeLessThan(0.15);
    const listed = await page.evaluate(() => window.__dotkick!.ctx.devices.list().filter((x) => x.kind === 'pad').map((x) => ({ id: x.id, c: x.connected })));
    expect(listed).toEqual([{ id: 'pad:1', c: false }]);
    await page.evaluate(() => {
      const w = window as unknown as W;
      const p = w.__mkPad(2) as W['__pads'][number];
      w.__pads[2] = p;
    });
    // Back at a new index: any button on it resumes (the card), then the stick drives the same player again.
    await page.evaluate(() => {
      const p = (window as unknown as W).__pads[2]!;
      p.buttons[0]!.pressed = true; p.buttons[0]!.value = 1;
    });
    await page.waitForFunction(() => !window.__dotkick!.ctx.session.paused, null, { timeout: 15_000 });
    await page.evaluate(() => {
      const p = (window as unknown as W).__pads[2]!;
      p.buttons[0]!.pressed = false; p.buttons[0]!.value = 0;
      p.axes[0] = 1;
    });
    const e = await controlled(page);
    await waitTicks(page, e.tick, 60);
    const f = await controlled(page);
    expect(f.x - e.x).toBeGreaterThan(0.8);
    const listed2 = await page.evaluate(() => window.__dotkick!.ctx.devices.list().filter((x) => x.kind === 'pad').map((x) => ({ id: x.id, c: x.connected })));
    expect(listed2).toEqual([{ id: 'pad:1', c: true }]);
    expect(errors).toEqual([]);
  });

  test('blocked storage and no service worker: the match starts and touch input works with zero console errors', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } });
      Object.defineProperty(window, 'sessionStorage', { configurable: true, get() { throw new DOMException('blocked', 'SecurityError'); } });
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, get() { return undefined; } });
    });
    const errors = collectErrors(page);
    await startMatch(page, true);
    const cdp = await page.context().newCDPSession(page);
    const before = await controlled(page);
    await touches(cdp, 'touchStart', [{ x: 300, y: 520, id: 1 }]);
    await touches(cdp, 'touchMove', [{ x: 400, y: 520, id: 1 }]);
    await waitTicks(page, before.tick, 60);
    const after = await controlled(page);
    await touches(cdp, 'touchEnd', []);
    expect(after.x - before.x).toBeGreaterThan(1.0);
    expect(errors).toEqual([]);
  });

  test('multi-touch: stick and SPRINT held together; lifting one keeps the other (no stolen touches)', async ({ page }) => {
    const errors = collectErrors(page);
    await startMatch(page);
    const cdp = await page.context().newCDPSession(page);
    const big = await centre(page, '#touch .dk-tbtn--big');
    const stick: Pt = { x: 300, y: 520, id: 1 };
    const sprint: Pt = { x: big.x, y: big.y, id: 2 };
    await touches(cdp, 'touchStart', [stick]);
    await touches(cdp, 'touchStart', [stick, sprint]);
    await touches(cdp, 'touchMove', [{ ...stick, x: 400 }, sprint]);
    await expect(page.locator('#touch .dk-stick.is-active')).toHaveCount(1);
    await expect(page.locator('#touch .dk-tbtn--big')).toHaveClass(/is-pressed/);
    const t0 = (await controlled(page)).tick;
    await waitTicks(page, t0, 6);
    const st = await page.evaluate(() => window.__dotkick!.ctx.session.getState()!.ctrl[0]!.buttons);
    expect(st & (1 << 7)).not.toBe(0); // Btn.SPRINT reached the sim
    // Lift only the stick finger (CDP: touchEnd lists the points that lift): SPRINT stays pressed.
    await touches(cdp, 'touchEnd', [{ ...stick, x: 400 }]);
    await expect(page.locator('#touch .dk-stick.is-active')).toHaveCount(0);
    await expect(page.locator('#touch .dk-tbtn--big')).toHaveClass(/is-pressed/);
    // A new finger in the left half takes the stick while SPRINT is still held.
    await touches(cdp, 'touchStart', [sprint, { x: 250, y: 600, id: 3 }]);
    await expect(page.locator('#touch .dk-stick.is-active')).toHaveCount(1);
    await expect(page.locator('#touch .dk-tbtn--big')).toHaveClass(/is-pressed/);
    await touches(cdp, 'touchCancel', []);
    await expect(page.locator('#touch .dk-stick.is-active')).toHaveCount(0);
    await expect(page.locator('#touch .dk-tbtn--big')).not.toHaveClass(/is-pressed/);
    expect(errors).toEqual([]);
  });

  test('graphics settings changed in a running session reach the renderer (fixed resolution scale)', async ({ page }) => {
    const errors = collectErrors(page);
    await startMatch(page);
    expect(await page.evaluate(() => window.__dotkickRendererStats!().resolutionScale)).toBeCloseTo(0.75, 5);
    // Settings screen: Quality tier + fixed 100 % resolution (settings.graphics.resolutionScale = 1.0).
    await page.evaluate(() => window.__dotkick!.ctx.settings.update((s) => {
      s.graphics.tier = 3; // QualityTier.QUALITY
      s.graphics.resolutionScale = 1.0;
    }));
    await waitFrames(page, 3);
    const st = await page.evaluate(() => window.__dotkickRendererStats!());
    expect(st.qualityTier).toBe(3);
    expect(st.resolutionScale).toBeCloseTo(1.0, 5);
    expect(errors).toEqual([]);
  });

  test('Escape and the touch PAUSE button pause exactly once; the touch layer ignores touches while paused', async ({ page }) => {
    const errors = collectErrors(page);
    await startMatch(page);
    await page.keyboard.press('Escape');
    await waitFrames(page, 8);
    expect(await page.evaluate(() => ({ p: window.__dotkick!.ctx.session.paused, by: window.__dotkick!.ctx.session.pausedBy })))
      .toEqual({ p: true, by: 0 });
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape');
    await waitFrames(page, 8);
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.paused)).toBe(false);
    // Touch PAUSE (top right).
    const cdp = await page.context().newCDPSession(page);
    await page.waitForTimeout(400);
    const pause = await centre(page, '#touch .dk-tbtn--pause');
    await touches(cdp, 'touchStart', [{ x: pause.x, y: pause.y, id: 1 }]);
    await touches(cdp, 'touchEnd', []);
    await waitFrames(page, 4);
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.paused)).toBe(true);
    // While paused, a drag in the left half does not activate the stick.
    await touches(cdp, 'touchStart', [{ x: 200, y: 600, id: 2 }]);
    await touches(cdp, 'touchMove', [{ x: 280, y: 600, id: 2 }]);
    await expect(page.locator('#touch .dk-stick.is-active')).toHaveCount(0);
    await touches(cdp, 'touchEnd', []);
    expect(errors).toEqual([]);
  });
});
