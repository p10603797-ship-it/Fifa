/**
 * FND-04 app shell end to end: boot -> splash tap -> main -> Kick-Off -> match (canvas + HUD) with zero console
 * errors or warnings; Escape opens the pause menu; Quit returns to the main menu; a second match starts cleanly.
 * Also: hidden page pauses and never fast-forwards; portrait shows the rotate card and pauses.
 * Requires `npx vite build` first (playwright.config.ts serves dist/ with vite preview).
 */
import { expect, test, type Page } from '@playwright/test';

/**
 * Messages Chromium itself prints about the container's software GPU (SwiftShader): no page script logs them and
 * they do not occur on devices with a GPU, so they are excluded from the zero-console check.
 */
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

async function tick(page: Page): Promise<number> {
  return page.evaluate(() => window.__dotkick!.ctx.session.getState()?.tick ?? -1);
}

async function bootToMain(page: Page): Promise<void> {
  await page.goto('/');
  const start = page.getByTestId('splash-start');
  await expect(start).toBeVisible();
  await start.tap();
  await expect(page.getByTestId('main-kickoff')).toBeVisible();
  expect(await page.evaluate(() => window.__dotkick!.ctx.router.current)).toBe('main');
}

async function kickOff(page: Page): Promise<void> {
  await page.getByTestId('main-kickoff').tap();
  await page.waitForFunction(() => {
    const d = window.__dotkick;
    return !!d && d.ctx.router.current === 'match' && d.ctx.session.getState() !== null;
  }, null, { timeout: 30_000 });
  // The sim is running: ticks advance.
  await page.waitForFunction(() => (window.__dotkick!.ctx.session.getState()?.tick ?? 0) > 10, null, { timeout: 10_000 });
}

async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => s === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

test.describe('FND-04 app shell', () => {
  test('boot, kick-off, pause, quit and a second match with zero console errors or warnings', async ({ page }) => {
    const messages = collectConsole(page);
    await bootToMain(page);
    await kickOff(page);

    // Canvas and HUD are visible over the running match.
    await expect(page.locator('#game')).toBeVisible();
    expect(await page.locator('#game').evaluate((el) => getComputedStyle(el).visibility)).toBe('visible');
    expect(await page.locator('#hud').evaluate((el) => getComputedStyle(el).visibility)).toBe('visible');
    const board = page.getByTestId('hud-scoreboard');
    await expect(board).toBeVisible();
    await expect(page.getByTestId('sb-home')).not.toHaveText('---');
    await expect(page.getByTestId('sb-score')).toHaveText('0-0');
    const stats = await page.evaluate(() => window.__dotkickFrameStats ?? null);
    expect(stats).not.toBeNull();
    expect(stats!.totalTicks).toBeGreaterThan(0);

    // Escape opens the pause menu and stops the sim.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.paused)).toBe(true);
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.pausedBy)).toBe(0);
    const frozen = await tick(page);
    await page.waitForTimeout(400);
    expect(await tick(page)).toBe(frozen);

    // Resume, then pause with the on-screen pause button and quit.
    await page.getByTestId('pause-resume').tap();
    await expect(page.getByTestId('pause-menu')).toBeHidden();
    await page.waitForFunction((t) => (window.__dotkick!.ctx.session.getState()?.tick ?? 0) > t + 5, frozen);
    // Exactly one on-screen pause control (the touch overlay's on a touch device) and it pauses.
    const pauseControl = page.locator('[aria-label="Pause"]:visible');
    await expect(pauseControl).toHaveCount(1);
    // The touch layer hit-tests its own controls, so tap the control's position like a finger would.
    const box = (await pauseControl.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    await page.getByTestId('pause-quit').tap();
    await expect(page.getByTestId('main-kickoff')).toBeVisible();
    const after = await page.evaluate(() => {
      const c = window.__dotkick!.ctx;
      return {
        stack: (window.__dotkick!.app.router.stack as readonly string[]).slice(),
        active: c.session.active,
        state: c.session.getState(),
        matchLayer: document.body.classList.contains('match-active'),
        inMatch: document.body.classList.contains('in-match'),
        touchChildren: document.getElementById('touch')!.children.length,
      };
    });
    expect(after).toEqual({ stack: ['main'], active: false, state: null, matchLayer: false, inMatch: false, touchChildren: 0 });

    // A second match starts cleanly.
    await kickOff(page);
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.paused)).toBe(false);
    await expect(page.getByTestId('hud-scoreboard')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    await page.getByTestId('pause-quit').tap();
    await expect(page.getByTestId('main-kickoff')).toBeVisible();

    expect(messages).toEqual([]);
  });

  test('hidden page pauses, shows the pause menu on return and never fast-forwards', async ({ page }) => {
    const messages = collectConsole(page);
    await bootToMain(page);
    await kickOff(page);
    await setVisibility(page, 'hidden');
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.pausedBy)).toBe(-1);
    expect(await page.evaluate(() => window.__dotkick!.app.loop.running)).toBe(false);
    const t0 = await tick(page);
    await page.waitForTimeout(1500);
    await setVisibility(page, 'visible');
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    expect(await tick(page)).toBe(t0);
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.paused)).toBe(true);
    await page.getByTestId('pause-resume').tap();
    await page.waitForTimeout(250);
    const t1 = await tick(page);
    // ~15 ticks in 250 ms; 1.5 s of hidden time (90 ticks) must never be replayed.
    expect(t1 - t0).toBeGreaterThan(0);
    expect(t1 - t0).toBeLessThan(45);
    expect(messages).toEqual([]);
  });

  test('portrait shows the rotate card and pauses; landscape keeps the pause menu', async ({ page }) => {
    const messages = collectConsole(page);
    await bootToMain(page);
    await kickOff(page);
    await page.setViewportSize({ width: 820, height: 1180 });
    await expect(page.locator('#rotate')).toBeVisible();
    await page.waitForFunction(() => window.__dotkick!.ctx.session.paused);
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.resume(0))).toBe(false);
    await page.setViewportSize({ width: 1180, height: 820 });
    await expect(page.locator('#rotate')).toBeHidden();
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    await page.getByTestId('pause-resume').tap();
    await expect(page.getByTestId('pause-menu')).toBeHidden();
    expect(messages).toEqual([]);
  });

  test('every menu screen opens and Back returns, by touch and by keyboard', async ({ page }) => {
    const messages = collectConsole(page);
    await bootToMain(page);
    for (const id of ['main-modes', 'main-practice', 'main-cup', 'main-online', 'main-settings', 'main-diagnostics']) {
      await page.getByTestId(id).tap();
      await expect(page.getByTestId('back')).toBeVisible();
      await page.getByTestId('back').tap();
      await expect(page.getByTestId('main-kickoff')).toBeVisible();
    }
    // Keyboard only: navigate into Settings and back with Escape.
    await page.getByTestId('main-settings').tap();
    await expect(page.getByTestId('settings-title')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('main-kickoff')).toBeVisible();
    expect(await page.evaluate(() => (window.__dotkick!.app.router.stack as readonly string[]).slice())).toEqual(['main']);
    // Browser back (Safari edge swipe) goes back inside the game and never leaves the page.
    await page.getByTestId('main-diagnostics').tap();
    await expect(page.getByTestId('diagnostics-title')).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('main-kickoff')).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('main-kickoff')).toBeVisible();
    expect(new URL(page.url()).port).not.toBe('');
    expect(messages).toEqual([]);
  });

  test('keyboard alone: one press = one action through splash, main, pause menu and quit', async ({ page }) => {
    const messages = collectConsole(page);
    await page.goto('/');
    await expect(page.getByTestId('splash-start')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('main-kickoff')).toBeVisible();
    // The same Enter must not also activate Kick-Off on the next screen.
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.active)).toBe(false);
    await page.keyboard.press('Enter'); // Kick-Off has default focus
    await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'match' && window.__dotkick!.app.session.loaded, null, { timeout: 30_000 });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.paused)).toBe(true); // one Escape = one toggle
    // Menu input samples direction taps once per frame, so wait for each move before the next press (back-to-back
    // presses inside one frame are one action; see the report's PAD-08 note). Each press moves focus exactly once.
    await expect(page.getByTestId('pause-resume')).toHaveAttribute('data-focused', '');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('pause-restart')).toHaveAttribute('data-focused', '');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('pause-quit')).toHaveAttribute('data-focused', '');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('main-kickoff')).toBeVisible();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.active)).toBe(false);
    expect(messages).toEqual([]);
  });

  test('runs when manifest, service worker and icons are missing', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.route(/\/(manifest\.webmanifest|sw\.js|icons\/.*)$/, (route) => route.fulfill({ status: 404, body: '' }));
    await bootToMain(page);
    await kickOff(page);
    await page.keyboard.press('Escape');
    await page.getByTestId('pause-quit').tap();
    await expect(page.getByTestId('main-kickoff')).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
});
