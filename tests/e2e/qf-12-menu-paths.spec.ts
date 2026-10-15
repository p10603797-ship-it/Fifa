/**
 * [QF-12] Every menu path by controller alone and by touch alone, with zero console errors or warnings (BRIEF §14
 * item 7, §12 UI rules). The specs before this one open every main-menu entry and come Back (uix-02, qf-3), run a
 * Kick-Off by pad and by touch to full time (int-b), walk settings / remap / editor (uix-09, pad-07, tch-08); this one
 * goes deep where they stop:
 *  - cup: new cup -> draw -> Play match -> pause -> every pause page (team, tactics, camera, sound, controls) and back
 *    -> Quit (confirm) -> the cup again with the tie still to play;
 *  - practice: free play -> pause -> Restart -> pause -> Quit -> the practice screen; the tutorial screen and back;
 *  - shoot-out: the whole flow (mode setup, teams, sides, settings) into the shoot-out, Quit;
 *  - diagnostics: input tester open / close, credits and licences, Back;
 *  - full time: Play now -> half-time Continue -> full time -> Change teams -> team select -> Back to main.
 *
 *   npx vite build --outDir dist-e2e/qf-12 --emptyOutDir && node tools/postbuild.mjs dist-e2e/qf-12
 *   PW_DIST=dist-e2e/qf-12 PW_PORT=4412 npx playwright test tests/e2e/qf-12-menu-paths.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import {
  collectConsole, fastForward, frames, PAD, padActivate, padButton, padInit, padTap, route, stopFastForward, waitMatch, waitRoute,
} from './int-b-harness';

/* eslint-disable @typescript-eslint/no-explicit-any */

const paused = (page: Page): Promise<boolean> => page.evaluate(() => (window as any).__dotkick.ctx.session.paused);
const pausePage = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.querySelector<HTMLElement>('[data-testid^="pause-page-"]')?.dataset.testid ?? null);

async function padToMain(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('splash-start')).toBeVisible();
  for (let i = 0; i < 6 && (await route(page)) !== 'main'; i++) await padTap(page, 0, PAD.CROSS);
  await waitRoute(page, 'main', 15_000);
}

async function touchToMain(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('splash-start')).toBeVisible();
  await page.touchscreen.tap(40, 410);
  await waitRoute(page, 'main', 15_000);
}

async function tapId(page: Page, id: string): Promise<void> {
  const el = page.getByTestId(id).first();
  await expect(el).toBeVisible();
  await el.tap();
  await frames(page, 2);
}

/** Every pause sub-page opens and Back returns to the main pause page. */
async function pausePagesByPad(page: Page): Promise<void> {
  for (const [tile, want] of [['pause-team', 'pause-page-team'], ['pause-tactics', 'pause-page-tactics'], ['pause-camera', 'pause-page-camera'],
    ['pause-sound', 'pause-page-sound'], ['pause-controls', 'pause-page-controls']] as const) {
    await padActivate(page, 0, tile, 20);
    await expect.poll(() => pausePage(page)).toBe(want);
    await padTap(page, 0, PAD.CIRCLE);
    await expect.poll(() => pausePage(page)).toBe('pause-page-main');
    expect(await paused(page)).toBe(true);
  }
}

async function pausePagesByTouch(page: Page): Promise<void> {
  for (const [tile, want] of [['pause-team', 'pause-page-team'], ['pause-tactics', 'pause-page-tactics'], ['pause-camera', 'pause-page-camera'],
    ['pause-sound', 'pause-page-sound'], ['pause-controls', 'pause-page-controls']] as const) {
    await tapId(page, tile);
    await expect.poll(() => pausePage(page)).toBe(want);
    await tapId(page, 'pause-back');
    await expect.poll(() => pausePage(page)).toBe('pause-page-main');
    expect(await paused(page)).toBe(true);
  }
}

/** A finger on the touch PAUSE button (the touch layer owns the pointer events, so tap by position). */
async function touchPause(page: Page): Promise<void> {
  const b = await page.locator('#touch .dk-tbtn--pause').boundingBox();
  expect(b).not.toBeNull();
  await page.touchscreen.tap(b!.x + b!.width / 2, b!.y + b!.height / 2);
  await frames(page, 2);
}

async function padQuitMatch(page: Page): Promise<void> {
  await padActivate(page, 0, 'pause-quit', 20);
  await padActivate(page, 0, 'pause-quit-confirm', 6);
}

test.describe('QF-12 menu paths', () => {
  test('controller alone: cup tie and every pause page, practice restart and quit, tutorial, shoot-out flow, diagnostics', async ({ page }) => {
    test.setTimeout(420_000);
    const errors = collectConsole(page);
    await page.addInitScript(padInit(1));
    await padToMain(page);

    // Cup: draw, play the tie, every pause page, quit back to the cup (the tie is still to play).
    await padActivate(page, 0, 'main-cup', 20);
    await waitRoute(page, 'cup');
    await padActivate(page, 0, 'cup-draw', 30);
    await expect(page.getByTestId('cup-bracket')).toBeVisible();
    await padActivate(page, 0, 'cup-play', 30);
    await waitMatch(page);
    await padTap(page, 0, PAD.OPTIONS);
    await expect.poll(() => paused(page)).toBe(true);
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    await pausePagesByPad(page);
    await padQuitMatch(page);
    await waitRoute(page, 'cup');
    await expect(page.getByTestId('cup-play')).toBeVisible();
    expect(await page.evaluate(() => (window as any).__dotkick.ctx.session.active)).toBe(false);
    await padTap(page, 0, PAD.CIRCLE);
    await waitRoute(page, 'main');

    // Practice: free play, Restart from the pause menu, Quit back to the practice screen; the tutorial and back.
    await padActivate(page, 0, 'main-practice', 20);
    await waitRoute(page, 'practice');
    await padActivate(page, 0, 'practice-free-play', 20);
    await padActivate(page, 0, 'practice-start', 20);
    await waitMatch(page);
    await padTap(page, 0, PAD.OPTIONS);
    await expect.poll(() => paused(page)).toBe(true);
    await padActivate(page, 0, 'pause-restart', 20);
    await waitMatch(page);
    await expect.poll(() => page.evaluate(() => (window as any).__dotkick.ctx.session.loaded)).toBe(true);
    await padTap(page, 0, PAD.OPTIONS);
    await expect.poll(() => paused(page)).toBe(true);
    await padQuitMatch(page);
    await waitRoute(page, 'practice');
    await padActivate(page, 0, 'practice-tutorial', 20);
    await padActivate(page, 0, 'practice-start', 20);
    await waitRoute(page, 'tutorial');
    await padTap(page, 0, PAD.CIRCLE);
    await waitRoute(page, 'practice');
    await padTap(page, 0, PAD.CIRCLE);
    await waitRoute(page, 'main');

    // Shoot-out: the whole flow by pad into the shoot-out, then quit.
    await padActivate(page, 0, 'main-shootout', 20);
    await waitRoute(page, 'mode-setup');
    await padActivate(page, 0, 'mode-continue', 20);
    await waitRoute(page, 'team-select');
    await padActivate(page, 0, 'team-continue', 30);
    await waitRoute(page, 'side-select');
    await padActivate(page, 0, 'side-continue', 20);
    await waitRoute(page, 'match-settings');
    await expect(page.getByTestId('settings-start')).toHaveText('Start shoot-out');
    await padActivate(page, 0, 'settings-start', 20);
    await waitMatch(page);
    expect(await page.evaluate(() => (window as any).__dotkick.ctx.session.getState().config.mode)).toBe(4);
    await padTap(page, 0, PAD.OPTIONS);
    await expect.poll(() => paused(page)).toBe(true);
    await padQuitMatch(page);
    await waitRoute(page, 'main');

    // Diagnostics: input tester and credits by pad, Back out.
    await padActivate(page, 0, 'main-diagnostics', 20);
    await waitRoute(page, 'diagnostics');
    await padActivate(page, 0, 'diagnostics-input', 30);
    await expect(page.getByTestId('diagnostics-tester-close')).toBeVisible();
    // Pad buttons are shown in the tester, never navigate it: a pad closes it by holding Circle (1 s).
    await padButton(page, 0, PAD.CIRCLE, true);
    await page.waitForTimeout(1400);
    await padButton(page, 0, PAD.CIRCLE, false);
    await expect(page.getByTestId('diagnostics-tester-close')).toBeHidden();
    await padActivate(page, 0, 'diagnostics-credits', 30);
    await frames(page, 4);
    await padTap(page, 0, PAD.CIRCLE);
    await frames(page, 4);
    if ((await route(page)) === 'diagnostics') await padTap(page, 0, PAD.CIRCLE);
    await waitRoute(page, 'main');
    expect(errors).toEqual([]);
  });

  test('touch alone: cup tie and every pause page, practice restart and quit, tutorial, shoot-out flow, diagnostics', async ({ page }) => {
    test.setTimeout(420_000);
    const errors = collectConsole(page);
    await touchToMain(page);

    await tapId(page, 'main-cup');
    await waitRoute(page, 'cup');
    await tapId(page, 'cup-draw');
    await expect(page.getByTestId('cup-bracket')).toBeVisible();
    await tapId(page, 'cup-play');
    await waitMatch(page);
    await touchPause(page);
    await expect.poll(() => paused(page)).toBe(true);
    await pausePagesByTouch(page);
    await tapId(page, 'pause-quit');
    await tapId(page, 'pause-quit-confirm');
    await waitRoute(page, 'cup');
    await expect(page.getByTestId('cup-play')).toBeVisible();
    await tapId(page, 'back');
    await waitRoute(page, 'main');

    await tapId(page, 'main-practice');
    await waitRoute(page, 'practice');
    await tapId(page, 'practice-free-play');
    await tapId(page, 'practice-start');
    await waitMatch(page);
    await touchPause(page);
    await expect.poll(() => paused(page)).toBe(true);
    await tapId(page, 'pause-restart');
    await waitMatch(page);
    await expect.poll(() => page.evaluate(() => (window as any).__dotkick.ctx.session.loaded)).toBe(true);
    await touchPause(page);
    await expect.poll(() => paused(page)).toBe(true);
    await tapId(page, 'pause-quit');
    await tapId(page, 'pause-quit-confirm');
    await waitRoute(page, 'practice');
    await tapId(page, 'practice-tutorial');
    await tapId(page, 'practice-start');
    await waitRoute(page, 'tutorial');
    await tapId(page, 'back');
    await waitRoute(page, 'practice');
    await tapId(page, 'back');
    await waitRoute(page, 'main');

    await tapId(page, 'main-shootout');
    await waitRoute(page, 'mode-setup');
    await tapId(page, 'mode-continue');
    await waitRoute(page, 'team-select');
    await tapId(page, 'team-continue');
    await waitRoute(page, 'side-select');
    await tapId(page, 'side-continue');
    await waitRoute(page, 'match-settings');
    await tapId(page, 'settings-start');
    await waitMatch(page);
    await touchPause(page);
    await expect.poll(() => paused(page)).toBe(true);
    await tapId(page, 'pause-quit');
    await tapId(page, 'pause-quit-confirm');
    await waitRoute(page, 'main');

    await tapId(page, 'main-diagnostics');
    await waitRoute(page, 'diagnostics');
    await tapId(page, 'diagnostics-input');
    await tapId(page, 'diagnostics-tester-close');
    await tapId(page, 'diagnostics-credits');
    await frames(page, 4);
    const close = page.getByRole('dialog').getByRole('button').first();
    if (await close.isVisible()) await close.tap();
    await frames(page, 4);
    await tapId(page, 'back');
    await waitRoute(page, 'main');
    expect(errors).toEqual([]);
  });

  test('controller alone: Play now to full time (half-time Continue), Change teams opens team select, Back to main', async ({ page }) => {
    test.setTimeout(300_000);
    const errors = collectConsole(page);
    await page.addInitScript(padInit(1));
    await padToMain(page);
    await padActivate(page, 0, 'main-kickoff', 20);
    await waitMatch(page);
    await fastForward(page, 120);
    const end = Date.now() + 200_000;
    while ((await route(page)) !== 'full-time' || !(await page.getByTestId('ft-change-teams').isVisible())) {
      if (Date.now() > end) throw new Error('no final full-time screen');
      const r = await route(page);
      const k = await page.evaluate(() => {
        const st = (window as any).__dotkick.ctx.session.getState();
        return st ? { phase: st.match.phase, phaseT: st.match.phaseT, team: st.match.restart.team } : null;
      });
      if (r === 'half-time' || (r === 'full-time' && (await page.getByTestId('ft-continue').isVisible()))) await padTap(page, 0, PAD.CROSS);
      else if (k && k.phase === 1 && k.team === 0 && k.phaseT > 90) await padTap(page, 0, PAD.CROSS); // take the kick-off
      await frames(page, 10);
    }
    await stopFastForward(page);
    await padActivate(page, 0, 'ft-change-teams', 10);
    await waitRoute(page, 'team-select');
    expect(await page.evaluate(() => (window as any).__dotkick.ctx.session.active)).toBe(false);
    for (let i = 0; i < 4 && (await route(page)) !== 'main'; i++) {
      await padTap(page, 0, PAD.CIRCLE);
      await frames(page, 4);
    }
    await waitRoute(page, 'main');
    expect(errors).toEqual([]);
  });
});
