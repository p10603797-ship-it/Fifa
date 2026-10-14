/**
 * [AUD-05] Menu sounds in a real browser (Web Audio in headless Chromium): the key press that starts the game and
 * unlocks audio plays START (queued until the context runs), keyboard navigation (Enter on a menu entry) plays
 * CONFIRM through the menus voice pool from pre-rendered buffers, key repeat is debounced, and nothing logs an
 * error or warning.
 * Run: npx vite build --outDir dist-e2e/aud-01 --emptyOutDir && PW_DIST=dist-e2e/aud-01 PW_PORT=4201 npx playwright test tests/e2e/aud-05-menus.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { UiSound } from '../../src/contracts/app';
import type { AudioEngineImpl } from '../../src/audio/engine';
import type { UiModule } from '../../src/audio/ui';

const GPU_ENVIRONMENT_NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/];

function collectConsole(page: Page): string[] {
  const out: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const text = m.text();
    if (GPU_ENVIRONMENT_NOISE.some((re) => re.test(text))) return;
    out.push(`${m.type()}: ${text}`);
  });
  page.on('pageerror', (e) => out.push(`pageerror: ${e.message}`));
  return out;
}

interface UiInfo {
  played: number[];
  fallback: number;
  debounced: number;
  menusPlays: number;
  state: string;
  failures: number[];
}

async function uiInfo(page: Page): Promise<UiInfo> {
  return page.evaluate(() => {
    const a = window.__dotkick!.ctx.audio as unknown as AudioEngineImpl;
    const ui = a.services!.modules.ui as unknown as UiModule;
    return {
      played: Array.from(ui.stats.played), fallback: ui.stats.fallback, debounced: ui.stats.debounced,
      menusPlays: a.services!.menus.allocator.plays, state: a.info().state, failures: a.info().moduleFailures,
    };
  });
}

test.describe('AUD-05 menu sounds', () => {
  test('splash START, CONFIRM on keyboard navigation, debounced key repeat, menus pool, no errors', async ({ page }) => {
    const messages = collectConsole(page);
    await page.goto('/');
    await expect(page.getByTestId('splash-start')).toBeVisible();
    // A keyboard player: any key starts (a key press is a user gesture that may unlock audio).
    await page.keyboard.press('KeyG');
    await expect(page.getByTestId('main-kickoff')).toBeVisible();
    const focused = (): Promise<string | null | undefined> => page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    await expect.poll(focused).toBe('main-kickoff');
    await page.waitForFunction(() => (window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).info().state === 'running');
    // The unlocking key press's START sound played from its pre-rendered buffer (not the oscillator fallback).
    await expect.poll(async () => (await uiInfo(page)).played[UiSound.START]).toBe(1);

    // Keyboard: walk to Settings in the top bar, open it (CONFIRM), come back.
    await page.keyboard.press('ArrowUp');
    await expect.poll(focused).toBe('main-settings');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await uiInfo(page)).played[UiSound.CONFIRM]).toBeGreaterThanOrEqual(1);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('main-kickoff')).toBeVisible();

    // Key repeat: a burst of the same sound inside the debounce window plays once.
    const burst = await page.evaluate((move) => {
      const a = window.__dotkick!.ctx.audio as unknown as AudioEngineImpl;
      const ui = a.services!.modules.ui as unknown as UiModule;
      const before = ui.stats.played[move]!;
      for (let i = 0; i < 8; i++) a.playUi(move);
      return { played: ui.stats.played[move]! - before, debounced: ui.stats.debounced };
    }, UiSound.MOVE);
    expect(burst.played).toBe(1);
    expect(burst.debounced).toBeGreaterThanOrEqual(7);

    const info = await uiInfo(page);
    expect(info.fallback).toBe(0);
    expect(info.menusPlays).toBe(info.played.reduce((x, y) => x + y, 0));
    expect(info.failures.every((n) => n === 0)).toBe(true);
    expect(messages).toEqual([]);
  });
});
