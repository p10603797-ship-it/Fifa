/**
 * INT-B e2e helpers (not a spec): mocked gamepads (navigator.getGamepads over window.__intbPads, plug / unplug by
 * index), real touch through CDP (taps, drags, a held stick), frame waits, the app's route / state probes, a match
 * clock fast-forward and a console collector that ignores the container's software-GPU noise.
 *
 *   npx vite build --outDir dist-e2e/int-b --emptyOutDir
 *   PW_DIST=dist-e2e/int-b PW_PORT=4317 npx playwright test tests/e2e/int-b-*.spec.ts
 *
 * Screenshots go to tmp/int-b/ (outside test-results/, which every Playwright run on the shared tree clears).
 */
import { expect, type CDPSession, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const SHOTS = join(process.cwd(), 'tmp', 'int-b');
mkdirSync(SHOTS, { recursive: true });

/** Standard-mapping button indices. */
export const PAD = {
  CROSS: 0, CIRCLE: 1, SQUARE: 2, TRIANGLE: 3, L1: 4, R1: 5, L2: 6, R2: 7, SHARE: 8, OPTIONS: 9,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
} as const;

/** Init script: up to four mock pads; `count` start connected. Unplugged pads read as null. */
export function padInit(count: number): string {
  return `
    (() => {
      const mk = (i) => ({
        id: 'Mock Controller ' + i + ' (STANDARD GAMEPAD Vendor: 045e Product: 0b1' + i + ')', index: i, connected: true,
        mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], vibrationActuator: null,
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
      });
      const pads = [mk(0), mk(1), mk(2), mk(3)];
      for (let i = ${count}; i < 4; i++) pads[i].connected = false;
      window.__intbPads = pads;
      Object.defineProperty(navigator, 'getGamepads', {
        configurable: true,
        value: () => pads.map((p) => (p.connected ? p : null)),
      });
    })();
  `;
}

type PadWin = { __intbPads: { connected: boolean; timestamp: number; axes: number[]; buttons: { pressed: boolean; touched: boolean; value: number }[] }[] };

/** Chromium's own messages about the container's software GPU (not from page scripts; absent on real devices). */
const GPU_NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/, /GPU stall due to ReadPixels/];

export function collectConsole(page: Page): string[] {
  const out: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const text = m.text();
    if (GPU_NOISE.some((re) => re.test(text))) return;
    out.push(`${m.type()}: ${text}`);
  });
  page.on('pageerror', (e) => out.push(`pageerror: ${e.message}`));
  return out;
}

export async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** Wait `n` animation frames. */
export async function frames(page: Page, n = 2): Promise<void> {
  await page.evaluate((k) => new Promise<void>((res) => {
    let left = k;
    const step = (): void => { if (--left <= 0) res(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }), n);
}

export const route = (page: Page): Promise<string | null> => page.evaluate(() => window.__dotkick?.ctx.router.current ?? null);


export async function waitRoute(page: Page, id: string, timeout = 45_000): Promise<void> {
  await expect.poll(() => route(page), { timeout, message: `route ${id}` }).toBe(id);
}

/** Wait for a live match: on 'match' with a state. */
export async function waitMatch(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const d = window.__dotkick;
    return !!d && d.ctx.router.current === 'match' && d.ctx.session.getState() !== null;
  }, null, { timeout: 60_000 });
}

// ------------------------------------------------------------------ pads

export async function padButton(page: Page, pad: number, b: number, down: boolean): Promise<void> {
  await page.evaluate(([p, i, d]) => {
    const w = window as unknown as PadWin;
    w.__intbPads[p as number]!.buttons[i as number] = { pressed: d as boolean, touched: d as boolean, value: d ? 1 : 0 };
    w.__intbPads[p as number]!.timestamp++;
  }, [pad, b, down] as const);
}

/** Press and release one button with a few frames in between (one edge each way). */
export async function padTap(page: Page, pad: number, b: number, holdFrames = 3): Promise<void> {
  await padButton(page, pad, b, true);
  await frames(page, holdFrames);
  await padButton(page, pad, b, false);
  await frames(page, 3);
}

export async function padStick(page: Page, pad: number, x: number, y: number): Promise<void> {
  await page.evaluate(([p, ax, ay]) => {
    const w = window as unknown as PadWin;
    w.__intbPads[p as number]!.axes[0] = ax as number;
    w.__intbPads[p as number]!.axes[1] = ay as number;
    w.__intbPads[p as number]!.timestamp++;
  }, [pad, x, y] as const);
}

export async function plugPad(page: Page, pad: number, on: boolean): Promise<void> {
  await page.evaluate(([p, c]) => {
    const w = window as unknown as PadWin;
    w.__intbPads[p as number]!.connected = c as boolean;
    if (!c) {
      for (const b of w.__intbPads[p as number]!.buttons) { b.pressed = false; b.touched = false; b.value = 0; }
    }
  }, [pad, on] as const);
  await frames(page, 3);
}

// ------------------------------------------------------------------ touch (CDP)

export class Touch {
  private constructor(private readonly cdp: CDPSession) {}

  static async open(page: Page): Promise<Touch> {
    return new Touch(await page.context().newCDPSession(page));
  }

  async down(id: number, x: number, y: number, others: { id: number; x: number; y: number }[] = []): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [...others, { x, y, id }] });
  }

  async move(id: number, x: number, y: number, others: { id: number; x: number; y: number }[] = []): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [...others, { x, y, id }] });
  }

  async up(rest: { id: number; x: number; y: number }[] = []): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: rest });
  }

  async tap(x: number, y: number): Promise<void> {
    await this.down(1, x, y);
    await this.up();
  }

  async detach(): Promise<void> {
    await this.cdp.detach();
  }
}

/** Centre of the first element matching `sel`, or null. */
export async function centreOf(page: Page, sel: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((s) => {
    const el = document.querySelector<HTMLElement>(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel);
}

/** Tap an element by test id with a real touch (CDP), not a synthetic click. */
export async function touchTestId(page: Page, t: Touch, testId: string): Promise<void> {
  const loc = page.getByTestId(testId).first();
  await expect(loc).toBeVisible();
  const b = await loc.boundingBox();
  if (!b) throw new Error(`no box for ${testId}`);
  await t.tap(b.x + b.width / 2, b.y + b.height / 2);
}

// ------------------------------------------------------------------ match clock

/**
 * Keep each half near its end (clock fast-forward) so a full match runs in seconds of real time: whenever the clock
 * runs in period 1 / 2 with more than `leftTicks` left, jump to `leftTicks` before the end. Stop with stopFastForward.
 */
export async function fastForward(page: Page, leftTicks = 240): Promise<void> {
  await page.evaluate((left) => {
    const w = window as unknown as { __intbFF?: number; __dotkick?: { ctx: { session: { runtime?: () => { curr: { match: Record<string, number> } } | null } } } };
    if (w.__intbFF) clearInterval(w.__intbFF);
    w.__intbFF = setInterval(() => {
      const rt = w.__dotkick?.ctx.session.runtime?.();
      if (!rt) return;
      const m = rt.curr.match;
      if ((m.period === 1 || m.period === 2) && m.clockRunning === 1 && m.periodT < m.periodLen - left) {
        m.periodT = m.periodLen - left;
        m.addedT = 0;
      }
    }, 50) as unknown as number;
  }, leftTicks);
}

export async function stopFastForward(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __intbFF?: number };
    if (w.__intbFF) clearInterval(w.__intbFF);
    w.__intbFF = 0;
  });
}

// ------------------------------------------------------------------ focus navigation by pad

/** Test id of the element holding the FocusNavigator's focus, or null. */
export const focusedId = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.querySelector<HTMLElement>('[data-focused]')?.dataset.testid ?? null);

type Dir = 'up' | 'down' | 'left' | 'right';
const DPAD: Record<Dir, number> = { up: PAD.UP, down: PAD.DOWN, left: PAD.LEFT, right: PAD.RIGHT };

/** Directions from the focused control toward `want` by geometry: the dominant axis first. */
function dirsToward(page: Page, want: string): Promise<Dir[]> {
  return page.evaluate((id) => {
    const cur = document.querySelector<HTMLElement>('[data-focused]');
    const tgt = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    if (!cur || !tgt) return ['down'] as Dir[];
    const c = cur.getBoundingClientRect();
    const t = tgt.getBoundingClientRect();
    const dx = (t.left + t.right - c.left - c.right) / 2, dy = (t.top + t.bottom - c.top - c.bottom) / 2;
    const hd: Dir = dx > 0 ? 'right' : 'left', vd: Dir = dy > 0 ? 'down' : 'up';
    const out: Dir[] = Math.abs(dx) > Math.abs(dy) ? [hd, vd] : [vd, hd];
    return out.filter((d) => ((d === 'left' || d === 'right') ? Math.abs(dx) > 1 : Math.abs(dy) > 1));
  }, want);
}

/** Move the pad's focus to `want` with D-pad presses (layout-agnostic), then press Cross. */
export async function padActivate(page: Page, pad: number, want: string, max = 14): Promise<void> {
  await expect(page.getByTestId(want).first()).toBeVisible();
  let preferOther = false;
  const seen = new Set<string>();
  for (let i = 0; i < max && (await focusedId(page)) !== want; i++) {
    const before = (await focusedId(page)) ?? '';
    seen.add(before);
    const dirs = await dirsToward(page, want);
    const d = (preferOther && dirs.length > 1 ? dirs[1] : dirs[0]) ?? 'down';
    await padTap(page, pad, DPAD[d]);
    const now = (await focusedId(page)) ?? '';
    preferOther = seen.has(now);
  }
  expect(await focusedId(page), `pad focus reached ${want}`).toBe(want);
  await padTap(page, pad, PAD.CROSS);
}
