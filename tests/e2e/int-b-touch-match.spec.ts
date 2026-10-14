/**
 * INT-B e2e (a): a complete Kick-Off match by touch alone in the shipped app (iPad 1180x820, DPR 1).
 * Menus by real touches (CDP): splash -> main -> Kick-Off -> mode -> teams -> sides -> match settings -> Start. In the
 * match: the floating stick and the cluster drive the human (frames carry the stick and the button bits), the touch
 * PAUSE pauses and Resume by touch resumes with no stuck input; blur / resize mid-hold release everything. The clock is
 * fast-forwarded: half-time (Continue by touch) -> second half -> full-time interim -> final screen (numbers from the
 * session summary) -> Rematch (fresh seed) -> pause -> Quit (confirm) -> main menu. No console errors from the game.
 *
 *   npx vite build --outDir dist-e2e/int-b --emptyOutDir
 *   PW_DIST=dist-e2e/int-b PW_PORT=4317 npx playwright test tests/e2e/int-b-touch-match.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { centreOf, collectConsole, fastForward, frames, route, shot, stopFastForward, Touch, touchTestId, waitMatch, waitRoute } from './int-b-harness';

/* eslint-disable @typescript-eslint/no-explicit-any */

const frame0 = (page: Page): Promise<{ mx: number; mz: number; buttons: number }> =>
  page.evaluate(() => {
    const f = (window as any).__dotkick.ctx.session.runtime().frames[0];
    return { mx: f.mx, mz: f.mz, buttons: f.buttons };
  });

/** Max stick magnitude and OR of button bits the human's frames carried over `n` frames (sampled per frame). */
async function watchFrames(page: Page, n: number): Promise<{ mag: number; buttons: number }> {
  return page.evaluate((k) => new Promise<{ mag: number; buttons: number }>((res) => {
    let left = k;
    let mag = 0;
    let buttons = 0;
    const step = (): void => {
      const f = (window as any).__dotkick.ctx.session.runtime()?.frames[0];
      if (f) {
        mag = Math.max(mag, Math.hypot(f.mx, f.mz));
        buttons |= f.buttons;
      }
      if (--left <= 0) res({ mag, buttons }); else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), n);
}

/**
 * Wait for `target` while playing by touch: a kick-off the human's side has to take (it waits for the taker, D-013)
 * is taken with a real tap on PASS.
 */
async function playUntil(page: Page, t: Touch, target: string, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (target === 'in-play') {
      if (await page.evaluate(() => (window as any).__dotkick.ctx.session.getState()?.match.phase === 2)) return;
    } else if ((await route(page)) === target) return;
    const k = await page.evaluate(() => {
      const st = (window as any).__dotkick.ctx.session.getState();
      return st ? { phase: st.match.phase, phaseT: st.match.phaseT, team: st.match.restart.team } : null;
    });
    if (k && k.phase === 1 && k.team === 0 && k.phaseT > 90) {
      const pass = await centreOf(page, '.dk-tbtn[data-btn="0"]');
      if (pass) await t.tap(pass.x, pass.y);
    }
    await frames(page, 10);
  }
  throw new Error(`timed out waiting for ${target}`);
}

test.describe('INT-B touch only', () => {
  test('full Kick-Off match by touch: menus, play, pause, half-time, full-time, rematch, quit', async ({ page }) => {
    test.setTimeout(420_000);
    const errors = collectConsole(page);
    const t0 = Date.now();
    const lap = (what: string): void => console.log(`[int-b touch] ${what} at ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    await page.goto('/');
    const t = await Touch.open(page);
    await touchTestId(page, t, 'splash-start');
    await waitRoute(page, 'main', 15_000);
    // Short halves for the run (the clock is fast-forwarded anyway).
    await page.evaluate(() => (window as any).__dotkick.ctx.settings.update((s: any) => { s.match.halfMinutes = 2; }));

    await touchTestId(page, t, 'main-mode-kickoff');
    await waitRoute(page, 'mode-setup');
    await touchTestId(page, t, 'mode-continue');
    await waitRoute(page, 'team-select');
    await touchTestId(page, t, 'team-continue');
    await waitRoute(page, 'side-select');
    await shot(page, 'touch-side-select');
    await touchTestId(page, t, 'side-continue');
    await waitRoute(page, 'match-settings');
    await touchTestId(page, t, 'settings-start');
    await waitMatch(page);
    lap('match loaded');
    const setup = await page.evaluate(() => (window as any).__dotkick.ctx.session.getSetup());
    expect(setup.config.mode).toBe(0);
    expect(setup.config.halfMinutes).toBe(2);
    expect(setup.bindings[0].deviceIds).toContain('touch');
    const seed1 = setup.config.seed >>> 0;

    // Let the kick-off happen (the CPU or the human takes it); the overlay is up.
    await expect(page.locator('.dk-touch')).toBeVisible();
    await playUntil(page, t, 'in-play', 60_000);

    // Floating stick: thumb down in the left half, drag right; the human's frames carry the direction.
    await t.down(1, 220, 600);
    for (let i = 1; i <= 6; i++) await t.move(1, 220 + i * 14, 600);
    const held = await watchFrames(page, 20);
    expect(held.mag).toBeGreaterThan(0.5);
    // Second finger on the big cluster button (sprint / skill) while the stick is held.
    const big = await centreOf(page, '.dk-tbtn--big');
    expect(big).not.toBeNull();
    await t.down(2, big!.x, big!.y, [{ id: 1, x: 304, y: 600 }]);
    const both = await watchFrames(page, 12);
    expect(both.buttons).not.toBe(0);
    await shot(page, 'touch-play');
    lap('touch-play');
    // Blur mid-hold releases everything (no stuck stick or sprint).
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await frames(page, 4);
    const afterBlur = await frame0(page);
    expect(afterBlur.mx).toBe(0);
    expect(afterBlur.mz).toBe(0);
    expect(afterBlur.buttons).toBe(0);
    await t.up();
    await frames(page, 3);

    // Hold the stick again, then resize the window: the viewport change releases it.
    await t.down(1, 220, 600);
    for (let i = 1; i <= 6; i++) await t.move(1, 220, 600 - i * 14);
    expect((await watchFrames(page, 10)).mag).toBeGreaterThan(0.5);
    await page.setViewportSize({ width: 1180, height: 800 });
    await frames(page, 6);
    const afterResize = await frame0(page);
    expect(Math.hypot(afterResize.mx, afterResize.mz)).toBe(0);
    await t.up();
    await page.setViewportSize({ width: 1180, height: 820 });
    await frames(page, 4);

    // Touch PAUSE (top right) pauses as human 0; Resume by touch.
    const pauseBtn = await centreOf(page, '.dk-tbtn--pause');
    expect(pauseBtn).not.toBeNull();
    expect(pauseBtn!.x).toBeGreaterThan(1180 / 2);
    await t.tap(pauseBtn!.x, pauseBtn!.y);
    await expect.poll(() => page.evaluate(() => (window as any).__dotkick.ctx.session.paused)).toBe(true);
    expect(await page.evaluate(() => (window as any).__dotkick.ctx.session.pausedBy)).toBe(0);
    await expect(page.getByTestId('pause-resume')).toBeVisible();
    await shot(page, 'touch-pause');
    lap('touch-pause');
    await touchTestId(page, t, 'pause-resume');
    await expect.poll(() => page.evaluate(() => (window as any).__dotkick.ctx.session.paused)).toBe(false);
    const tick0 = await page.evaluate(() => (window as any).__dotkick.ctx.session.getState().tick);
    await frames(page, 10);
    expect(await page.evaluate(() => (window as any).__dotkick.ctx.session.getState().tick)).toBeGreaterThan(tick0);

    // Half-time.
    await fastForward(page);
    await playUntil(page, t, 'half-time', 90_000);
    await expect(page.getByTestId('ht-continue')).toBeVisible();
    await shot(page, 'touch-half-time');
    lap('touch-half-time');
    await touchTestId(page, t, 'ht-continue');
    await waitRoute(page, 'match');
    // Full time: the interim screen, then the final one.
    await playUntil(page, t, 'full-time', 120_000);
    // The interim full-time screen (phase FULL_TIME, not finished yet) continues by touch.
    if (!(await page.evaluate(() => (window as any).__dotkick.ctx.session.finished))) {
      await shot(page, 'touch-full-time-interim');
      await touchTestId(page, t, 'ft-continue');
    }
    await page.waitForFunction(() => (window as any).__dotkick.ctx.session.finished === true, null, { timeout: 60_000 });
    await stopFastForward(page);
    await expect(page.getByTestId('ft-rematch')).toBeVisible();
    const sum = await page.evaluate(() => (window as any).__dotkick.ctx.session.lastSummary);
    expect(sum).not.toBeNull();
    // The final screen shows the summary's score (brk-goals-0 / brk-goals-1 of the score header).
    await expect(page.getByTestId('brk-goals-0')).toHaveText(String(sum.teams[0].goals));
    await expect(page.getByTestId('brk-goals-1')).toHaveText(String(sum.teams[1].goals));
    await shot(page, 'touch-full-time');
    lap('touch-full-time');

    // Rematch by touch: the same setup with a fresh seed.
    await touchTestId(page, t, 'ft-rematch');
    await waitMatch(page);
    const seed2 = await page.evaluate(() => (window as any).__dotkick.ctx.session.getSetup().config.seed >>> 0);
    expect(seed2).not.toBe(seed1);
    // Quit through the pause menu (confirm dialog) back to the main menu.
    const p2 = await centreOf(page, '.dk-tbtn--pause');
    await t.tap(p2!.x, p2!.y);
    await expect(page.getByTestId('pause-quit')).toBeVisible();
    await touchTestId(page, t, 'pause-quit');
    await touchTestId(page, t, 'pause-quit-confirm');
    await waitRoute(page, 'main');
    expect(await page.evaluate(() => (window as any).__dotkick.ctx.session.active)).toBe(false);
    lap('main');
    expect(await page.locator('.dk-touch').count()).toBe(0);
    await t.detach();
    expect(await route(page)).toBe('main');
    expect(errors).toEqual([]);
  });
});
