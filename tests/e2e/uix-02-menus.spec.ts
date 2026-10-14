/**
 * UIX-02 e2e: splash and main menu through the real app (router, FocusNavigator, menu input, session).
 *  - splash -> main by touch (tap anywhere), by keyboard (any key) and by controller (any button, also one outside
 *    the menu map); the starting press never also confirms on the main menu;
 *  - every main menu entry routes to its screen (with the mode param for mode-setup) and Back returns, by touch, by
 *    keyboard alone and by controller alone, with the focus back on the entry that opened the screen;
 *  - quick play: tap to start + Play now reaches a running match within a few seconds;
 *  - layout at iPad landscape (1180x820), 4:3 (1024x768, 1366x1024), 21:9 (1680x720, 1260x540) and a small window
 *    (640x360): every control >= 60 pt, inside the viewport and 24 pt clear of the top and bottom edges, no overlaps,
 *    no scrolling; screenshots in tmp/uix-02/ (or $UIX02_SHOTS);
 *  - iPad in a Safari tab: the Add to Home Screen hint shows once; Play full screen requests full screen; neither
 *    shows in the Home Screen app (standalone).
 *
 *   npx vite build --outDir dist-e2e/uix-02 --emptyOutDir
 *   PW_DIST=dist-e2e/uix-02 PW_PORT=4262 npx playwright test tests/e2e/uix-02-menus.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Screenshots (outside test-results/, which every Playwright run on the shared tree clears). */
const SHOTS = process.env.UIX02_SHOTS || join(process.cwd(), 'tmp', 'uix-02');
mkdirSync(SHOTS, { recursive: true });

/** Chromium's own messages about the container's software GPU (not from page scripts; absent on real devices). */
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

const MOCK_PAD = `
  window.__uix02pad = {
    id: 'Mock Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', index: 0, connected: true, mapping: 'standard',
    timestamp: 0, axes: [0, 0, 0, 0], vibrationActuator: null,
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [window.__uix02pad, null, null, null] });
`;
type PadWin = { __uix02pad: { buttons: { pressed: boolean; touched: boolean; value: number }[] } };

const IPAD_SAFARI_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/** Main menu entries: test id -> [route, mode param or null]. Mirrors src/ui/screens/main.ts MAIN_*_ENTRIES. */
const MODE_ENTRIES: readonly (readonly [string, string, number | null])[] = [
  ['main-mode-kickoff', 'mode-setup', 0], // ModeId.KICK_OFF
  ['main-friend', 'mode-setup', 1], // ModeId.FRIEND_LOCAL
  ['main-cup', 'cup', null],
  ['main-shootout', 'mode-setup', 4], // ModeId.SHOOT_OUT
  ['main-practice', 'practice', null],
];
const UTILITY_ENTRIES: readonly (readonly [string, string, number | null])[] = [
  ['main-settings', 'settings', null],
  ['main-diagnostics', 'diagnostics', null],
];

const route = (page: Page): Promise<string | null> => page.evaluate(() => window.__dotkick!.ctx.router.current);
const stack = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window.__dotkick!.app.router.stack as readonly string[]).slice());
const focused = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.querySelector<HTMLElement>('[data-focused]')?.dataset.testid ?? null);
const ring = (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.hasAttribute('data-focus-visible'));
const sessionActive = (page: Page): Promise<boolean> => page.evaluate(() => window.__dotkick!.ctx.session.active);

/** Wait for n animation frames (menu input and screen.onFrame run once per frame). */
async function frames(page: Page, n = 2): Promise<void> {
  await page.evaluate((k) => new Promise<void>((res) => {
    let left = k;
    const step = (): void => { if (--left <= 0) res(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }), n);
}

/** Record every ctx.router.go (screen id + params) made from now on. */
async function recordNavigation(page: Page): Promise<void> {
  await page.evaluate(() => {
    const r = window.__dotkick!.ctx.router as unknown as { go(id: string, p?: Record<string, unknown>): void };
    const log: [string, Record<string, unknown> | null][] = [];
    const go = r.go.bind(r);
    r.go = (id, p) => { log.push([id, p ? { ...p } : null]); go(id, p); };
    (window as unknown as { __uix02nav: typeof log }).__uix02nav = log;
  });
}
const lastNav = (page: Page): Promise<[string, Record<string, unknown> | null] | null> =>
  page.evaluate(() => {
    const log = (window as unknown as { __uix02nav?: [string, Record<string, unknown> | null][] }).__uix02nav ?? [];
    return log.length ? log[log.length - 1]! : null;
  });

/**
 * Press button b for exactly one menu poll: pressed now, released in the next animation frame after the app loop's
 * own callback (registered first) has polled it. A hold over two slow frames could pass the menu repeat delay on a
 * loaded machine and step twice.
 */
async function padTap(page: Page, b: number): Promise<void> {
  await page.evaluate((i) => new Promise<void>((res) => {
    const pad = (window as unknown as PadWin).__uix02pad;
    pad.buttons[i] = { pressed: true, touched: true, value: 1 };
    requestAnimationFrame(() => {
      pad.buttons[i] = { pressed: false, touched: false, value: 0 };
      res();
    });
  }), b);
  await frames(page, 2);
}

/** Press until `want` has the focus; returns the focus after each press. */
async function walkTo(page: Page, want: string, press: () => Promise<void>, max = 8): Promise<string[]> {
  const path: string[] = [];
  for (let i = 0; i < max && (await focused(page)) !== want; i++) {
    await press();
    await frames(page);
    path.push((await focused(page)) ?? '');
  }
  expect(await focused(page)).toBe(want);
  return path;
}

async function expectEntryRoute(page: Page, id: string, want: string, mode: number | null): Promise<void> {
  await expect.poll(() => route(page)).toBe(want);
  const nav = await lastNav(page);
  expect(nav?.[0]).toBe(want);
  if (mode === null) expect(nav?.[1] ?? {}).toEqual({});
  else expect(nav?.[1]).toEqual({ mode });
  expect(await stack(page), `stack after ${id}`).toEqual(['main', want]);
}

interface LayoutReport {
  small: string[];
  outside: string[];
  overlaps: string[];
  count: number;
}

/** Every visible control of the current screen: >= 60 x 60, inside the viewport (24 pt clear of the top and bottom), no overlaps. */
async function checkLayout(page: Page): Promise<LayoutReport> {
  return page.evaluate(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const els = Array.from(document.querySelectorAll<HTMLElement>('#ui [data-focus], #ui button'));
    const rects: { id: string; r: DOMRect }[] = [];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
      rects.push({ id: el.dataset.testid ?? el.textContent ?? '?', r });
    }
    const small: string[] = [], outside: string[] = [], overlaps: string[] = [];
    for (const { id, r } of rects) {
      if (r.width < 60 || r.height < 60) small.push(`${id} ${Math.round(r.width)}x${Math.round(r.height)}`);
      // Inside the viewport, and 24 pt clear of the top corners and the bottom edge (system gestures, BRIEF section 3).
      if (r.left < 0 || r.top < 24 || r.right > vw + 0.5 || r.bottom > vh - 24 + 0.5) {
        outside.push(`${id} ${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}`);
      }
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!.r, b = rects[j]!.r;
        if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) {
          overlaps.push(`${rects[i]!.id} x ${rects[j]!.id}`);
        }
      }
    }
    return { small, outside, overlaps, count: rects.length };
  });
}

test.describe('UIX-02 splash and main menu', () => {
  test('touch alone: tap anywhere starts; every entry opens its screen and Back returns', async ({ page }) => {
    const messages = collectConsole(page);
    await page.goto('/');
    await expect(page.getByTestId('splash-start')).toBeVisible();
    await page.screenshot({ path: join(SHOTS, 'splash-1180x820.png') });
    // A tap on empty space, away from the buttons.
    await page.touchscreen.tap(40, 410);
    await expect.poll(() => route(page)).toBe('main');
    expect(await stack(page)).toEqual(['main']);
    expect(await ring(page)).toBe(false); // touch players never see the focus ring
    await expect(page.getByTestId('main-kickoff')).toBeVisible();
    await expect(page.getByTestId('main-play-meta')).toHaveText(/ min · /);
    await page.screenshot({ path: join(SHOTS, 'main-1180x820.png') });
    // The tap that started was one action only: nothing else happened on the main menu.
    await frames(page, 4);
    expect(await sessionActive(page)).toBe(false);

    await recordNavigation(page);
    for (const [id, want, mode] of [...MODE_ENTRIES, ...UTILITY_ENTRIES]) {
      await page.getByTestId(id).tap();
      await expectEntryRoute(page, id, want, mode);
      if (id === 'main-mode-kickoff') await page.screenshot({ path: join(SHOTS, 'after-kickoff-entry.png') });
      // Back by touch: the screen's Back button where it has one, else the Safari edge swipe (history back).
      const back = page.getByTestId('back');
      if ((await back.count()) > 0 && (await back.first().isVisible())) await back.first().tap();
      else await page.goBack();
      await expect.poll(() => route(page), `Back from ${id}`).toBe('main');
      expect(await stack(page)).toEqual(['main']);
    }
    expect(messages).toEqual([]);
  });

  test('keyboard alone: any key starts without leaking; arrows walk a sensible order; Enter opens, Escape returns', async ({ page }) => {
    const messages = collectConsole(page);
    await page.goto('/');
    await expect(page.getByTestId('splash-start')).toBeVisible();
    // Modifiers and the debug overlay key do not start.
    await page.keyboard.press('Shift');
    await frames(page, 3);
    expect(await route(page)).toBe('splash');
    await page.keyboard.press('KeyG');
    await expect.poll(() => route(page)).toBe('main');
    await expect.poll(() => focused(page)).toBe('main-kickoff');
    expect(await ring(page)).toBe(true); // a keyboard player sees where the focus is
    await page.waitForTimeout(300);
    expect(await sessionActive(page)).toBe(false);
    expect(await route(page)).toBe('main');

    // Order: Play now -> Right enters the modes at the top -> Down through the list (wraps) -> Left back to Play now.
    const order = await walkTo(page, 'main-practice', async () => {
      const f = await focused(page);
      await page.keyboard.press(f === 'main-kickoff' ? 'ArrowRight' : 'ArrowDown');
    });
    expect(order).toEqual(['main-mode-kickoff', 'main-friend', 'main-cup', 'main-shootout', 'main-practice']);
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => focused(page)).toBe('main-mode-kickoff'); // the list wraps
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => focused(page)).toBe('main-kickoff');
    await page.keyboard.press('ArrowDown'); // Down from Play now also enters the list at the top
    await expect.poll(() => focused(page)).toBe('main-mode-kickoff');
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => focused(page)).toBe('main-kickoff');
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => focused(page)).toBe('main-settings'); // the top bar
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => focused(page)).toBe('main-diagnostics');
    await page.screenshot({ path: join(SHOTS, 'main-keyboard-focus.png') });

    await recordNavigation(page);
    // Every mode: Enter opens it, Escape returns with the focus on the same entry; Down reaches the next one.
    // From the top bar: Down lands in the content (Play now or the first mode), Right from Play now enters the list.
    await walkTo(page, 'main-mode-kickoff', async () => {
      const f = await focused(page);
      await page.keyboard.press(f === 'main-kickoff' ? 'ArrowRight' : 'ArrowDown');
    }, 3);
    for (let i = 0; i < MODE_ENTRIES.length; i++) {
      const [id, want, mode] = MODE_ENTRIES[i]!;
      if (i > 0) await walkTo(page, id, () => page.keyboard.press('ArrowDown'));
      await page.keyboard.press('Enter');
      await expectEntryRoute(page, id, want, mode);
      await page.keyboard.press('Escape');
      await expect.poll(() => route(page), `Escape from ${id}`).toBe('main');
      await expect.poll(() => focused(page), `focus restored to ${id}`).toBe(id);
    }
    // Settings and Diagnostics from the top bar.
    for (const [id, want, mode] of UTILITY_ENTRIES) {
      await walkTo(page, id, async () => {
        const f = await focused(page);
        if (f === 'main-kickoff') await page.keyboard.press('ArrowUp');
        else if (f?.startsWith('main-') && MODE_ENTRIES.some((e) => e[0] === f)) await page.keyboard.press('ArrowLeft');
        else await page.keyboard.press(id === 'main-settings' ? 'ArrowRight' : 'ArrowLeft');
      });
      await page.keyboard.press('Enter');
      await expectEntryRoute(page, id, want, mode);
      await page.keyboard.press('Escape');
      await expect.poll(() => route(page)).toBe('main');
      await expect.poll(() => focused(page)).toBe(id);
    }
    expect(messages).toEqual([]);
  });

  test('controller alone: a button outside the menu map starts; D-pad, Cross and Circle drive the menu', async ({ page }) => {
    const messages = collectConsole(page);
    await page.addInitScript(MOCK_PAD);
    await page.goto('/');
    await expect(page.getByTestId('splash-start')).toBeVisible();
    await frames(page, 3);
    await padTap(page, 3); // Triangle / Y: not a menu action; the splash reads it from the pad manager
    await expect.poll(() => route(page)).toBe('main');
    await expect.poll(() => focused(page)).toBe('main-kickoff');
    expect(await ring(page)).toBe(true);
    await frames(page, 4);
    expect(await sessionActive(page)).toBe(false);

    await recordNavigation(page);
    await padTap(page, 15); // D-pad right: into the modes at the top
    await expect.poll(() => focused(page)).toBe('main-mode-kickoff');
    await padTap(page, 0); // Cross
    await expectEntryRoute(page, 'main-mode-kickoff', 'mode-setup', 0);
    await padTap(page, 1); // Circle
    await expect.poll(() => route(page)).toBe('main');
    await expect.poll(() => focused(page)).toBe('main-mode-kickoff');
    for (const [id, want, mode] of MODE_ENTRIES.slice(1)) {
      await padTap(page, 13); // D-pad down
      await expect.poll(() => focused(page)).toBe(id);
      await padTap(page, 0);
      await expectEntryRoute(page, id, want, mode);
      await padTap(page, 1);
      await expect.poll(() => route(page), `Circle from ${id}`).toBe('main');
      await expect.poll(() => focused(page)).toBe(id);
    }
    await padTap(page, 14); // D-pad left: back to Play now
    await expect.poll(() => focused(page)).toBe('main-kickoff');
    await padTap(page, 12); // D-pad up: Settings in the top bar
    await expect.poll(() => focused(page)).toBe('main-settings');
    await padTap(page, 0);
    await expectEntryRoute(page, 'main-settings', 'settings', null);
    await padTap(page, 1);
    await expect.poll(() => route(page)).toBe('main');
    expect(messages).toEqual([]);
  });

  test('controller alone: Cross and Options also start, once (the press does not reach the main menu)', async ({ page }) => {
    const messages = collectConsole(page);
    await page.addInitScript(MOCK_PAD);
    for (const button of [0, 9]) { // Cross / A (a menu action), Options / Menu (the pause button)
      await page.goto('/');
      await expect(page.getByTestId('splash-start')).toBeVisible();
      await frames(page, 3);
      await padTap(page, button);
      await expect.poll(() => route(page), `button ${button}`).toBe('main');
      await frames(page, 6);
      expect(await route(page)).toBe('main');
      expect(await sessionActive(page)).toBe(false);
      expect(await focused(page)).toBe('main-kickoff');
      expect(await ring(page)).toBe(true);
    }
    expect(messages).toEqual([]);
  });

  test('quick play: tap to start and Play now reach a running match within a few seconds', async ({ page }) => {
    const messages = collectConsole(page);
    await page.goto('/');
    await expect(page.getByTestId('splash-start')).toBeVisible();
    const t0 = Date.now();
    await page.getByTestId('splash-start').tap(); // tap 1
    await page.getByTestId('main-kickoff').tap(); // tap 2
    await page.waitForFunction(() => {
      const d = window.__dotkick!;
      return d.ctx.router.current === 'match' && (d.ctx.session.getState()?.tick ?? 0) > 0;
    }, null, { timeout: 30_000 });
    const ms = Date.now() - t0;
    test.info().annotations.push({ type: 'quick-play-ms', description: String(ms) });
    console.log(`[uix-02] splash -> running match in ${ms} ms (2 taps, software WebGL)`);
    expect(ms).toBeLessThan(15_000);
    const cfg = await page.evaluate(() => {
      const s = window.__dotkick!.ctx.session.getState()!;
      const m = window.__dotkick!.ctx.settings.get().match;
      return { home: s.config.homeClub, away: s.config.awayClub, half: s.config.halfMinutes, wantHome: m.homeClub, wantAway: m.awayClub };
    });
    expect(cfg.home).toBe(cfg.wantHome);
    expect(cfg.away).toBe(cfg.wantAway);
    await page.screenshot({ path: join(SHOTS, 'quick-play-match.png') });
    expect(messages).toEqual([]);
  });

  test('layout at iPad, 4:3 and 21:9: controls >= 60 pt, inside the viewport, no overlaps', async ({ page }) => {
    const messages = collectConsole(page);
    const sizes = [
      { w: 1180, h: 820, name: 'ipad' },
      { w: 1024, h: 768, name: '4x3' },
      { w: 1366, h: 1024, name: '4x3-large' },
      { w: 1680, h: 720, name: '21x9' },
      { w: 1260, h: 540, name: '21x9-short' },
      { w: 640, h: 360, name: 'small-window' }, // a small Stage Manager window, above the minimum playable size
    ];
    for (const s of sizes) {
      await page.setViewportSize({ width: s.w, height: s.h });
      await page.goto('/');
      await expect(page.getByTestId('splash-start')).toBeVisible();
      const splash = await checkLayout(page);
      expect(splash, `splash ${s.name}`).toEqual({ small: [], outside: [], overlaps: [], count: splash.count });
      await page.screenshot({ path: join(SHOTS, `splash-${s.name}.png`) });
      await page.getByTestId('splash-start').tap();
      await expect(page.getByTestId('main-kickoff')).toBeVisible();
      const main = await checkLayout(page);
      expect(main, `main ${s.name}`).toEqual({ small: [], outside: [], overlaps: [], count: 8 });
      // The wordmark, the quick match and the modes are on screen without scrolling or clipping.
      const scroll = await page.evaluate(() => {
        const l = document.querySelector<HTMLElement>('.main-layout')!;
        return [l.scrollHeight - l.clientHeight, l.scrollWidth - l.clientWidth];
      });
      expect(scroll, `main ${s.name} needs no scrolling`).toEqual([0, 0]);
      await page.screenshot({ path: join(SHOTS, `main-${s.name}.png`) });
    }
    expect(messages).toEqual([]);
  });
});

test.describe('UIX-02 on an iPad in a Safari tab', () => {
  test.use({ userAgent: IPAD_SAFARI_UA });

  test('Add to Home Screen hint shows once; Play full screen requests full screen and starts', async ({ page }) => {
    const messages = collectConsole(page);
    await page.addInitScript(() => {
      const calls: string[] = [];
      (window as unknown as { __uix02fs: string[] }).__uix02fs = calls;
      Element.prototype.requestFullscreen = function (this: Element) {
        calls.push(this.tagName);
        return Promise.resolve();
      };
    });
    await page.goto('/');
    await expect(page.getByTestId('splash-a2hs')).toBeVisible();
    await expect(page.getByTestId('splash-a2hs')).toContainText('Add to Home Screen');
    await expect(page.getByTestId('splash-fullscreen')).toBeVisible();
    expect(await checkLayout(page)).toMatchObject({ small: [], outside: [], overlaps: [] });
    await page.screenshot({ path: join(SHOTS, 'splash-ipad-tab.png') });
    await page.getByTestId('splash-fullscreen').tap();
    await expect.poll(() => route(page)).toBe('main');
    expect(await page.evaluate(() => (window as unknown as { __uix02fs: string[] }).__uix02fs)).toEqual(['HTML']);
    expect(await page.evaluate(() => window.__dotkick!.ctx.settings.get().homeScreenHintShown)).toBe(true);
    // Shown once: the next visit has no hint (the setting persisted), the full-screen offer stays.
    await page.reload();
    await expect(page.getByTestId('splash-start')).toBeVisible();
    await expect(page.getByTestId('splash-fullscreen')).toBeVisible();
    expect(await page.getByTestId('splash-a2hs').count()).toBe(0);
    // From a keyboard, F is the full-screen start.
    await page.keyboard.press('KeyF');
    await expect.poll(() => route(page)).toBe('main');
    expect(await page.evaluate(() => (window as unknown as { __uix02fs: string[] }).__uix02fs)).toEqual(['HTML']);
    expect(messages).toEqual([]);
  });

  test('Home Screen app (standalone): no hint and no full-screen button', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    });
    await page.goto('/');
    await expect(page.getByTestId('splash-start')).toBeVisible();
    expect(await page.evaluate(() => window.__dotkick!.ctx.platform.isStandalone)).toBe(true);
    expect(await page.getByTestId('splash-a2hs').count()).toBe(0);
    expect(await page.getByTestId('splash-fullscreen').count()).toBe(0);
  });
});
