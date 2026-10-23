/**
 * [QF-17 skeptic] FIX-10 second pass, in the real app with keyboard play (no touch device bound, so the match screen
 * shows its own pause button):
 *  - D-S1: pause -> settings -> Back in the first half keeps the half-time screen built on the loading screen (out of
 *    the DOM while settings shows, the same element back over the match screen afterwards), and half time reveals it;
 *  - D-S2: under the half-time overlay the match screen's own pause button is hidden (it showed through the scrim) and
 *    the match container is aria-hidden; the second half brings both back.
 *
 *   npx vite build --outDir dist-e2e/qf-17 --emptyOutDir
 *   PW_DIST=dist-e2e/qf-17 PW_PORT=4419 npx playwright test tests/e2e/qf-17-skeptic-halftime.spec.ts
 */
import { expect, test } from '@playwright/test';
import { bootToMain, collectConsole } from './uix-08-harness';

/* eslint-disable @typescript-eslint/no-explicit-any */

test('QF-17 skeptic: settings visit keeps the half-time screen built ahead; the covered match screen hides its pause button', async ({ page }) => {
  test.setTimeout(180_000);
  const messages = collectConsole(page);
  await bootToMain(page);
  await page.evaluate(() => {
    const human = (side: number) => ({ kind: 1, side, assist: 0, autoSwitch: 1, fastPower: 0 });
    const none = { kind: 0, side: -1, assist: 0, autoSwitch: 1, fastPower: 0 };
    const config = {
      seed: 1777, mode: 0, homeClub: 0, awayClub: 1, homeKit: 0, awayKit: 1, homeFormation: 0, awayFormation: 0,
      halfMinutes: 2, cupRules: 0, night: 0, offside: 1, fouls: 1, difficulty: 3,
      humans: [human(0), none], practice: 0, startPhase: 1, replaySeconds: 0,
    };
    window.__dotkick!.ctx.session.start({ config, bindings: [{ human: 0, deviceIds: ['keyboard'] }] } as any);
  });
  await page.waitForFunction(() => {
    const d = window.__dotkick;
    return !!d && d.ctx.router.current === 'match' && d.ctx.session.getState() !== null;
  }, null, { timeout: 45_000 });
  await expect(page.getByTestId('match-pause')).toBeVisible();
  await page.evaluate(() => {
    const h = document.querySelector<HTMLElement>('#ui > .screen[data-screen="half-time"]')!;
    h.dataset.qf17s = 'prepared';
  });

  // Pause -> settings (what the pause menu's Control settings button does) -> Back.
  await page.evaluate(() => window.__dotkick!.ctx.session.pause(0));
  await expect(page.getByTestId('pause-menu')).toBeVisible();
  await page.evaluate(() => window.__dotkick!.ctx.router.go('settings', { tab: 'controls' }));
  await expect(page.getByTestId('settings-title')).toBeVisible();
  const inSettings = await page.evaluate(() => ({
    screens: [...document.querySelectorAll<HTMLElement>('#ui > .screen')].map((e) => e.dataset.screen),
    prepared: (window.__dotkick!.ctx.router as any).prepared,
    htIds: document.querySelectorAll('[data-testid="ht-continue"]').length,
  }));
  expect(inSettings).toEqual({ screens: ['settings'], prepared: 'half-time', htIds: 0 });
  await page.getByTestId('back').first().click();
  await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'match');
  const back = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('#ui > .screen')]
    .map((e) => `${e.dataset.screen}:${e.dataset.qf17s ?? 'new'}:${e.hasAttribute('data-prepared') ? 'hidden' : 'shown'}`));
  expect(back).toEqual(['match:new:shown', 'half-time:prepared:hidden']);
  await page.evaluate(() => window.__dotkick!.ctx.session.resume(0));
  await expect(page.getByTestId('pause-menu')).toBeHidden();

  // Fast-forward to half time and hold the break.
  await page.evaluate(() => {
    const w = window as any;
    w.__qf17shold = true;
    w.__qf17stimer = setInterval(() => {
      const rt = w.__dotkick?.ctx.session.runtime?.();
      if (!rt) return;
      const m = rt.curr.match;
      if (m.period === 1 && m.clockRunning && m.periodT < m.periodLen - 30) {
        m.periodT = m.periodLen - 30;
        m.addedT = 0;
      }
      if (m.phase === 11 && w.__qf17shold) m.phaseT = 1;
      const r = m.restart;
      if (m.phase >= 1 && m.phase <= 7 && r.ready === 1 && r.timeoutT > 5) r.timeoutT = 5;
    }, 50);
  });
  await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'half-time', null, { timeout: 90_000 });
  await expect(page.getByTestId('ht-continue')).toBeVisible();
  const during = await page.evaluate(() => {
    const m = document.querySelector<HTMLElement>('#ui > .screen[data-screen="match"]')!;
    const h = document.querySelector<HTMLElement>('#ui > .screen[data-screen="half-time"]')!;
    const btn = m.querySelector<HTMLElement>('[data-testid="match-pause"]')!;
    return {
      reused: h.dataset.qf17s ?? 'new',
      pauseBtn: getComputedStyle(btn).visibility,
      matchAria: m.getAttribute('aria-hidden'),
      htAria: h.getAttribute('aria-hidden'),
    };
  });
  expect(during).toEqual({ reused: 'prepared', pauseBtn: 'hidden', matchAria: 'true', htAria: null });
  await expect(page.getByTestId('match-pause')).toBeHidden();

  // Second half: the pause button and the match container are back.
  await page.evaluate(() => { (window as any).__qf17shold = false; });
  await page.getByTestId('ht-continue').click();
  await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'match', null, { timeout: 15_000 });
  await expect(page.getByTestId('match-pause')).toBeVisible();
  const after = await page.evaluate(() => {
    const m = document.querySelector<HTMLElement>('#ui > .screen[data-screen="match"]')!;
    return { aria: m.getAttribute('aria-hidden'), screens: document.querySelectorAll('#ui > .screen').length };
  });
  expect(after).toEqual({ aria: null, screens: 1 });
  await page.evaluate(() => clearInterval((window as any).__qf17stimer));
  expect(messages.filter((m) => !/WebGL|GPU|swiftshader|GroupMarkerNotSet/i.test(m))).toEqual([]);
});
