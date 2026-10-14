/**
 * PAD-08 e2e: menu navigation through the real app (FocusNavigator + menu input + router) with the keyboard alone and
 * with a mocked pad alone (navigator.getGamepads overridden by an init script): splash -> main menu -> Settings ->
 * Back, a visible focus ring, a sensible focus order. A third test drives a real-DOM panel attached to the app's
 * navigator: focus-group wrap, slider adjust (no native double step), tabs, and recovery when the focused element is
 * removed (MutationObserver), and the ring following native focus moved by the Tab key.
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

type Dir = 'up' | 'down' | 'left' | 'right';

/** Directions from the focused control toward `want` by geometry: the dominant axis first, then the other one. */
function dirsToward(page: Page, want: string): Promise<Dir[]> {
  return page.evaluate((id) => {
    const c = document.querySelector<HTMLElement>('[data-focused]')!.getBoundingClientRect();
    const t = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.getBoundingClientRect();
    const dx = (t.left + t.right - c.left - c.right) / 2, dy = (t.top + t.bottom - c.top - c.bottom) / 2;
    const h: Dir = dx > 0 ? 'right' : 'left', v: Dir = dy > 0 ? 'down' : 'up';
    const out: Dir[] = Math.abs(dx) > Math.abs(dy) ? [h, v] : [v, h];
    return out.filter((d) => ((d === 'left' || d === 'right') ? Math.abs(dx) > 1 : Math.abs(dy) > 1));
  }, want);
}

/**
 * Steer focus to `want` with directional presses only (layout-agnostic: the screens belong to other modules): each
 * press goes toward the target, the first press with a hidden ring only reveals it, and every later press must move
 * focus. When a press lands somewhere already visited (a group wrapped), the next press tries the other axis.
 * Returns the focus path.
 */
async function seek(page: Page, want: string, press: (d: Dir) => Promise<void>, max = 12): Promise<string[]> {
  const path: string[] = [];
  const seen = new Set<string>([(await focused(page)) ?? '']);
  let preferOther = false;
  if (!(await ring(page))) {
    await press((await dirsToward(page, want))[0] ?? 'down');
    await expect.poll(() => ring(page)).toBe(true);
  }
  for (let i = 0; i < max && (await focused(page)) !== want; i++) {
    const before = await focused(page);
    const dirs = await dirsToward(page, want);
    const d = (preferOther && dirs.length > 1 ? dirs[1] : dirs[0]) ?? 'down';
    await press(d);
    await expect.poll(() => focused(page), `press ${d} from ${before} moves focus`).not.toBe(before);
    const now = (await focused(page)) ?? '';
    preferOther = seen.has(now);
    seen.add(now);
    path.push(now);
  }
  expect(await focused(page), `reached ${want} by ${path.join(' > ')}`).toBe(want);
  return path;
}

const KEY_OF: Record<Dir, string> = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
const DPAD_OF: Record<Dir, number> = { up: 12, down: 13, left: 14, right: 15 };

/** Id of the focused control inside the mounted screen `screen` (null when focus is elsewhere). */
const focusedIn = (page: Page, screen: string): Promise<string | null> =>
  page.evaluate((id) => document.querySelector<HTMLElement>(`[data-screen="${id}"] [data-focused]`)?.dataset.testid ?? null, screen);

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
    await expect.poll(() => focusedIn(page, 'main')).not.toBeNull(); // initial focus without any input
    await seek(page, 'main-settings', (d) => page.keyboard.press(KEY_OF[d]));
    expect(await ring(page)).toBe(true);
    await page.keyboard.press('Enter');
    await expect.poll(() => route(page)).toBe('settings');
    await expect.poll(() => focusedIn(page, 'settings')).not.toBeNull();
    const first = await focused(page);
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => focused(page)).not.toBe(first);
    expect(await focusedIn(page, 'settings')).not.toBeNull();
    await page.keyboard.press('Escape');
    await expect.poll(() => route(page)).toBe('main');
    await expect.poll(() => focusedIn(page, 'main')).not.toBeNull();
    // Again, backing out with K (Circle's key) this time.
    await seek(page, 'main-settings', (d) => page.keyboard.press(KEY_OF[d]));
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
    await expect.poll(() => focusedIn(page, 'main')).not.toBeNull();
    await seek(page, 'main-settings', (d) => padTap(page, DPAD_OF[d]));
    await padTap(page, 0); // Cross
    await expect.poll(() => route(page)).toBe('settings');
    await expect.poll(() => focusedIn(page, 'settings')).not.toBeNull();
    const first = await focused(page);
    await padTap(page, 13); // D-pad down
    await expect.poll(() => focused(page)).not.toBe(first);
    await padTap(page, 1); // Circle
    await expect.poll(() => route(page)).toBe('main');
    await expect.poll(() => focusedIn(page, 'main')).not.toBeNull();
    expect(await ring(page)).toBe(true);
    // Left stick on a panel of known layout: a short push is one step (no repeat), then it must pass the centre.
    await page.evaluate(() => {
      const root = document.createElement('div');
      root.id = 'pad08-stick';
      root.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#07070d;display:flex;flex-direction:column;gap:16px;padding:40px';
      root.innerHTML = ['s0', 's1', 's2', 's3'].map((id) => `<button data-testid="${id}" style="min-height:60px;width:300px">${id}</button>`).join('');
      document.body.append(root);
      window.__dotkick!.ctx.focus.attach(root);
    });
    await expect.poll(() => focused(page)).toBe('s0');
    await padStick(page, 0, 1);
    await padStick(page, 0, 0);
    await expect.poll(() => focused(page)).toBe('s1');
    await frames(page, 3);
    expect(await focused(page)).toBe('s1');
    await padStick(page, 0.1, -0.9); // up (dominant axis), once
    await padStick(page, 0, 0);
    await expect.poll(() => focused(page)).toBe('s0');
    await page.evaluate(() => {
      const root = document.getElementById('pad08-stick')!;
      window.__dotkick!.ctx.focus.detach(root);
      root.remove();
    });
    await expect.poll(() => focusedIn(page, 'main')).not.toBeNull();
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
    // Tab moves native focus: the ring follows it, and Enter activates that control (not the old ring holder).
    await page.evaluate(() => {
      const g1 = document.querySelector<HTMLElement>('[data-testid="g1"]')!;
      g1.addEventListener('click', () => { g1.dataset.clicks = String(Number(g1.dataset.clicks ?? 0) + 1); });
    });
    await page.keyboard.press('Tab');
    await expect.poll(() => focused(page)).toBe('tab1');
    await page.keyboard.press('Tab');
    await expect.poll(() => focused(page)).toBe('g1');
    expect(await ring(page)).toBe(true);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => document.querySelector<HTMLElement>('[data-testid="g1"]')!.dataset.clicks)).toBe('1');
    await page.evaluate(() => {
      const root = document.getElementById('pad08-root')!;
      window.__dotkick!.ctx.focus.detach(root);
      root.remove();
    });
    await expect.poll(() => focused(page)).toBe('main-kickoff');
    expect(errors).toEqual([]);
  });
});
