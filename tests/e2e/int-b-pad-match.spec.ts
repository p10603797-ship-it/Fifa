/**
 * INT-B e2e (b): controller alone (simulated Gamepad API) in the shipped app, and the PAD-03 reconnect card for real.
 *  - Full Kick-Off match by pad: menus by D-pad + Cross (splash -> main -> Kick-Off -> mode -> teams -> sides ->
 *    settings -> Start), the left stick and buttons drive the human, Options pauses / resumes (only the pauser),
 *    half-time and full-time continue by Cross, the final screen's Quit by pad. No console errors.
 *  - PAD-03 in the app: unplug the bound pad mid-match -> auto-pause + card; plug back + any button resumes; unplug ->
 *    "Touch" hands the side to touch (the touch overlay drives, the pad source is gone); a new match, unplug -> "CPU"
 *    hands the side to the CPU (ctrl kind CPU through Command.HAND_TO_CPU) and play goes on.
 *
 *   npx vite build --outDir dist-e2e/int-b --emptyOutDir
 *   PW_DIST=dist-e2e/int-b PW_PORT=4317 npx playwright test tests/e2e/int-b-pad-match.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import {
  collectConsole, fastForward, frames, PAD, padActivate, padButton, padInit, padStick, padTap, plugPad, route, shot,
  stopFastForward, Touch, touchTestId, waitMatch, waitRoute,
} from './int-b-harness';

/* eslint-disable @typescript-eslint/no-explicit-any */

const paused = (page: Page): Promise<boolean> => page.evaluate(() => (window as any).__dotkick.ctx.session.paused);
const pausedBy = (page: Page): Promise<number> => page.evaluate(() => (window as any).__dotkick.ctx.session.pausedBy);

/** Splash -> main by pad (the first press makes the pad appear; the splash never lets it confirm twice). */
async function padToMain(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('splash-start')).toBeVisible();
  for (let i = 0; i < 6 && (await route(page)) !== 'main'; i++) await padTap(page, 0, PAD.CROSS);
  await waitRoute(page, 'main', 15_000);
}

/** Main -> Kick-Off flow -> match, by pad only. */
async function padKickOff(page: Page): Promise<void> {
  await padActivate(page, 0, 'main-mode-kickoff');
  await waitRoute(page, 'mode-setup');
  await padActivate(page, 0, 'mode-continue');
  await waitRoute(page, 'team-select');
  await padActivate(page, 0, 'team-continue');
  await waitRoute(page, 'side-select');
  await padActivate(page, 0, 'side-continue');
  await waitRoute(page, 'match-settings');
  await padActivate(page, 0, 'settings-start');
  await waitMatch(page);
}

/** Wait for `target` while playing by pad: a kick-off the human has to take is taken with Cross (pass). */
async function playUntil(page: Page, target: string, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (target === 'in-play') {
      if (await page.evaluate(() => (window as any).__dotkick.ctx.session.getState()?.match.phase === 2)) return;
    } else if ((await route(page)) === target) return;
    const k = await page.evaluate(() => {
      const st = (window as any).__dotkick.ctx.session.getState();
      return st ? { phase: st.match.phase, phaseT: st.match.phaseT, team: st.match.restart.team } : null;
    });
    if (k && k.phase === 1 && k.team === 0 && k.phaseT > 90) await padTap(page, 0, PAD.CROSS);
    await frames(page, 10);
  }
  throw new Error(`timed out waiting for ${target}`);
}

/** Max stick magnitude and OR of button bits of human 0's frames over `n` frames. */
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

test.describe('INT-B controller only', () => {
  test('full Kick-Off match by pad: menus, play, Options pause, half-time, full-time, quit', async ({ page }) => {
    test.setTimeout(360_000);
    const errors = collectConsole(page);
    await page.addInitScript(padInit(1));
    await padToMain(page);
    await page.evaluate(() => (window as any).__dotkick.ctx.settings.update((s: any) => { s.match.halfMinutes = 2; }));
    await padKickOff(page);
    const setup = await page.evaluate(() => (window as any).__dotkick.ctx.session.getSetup());
    expect(setup.bindings).toHaveLength(1);
    expect(setup.bindings[0].deviceIds.some((d: string) => d.startsWith('pad:'))).toBe(true);
    await playUntil(page, 'in-play', 60_000);

    // Left stick + R2 (sprint) reach the human's frames.
    await padStick(page, 0, 0.9, 0);
    await padButton(page, 0, PAD.R2, true);
    const held = await watchFrames(page, 15);
    expect(held.mag).toBeGreaterThan(0.5);
    expect(held.buttons).not.toBe(0);
    await padStick(page, 0, 0, 0);
    await padButton(page, 0, PAD.R2, false);
    await shot(page, 'pad-play');

    // Options pauses as human 0 and releases everything; Options again (after the debounce) resumes.
    await padStick(page, 0, 0, -0.9);
    await frames(page, 4);
    await padTap(page, 0, PAD.OPTIONS);
    await expect.poll(() => paused(page)).toBe(true);
    expect(await pausedBy(page)).toBe(0);
    await expect(page.getByTestId('pause-resume')).toBeVisible();
    await padStick(page, 0, 0, 0);
    await page.waitForTimeout(400);
    await padTap(page, 0, PAD.OPTIONS);
    await expect.poll(() => paused(page)).toBe(false);
    const after = await watchFrames(page, 6);
    expect(after.mag).toBe(0); // the stick held across the pause never sticks

    await fastForward(page);
    await playUntil(page, 'half-time', 90_000);
    await shot(page, 'pad-half-time');
    await padActivate(page, 0, 'ht-continue');
    await waitRoute(page, 'match');
    await playUntil(page, 'full-time', 120_000);
    if (!(await page.evaluate(() => (window as any).__dotkick.ctx.session.finished))) await padActivate(page, 0, 'ft-continue');
    await page.waitForFunction(() => (window as any).__dotkick.ctx.session.finished === true, null, { timeout: 60_000 });
    await stopFastForward(page);
    await expect(page.getByTestId('ft-quit')).toBeVisible();
    await shot(page, 'pad-full-time');
    await padActivate(page, 0, 'ft-quit');
    await waitRoute(page, 'main');
    expect(await page.evaluate(() => (window as any).__dotkick.ctx.session.active)).toBe(false);
    expect(errors).toEqual([]);
  });

  test('touch controls hide while the same human\'s pad drives and return on the next screen touch', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectConsole(page);
    await page.addInitScript(padInit(1));
    await padToMain(page);
    // Play now: human 0 on every device (touch and the pad drive the same side).
    await padActivate(page, 0, 'main-kickoff');
    await waitMatch(page);
    const ids = await page.evaluate(() => (window as any).__dotkick.app.session.runtime().provider.devicesOf(0));
    expect(ids).toContain('touch');
    expect(ids.some((d: string) => d.startsWith('pad:'))).toBe(true);
    await expect(page.locator('.dk-touch')).toBeVisible();
    expect(await page.locator('.dk-touch.is-pad-hidden').count()).toBe(0);
    await padStick(page, 0, 0.8, 0);
    await expect(page.locator('.dk-touch.is-pad-hidden')).toHaveCount(1);
    await padStick(page, 0, 0, 0);
    await shot(page, 'pad-drives-touch-hidden');
    const t = await Touch.open(page);
    await t.tap(600, 420);
    await expect(page.locator('.dk-touch.is-pad-hidden')).toHaveCount(0);
    await t.detach();
    expect(errors).toEqual([]);
  });

  test('PAD-03 in the app: unplug -> card -> reconnect resumes; hand to touch; hand to CPU', async ({ page }) => {
    test.setTimeout(300_000);
    const errors = collectConsole(page);
    await page.addInitScript(padInit(1));
    await padToMain(page);
    await padKickOff(page);
    await playUntil(page, 'in-play', 60_000);

    // 1) Unplug mid-match: auto-pause with the card, the clock stands still; back + any button resumes.
    await plugPad(page, 0, false);
    await expect(page.getByTestId('reconnect-card')).toBeVisible();
    expect(await paused(page)).toBe(true);
    expect(await pausedBy(page)).toBe(-2);
    await expect(page.getByTestId('reconnect-title')).toContainText(/disconnected/i);
    await shot(page, 'pad03-card');
    const tick = await page.evaluate(() => (window as any).__dotkick.ctx.session.getState().tick);
    await frames(page, 20);
    expect(await page.evaluate(() => (window as any).__dotkick.ctx.session.getState().tick)).toBe(tick);
    // Nobody else can lift the card's pause (pause-menu Resume / Options of a human are refused).
    expect(await page.evaluate(() => (window as any).__dotkick.ctx.session.resume(0))).toBe(false);
    await plugPad(page, 0, true);
    await expect(page.getByTestId('reconnect-title')).toContainText(/reconnected/i);
    await padTap(page, 0, PAD.CIRCLE);
    await expect(page.getByTestId('reconnect-card')).toBeHidden();
    await expect.poll(() => paused(page)).toBe(false);
    // The resume press never reached the game as a shot.
    expect((await watchFrames(page, 4)).buttons).toBe(0);

    // 2) Unplug again and hand the side to touch: the touch overlay now drives human 0, the pad source is gone.
    await plugPad(page, 0, false);
    await expect(page.getByTestId('reconnect-touch')).toBeVisible();
    const t = await Touch.open(page);
    await touchTestId(page, t, 'reconnect-touch');
    await expect(page.getByTestId('reconnect-card')).toBeHidden();
    await expect.poll(() => paused(page)).toBe(false);
    const b2 = await page.evaluate(() => (window as any).__dotkick.ctx.session.getSetup().bindings);
    expect(b2).toEqual([{ human: 0, deviceIds: ['touch'] }]);
    expect(await page.evaluate(() => (window as any).__dotkick.app.session.runtime().provider.devicesOf(0))).toEqual(['touch']);
    await expect(page.locator('.dk-touch')).toBeVisible();
    await t.down(1, 220, 600);
    for (let i = 1; i <= 6; i++) await t.move(1, 220 + i * 14, 600);
    expect((await watchFrames(page, 12)).mag).toBeGreaterThan(0.5);
    await t.up();
    // The old pad coming back no longer drives (and no card: it is not bound any more).
    await plugPad(page, 0, true);
    await padStick(page, 0, 0.9, 0);
    await frames(page, 6);
    expect(await page.getByTestId('reconnect-card').isVisible()).toBe(false);
    await padStick(page, 0, 0, 0);
    await shot(page, 'pad03-touch');

    // 3) A new match on the pad, unplug, hand to the CPU: the side keeps playing under the CPU brain.
    await page.evaluate(() => (window as any).__dotkick.ctx.session.quit());
    await waitRoute(page, 'main');
    await padKickOff(page);
    await playUntil(page, 'in-play', 60_000);
    await plugPad(page, 0, false);
    await expect(page.getByTestId('reconnect-cpu')).toBeVisible();
    await touchTestId(page, t, 'reconnect-cpu');
    await expect(page.getByTestId('reconnect-card')).toBeHidden();
    await expect.poll(() => paused(page)).toBe(false);
    await expect.poll(() => page.evaluate(() => (window as any).__dotkick.ctx.session.getState().ctrl[2].kind)).toBe(2);
    const s = await page.evaluate(() => {
      const st = (window as any).__dotkick.ctx.session.getState();
      return { human: st.ctrl[0].kind, cpuSide: st.ctrl[2].side, active: st.teams[0].cpu.active, tick: st.tick };
    });
    expect(s.human).toBe(0);
    expect(s.cpuSide).toBe(0);
    expect(s.active).toBe(1);
    await frames(page, 20);
    expect(await page.evaluate(() => (window as any).__dotkick.ctx.session.getState().tick)).toBeGreaterThan(s.tick);
    // A later reconnect of that pad never reopens the card (the side belongs to the CPU now).
    await plugPad(page, 0, true);
    await plugPad(page, 0, false);
    await frames(page, 6);
    expect(await page.getByTestId('reconnect-card').isVisible()).toBe(false);
    await t.detach();
    expect(errors).toEqual([]);
  });
});
