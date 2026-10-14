/**
 * UIX-09 e2e: settings screen through the real app (settings store with localStorage, router, FocusNavigator).
 *  - touch only: every control on every tab changes the stored setting; the settings survive a reload; Data reset
 *    (with confirmation) restores the defaults and clears progress;
 *  - controller only (keyboard): L1 / R1 (Q / E) switch tabs, Up / Down move, Left / Right change values, the reset
 *    dialog works and Back leaves;
 *  - layout: every control >= 60 pt and on screen at 1180x820, 4:3 and 21:9; screenshots in tmp/uix-08/.
 *
 *   npx vite build --outDir dist-e2e/uix-08 --emptyOutDir
 *   PW_DIST=dist-e2e/uix-08 PW_PORT=4208 npx playwright test tests/e2e/uix-09-settings.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { bootToMain, checkTargets, collectConsole, focused, shot } from './uix-08-harness';

/* eslint-disable @typescript-eslint/no-explicit-any */

const settings = (page: Page): Promise<any> => page.evaluate(() => JSON.parse(JSON.stringify(window.__dotkick!.ctx.settings.get())));

async function tapTab(page: Page, id: string): Promise<void> {
  await page.getByTestId(`settings-tab-${id}`).tap();
  await expect(page.getByTestId('settings-body')).toHaveAttribute('data-tab', id);
}

/** Tap a slider's track at fraction f (0 = left end, 1 = right end). */
async function tapSlider(page: Page, testId: string, f: number): Promise<void> {
  const box = await page.locator(`[data-testid="${testId}"] .sld__track`).boundingBox();
  if (!box) throw new Error(`no slider ${testId}`);
  await page.touchscreen.tap(box.x + box.width * f, box.y + box.height / 2);
}

const next = (page: Page, testId: string) => page.locator(`[data-testid="${testId}"] [data-adjust="inc"]`).tap();

test.describe('UIX-09 settings', () => {
  test('touch: every control changes the stored setting, persists across reload, and reset restores defaults', async ({ page }) => {
    const messages = collectConsole(page);
    await bootToMain(page);
    await page.getByTestId('main-settings').tap();
    await expect(page.getByTestId('settings-title')).toBeVisible();
    const d = await settings(page);
    expect(d.controls.assist).toBe(0);

    // ---- Controls
    await tapTab(page, 'controls');
    await page.getByTestId('set-assist-2').tap();
    await next(page, 'set-autoswitch');
    await tapSlider(page, 'set-touch-opacity', 0);
    for (const id of ['set-touch-floating', 'set-touch-mirror', 'set-touch-gestures', 'set-touch-gestures-only', 'set-touch-fastpower', 'set-pad-rumble']) {
      await page.getByTestId(id).tap();
    }
    await next(page, 'set-skill-tap');
    await next(page, 'set-skill-up');
    await next(page, 'set-skill-right');
    await next(page, 'set-pad-family');
    await shot(page, 'uix09-controls-1180');
    expect(await checkTargets(page, '.screen--settings')).toEqual([]);
    let s = await settings(page);
    expect(s.controls.assist).toBe(2);
    expect(s.controls.autoSwitch).not.toBe(d.controls.autoSwitch);
    expect(s.controls.touch.opacity).toBeCloseTo(0.2, 5);
    expect(s.controls.touch.floatingStick).toBe(!d.controls.touch.floatingStick);
    expect(s.controls.touch.mirror).toBe(!d.controls.touch.mirror);
    expect(s.controls.touch.gestures).toBe(!d.controls.touch.gestures);
    expect(s.controls.touch.gesturesOnly).toBe(!d.controls.touch.gesturesOnly);
    expect(s.controls.touch.fastPowerBar).toBe(!d.controls.touch.fastPowerBar);
    expect(s.controls.pad.rumble).toBe(!d.controls.pad.rumble);
    expect(s.controls.touch.skillTap).not.toBe(d.controls.touch.skillTap);
    expect(s.controls.touch.skillUp).not.toBe(d.controls.touch.skillUp);
    expect(s.controls.touch.skillRight).not.toBe(d.controls.touch.skillRight);
    expect(s.controls.pad.familyOverride).not.toBe(d.controls.pad.familyOverride);

    // ---- Camera
    await tapTab(page, 'camera');
    await next(page, 'set-camera-type');
    await tapSlider(page, 'set-camera-height', 1);
    await tapSlider(page, 'set-camera-zoom', 0);
    s = await settings(page);
    expect(s.camera).toEqual({ type: 1, height: 20, zoom: 0 });

    // ---- Match defaults
    await tapTab(page, 'match');
    await tapSlider(page, 'set-match-half', 1);
    await next(page, 'set-match-difficulty');
    for (const id of ['set-match-offside', 'set-match-fouls', 'set-match-replays', 'set-match-night-1']) await page.getByTestId(id).tap();
    await next(page, 'set-match-home');
    await next(page, 'set-match-formation');
    await page.setViewportSize({ width: 1680, height: 720 });
    await shot(page, 'uix09-match-21x9');
    expect(await checkTargets(page, '.screen--settings')).toEqual([]);
    await page.setViewportSize({ width: 1180, height: 820 });
    s = await settings(page);
    expect(s.match.halfMinutes).toBe(10);
    expect(s.match.difficulty).toBe(d.match.difficulty + 1);
    expect([s.match.offside, s.match.fouls, s.match.replays, s.match.night]).toEqual([false, false, false, true]);
    expect(s.match.homeClub).toBe(d.match.homeClub + 1);
    expect(s.match.awayClub).not.toBe(s.match.homeClub);
    expect(s.match.homeFormation).toBe(d.match.homeFormation + 1);

    // ---- Audio
    await tapTab(page, 'audio');
    await tapSlider(page, 'set-vol-master', 0.5);
    await tapSlider(page, 'set-vol-crowd', 0);
    await tapSlider(page, 'set-vol-effects', 1);
    await tapSlider(page, 'set-vol-menus', 0.25);
    s = await settings(page);
    expect(s.audio.master).toBeCloseTo(0.5, 5);
    expect(s.audio.crowd).toBe(0);
    expect(s.audio.effects).toBe(1);
    expect(s.audio.menus).toBeCloseTo(0.25, 5);

    // ---- Graphics
    await tapTab(page, 'graphics');
    await page.getByTestId('set-gfx-tier-1').tap();
    await page.getByTestId('set-gfx-fps').tap();
    await page.getByTestId('set-gfx-res-auto').tap();
    expect((await settings(page)).graphics.resolutionScale).toBe(1);
    await tapSlider(page, 'set-gfx-res', 0);
    await page.setViewportSize({ width: 1024, height: 768 });
    await shot(page, 'uix09-graphics-4x3');
    expect(await checkTargets(page, '.screen--settings')).toEqual([]);
    await page.setViewportSize({ width: 1180, height: 820 });
    s = await settings(page);
    expect(s.graphics).toEqual({ tier: 1, showFps: true, resolutionScale: 0.6 });

    // ---- Accessibility
    await tapTab(page, 'access');
    for (const id of ['set-a11y-contrast', 'set-a11y-hud', 'set-a11y-motion', 'set-a11y-markers']) await page.getByTestId(id).tap();
    s = await settings(page);
    expect(s.accessibility).toEqual({ highContrastKits: true, largerHud: true, reducedCameraMotion: true, colourBlindMarkers: true });

    // ---- Diagnostics shows the version and links to the diagnostics screen.
    await tapTab(page, 'diagnostics');
    await expect(page.getByTestId('settings-version')).toContainText('DotKick');

    // ---- Persist across reload.
    const before = await settings(page);
    await page.evaluate(() => window.__dotkick!.ctx.settings.saveProgress('uix09.check', { ok: 1 }));
    await page.waitForTimeout(600);
    await page.reload();
    await page.waitForFunction(() => !!window.__dotkick?.ctx);
    const after = await settings(page);
    for (const k of ['controls', 'camera', 'match', 'audio', 'graphics', 'accessibility']) expect(after[k], k).toEqual(before[k]);

    // ---- Data reset (confirm) restores the defaults and clears progress.
    await page.getByTestId('splash-start').tap();
    await page.waitForFunction(() => window.__dotkick?.ctx.router.current === 'main');
    await page.getByTestId('main-settings').tap();
    await tapTab(page, 'data');
    await page.getByTestId('settings-reset').tap();
    await expect(page.getByTestId('settings-reset-dialog')).toBeVisible();
    await page.getByTestId('settings-reset-cancel').tap();
    expect((await settings(page)).camera.height).toBe(20);
    await page.getByTestId('settings-reset').tap();
    await page.getByTestId('settings-reset-confirm').tap();
    s = await settings(page);
    for (const k of ['controls', 'camera', 'match', 'audio', 'graphics', 'accessibility']) expect(s[k], k).toEqual(d[k]);
    expect(await page.evaluate(() => window.__dotkick!.ctx.settings.loadProgress('uix09.check'))).toBeNull();
    // Back by touch.
    await page.getByTestId('back').tap();
    await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'main');
    expect(messages).toEqual([]);
  });

  test('controller only: tabs with Q / E, values with arrows, reset dialog, Back', async ({ page }) => {
    const messages = collectConsole(page);
    await bootToMain(page);
    await page.evaluate(() => window.__dotkick!.ctx.router.go('settings', { tab: 'controls' }));
    await expect(page.getByTestId('settings-title')).toBeVisible();
    await expect.poll(() => focused(page)).toBe('settings-tab-controls');

    // E: next tab (Camera); the focus follows the tab bar.
    await page.keyboard.press('e');
    await expect(page.getByTestId('settings-body')).toHaveAttribute('data-tab', 'camera');
    await expect.poll(() => focused(page)).toBe('settings-tab-camera');
    // Down to the camera type, Right changes it; Down to height, Right twice.
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => focused(page)).toBe('set-camera-type');
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await settings(page)).camera.type).toBe(1);
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => focused(page)).toBe('set-camera-height');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await settings(page)).camera.height).toBe(12);

    // E from inside the content: the next tab's first control takes the focus.
    await page.keyboard.press('e');
    await expect(page.getByTestId('settings-body')).toHaveAttribute('data-tab', 'match');
    await expect.poll(() => focused(page)).toBe('set-match-half');
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await settings(page)).match.halfMinutes).toBe(3);
    // Q goes back a tab.
    await page.keyboard.press('q');
    await expect(page.getByTestId('settings-body')).toHaveAttribute('data-tab', 'camera');

    // To Data (five tabs on), reset through the dialog with the keyboard.
    for (let i = 0; i < 5; i++) await page.keyboard.press('e');
    await expect(page.getByTestId('settings-body')).toHaveAttribute('data-tab', 'data');
    await expect.poll(() => focused(page)).toBe('settings-reset');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('settings-reset-dialog')).toBeVisible();
    await expect.poll(() => focused(page)).toBe('settings-reset-cancel');
    // Back closes the dialog, not the screen.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-reset-dialog')).toHaveCount(0);
    expect(await page.evaluate(() => window.__dotkick!.ctx.router.current)).toBe('settings');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('settings-reset-dialog')).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => focused(page)).toBe('settings-reset-confirm');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await settings(page)).camera).toEqual({ type: 0, height: 10, zoom: 10 });
    expect((await settings(page)).match.halfMinutes).toBe(4);

    // Back leaves the screen.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'main');
    expect(messages).toEqual([]);
  });
});
