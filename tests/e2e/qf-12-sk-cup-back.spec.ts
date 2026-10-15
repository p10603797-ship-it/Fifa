/**
 * [QF-12 skeptic] Controller alone: a finished cup tie's final full-time screen (stats, player of the match) answers
 * Back (Circle) like its Continue: back to the cup with the tie's result card, not to the main menu (BRIEF §12 "Back
 * always works"; the cup is where the player came from). Zero console errors or warnings.
 *
 *   npx vite build --outDir dist-e2e/qf-12 --emptyOutDir
 *   PW_DIST=dist-e2e/qf-12 PW_PORT=4412 npx playwright test tests/e2e/qf-12-sk-cup-back.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { collectConsole, PAD, padActivate, padInit, padTap, route, waitMatch, waitRoute } from './int-b-harness';

/* eslint-disable @typescript-eslint/no-explicit-any */

async function padToMain(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByTestId('splash-start')).toBeVisible();
  for (let i = 0; i < 6 && (await route(page)) !== 'main'; i++) await padTap(page, 0, PAD.CROSS);
  await waitRoute(page, 'main', 15_000);
}

test('controller alone: Back on a finished cup tie\'s final screen returns to the cup with the result card', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectConsole(page);
  await page.addInitScript(padInit(1));
  await padToMain(page);
  await padActivate(page, 0, 'main-cup', 20);
  await waitRoute(page, 'cup');
  await padActivate(page, 0, 'cup-draw', 30);
  await expect(page.getByTestId('cup-bracket')).toBeVisible();
  await padActivate(page, 0, 'cup-play', 30);
  await waitMatch(page);
  // The tie ends (forced: a human 2-0 win at POST_MATCH, as uix-11 does).
  await page.evaluate(() => {
    const ctx = (window as any).__dotkick.ctx;
    const side = ctx.session.getSetup().config.humans[0].side;
    const s = ctx.session.getState();
    s.teams[side].goals = 2;
    s.match.winner = side;
    s.match.finished = 1;
    s.match.phase = 15; // POST_MATCH
  });
  await waitRoute(page, 'full-time', 30_000);
  await expect(page.getByTestId('full-time-panel')).toBeVisible();
  await expect(page.getByTestId('ft-cup')).toBeVisible();
  await padTap(page, 0, PAD.CIRCLE);
  await waitRoute(page, 'cup', 30_000);
  await expect(page.getByTestId('cup-result')).toContainText('Through');
  expect(await page.evaluate(() => (window as any).__dotkick.ctx.router.stack)).toEqual(['main', 'cup']);
  expect(await page.evaluate(() => (window as any).__dotkick.ctx.session.active)).toBe(false);
  // Back from the cup reaches the main menu.
  await padTap(page, 0, PAD.CIRCLE);
  await waitRoute(page, 'main');
  expect(errors).toEqual([]);
});
