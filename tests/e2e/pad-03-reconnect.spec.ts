/**
 * PAD-03 reconnect card in a real browser with mocked pads (navigator.getGamepads list in the page) driving the real
 * pad manager, device registry and installReconnectFlow (flow + DOM card), and the real sim stepped per frame while the
 * session double is not paused. Harness: tests/e2e/pad-03-harness.ts, bundled with esbuild.
 *  - disconnect during play: auto-pause, the card names the controller, the clock stops; hand-off to the CPU by touch;
 *  - glitch "controller disconnect during a penalty": no tick runs while the pad is gone, the card turns into
 *    "reconnected" when it is back, any button resumes and that press is not a penalty kick.
 *   npx vite build --outDir dist-e2e/tch-08 --emptyOutDir
 *   PW_DIST=dist-e2e/tch-08 PW_PORT=4238 npx playwright test tests/e2e/pad-03-reconnect.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';

const MOCK = `
  window.__pad03pads = [{
    id: 'Mock Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, connected: true, mapping: 'standard',
    timestamp: 0, axes: [0, 0, 0, 0], vibrationActuator: null,
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  }, null, null, null];
  window.__pad03saved = window.__pad03pads[0];
`;
type W = {
  __pad03pads: ({ connected: boolean; buttons: { pressed: boolean; touched: boolean; value: number }[] } | null)[];
  __pad03saved: { connected: boolean; buttons: { pressed: boolean; touched: boolean; value: number }[] };
};

async function frames(page: Page, n = 2): Promise<void> {
  await page.evaluate((k) => new Promise<void>((res) => {
    let left = k;
    const step = (): void => { if (--left <= 0) res(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }), n);
}

async function setButton(page: Page, b: number, down: boolean): Promise<void> {
  await page.evaluate(([i, d]) => {
    const p = (window as unknown as W).__pad03saved;
    p.buttons[i as number] = { pressed: d as boolean, touched: d as boolean, value: d ? 1 : 0 };
  }, [b, down] as const);
  await frames(page, 2);
}

async function unplug(page: Page): Promise<void> {
  await page.evaluate(() => { const w = window as unknown as W; w.__pad03saved.connected = false; w.__pad03pads[0] = null; });
  await frames(page, 2);
}

async function plug(page: Page): Promise<void> {
  await page.evaluate(() => { const w = window as unknown as W; w.__pad03saved.connected = true; w.__pad03pads[0] = w.__pad03saved; });
  await frames(page, 2);
}

test.describe('PAD-03 reconnect card (mocked pads)', () => {
  let js = '';
  test.beforeAll(async () => {
    const r = await build({
      entryPoints: [path.resolve('tests/e2e/pad-03-harness.ts')],
      bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent', outdir: 'pad03-out',
      define: { __DEV_BUILD__: 'true' },
    });
    js = r.outputFiles.find((f) => f.path.endsWith('.js'))!.text;
  });

  async function open(page: Page, mode: 'play' | 'penalty'): Promise<string[]> {
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body></body></html>');
    await page.addScriptTag({ content: MOCK });
    await page.addScriptTag({ content: js });
    await page.waitForFunction(() => !!window.__pad03);
    await setButton(page, 0, true); // the first press lists the pad as 'pad:1'
    await setButton(page, 0, false);
    await page.evaluate((m) => { window.__pad03!.start(m); window.__pad03!.bind(); }, mode);
    await frames(page, 4);
    return errors;
  }

  test('disconnect during play: auto-pause with the card; hand the side to the CPU by touch', async ({ page }) => {
    const errors = await open(page, 'play');
    expect(await page.evaluate(() => window.__pad03!.ticks())).toBeGreaterThan(0);
    await expect(page.getByTestId('reconnect-card')).toBeHidden();
    await unplug(page);
    await expect(page.getByTestId('reconnect-card')).toBeVisible();
    await expect(page.getByTestId('reconnect-title')).toHaveText('Controller 1 disconnected');
    await expect(page.getByTestId('reconnect-body')).toHaveText('Press any button on a controller to continue, or hand this side to:');
    await expect(page.getByTestId('reconnect-player')).toHaveText('Player 1');
    expect(await page.evaluate(() => window.__pad03!.paused())).toBe(true);
    const t0 = await page.evaluate(() => window.__pad03!.ticks());
    await frames(page, 20);
    expect(await page.evaluate(() => window.__pad03!.ticks())).toBe(t0);
    const cpu = page.getByTestId('reconnect-cpu');
    await expect(cpu).toBeVisible();
    const box = (await cpu.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(60); // 60 pt targets
    await cpu.tap();
    await expect(page.getByTestId('reconnect-card')).toBeHidden();
    expect(await page.evaluate(() => window.__pad03!.calls())).toEqual(['0:cpu']);
    expect(await page.evaluate(() => window.__pad03!.paused())).toBe(false);
    await frames(page, 6);
    expect(await page.evaluate(() => window.__pad03!.ticks())).toBeGreaterThan(t0);
    expect(errors).toEqual([]);
  });

  test('glitch: controller disconnect during a penalty - frozen while gone, any button resumes, no kick from it', async ({ page }) => {
    const errors = await open(page, 'penalty');
    expect(await page.evaluate(() => window.__pad03!.taken())).toBe(0);
    await unplug(page);
    await expect(page.getByTestId('reconnect-card')).toBeVisible();
    const t0 = await page.evaluate(() => window.__pad03!.ticks());
    await frames(page, 60);
    expect(await page.evaluate(() => window.__pad03!.ticks())).toBe(t0);
    expect(await page.evaluate(() => window.__pad03!.taken())).toBe(0);
    await plug(page);
    await expect(page.getByTestId('reconnect-title')).toHaveText('Controller 1 reconnected');
    await expect(page.getByTestId('reconnect-body')).toHaveText('Press any button to continue, or hand this side to:');
    await setButton(page, 1, true); // Circle / B: in a penalty that is SHOOT, here it only resumes
    await expect(page.getByTestId('reconnect-card')).toBeHidden();
    expect(await page.evaluate(() => window.__pad03!.paused())).toBe(false);
    await frames(page, 20);
    await setButton(page, 1, false);
    await frames(page, 20);
    expect(await page.evaluate(() => window.__pad03!.taken())).toBe(0);
    expect(await page.evaluate(() => window.__pad03!.ticks())).toBeGreaterThan(t0);
    expect(errors).toEqual([]);
  });
});
