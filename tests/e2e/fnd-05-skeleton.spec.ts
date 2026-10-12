/**
 * FND-05 walking skeleton (brief section 16 rule 2): a ball, 22 capsules, the broadcast camera, and one player
 * moved by keyboard, by touch and by a (mocked) controller. iPad-like viewport 1180 x 820 with touch.
 * Requires `npx vite build` first (playwright.config.ts serves dist/ with vite preview).
 */
import { expect, test, type CDPSession, type Page } from '@playwright/test';

interface Controlled { slot: number; x: number; z: number; tick: number }

/** Mock gamepad installed before any page script: navigator.getGamepads() returns window.__mockPad. */
const MOCK_PAD_SCRIPT = `
  window.__mockPad = {
    id: 'Mock Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, connected: true, mapping: 'standard',
    timestamp: 0, axes: [0, 0, 0, 0], vibrationActuator: null,
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [window.__mockPad, null, null, null] });
`;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function startMatch(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('splash-start').click();
  await page.getByTestId('main-kickoff').click();
  await page.waitForFunction(() => {
    const d = window.__dotkick;
    return !!d && d.ctx.router.current === 'match' && d.ctx.session.getState() !== null;
  }, null, { timeout: 30_000 });
  // Let a few ticks run so the controlled player is assigned.
  await page.waitForFunction(() => {
    const s = window.__dotkick!.ctx.session.getState();
    return !!s && s.tick > 10 && s.ctrl[0]!.slot >= 0;
  }, null, { timeout: 10_000 });
}

async function controlled(page: Page): Promise<Controlled> {
  return page.evaluate(() => {
    const s = window.__dotkick!.ctx.session.getState()!;
    const slot = s.ctrl[0]!.slot;
    const p = s.players[slot]!;
    return { slot, x: p.x, z: p.z, tick: s.tick };
  });
}

/**
 * Keep an input held for at least 1 s of real time AND at least `ticks` sim ticks. Headless Chromium renders with
 * SwiftShader at a few fps, and the loop runs at most 3 ticks per frame, so wall time alone is not enough.
 */
async function holdFor(page: Page, startTick: number, ticks = 60): Promise<void> {
  await page.waitForTimeout(1000);
  await page.waitForFunction((t) => window.__dotkick!.ctx.session.getState()!.tick >= t, startTick + ticks, { timeout: 30_000 });
}

async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', x: number, y: number): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x, y, id: 1 }] });
}

test.describe('FND-05 skeleton', () => {
  test('match renders: 22 capsules, ball, broadcast camera, sane draw calls', async ({ page }) => {
    const errors = collectErrors(page);
    await startMatch(page);
    await page.waitForTimeout(500);
    const stats = await page.evaluate(() => window.__dotkickRendererStats?.() ?? null);
    expect(stats).not.toBeNull();
    expect(stats!.drawCalls).toBeGreaterThan(3);
    expect(stats!.drawCalls).toBeLessThanOrEqual(80);
    expect(stats!.triangles).toBeGreaterThan(1000);
    expect(stats!.triangles).toBeLessThanOrEqual(200_000);
    // The centre spot projects near the middle of the screen at kick-off; the ball is above the bottom 15%.
    const spot = await page.evaluate(() => {
      const r = window.__dotkick!.app.renderer;
      const out = { x: 0, y: 0 };
      const ok = r.projector.pitchToScreen(0, 0, 0, out);
      return { ok, ...out, w: window.innerWidth, h: window.innerHeight };
    });
    expect(spot.ok).toBe(true);
    expect(spot.x).toBeGreaterThan(spot.w * 0.3);
    expect(spot.x).toBeLessThan(spot.w * 0.7);
    expect(spot.y).toBeLessThan(spot.h * 0.85);
    // Touch overlay is present while the match runs: stick zone, four buttons and pause.
    await expect(page.locator('#touch .dk-touch')).toHaveCount(1);
    await expect(page.locator('#touch .dk-tbtn')).toHaveCount(5);
    expect(errors).toEqual([]);
  });

  test('keyboard: holding D for 1 s moves the controlled player toward +x', async ({ page }) => {
    const errors = collectErrors(page);
    await startMatch(page);
    const before = await controlled(page);
    await page.keyboard.down('KeyD');
    await holdFor(page, before.tick);
    const during = await controlled(page);
    await page.keyboard.up('KeyD');
    expect(during.slot).toBe(before.slot);
    expect(during.x - before.x).toBeGreaterThan(1.5);
    expect(Math.abs(during.z - before.z)).toBeLessThan(1);
    // Releasing stops the player (decelerates to rest within ~1 s of sim time).
    await holdFor(page, during.tick, 60);
    const a = await controlled(page);
    await holdFor(page, a.tick, 20);
    const b = await controlled(page);
    expect(Math.abs(b.x - a.x)).toBeLessThan(0.2);
    expect(errors).toEqual([]);
  });

  test('touch: a drag in the left half moves the player; pointer release stops it', async ({ page }) => {
    const errors = collectErrors(page);
    await startMatch(page);
    const cdp = await page.context().newCDPSession(page);
    const before = await controlled(page);
    await touch(cdp, 'touchStart', 300, 520);
    for (let i = 1; i <= 6; i++) await touch(cdp, 'touchMove', 300 + i * 20, 520);
    // Pressed visual state of the stick appears immediately.
    await expect(page.locator('#touch .dk-stick.is-active')).toHaveCount(1);
    await holdFor(page, before.tick);
    const during = await controlled(page);
    await touch(cdp, 'touchEnd', 420, 520);
    expect(during.x - before.x).toBeGreaterThan(1.5);
    expect(Math.abs(during.z - before.z)).toBeLessThan(1);
    await expect(page.locator('#touch .dk-stick.is-active')).toHaveCount(0);
    // Pressing SPRINT shows the pressed state.
    const big = page.locator('#touch .dk-tbtn--big');
    const box = (await big.boundingBox())!;
    await touch(cdp, 'touchStart', box.x + box.width / 2, box.y + box.height / 2);
    await expect(big).toHaveClass(/is-pressed/);
    await touch(cdp, 'touchEnd', box.x + box.width / 2, box.y + box.height / 2);
    await expect(big).not.toHaveClass(/is-pressed/);
    expect(errors).toEqual([]);
  });

  test('controller: a mocked pad joins after a button press and moves the player', async ({ page }) => {
    await page.addInitScript(MOCK_PAD_SCRIPT);
    const errors = collectErrors(page);
    await startMatch(page);
    // Not listed before a press.
    const listed0 = await page.evaluate(() => window.__dotkick!.ctx.devices.list().some((d) => d.kind === 'pad'));
    expect(listed0).toBe(false);
    // Press Square / X (LOB: harmless in the skeleton), release, then push the left stick left.
    await page.evaluate(() => {
      const p = (window as unknown as { __mockPad: { buttons: { pressed: boolean; value: number }[] } }).__mockPad;
      p.buttons[2]!.pressed = true; p.buttons[2]!.value = 1;
    });
    await page.waitForFunction(() => window.__dotkick!.ctx.devices.list().some((d) => d.kind === 'pad'));
    await page.evaluate(() => {
      const p = (window as unknown as { __mockPad: { buttons: { pressed: boolean; value: number }[]; axes: number[] } }).__mockPad;
      p.buttons[2]!.pressed = false; p.buttons[2]!.value = 0;
    });
    const before = await controlled(page);
    await page.evaluate(() => {
      (window as unknown as { __mockPad: { axes: number[] } }).__mockPad.axes[0] = -1;
    });
    await holdFor(page, before.tick);
    const during = await controlled(page);
    await page.evaluate(() => {
      (window as unknown as { __mockPad: { axes: number[] } }).__mockPad.axes[0] = 0;
    });
    expect(before.x - during.x).toBeGreaterThan(1.5);
    expect(Math.abs(during.z - before.z)).toBeLessThan(1);
    expect(errors).toEqual([]);
  });

  test('touch: pointercancel and window blur release a held stick and sprint (no stuck input)', async ({ page }) => {
    const errors = collectErrors(page);
    await startMatch(page);
    const cdp = await page.context().newCDPSession(page);
    const heldState = (): Promise<{ held: number; stick: boolean; buttons: number }> => page.evaluate(() => {
      const s = window.__dotkick!.ctx.session.getState()!;
      return {
        held: document.querySelectorAll('#touch .dk-tbtn.is-pressed').length,
        stick: document.querySelector('#touch .dk-stick.is-active') !== null,
        buttons: s.ctrl[0]!.buttons,
      };
    });
    await touch(cdp, 'touchStart', 300, 520);
    await touch(cdp, 'touchMove', 400, 520);
    expect((await heldState()).stick).toBe(true);
    await touch(cdp, 'touchCancel', 400, 520);
    expect((await heldState()).stick).toBe(false);
    const a = await controlled(page);
    await holdFor(page, a.tick, 90);
    const b = await controlled(page);
    await holdFor(page, b.tick, 10);
    const c = await controlled(page);
    expect(Math.abs(c.x - b.x)).toBeLessThan(0.1); // stopped, not stuck running
    // Hold SPRINT, then the window loses focus (multitasking gesture): everything is released.
    const big = (await page.locator('#touch .dk-tbtn--big').boundingBox())!;
    await touch(cdp, 'touchStart', big.x + big.width / 2, big.y + big.height / 2);
    expect((await heldState()).held).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    expect((await heldState()).held).toBe(0);
    const t = (await controlled(page)).tick;
    await holdFor(page, t, 5);
    expect((await heldState()).buttons).toBe(0);
    await touch(cdp, 'touchEnd', big.x + big.width / 2, big.y + big.height / 2);
    expect(errors).toEqual([]);
  });

  test('menus: keyboard focus navigation shows a ring, Enter confirms, Escape goes back', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await page.getByTestId('splash-start').click();
    await expect(page.getByTestId('main-kickoff')).toBeVisible();
    const focused = (): Promise<string | null> => page.evaluate(() => document.querySelector<HTMLElement>('[data-focused]')?.dataset.testid ?? null);
    expect(await focused()).toBe('main-kickoff');
    await page.keyboard.press('ArrowDown'); // first press reveals the ring
    await expect(page.locator('html[data-focus-visible]')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await expect.poll(focused).not.toBe('main-kickoff');
    const target = await focused();
    expect(target === 'main-modes' || target === 'main-practice').toBe(true);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => window.__dotkick!.ctx.router.current)).not.toBe('main');
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => window.__dotkick!.ctx.router.current)).toBe('main');
    // A pointer press hides the ring again.
    await page.mouse.click(5, 5);
    await expect(page.locator('html[data-focus-visible]')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('WebGL context loss pauses the match; after restore the scene draws again', async ({ page }) => {
    const errors = collectErrors(page);
    await startMatch(page);
    await page.evaluate(() => {
      const c = document.getElementById('game') as HTMLCanvasElement;
      const gl = c.getContext('webgl2')!;
      (window as unknown as { __loseExt: WEBGL_lose_context }).__loseExt = gl.getExtension('WEBGL_lose_context')!;
      (window as unknown as { __loseExt: WEBGL_lose_context }).__loseExt.loseContext();
    });
    await page.waitForFunction(() => window.__dotkick!.ctx.session.paused, null, { timeout: 10_000 });
    await page.evaluate(() => (window as unknown as { __loseExt: WEBGL_lose_context }).__loseExt.restoreContext());
    await page.waitForFunction(() => {
      const c = document.getElementById('game') as HTMLCanvasElement;
      return !c.getContext('webgl2')!.isContextLost();
    }, null, { timeout: 10_000 });
    // Resume (system pause: anyone may resume) and check frames are drawn with the rebuilt resources.
    await page.evaluate(() => window.__dotkick!.ctx.session.resume(-1));
    const t = (await controlled(page)).tick;
    await holdFor(page, t, 10);
    const stats = await page.evaluate(() => window.__dotkickRendererStats!());
    expect(stats.drawCalls).toBeGreaterThan(3);
    expect(errors).toEqual([]);
  });
});
