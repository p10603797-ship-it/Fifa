/**
 * FND-05 fixes for the independent review, checked in the real app (iPad-like 1180 x 820, touch).
 * Requires `npx vite build` first (playwright.config.ts serves dist/ with vite preview).
 *  - No WebGL2: the "3D view unavailable" message sits in the canvas layer; the touch PAUSE button and the pause menu
 *    are above it and actually work (a real tap pauses, Resume resumes, Quit hides the message).
 *  - Live settings: once the renderer follows the SettingsStore (DotkickRenderer.bindSettings, the wiring requested
 *    from FND-04 / the lead as a CR), a fixed resolution scale and tier chosen mid-match apply at once.
 *  - Keyboard: D + ArrowRight held, ArrowRight released -> the player keeps running right.
 */
import { expect, test, type CDPSession, type Page } from '@playwright/test';

interface Controlled { slot: number; x: number; z: number; tick: number }

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
  await page.waitForFunction(() => {
    const s = window.__dotkick!.ctx.session.getState();
    return !!s && s.tick > 10 && s.ctrl[0]!.slot >= 0;
  }, null, { timeout: 15_000 });
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

async function tap(cdp: CDPSession, x: number, y: number): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test.describe('FND-05 fixes', () => {
  test('no WebGL2: message in the canvas layer; touch PAUSE and the pause menu stay above it and work', async ({ page }) => {
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        if (type === 'webgl2') return null;
        return (orig as (...a: unknown[]) => unknown).call(this, type, ...rest);
      } as typeof orig;
    });
    const errors = collectErrors(page);
    await startMatch(page);
    const msg = page.locator('#dk-webgl-missing');
    await expect(msg).toBeVisible();
    await expect(msg).toContainText('3D view unavailable');
    const layer = await page.evaluate(() => {
      const m = document.getElementById('dk-webgl-missing')!;
      const z = (id: string): number => Number(getComputedStyle(document.getElementById(id)!).zIndex) || 0;
      return {
        afterCanvas: m.previousElementSibling?.id ?? '',
        z: Number(getComputedStyle(m).zIndex) || 0,
        canvas: z('game'), hud: z('hud'), touch: z('touch'), ui: z('ui'),
      };
    });
    expect(layer.afterCanvas).toBe('game');
    expect(layer.z).toBe(layer.canvas);
    expect(layer.z).toBeLessThan(layer.hud);
    expect(layer.z).toBeLessThan(layer.touch);
    expect(layer.z).toBeLessThan(layer.ui);
    // A real finger on the touch PAUSE button pauses the match.
    const cdp = await page.context().newCDPSession(page);
    const pb = (await page.locator('#touch .dk-tbtn--pause').boundingBox())!;
    await tap(cdp, pb.x + pb.width / 2, pb.y + pb.height / 2);
    await page.waitForFunction(() => window.__dotkick!.ctx.session.paused);
    await expect(page.getByTestId('pause-resume')).toBeVisible();
    await page.getByTestId('pause-resume').click();
    await page.waitForFunction(() => !window.__dotkick!.ctx.session.paused);
    // Quit: back to the menu, the message goes away with the match.
    await page.evaluate(() => window.__dotkick!.ctx.session.pause(0));
    await page.getByTestId('pause-quit').click();
    await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'main');
    await expect(msg).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('renderer bound to the SettingsStore: tier and fixed resolution scale chosen mid-match apply', async ({ page }) => {
    const errors = collectErrors(page);
    await startMatch(page);
    type Bindable = { bindSettings(store: unknown): () => void };
    // The wiring requested from FND-04 (CR): boot binds the renderer to ctx.settings.
    await page.evaluate(() => {
      const d = window.__dotkick!;
      (d.app.renderer as unknown as Bindable).bindSettings(d.ctx.settings);
    });
    const read = (): Promise<{ scale: number; tier: number; bufW: number; cssW: number; dpr: number }> => page.evaluate(() => {
      const st = window.__dotkickRendererStats!();
      const c = document.getElementById('game') as HTMLCanvasElement;
      return { scale: st.resolutionScale, tier: st.qualityTier, bufW: c.width, cssW: c.clientWidth, dpr: window.devicePixelRatio };
    });
    expect((await read()).scale).toBeCloseTo(0.75, 5);
    await page.evaluate(() => window.__dotkick!.ctx.settings.update((s) => {
      s.graphics.tier = 3; // QualityTier.QUALITY
      s.graphics.resolutionScale = 1.0;
    }));
    await waitFrames(page, 3);
    let r = await read();
    expect(r.tier).toBe(3);
    expect(r.scale).toBeCloseTo(1.0, 5);
    expect(Math.abs(r.bufW - r.cssW * r.dpr)).toBeLessThanOrEqual(1);
    // Scale-only change (tier unchanged).
    await page.evaluate(() => window.__dotkick!.ctx.settings.update((s) => { s.graphics.resolutionScale = 0.6; }));
    await waitFrames(page, 3);
    r = await read();
    expect(r.tier).toBe(3);
    expect(r.scale).toBeCloseTo(0.6, 5);
    // Back to automatic: the dynamic controller's starting scale.
    await page.evaluate(() => window.__dotkick!.ctx.settings.update((s) => { s.graphics.resolutionScale = 0; }));
    await waitFrames(page, 3);
    expect((await read()).scale).toBeCloseTo(0.75, 5);
    expect(errors).toEqual([]);
  });

  test('keyboard: D + ArrowRight held, ArrowRight released -> still running right', async ({ page }) => {
    const errors = collectErrors(page);
    await startMatch(page);
    await page.keyboard.down('KeyD');
    await page.keyboard.down('ArrowRight');
    const a = await controlled(page);
    await waitTicks(page, a.tick, 20);
    await page.keyboard.up('ArrowRight');
    const b = await controlled(page);
    await waitTicks(page, b.tick, 45);
    const c = await controlled(page);
    await page.keyboard.up('KeyD');
    expect(c.slot).toBe(b.slot);
    expect(c.x - b.x).toBeGreaterThan(1.2);
    expect(errors).toEqual([]);
  });
});
