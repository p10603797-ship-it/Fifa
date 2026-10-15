/**
 * [QF-12] Settings can be opened from the pause menu (Controls > Settings), and from there Diagnostics and the
 * Tutorial. Run benchmark and Load replay used to end the paused match without a word (a new session over it), the
 * Tutorial's Start did nothing at all, and Reset all data under a paused cup tie was undone when the tie ended. Now
 * each says that a match is in progress and the paused match is untouched; back in the pause menu it resumes.
 *
 *   npx vite build --outDir dist-e2e/qf-12 --emptyOutDir && node tools/postbuild.mjs dist-e2e/qf-12
 *   PW_DIST=dist-e2e/qf-12 PW_PORT=4412 npx playwright test tests/e2e/qf-12-match-guard.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { collectConsole, frames, route, waitMatch, waitRoute } from './int-b-harness';

/* eslint-disable @typescript-eslint/no-explicit-any */

const sessionState = (page: Page): Promise<{ active: boolean; paused: boolean; seed: number | null }> => page.evaluate(() => {
  const s = (window as any).__dotkick.ctx.session;
  return { active: s.active, paused: s.paused, seed: s.getSetup()?.config.seed ?? null };
});

async function tapId(page: Page, id: string): Promise<void> {
  const el = page.getByTestId(id).first();
  await expect(el).toBeVisible();
  await el.tap();
  await frames(page, 2);
}

test('pause menu > settings: tutorial start, data reset, benchmark and replay load refuse while a match is in progress; the match stays and resumes', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = collectConsole(page);
  await page.goto('/');
  await expect(page.getByTestId('splash-start')).toBeVisible();
  await page.touchscreen.tap(40, 410);
  await waitRoute(page, 'main');
  await tapId(page, 'main-kickoff');
  await waitMatch(page);
  const box = await page.locator('#touch .dk-tbtn--pause').boundingBox();
  await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect.poll(async () => (await sessionState(page)).paused).toBe(true);
  const before = await sessionState(page);

  // Pause menu > Controls > Settings > Tutorial > Start.
  await tapId(page, 'pause-controls');
  await tapId(page, 'pause-open-settings');
  await waitRoute(page, 'settings');
  await tapId(page, 'settings-tutorial');
  await waitRoute(page, 'tutorial');
  await tapId(page, 'tut-start');
  await expect(page.getByTestId('match-in-progress')).toBeVisible();
  expect(await route(page)).toBe('tutorial');
  expect(await sessionState(page)).toEqual(before);

  // Settings > Data: Reset all data (a reset under a paused cup tie was undone when the tie ended).
  await tapId(page, 'back');
  await waitRoute(page, 'settings');
  await tapId(page, 'settings-tab-data');
  await tapId(page, 'settings-reset');
  await expect(page.getByTestId('settings-reset-dialog')).toHaveCount(0);
  await expect(page.getByTestId('match-in-progress').first()).toBeVisible();
  // Settings > Diagnostics: Run benchmark and Load replay.
  await tapId(page, 'settings-tab-diagnostics');
  await tapId(page, 'settings-diagnostics');
  await waitRoute(page, 'diagnostics');
  await tapId(page, 'diagnostics-bench');
  await expect(page.getByTestId('match-in-progress').first()).toBeVisible();
  await frames(page, 10);
  expect(await route(page)).toBe('diagnostics');
  expect(await sessionState(page)).toEqual(before);
  const chooser = page.waitForEvent('filechooser', { timeout: 1500 }).then(() => true, () => false);
  await tapId(page, 'diagnostics-replay-load');
  expect(await chooser).toBe(false); // no file picker over a match in progress
  expect(await sessionState(page)).toEqual(before);

  // Back to the match: the pause menu is still there and resumes the same match.
  for (let i = 0; i < 6 && (await route(page)) !== 'match'; i++) await tapId(page, 'back');
  await waitRoute(page, 'match');
  // The pause menu comes back on the Controls page it was left from.
  await expect(page.getByTestId('pause-page-controls')).toBeVisible();
  await tapId(page, 'pause-back');
  await tapId(page, 'pause-resume');
  await expect.poll(async () => (await sessionState(page)).paused).toBe(false);
  expect((await sessionState(page)).seed).toBe(before.seed);
  expect(errors).toEqual([]);
});
