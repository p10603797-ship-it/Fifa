/**
 * TCH-08 controls editor through the real app (router, settings store with real storage, FocusNavigator, menu input):
 *  - drag a cluster button by touch, reload: the position persists (settings.controls.touch.layout) and the editor
 *    shows it there again; Reset to defaults restores the default layout;
 *  - controller only (mocked Standard Gamepad): focus moves to a control, Confirm picks it up, the D-pad nudges it,
 *    Confirm drops it (saved); Back while picked up puts it back; Back then leaves the screen.
 *   npx vite build --outDir dist-e2e/tch-08 --emptyOutDir
 *   PW_DIST=dist-e2e/tch-08 PW_PORT=4238 npx playwright test tests/e2e/tch-08-editor.spec.ts
 */
import { expect, test, type CDPSession, type Page } from '@playwright/test';

const GPU_NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/];

function collectErrors(page: Page): string[] {
  const out: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (GPU_NOISE.some((re) => re.test(m.text()))) return;
    out.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => out.push(`pageerror: ${e.message}`));
  return out;
}

const MOCK_PAD = `
  window.__tch08pad = {
    id: 'Mock Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, connected: true, mapping: 'standard',
    timestamp: 0, axes: [0, 0, 0, 0], vibrationActuator: null,
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [window.__tch08pad, null, null, null] });
`;
type PadWin = { __tch08pad: { buttons: { pressed: boolean; touched: boolean; value: number }[] } };
type Win = { __dotkick?: { ctx: { router: { go(id: string): void; current: string | null }; settings: { get(): { controls: { touch: { layout: Record<string, { dx: number; dy: number; scale: number }> } } } } } } };

async function frames(page: Page, n = 2): Promise<void> {
  await page.evaluate((k) => new Promise<void>((res) => {
    let left = k;
    const step = (): void => { if (--left <= 0) res(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }), n);
}

async function padTap(page: Page, b: number): Promise<void> {
  await page.evaluate((i) => new Promise<void>((res) => {
    const pad = (window as unknown as PadWin).__tch08pad;
    pad.buttons[i] = { pressed: true, touched: true, value: 1 };
    requestAnimationFrame(() => {
      pad.buttons[i] = { pressed: false, touched: false, value: 0 };
      res();
    });
  }), b);
  await frames(page, 2);
}

async function openEditor(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as unknown as Win).__dotkick);
  await page.evaluate(() => (window as unknown as Win).__dotkick!.ctx.router.go('controls-editor'));
  await expect(page.getByTestId('controls-editor')).toBeVisible();
  await frames(page, 2);
}

async function centre(page: Page, testId: string): Promise<{ x: number; y: number }> {
  const b = (await page.getByTestId(testId).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

const layout = (page: Page): Promise<Record<string, { dx: number; dy: number; scale: number }>> =>
  page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as Win).__dotkick!.ctx.settings.get().controls.touch.layout)));
const route = (page: Page): Promise<string | null> => page.evaluate(() => (window as unknown as Win).__dotkick!.ctx.router.current);

async function drag(cdp: CDPSession, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
  for (let i = 1; i <= 8; i++) {
    const x = from.x + ((to.x - from.x) * i) / 8, y = from.y + ((to.y - from.y) * i) / 8;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test.describe('TCH-08 controls editor (real app)', () => {
  test('drag a button by touch, reload: the position persists; Reset restores the defaults', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await page.evaluate(() => { try { localStorage.clear(); } catch { /* blocked */ } });
    await page.reload();
    await openEditor(page);
    const start = await centre(page, 'ce-ctl-0'); // PASS
    const want = { x: start.x - 160, y: start.y - 140 };
    const cdp = await page.context().newCDPSession(page);
    await drag(cdp, start, want);
    await frames(page, 2);
    const moved = await centre(page, 'ce-ctl-0');
    expect(Math.hypot(moved.x - want.x, moved.y - want.y)).toBeLessThan(2);
    const saved = await layout(page);
    expect(saved['0']).toBeDefined();
    expect(Object.keys(saved).sort()).toEqual(['0', '1', '2', '3']); // the first edit pins the whole cluster

    await page.reload();
    await openEditor(page);
    expect(await layout(page)).toEqual(saved);
    const again = await centre(page, 'ce-ctl-0');
    expect(Math.hypot(again.x - moved.x, again.y - moved.y)).toBeLessThan(1);

    await page.getByTestId('ce-reset').click();
    await frames(page, 2);
    expect(await layout(page)).toEqual({});
    const reset = await centre(page, 'ce-ctl-0');
    expect(Math.hypot(reset.x - start.x, reset.y - start.y)).toBeLessThan(1);
    expect(errors).toEqual([]);
  });

  test('controller only: focus a control, Confirm picks it up, the D-pad nudges it, Confirm drops it; Back works', async ({ page }) => {
    const errors = collectErrors(page);
    await page.addInitScript(MOCK_PAD);
    await page.goto('/');
    await page.evaluate(() => { try { localStorage.clear(); } catch { /* blocked */ } });
    await page.reload();
    await openEditor(page);
    await padTap(page, 10); // L3: makes the pad known, does nothing in menus
    await padTap(page, 13); // D-pad down: shows the focus ring
    const focusedKey = (): Promise<string | null> => page.evaluate(() => document.querySelector<HTMLElement>('[data-focused]')?.dataset.key ?? null);
    for (let i = 0; i < 6 && (await focusedKey()) === null; i++) await padTap(page, 15);
    const key = await focusedKey();
    expect(key).not.toBeNull();
    const ctl = `ce-ctl-${key}`;
    const before = await centre(page, ctl);

    await padTap(page, 0); // Confirm: pick up
    await expect(page.getByTestId(ctl)).toHaveClass(/is-picked/);
    for (let i = 0; i < 3; i++) await padTap(page, 12); // D-pad up x3
    const nudged = await centre(page, ctl);
    expect(before.y - nudged.y).toBeGreaterThan(20);
    expect(Math.abs(nudged.x - before.x)).toBeLessThan(1);
    await padTap(page, 0); // Confirm: drop
    await expect(page.getByTestId(ctl)).not.toHaveClass(/is-picked/);
    expect((await layout(page))[key!]).toBeDefined();
    expect(await route(page)).toBe('controls-editor');

    // Pick up again, nudge, Back: put back where it was picked up; still in the editor.
    await padTap(page, 0);
    await padTap(page, 14);
    await padTap(page, 14);
    await padTap(page, 1); // Circle / B = Back
    await expect(page.getByTestId(ctl)).not.toHaveClass(/is-picked/);
    const back = await centre(page, ctl);
    expect(Math.hypot(back.x - nudged.x, back.y - nudged.y)).toBeLessThan(1);
    expect(await route(page)).toBe('controls-editor');

    // Back again leaves the screen.
    await padTap(page, 1);
    await expect.poll(() => route(page)).not.toBe('controls-editor');
    expect(errors).toEqual([]);
  });
});
