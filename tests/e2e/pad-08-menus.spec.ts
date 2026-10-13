/**
 * PAD-08 e2e: menu navigation through the real app (FocusNavigator + menu input + router) with the keyboard alone and
 * with a mocked pad alone (navigator.getGamepads overridden by an init script): splash -> main menu -> Settings ->
 * Back, a visible focus ring, a sensible focus order. A third test drives a real-DOM panel attached to the app's
 * navigator: focus-group wrap, slider adjust (no native double step), tabs, and recovery when the focused element is
 * removed (MutationObserver).
 *
 *   npx vite build --outDir dist-e2e/pad-08 --emptyOutDir
 *   PW_DIST=dist-e2e/pad-08 PW_PORT=4208 npx playwright test tests/e2e/pad-08-menus.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';

const MOCK_PAD = `
  window.__pad08 = {
    id: 'Mock Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, connected: true, mapping: 'standard',
    timestamp: 0, axes: [0, 0, 0, 0], vibrationActuator: null,
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [window.__pad08, null, null, null] });
`;

type PadWin = { __pad08: { axes: number[]; buttons: { pressed: boolean; touched: boolean; value: number }[] } };

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

/** Wait for two animation frames (the menu input polls once per frame). */
async function frames(page: Page, n = 2): Promise<void> {
  await page.evaluate((k) => new Promise<void>((res) => {
    let left = k;
    const step = (): void => { if (--left <= 0) res(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }), n);
}

const focused = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.querySelector<HTMLElement>('[data-focused]')?.dataset.testid ?? null);
const route = (page: Page): Promise<string | null> => page.evaluate(() => window.__dotkick!.ctx.router.current);
const ring = (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.hasAttribute('data-focus-visible'));

/** Press a direction until `want` is focused; returns the focus path (each press must move focus). */
async function walkTo(page: Page, want: string, press: () => Promise<void>, max = 6): Promise<string[]> {
  const path: string[] = [];
  for (let i = 0; i < max && (await focused(page)) !== want; i++) {
    const before = await focused(page);
    const hadRing = await ring(page);
    await press();
    if (hadRing) await expect.poll(() => focused(page)).not.toBe(before);
    else await expect.poll(() => ring(page)).toBe(true);
    path.push((await focused(page)) ?? '');
  }
  return path;
}

async function padTap(page: Page, b: number): Promise<void> {
  await page.evaluate((i) => { const p = (window as unknown as PadWin).__pad08; p.buttons[i] = { pressed: true, touched: true, value: 1 }; }, b);
  await frames(page);
  await page.evaluate((i) => { const p = (window as unknown as PadWin).__pad08; p.buttons[i] = { pressed: false, touched: false, value: 0 }; }, b);
  await frames(page);
}

async function padStick(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(([ax, ay]) => { const p = (window as unknown as PadWin).__pad08; p.axes[0] = ax!; p.axes[1] = ay!; }, [x, y]);
  await frames(page);
}

test.describe('PAD-08 menus by keyboard alone and by controller alone', () => {
  test('keyboard only: splash -> main -> Settings -> Back (Escape and K), visible ring, sensible order', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await expect(page.getByTestId('splash-start')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('main-kickoff')).toBeVisible();
    await expect.poll(() => focused(page)).toBe('main-kickoff');
    const path = await walkTo(page, 'main-settings', () => page.keyboard.press('ArrowDown'));
    expect(path.filter((p) => p !== 'main-kickoff')).toEqual(['main-modes', 'main-cup', 'main-settings']);
    expect(await ring(page)).toBe(true);
    await page.keyboard.press('Enter');
    await expect.poll(() => route(page)).toBe('settings');
    await expect.poll(() => focused(page)).toBe('settings-controls-editor');
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => focused(page)).toBe('settings-remap');
    await page.keyboard.press('Escape');
    await expect.poll(() => route(page)).toBe('main');
    await expect.poll(() => focused(page)).toBe('main-kickoff');
    // Again, backing out with K (Circle's key) this time.
    await walkTo(page, 'main-settings', () => page.keyboard.press('ArrowDown'));
    await page.keyboard.press('Enter');
    await expect.poll(() => route(page)).toBe('settings');
    await page.keyboard.press('KeyK');
    await expect.poll(() => route(page)).toBe('main');
    expect(errors).toEqual([]);
  });

  test('controller only: Cross starts, D-pad and stick move, Cross confirms, Circle goes back', async ({ page }) => {
    const errors = collectErrors(page);
    await page.addInitScript(MOCK_PAD);
    await page.goto('/');
    await expect(page.getByTestId('splash-start')).toBeVisible();
    await padTap(page, 0); // Cross: the pad's first press activates it and confirms "Tap to start"
    await expect(page.getByTestId('main-kickoff')).toBeVisible();
    const path = await walkTo(page, 'main-settings', () => padTap(page, 13)); // D-pad down
    expect(path.filter((p) => p !== 'main-kickoff')).toEqual(['main-modes', 'main-cup', 'main-settings']);
    // Left stick up then centre: one step up (no repeat for a short push).
    await padStick(page, 0, -1);
    await padStick(page, 0, 0);
    await expect.poll(() => focused(page)).toBe('main-cup');
    await padTap(page, 14 + 1); // D-pad right
    await expect.poll(() => focused(page)).toBe('main-online');
    await padTap(page, 14); // D-pad left
    await padTap(page, 13); // down
    await expect.poll(() => focused(page)).toBe('main-settings');
    await padTap(page, 0); // Cross
    await expect.poll(() => route(page)).toBe('settings');
    await expect.poll(() => focused(page)).toBe('settings-controls-editor');
    await padTap(page, 1); // Circle
    await expect.poll(() => route(page)).toBe('main');
    expect(await ring(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test('real DOM: group wrap, slider adjust without a native double step, tabs, recovery after removal', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('main-kickoff')).toBeVisible();
    await page.evaluate(() => {
      const root = document.createElement('div');
      root.id = 'pad08-root';
      root.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#07070d;display:flex;flex-direction:column;gap:16px;padding:40px';
      root.innerHTML = `
        <div data-tabs style="display:flex;gap:8px">
          <button data-testid="tab0" role="tab" aria-selected="true" style="min-height:60px">A</button>
          <button data-testid="tab1" role="tab" aria-selected="false" style="min-height:60px">B</button>
        </div>
        <div data-focus-group="y" style="display:flex;flex-direction:column;gap:8px;width:320px">
          <button data-testid="g0" data-focus-default style="min-height:60px">g0</button>
          <button data-testid="g1" style="min-height:60px">g1</button>
          <input data-testid="vol" type="range" min="0" max="10" value="5" data-focus data-focus-adjust style="height:60px">
        </div>`;
      const tabs = Array.from(root.querySelectorAll<HTMLElement>('[role="tab"]'));
      for (const t of tabs) t.addEventListener('click', () => { for (const o of tabs) o.setAttribute('aria-selected', String(o === t)); });
      document.body.append(root);
      window.__dotkick!.ctx.focus.attach(root);
    });
    await expect.poll(() => focused(page)).toBe('g0');
    await page.keyboard.press('ArrowUp'); // top of the group: wraps to its bottom
    await expect.poll(() => focused(page)).toBe('vol');
    await page.keyboard.press('ArrowRight');
    await frames(page, 3);
    expect(await page.evaluate(() => document.querySelector<HTMLInputElement>('[data-testid="vol"]')!.value)).toBe('6');
    expect(await focused(page)).toBe('vol');
    await page.keyboard.press('ArrowDown'); // bottom: wraps to the top
    await expect.poll(() => focused(page)).toBe('g0');
    await page.keyboard.press('KeyE'); // next tab
    await expect.poll(() => page.evaluate(() => document.querySelector('[data-testid="tab1"]')!.getAttribute('aria-selected'))).toBe('true');
    // The focused element disappears (a screen re-render): focus lands on a live control without any input.
    await page.evaluate(() => document.querySelector('[data-testid="g0"]')!.remove());
    await expect.poll(() => focused(page)).toBe('tab0');
    await page.evaluate(() => {
      const root = document.getElementById('pad08-root')!;
      window.__dotkick!.ctx.focus.detach(root);
      root.remove();
    });
    await expect.poll(() => focused(page)).toBe('main-kickoff');
    expect(errors).toEqual([]);
  });
});
