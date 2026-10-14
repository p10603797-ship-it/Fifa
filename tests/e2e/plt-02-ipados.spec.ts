/**
 * [PLT-02] iPadOS hardening end to end (Chromium with iPad touch emulation):
 * - a resize mid-hold releases the held stick (with TCH-01's pointer manager); portrait shows the rotate screen and
 *   pauses; turning back to landscape keeps the pause until the player resumes;
 * - a window below the minimum playable size shows "make the window larger" and pauses;
 * - a synthetic pinch never zooms (visualViewport.scale stays 1);
 * - safe-area and viewport variables are applied.
 * Build first:  npx vite build --outDir dist-e2e/plt --emptyOutDir && node tools/postbuild.mjs dist-e2e/plt
 * Run:          PW_DIST=dist-e2e/plt PW_PORT=4205 npx playwright test tests/e2e/plt-02-ipados.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';

async function bootToMain(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('splash-start').tap();
  await expect(page.getByTestId('main-kickoff')).toBeVisible();
}

async function kickOff(page: Page): Promise<void> {
  await page.getByTestId('main-kickoff').tap();
  await page.waitForFunction(() => {
    const d = window.__dotkick;
    return !!d && d.ctx.router.current === 'match' && (d.ctx.session.getState()?.tick ?? 0) > 20;
  }, null, { timeout: 60_000 });
}

/** The human 0 frame the sim used on the latest tick: |mx| + |mz|. */
const stickMagnitude = (page: Page): Promise<number> => page.evaluate(() => {
  const rt = window.__dotkick!.app.session.runtime();
  const f = rt?.frames[0];
  return f ? Math.abs(f.mx) + Math.abs(f.mz) : -1;
});

test.describe('PLT-02 iPadOS hardening', () => {
  test('resize mid-hold releases the stick; portrait pauses behind the rotate screen; landscape waits for the player', async ({ page }) => {
    await bootToMain(page);
    await kickOff(page);
    const cdp = await page.context().newCDPSession(page);
    const vp = page.viewportSize()!;
    const x0 = Math.round(vp.width * 0.18);
    const y0 = Math.round(vp.height * 0.7);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0, id: 1 }] });
    for (let i = 1; i <= 6; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + i * 15, y: y0 - i * 4, id: 1 }] });
    }
    await expect.poll(() => stickMagnitude(page), { timeout: 10_000 }).toBeGreaterThan(20);

    // The finger stays down; the window changes size (Stage Manager / Split View): every held input is released.
    await page.setViewportSize({ width: vp.width - 80, height: vp.height - 40 });
    await expect.poll(() => stickMagnitude(page), { timeout: 10_000 }).toBe(0);
    await page.waitForTimeout(300);
    expect(await stickMagnitude(page)).toBe(0); // no stuck stick afterwards
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    // Portrait: rotate screen and pause.
    await page.setViewportSize({ width: 820, height: 1180 });
    await expect(page.locator('#rotate')).toBeVisible();
    await expect(page.locator('#rotate .msg-portrait')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__dotkick!.ctx.session.paused)).toBe(true);
    expect(await page.evaluate(() => document.body.classList.contains('is-portrait'))).toBe(true);
    const tickAtPause = await page.evaluate(() => window.__dotkick!.ctx.session.getState()!.tick);
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.getState()!.tick)).toBe(tickAtPause);

    // Back to landscape: the card goes, the pause stays until the player resumes.
    await page.setViewportSize(vp);
    await expect(page.locator('#rotate')).toBeHidden();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.paused)).toBe(true);
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.getState()!.tick)).toBe(tickAtPause);
  });

  test('a window below the minimum playable size says so and pauses', async ({ page }) => {
    await bootToMain(page);
    await kickOff(page);
    await page.setViewportSize({ width: 520, height: 300 });
    await expect(page.locator('#rotate')).toBeVisible();
    await expect(page.locator('#rotate .msg-small')).toBeVisible();
    await expect(page.locator('#rotate .msg-portrait')).toBeHidden();
    await expect.poll(() => page.evaluate(() => window.__dotkick!.ctx.session.paused)).toBe(true);
    expect(await page.evaluate(() => document.body.classList.contains('too-small'))).toBe(true);
    await page.setViewportSize({ width: 1180, height: 820 });
    await expect(page.locator('#rotate')).toBeHidden();
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.paused)).toBe(true);
  });

  test('a synthetic pinch never zooms; safe-area and viewport variables are applied', async ({ page }) => {
    await bootToMain(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.synthesizePinchGesture', { x: 590, y: 410, scaleFactor: 2.5, relativeSpeed: 800, gestureSourceType: 'touch' });
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
    // A two-finger touch sequence the page sees is cancelled too.
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 500, y: 400, id: 1 }, { x: 680, y: 420, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 420, y: 390, id: 1 }, { x: 780, y: 430, id: 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);

    const vars = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const body = getComputedStyle(document.body);
      return {
        safeTop: cs.getPropertyValue('--safe-top').trim(),
        safeBottom: cs.getPropertyValue('--safe-bottom').trim(),
        margin: cs.getPropertyValue('--gesture-margin').trim(),
        ctlBottom: cs.getPropertyValue('--ctl-inset-bottom').trim(),
        appHeight: document.documentElement.style.getPropertyValue('--app-height'),
        innerHeight: window.innerHeight,
        aspect: document.body.dataset.aspect,
        touchAction: body.touchAction,
        userSelect: body.userSelect || body.webkitUserSelect,
        overscroll: body.overscrollBehaviorY,
      };
    });
    expect(vars.safeTop).not.toBe('');
    expect(vars.safeBottom).not.toBe('');
    expect(vars.margin).toBe('24px');
    expect(vars.ctlBottom).not.toBe('');
    expect(vars.appHeight).toBe(`${vars.innerHeight}px`);
    expect(vars.aspect).toBe('ok');
    expect(vars.touchAction).toBe('none');
    expect(vars.userSelect).toBe('none');
    expect(vars.overscroll).toBe('none');
    // The safe-area probe of PlatformInfo reads the same insets (0 on a desktop browser).
    expect(await page.evaluate(() => window.__dotkick!.ctx.platform.safeArea())).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});
