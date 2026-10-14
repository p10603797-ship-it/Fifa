/**
 * [PLT-05] Recovery screen, diagnostics screen (input tester, replay save / load) and the debug overlay, end to end.
 * Build first:  npx vite build --outDir dist-e2e/plt --emptyOutDir && node tools/postbuild.mjs dist-e2e/plt
 * Run:          PW_DIST=dist-e2e/plt PW_PORT=4205 npx playwright test tests/e2e/plt-05-recovery.spec.ts
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

async function bootToMain(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('splash-start').tap();
  await expect(page.getByTestId('main-kickoff')).toBeVisible();
}

async function kickOff(page: Page, minTick = 20): Promise<void> {
  await page.getByTestId('main-kickoff').tap();
  await page.waitForFunction((t) => {
    const d = window.__dotkick;
    return !!d && d.ctx.router.current === 'match' && (d.ctx.session.getState()?.tick ?? 0) > t;
  }, minTick, { timeout: 60_000 });
}

const tick = (page: Page): Promise<number> => page.evaluate(() => window.__dotkick!.ctx.session.getState()?.tick ?? -1);

test.describe('PLT-05 recovery, diagnostics and debug overlay', () => {
  test('a thrown error during a match pauses to the recovery screen; Resume and Restart work', async ({ page }) => {
    await bootToMain(page);
    await kickOff(page);
    await page.evaluate(() => { setTimeout(() => { throw new Error('plt05 boom'); }, 0); });
    await expect(page.getByTestId('recovery-title')).toBeVisible();
    await expect(page.getByTestId('recovery-message')).toContainText('plt05 boom');
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.paused)).toBe(true);
    const frozen = await tick(page);
    await page.waitForTimeout(300);
    expect(await tick(page)).toBe(frozen);

    await page.getByTestId('recovery-resume').tap();
    await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'match' && !window.__dotkick!.ctx.session.paused);
    await page.waitForFunction((t) => (window.__dotkick!.ctx.session.getState()?.tick ?? 0) > t + 10, frozen);

    // A rejected promise also lands on recovery; Restart starts a fresh match.
    await page.evaluate(() => { void Promise.reject(new Error('plt05 rejection')); });
    await expect(page.getByTestId('recovery-message')).toContainText('plt05 rejection');
    const before = await tick(page);
    await page.getByTestId('recovery-restart').tap();
    await page.waitForFunction((b) => {
      const d = window.__dotkick!;
      const s = d.ctx.session.getState();
      return d.ctx.router.current === 'match' && s !== null && s.tick < b && !d.ctx.session.paused;
    }, before, { timeout: 60_000 });
    expect(await page.evaluate(() => window.__dotkick!.ctx.diagnostics.report())).toContain('plt05 boom');
  });

  test('debug overlay toggles with the backquote key and shows live numbers', async ({ page }) => {
    await bootToMain(page);
    await kickOff(page);
    const overlay = page.getByTestId('debug-overlay');
    await expect(overlay).toBeHidden();
    await page.keyboard.press('Backquote');
    await expect(overlay).toBeVisible();
    await expect(page.getByTestId('debug-text')).toContainText(/fps \d+/);
    await expect(page.getByTestId('debug-text')).toContainText(/sim \d+\.\d+ ms/);
    await expect(page.getByTestId('debug-text')).toContainText(/draw \d+ {2}tris \d+/);
    await expect(page.getByTestId('debug-text')).toContainText(/tick \d+ {2}phase [A-Z_]+ .* hash [0-9a-f]{8} @\d+/);
    expect(await page.evaluate(() => window.__dotkick!.ctx.settings.get().debug)).toBe(true);
    await page.keyboard.press('Backquote');
    await expect(overlay).toBeHidden();
  });

  test('input tester shows a mocked pad and touch points', async ({ page }) => {
    await bootToMain(page);
    await page.getByTestId('main-diagnostics').tap();
    await expect(page.getByTestId('diagnostics-title')).toBeVisible();
    await expect(page.getByTestId('diagnostics-version')).toContainText(/DotKick \d+\.\d+\.\d+ · sim \d+/);
    await page.getByTestId('diagnostics-input').tap();
    await expect(page.getByTestId('diagnostics-no-pads')).toBeVisible();
    // A pad appears while the tester is open, then a button goes down: shown, never navigates.
    await page.evaluate(() => {
      const pad = {
        index: 0, id: 'PLT05 Mock Pad (STANDARD GAMEPAD)', connected: true, mapping: 'standard', timestamp: 1,
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
        axes: [0.5, -1, 0, 0],
      };
      Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [pad, null, null, null] });
      setTimeout(() => { pad.buttons[3] = { pressed: true, touched: true, value: 1 }; pad.timestamp = 2; }, 300);
    });
    const pad = page.locator('[data-pad="0"]');
    await expect(pad).toContainText('PLT05 Mock Pad');
    await expect(pad.locator('[data-button="3"]')).toHaveAttribute('data-pressed', '');
    await expect(pad.locator('[data-button="0"]')).not.toHaveAttribute('data-pressed', '');
    await expect(pad.locator('[data-axis="0"]')).toContainText('0.50');
    await expect(pad.locator('[data-axis="1"]')).toContainText('-1.00');
    // A pad press only shows in the tester: the menu stays put.
    expect(await page.evaluate(() => window.__dotkick!.ctx.router.current)).toBe('diagnostics');
    const area = page.getByTestId('diagnostics-touch-area');
    const box = (await area.boundingBox())!;
    await area.dispatchEvent('pointerdown', { pointerId: 7, clientX: box.x + 50, clientY: box.y + 40, pointerType: 'touch', isPrimary: true });
    await expect(area.locator('[data-pointer="7"]')).toBeVisible();
    await area.dispatchEvent('pointerup', { pointerId: 7, clientX: box.x + 50, clientY: box.y + 40, pointerType: 'touch' });
    await expect(area.locator('[data-pointer="7"]')).toHaveCount(0);
    await page.keyboard.down('KeyW');
    await expect(page.getByTestId('diagnostics-keys')).toContainText('KeyW');
    await page.keyboard.up('KeyW');
    await page.getByTestId('diagnostics-tester-close').tap();
    await expect(page.getByTestId('diagnostics-tester')).toBeHidden();
    await expect(page.getByTestId('diagnostics-report')).toBeVisible();
  });

  test('replay save and load round trip: the saved match plays back to the same hash', async ({ page }) => {
    await bootToMain(page);
    await kickOff(page, 150);
    await page.evaluate(() => window.__dotkick!.ctx.session.quit());
    await expect(page.getByTestId('main-diagnostics')).toBeVisible();
    await page.getByTestId('main-diagnostics').tap();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('diagnostics-replay-save').tap()]);
    expect(download.suggestedFilename()).toMatch(/^dotkick-replay-\d+-\d+t-.+\.json$/);
    const file = await download.path();
    const replay = JSON.parse(readFileSync(file, 'utf8')) as { ticks: number; seed: number; frames: number[]; finalHash: number };
    expect(replay.ticks).toBeGreaterThan(150);
    await expect(page.getByTestId('diagnostics-status')).toContainText(`(${replay.ticks} ticks)`);

    await page.getByTestId('diagnostics-replay-file').setInputFiles(file);
    await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'match', null, { timeout: 60_000 });
    await expect(page.getByTestId('replay-verdict')).toContainText(`replay matched: ${replay.ticks} ticks`, { timeout: 90_000 });
    const log = await page.evaluate(() => window.__dotkick!.ctx.diagnostics.recent().join('\n'));
    expect(log).toContain('replay matched');
  });
});
