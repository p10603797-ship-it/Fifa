/**
 * PAD-07 remap screen through the real app with a mocked pad WITHOUT the standard mapping (navigator.getGamepads
 * overridden in an init script): the pad opens by itself, Start / Cancel work by touch (nothing saved on Cancel), the
 * walk asks for each action with a generated glyph hint, the pad's own presses are captured (and never click the
 * screen), and the result is saved to settings.controls.pad.remaps[gamepad.id]; Done and Back leave the screen.
 *   npx vite build --outDir dist-e2e/tch-08 --emptyOutDir
 *   PW_DIST=dist-e2e/tch-08 PW_PORT=4238 npx playwright test tests/e2e/pad-07-remap.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';

const ODD_ID = 'Retro Arcade Pad (Vendor: 1234 Product: 5678)';
const MOCK_PAD = `
  window.__pad07 = {
    id: ${JSON.stringify(ODD_ID)}, index: 0, connected: true, mapping: '', timestamp: 0, axes: [0, 0, 0, 0],
    vibrationActuator: null, buttons: Array.from({ length: 20 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [window.__pad07, null, null, null] });
`;
type PadWin = { __pad07: { buttons: { pressed: boolean; touched: boolean; value: number }[] } };
type Win = { __dotkick?: { ctx: { router: { go(id: string): void; current: string | null }; settings: { get(): { controls: { pad: { remaps: Record<string, number[]> } } } } } } };

const GPU_NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/];

async function frames(page: Page, n = 2): Promise<void> {
  await page.evaluate((k) => new Promise<void>((res) => {
    let left = k;
    const step = (): void => { if (--left <= 0) res(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }), n);
}

async function padTap(page: Page, b: number): Promise<void> {
  await page.evaluate((i) => new Promise<void>((res) => {
    const pad = (window as unknown as PadWin).__pad07;
    pad.buttons[i] = { pressed: true, touched: true, value: 1 };
    requestAnimationFrame(() => requestAnimationFrame(() => {
      pad.buttons[i] = { pressed: false, touched: false, value: 0 };
      res();
    }));
  }), b);
  await frames(page, 2);
}

const remaps = (page: Page): Promise<Record<string, number[]>> =>
  page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as Win).__dotkick!.ctx.settings.get().controls.pad.remaps)));

test('PAD-07 remap screen: a non-standard pad walks every action and the remap is saved', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' && !GPU_NOISE.some((re) => re.test(m.text()))) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(MOCK_PAD);
  await page.goto('/');
  await page.evaluate(() => { try { localStorage.clear(); } catch { /* blocked */ } });
  await page.reload();
  await page.waitForFunction(() => !!(window as unknown as Win).__dotkick);
  await page.evaluate(() => (window as unknown as Win).__dotkick!.ctx.router.go('remap'));
  await expect(page.getByTestId('remap-waiting')).toBeVisible();
  await padTap(page, 2); // first press: the pad is listed and, being the only non-standard pad, opens by itself
  await expect(page.getByTestId('remap-intro')).toBeVisible();
  await expect(page.getByTestId('remap-eyebrow')).toContainText('Controller 1');

  // Start, then Cancel by touch: nothing is saved.
  await page.getByTestId('remap-start').tap();
  await expect(page.getByTestId('remap-action')).toHaveText('Pass');
  await expect(page.getByTestId('remap-where')).toContainText('Usually the bottom face button');
  await expect(page.locator('[data-testid="remap-where"] svg')).toHaveCount(1);
  await page.getByTestId('remap-cancel').tap();
  await expect(page.getByTestId('remap-notice')).toContainText('Nothing changed');
  expect(await remaps(page)).toEqual({});

  // The full walk with the pad alone: one new raw button per action.
  await page.getByTestId('remap-start').tap();
  const raws = [3, 4, 5, 6, 7, 8, 10, 11, 16, 17, 18, 19, 0];
  for (let i = 0; i < raws.length; i++) {
    await expect(page.getByTestId('remap-step')).toHaveText(`Step ${i + 1} of 13`);
    await padTap(page, raws[i]!);
  }
  await expect(page.getByTestId('remap-done')).toBeVisible();
  expect((await remaps(page))[ODD_ID]).toEqual(raws);
  await expect(page.getByTestId('remap-binding-0')).toHaveText('Button 4');

  // Done (touch) leaves the screen; the remap survives a reload.
  await page.getByTestId('remap-done').tap();
  await expect.poll(() => page.evaluate(() => (window as unknown as Win).__dotkick!.ctx.router.current)).not.toBe('remap');
  await page.reload();
  await page.waitForFunction(() => !!(window as unknown as Win).__dotkick);
  expect((await remaps(page))[ODD_ID]).toEqual(raws);
  expect(errors).toEqual([]);
});
