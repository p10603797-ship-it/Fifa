/**
 * Shared helpers for the UIX-03 / UIX-04 / UIX-05 e2e specs (pre-match flow: mode setup, team select, side select,
 * match settings, loading). Mocked pads: navigator.getGamepads is replaced by an init script with up to two
 * standard-mapping pads (window.__uixPads); padTap presses a button for exactly one menu poll.
 */
import { expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Screenshots (outside test-results/, which every Playwright run on the shared tree clears). */
export const SHOTS = process.env.UIX345_SHOTS || join(process.cwd(), 'tmp', 'uix-345');
mkdirSync(SHOTS, { recursive: true });

const GPU_ENVIRONMENT_NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/, /WebGL/];

export function collectConsole(page: Page): string[] {
  const out: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (GPU_ENVIRONMENT_NOISE.some((re) => re.test(text))) return;
    out.push(`${m.type()}: ${text}`);
  });
  page.on('pageerror', (e) => out.push(`pageerror: ${e.message}`));
  return out;
}

/** Init script: `n` mocked standard pads (PlayStation and Xbox ids), none pressed. */
export function mockPads(n: number): string {
  return `
  (() => {
    const ids = ['Mock DualSense (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', 'Mock Xbox Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'];
    window.__uixPads = Array.from({ length: ${n} }, (_, i) => ({
      id: ids[i % ids.length], index: i, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], vibrationActuator: null,
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    }));
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [...window.__uixPads, null, null, null].slice(0, 4) });
  })();
  `;
}

type PadsWin = { __uixPads: { buttons: { pressed: boolean; touched: boolean; value: number }[]; timestamp: number }[] };

/** Wait for n animation frames. */
export async function frames(page: Page, n = 2): Promise<void> {
  await page.evaluate((k) => new Promise<void>((res) => {
    let left = k;
    const step = (): void => { if (--left <= 0) res(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }), n);
}

/** Press button b of pad `pad` for exactly one poll (released in the next animation frame). */
export async function padTap(page: Page, b: number, pad = 0): Promise<void> {
  await page.evaluate(([i, p]) => new Promise<void>((res) => {
    const pads = (window as unknown as PadsWin).__uixPads;
    pads[p]!.buttons[i] = { pressed: true, touched: true, value: 1 };
    pads[p]!.timestamp++;
    requestAnimationFrame(() => {
      pads[p]!.buttons[i] = { pressed: false, touched: false, value: 0 };
      pads[p]!.timestamp++;
      res();
    });
  }), [b, pad] as const);
  await frames(page, 2);
}

/** Standard Gamepad buttons. */
export const PAD = { A: 0, B: 1, X: 2, Y: 3, L1: 4, R1: 5, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } as const;

export const route = (page: Page): Promise<string | null> => page.evaluate(() => window.__dotkick!.ctx.router.current);
export const focused = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.querySelector<HTMLElement>('[data-focused]')?.dataset.testid ?? null);

/** Record every ctx.router.go (screen id + a JSON copy of its params). */
export async function recordNavigation(page: Page): Promise<void> {
  await page.evaluate(() => {
    const r = window.__dotkick!.ctx.router as unknown as { go(id: string, p?: Record<string, unknown>): void };
    const log: [string, unknown][] = [];
    const go = r.go.bind(r);
    r.go = (id, p) => {
      let copy: unknown = null;
      try {
        copy = p ? JSON.parse(JSON.stringify(p)) : null;
      } catch {
        copy = 'unserialisable';
      }
      log.push([id, copy]);
      go(id, p);
    };
    (window as unknown as { __uixNav: typeof log }).__uixNav = log;
  });
}

export interface NavParams {
  mode?: number;
  setup?: {
    config: Record<string, unknown> & { humans: { kind: number; side: number }[] };
    bindings: { human: number; deviceIds: string[] }[];
  };
}

/** Params of the latest recorded navigation to `id`. */
export async function navParams(page: Page, id: string): Promise<NavParams | null> {
  return page.evaluate((want) => {
    const log = (window as unknown as { __uixNav?: [string, unknown][] }).__uixNav ?? [];
    for (let i = log.length - 1; i >= 0; i--) if (log[i]![0] === want) return log[i]![1] as NavParams;
    return null;
  }, id);
}

/** Splash -> main by a tap (touch) or a key (keyboard). */
export async function toMain(page: Page, by: 'touch' | 'key' | 'pad'): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('splash-start')).toBeVisible();
  if (by === 'touch') await page.touchscreen.tap(40, 410);
  else if (by === 'key') await page.keyboard.press('KeyG');
  else {
    await frames(page, 3);
    await padTap(page, PAD.Y);
  }
  await expect.poll(() => route(page)).toBe('main');
}

/** Press until `want` has the focus. */
export async function walkTo(page: Page, want: string, press: () => Promise<void>, max = 12): Promise<void> {
  for (let i = 0; i < max && (await focused(page)) !== want; i++) {
    await press();
    await frames(page);
  }
  expect(await focused(page)).toBe(want);
}

export interface LayoutReport {
  small: string[];
  outside: string[];
  overlaps: string[];
  count: number;
}

/** Every visible control of the current screen: >= 60 x 60, inside the viewport, no overlaps; no page scroll. */
export async function checkLayout(page: Page): Promise<LayoutReport> {
  return page.evaluate(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const els = Array.from(document.querySelectorAll<HTMLElement>('#ui [data-focus], #ui button'));
    const rects: { id: string; r: DOMRect }[] = [];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
      if (el.closest('.toast, .tst, [role="status"]')) continue;
      rects.push({ id: el.dataset.testid ?? el.getAttribute('aria-label') ?? el.textContent ?? '?', r });
    }
    const small: string[] = [], outside: string[] = [], overlaps: string[] = [];
    for (const { id, r } of rects) {
      if (r.width < 59.5 || r.height < 59.5) small.push(`${id} ${Math.round(r.width)}x${Math.round(r.height)}`);
      if (r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5) {
        outside.push(`${id} ${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}`);
      }
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!.r, b = rects[j]!.r;
        const nested = false;
        if (!nested && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) {
          overlaps.push(`${rects[i]!.id} x ${rects[j]!.id}`);
        }
      }
    }
    if (document.scrollingElement && document.scrollingElement.scrollHeight > vh + 1) outside.push('page scrolls');
    return { small, outside, overlaps, count: rects.length };
  });
}

export function expectCleanLayout(r: LayoutReport, label: string): void {
  expect(r.small, `${label}: controls under 60 pt`).toEqual([]);
  expect(r.outside, `${label}: controls outside the viewport`).toEqual([]);
  expect(r.overlaps, `${label}: overlapping controls`).toEqual([]);
  expect(r.count, `${label}: controls found`).toBeGreaterThan(0);
}

export const VIEWPORTS = [
  { w: 1180, h: 820, name: 'ipad-1180x820' },
  { w: 1024, h: 768, name: '4x3-1024x768' },
  { w: 1680, h: 720, name: '21x9-1680x720' },
  { w: 1260, h: 540, name: '21x9-1260x540' },
] as const;

/** Open a flow screen directly with fresh flow params built by the app (mode-setup's own route helper). */
export async function openMode(page: Page, mode: number): Promise<void> {
  await page.evaluate((m) => window.__dotkick!.ctx.router.go('mode-setup', { mode: m }), mode);
  await expect.poll(() => route(page)).toBe('mode-setup');
}

export async function shot(page: Page, name: string): Promise<void> {
  await frames(page, 2);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}
