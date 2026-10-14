/**
 * Shared e2e helpers for UIX-08 (pause menu), UIX-09 (settings) and UIX-10 (half-time / full-time) specs.
 *
 *   npx vite build --outDir dist-e2e/uix-08 --emptyOutDir
 *   PW_DIST=dist-e2e/uix-08 PW_PORT=4208 npx playwright test tests/e2e/uix-08-pause.spec.ts tests/e2e/uix-09-settings.spec.ts tests/e2e/uix-10-breaks.spec.ts
 *
 * Screenshots go to tmp/uix-08/ (outside test-results/, which every Playwright run on the shared tree clears).
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const SHOTS = process.env.UIX08_SHOTS || join(process.cwd(), 'tmp', 'uix-08');
mkdirSync(SHOTS, { recursive: true });

/** Chromium's own messages about the container's software GPU (not from page scripts; absent on real devices). */
const GPU_ENVIRONMENT_NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/];

export function collectConsole(page: Page): string[] {
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

export async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** Boot, tap the splash, land on the main menu. */
export async function bootToMain(page: Page): Promise<void> {
  await page.goto('/');
  const start = page.getByTestId('splash-start');
  await expect(start).toBeVisible();
  await start.tap();
  await page.waitForFunction(() => window.__dotkick?.ctx.router.current === 'main', null, { timeout: 15_000 });
}

export interface StartOptions {
  /** Two humans: P1 (touch) home, P2 (keyboard) away. Default one human on any device. */
  twoHumans?: boolean;
  halfMinutes?: number;
  seed?: number;
}

/** Start a Kick-Off match through ctx.session.start and wait until the sim exists on the match screen. */
export async function startMatch(page: Page, o: StartOptions = {}): Promise<void> {
  await page.evaluate((opt) => {
    const human = (side: number) => ({ kind: 1, side, assist: 0, autoSwitch: 1, fastPower: 0 });
    const none = { kind: 0, side: -1, assist: 0, autoSwitch: 1, fastPower: 0 };
    const config = {
      seed: opt.seed ?? 4242, mode: 0, homeClub: 0, awayClub: 1, homeKit: 0, awayKit: 1, homeFormation: 0, awayFormation: 0,
      halfMinutes: opt.halfMinutes ?? 4, cupRules: 0, night: 0, offside: 1, fouls: 1, difficulty: 3,
      humans: [human(0), opt.twoHumans ? human(1) : none], practice: 0, startPhase: 1, replaySeconds: 0,
    };
    const bindings = opt.twoHumans
      ? [{ human: 0, deviceIds: ['touch'] }, { human: 1, deviceIds: ['keyboard'] }]
      : [{ human: 0, deviceIds: ['*'] }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    window.__dotkick!.ctx.session.start({ config, bindings } as any);
  }, o);
  await page.waitForFunction(() => {
    const d = window.__dotkick;
    return !!d && d.ctx.router.current === 'match' && d.ctx.session.getState() !== null;
  }, null, { timeout: 45_000 });
}

/** The live (mutable) sim state through AppSession.runtime() — tests only. */
export const RT = `(window.__dotkick.ctx.session.runtime().curr)`;

/** Focused element's test id. */
export async function focused(page: Page): Promise<string | null> {
  return page.evaluate(() => (document.querySelector('[data-focused]') as HTMLElement | null)?.dataset.testid ?? null);
}

/** Put the FocusNavigator on an element (as a controller user would have after moving there). */
export async function focusOn(page: Page, testId: string): Promise<void> {
  await page.evaluate((id) => {
    const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    if (!el) throw new Error(`no element ${id}`);
    window.__dotkick!.ctx.focus.focus(el);
  }, testId);
}

/** Real touch drag (CDP touch events -> pointer events of type touch) from the centre of one element to another. */
export async function touchDrag(page: Page, from: Locator, to: Locator, steps = 8): Promise<void> {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error('drag target not visible');
  const ax = a.x + a.width / 2, ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2, by = b.y + b.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: ax, y: ay, id: 1 }] });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: ax + (bx - ax) * t, y: ay + (by - ay) * t, id: 1 }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/** Every visible [data-focus] / button under `root` is at least 60 px in both directions and inside the viewport. */
export async function checkTargets(page: Page, rootSelector: string): Promise<string[]> {
  return page.evaluate((sel) => {
    const bad: string[] = [];
    const root = document.querySelector(sel);
    if (!root) return [`no ${sel}`];
    const vw = window.innerWidth, vh = window.innerHeight;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-focus], button'))) {
      if (el.hasAttribute('data-focus-skip')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const name = el.dataset.testid ?? el.textContent?.trim().slice(0, 20) ?? el.tagName;
      if (r.height < 59.5 || r.width < 59.5) bad.push(`${name}: ${Math.round(r.width)}x${Math.round(r.height)}`);
      if (r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5) {
        // Inside a scroll container is fine when the container itself is on screen.
        let p = el.parentElement;
        let scrolled = false;
        while (p && p !== root) {
          const ps = getComputedStyle(p);
          if (/(auto|scroll)/.test(ps.overflowY + ps.overflowX)) { scrolled = true; break; }
          p = p.parentElement;
        }
        if (!scrolled) bad.push(`${name}: outside viewport`);
      }
    }
    return bad;
  }, rootSelector);
}
