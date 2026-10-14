/**
 * INT-B e2e: settings reach the running game live, persist across a reload and apply again after it.
 *  - Settings screen by touch: the touch Mirror toggle -> in the match the cluster sits bottom left and PAUSE stays
 *    top right (TCH-09 CR); larger HUD (accessibility) -> the HUD parts switch to the large size; master volume ->
 *    the audio engine's master bus follows; camera type (pause menu Camera page) -> the projector changes at once;
 *    assist level -> the next match's controller config.
 *  - Reload: every value is still there and the match uses it again (mirrored cluster, larger HUD).
 *
 *   npx vite build --outDir dist-e2e/int-b --emptyOutDir
 *   PW_DIST=dist-e2e/int-b PW_PORT=4317 npx playwright test tests/e2e/int-b-settings.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { centreOf, collectConsole, frames, shot, Touch, touchTestId, waitMatch, waitRoute } from './int-b-harness';

/* eslint-disable @typescript-eslint/no-explicit-any */

async function quickMatch(page: Page, t: Touch): Promise<void> {
  await touchTestId(page, t, 'main-kickoff'); // Play now: human 0 on every device
  await waitMatch(page);
  await expect(page.locator('.dk-touch')).toBeVisible();
  await frames(page, 6);
}

async function quit(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__dotkick.ctx.session.quit());
  await waitRoute(page, 'main');
}

const centreSpot = (page: Page): Promise<{ x: number; y: number }> => page.evaluate(() => {
  const out = { x: 0, y: 0 };
  (window as any).__dotkick.app.renderer.projector.pitchToScreen(0, 0, 0, out);
  return { x: Math.round(out.x), y: Math.round(out.y) };
});

test.describe('INT-B settings live and after reload', () => {
  test('mirror, larger HUD, volume, camera and assist apply live and survive a reload', async ({ page }) => {
    test.setTimeout(240_000);
    const errors = collectConsole(page);
    await page.goto('/');
    let t = await Touch.open(page);
    await touchTestId(page, t, 'splash-start');
    await waitRoute(page, 'main', 15_000);
    expect(await page.evaluate(() => (window as any).__dotkick.ctx.settings.persistent)).toBe(true);

    // Settings screen by touch: mirror the touch controls (Controls tab is where the toggle lives).
    await touchTestId(page, t, 'main-settings');
    await waitRoute(page, 'settings');
    const tab = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).find((e) => /controls/i.test(e.textContent ?? ''));
      return el?.dataset.testid ?? null;
    });
    if (tab) await touchTestId(page, t, tab);
    await touchTestId(page, t, 'set-touch-mirror');
    await expect.poll(() => page.evaluate(() => (window as any).__dotkick.ctx.settings.get().controls.touch.mirror)).toBe(true);
    await touchTestId(page, t, 'back');
    await waitRoute(page, 'main');
    // The rest straight through the store (the screen's controls are UIX-09's own e2e).
    await page.evaluate(() => (window as any).__dotkick.ctx.settings.update((s: any) => {
      s.accessibility.largerHud = true;
      s.audio.master = 0.3;
      s.controls.assist = 2; // Manual
    }));

    await quickMatch(page, t);
    const big = await centreOf(page, '.dk-tbtn--big');
    const pause = await centreOf(page, '.dk-tbtn--pause');
    expect(big!.x).toBeLessThan(1180 / 2);
    expect(pause!.x).toBeGreaterThan(1180 / 2);
    expect(await page.locator('.hud-lg').count()).toBeGreaterThan(0);
    const cfg = await page.evaluate(() => (window as any).__dotkick.ctx.session.getSetup().config.humans[0]);
    expect(cfg.assist).toBe(2);
    await expect.poll(() => page.evaluate(() => (window as any).__dotkick.app.audio.info().levels.master), { timeout: 5000 }).toBeLessThan(0.35);
    await shot(page, 'settings-mirrored-large');

    // Live while playing: volume and HUD size follow at once.
    await page.evaluate(() => (window as any).__dotkick.ctx.settings.update((s: any) => { s.audio.master = 0.9; s.accessibility.largerHud = false; }));
    await expect.poll(() => page.evaluate(() => (window as any).__dotkick.app.audio.info().levels.master), { timeout: 5000 }).toBeGreaterThan(0.8);
    await expect.poll(() => page.locator('.hud-lg').count()).toBe(0);
    // Camera type from the pause menu's Camera page: the projector moves on the next frame.
    const before = await centreSpot(page);
    const pb = await centreOf(page, '.dk-tbtn--pause');
    await t.tap(pb!.x, pb!.y);
    await expect(page.getByTestId('pause-camera')).toBeVisible();
    const type0 = await page.evaluate(() => (window as any).__dotkick.ctx.settings.get().camera.type);
    await page.evaluate((ty) => (window as any).__dotkick.ctx.settings.update((s: any) => { s.camera.type = ty === 0 ? 1 : 0; s.camera.zoom = 18; }), type0);
    await frames(page, 8);
    await expect.poll(() => centreSpot(page)).not.toEqual(before);
    await touchTestId(page, t, 'pause-resume');
    await quit(page);

    // Reload: everything persisted and applied again.
    await page.evaluate(() => (window as any).__dotkick.ctx.settings.update((s: any) => { s.accessibility.largerHud = true; }));
    await t.detach();
    await page.reload();
    t = await Touch.open(page);
    await touchTestId(page, t, 'splash-start');
    await waitRoute(page, 'main', 15_000);
    const s = await page.evaluate(() => (window as any).__dotkick.ctx.settings.get());
    expect(s.controls.touch.mirror).toBe(true);
    expect(s.accessibility.largerHud).toBe(true);
    expect(s.audio.master).toBeCloseTo(0.9, 5);
    expect(s.controls.assist).toBe(2);
    expect(s.camera.zoom).toBe(18);
    await quickMatch(page, t);
    expect((await centreOf(page, '.dk-tbtn--big'))!.x).toBeLessThan(1180 / 2);
    expect(await page.locator('.hud-lg').count()).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as any).__dotkick.ctx.session.getSetup().config.humans[0].assist)).toBe(2);
    await quit(page);
    await t.detach();
    expect(errors).toEqual([]);
  });
});
