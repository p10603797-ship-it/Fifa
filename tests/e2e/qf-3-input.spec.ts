/**
 * QF-3 e2e (Chromium only here: WebKit is not installed in this container): QA-30 menus by controller alone and by
 * touch alone on the screens the earlier specs do not walk (settings tabs, touch controls editor, controller remap,
 * cup, practice, diagnostics, play a friend), and the in-match fixes that need a real DOM: swipe hints stay on screen
 * (FIX-06) and a keyboard driving the touch player's side hides the touch controls (FIX-07).
 *
 *   npx vite build --outDir dist-e2e/qf-3 --emptyOutDir
 *   PW_DIST=dist-e2e/qf-3 PW_PORT=4403 npx playwright test tests/e2e/qf-3-input.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import {
  collectConsole, focusedId, frames, PAD, padActivate, padInit, padTap, route, Touch, waitMatch, waitRoute,
} from './int-b-harness';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ring = (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.hasAttribute('data-focus-visible'));

async function padToMain(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('splash-start')).toBeVisible();
  for (let i = 0; i < 6 && (await route(page)) !== 'main'; i++) await padTap(page, 0, PAD.CROSS);
  await waitRoute(page, 'main', 15_000);
}

/** On a screen reached by pad: the ring shows on a control, a D-pad press moves it (when there is somewhere to go). */
async function ringMoves(page: Page, label: string): Promise<void> {
  await expect.poll(() => focusedId(page), `${label}: something focused`).not.toBeNull();
  expect(await ring(page), `${label}: ring visible`).toBe(true);
  const before = await focusedId(page);
  let moved = false;
  for (const d of [PAD.DOWN, PAD.RIGHT, PAD.UP, PAD.LEFT]) {
    await padTap(page, 0, d);
    if ((await focusedId(page)) !== before) { moved = true; break; }
  }
  expect(moved, `${label}: the D-pad moves the focus`).toBe(true);
}

test.describe('QF-3 QA-30 menus', () => {
  test('controller alone: settings tabs (L1 / R1), controls editor, remap, cup, practice, diagnostics, friend; Circle always backs out', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectConsole(page);
    await page.addInitScript(padInit(1));
    await padToMain(page);

    await padActivate(page, 0, 'main-settings');
    await waitRoute(page, 'settings');
    await ringMoves(page, 'settings');
    // R1 / L1 switch tabs.
    const tabOf = (): Promise<string | null> => page.evaluate(() => document.querySelector<HTMLElement>('[data-tab]')?.dataset.tab ?? null);
    const t0 = await tabOf();
    await padTap(page, 0, PAD.R1);
    await expect.poll(tabOf).not.toBe(t0);
    await padTap(page, 0, PAD.L1);
    await expect.poll(tabOf).toBe(t0);
    for (let i = 0; i < 8 && (await tabOf()) !== 'controls'; i++) await padTap(page, 0, PAD.L1);
    expect(await tabOf()).toBe('controls');

    await padActivate(page, 0, 'settings-controls-editor', 30);
    await waitRoute(page, 'controls-editor');
    await ringMoves(page, 'controls-editor');
    await padTap(page, 0, PAD.CIRCLE);
    await waitRoute(page, 'settings');

    await padActivate(page, 0, 'settings-remap', 30);
    await waitRoute(page, 'remap');
    await expect.poll(() => focusedId(page)).not.toBeNull();
    await padTap(page, 0, PAD.CIRCLE);
    await waitRoute(page, 'settings');
    await padTap(page, 0, PAD.CIRCLE);
    await waitRoute(page, 'main');

    for (const [id, want] of [['main-cup', 'cup'], ['main-practice', 'practice'], ['main-diagnostics', 'diagnostics'], ['main-friend', 'mode-setup']] as const) {
      await padActivate(page, 0, id, 20);
      await waitRoute(page, want);
      await ringMoves(page, want);
      await padTap(page, 0, PAD.CIRCLE);
      await waitRoute(page, 'main');
    }
    expect(errors).toEqual([]);
  });

  test('touch alone: the same screens by taps, the controls editor drags a control, Back by touch everywhere', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = collectConsole(page);
    await page.goto('/');
    await expect(page.getByTestId('splash-start')).toBeVisible();
    await page.touchscreen.tap(40, 410);
    await waitRoute(page, 'main');
    await page.getByTestId('main-settings').tap();
    await waitRoute(page, 'settings');
    await page.getByTestId('settings-tab-controls').tap();
    await page.getByTestId('settings-controls-editor').tap();
    await waitRoute(page, 'controls-editor');
    expect(await ring(page)).toBe(false);
    // Drag the SHOOT control (TouchButtonId 2) by touch: its position changes.
    const ctl = page.getByTestId('ce-ctl-2');
    const box0 = await ctl.boundingBox();
    expect(box0).not.toBeNull();
    const t = await Touch.open(page);
    const cx = box0!.x + box0!.width / 2, cy = box0!.y + box0!.height / 2;
    await t.down(1, cx, cy);
    for (let i = 1; i <= 6; i++) { await t.move(1, cx - i * 12, cy - i * 6); await frames(page, 1); }
    await t.up();
    await frames(page, 3);
    const box1 = await ctl.boundingBox();
    expect(Math.abs(box1!.x - box0!.x) + Math.abs(box1!.y - box0!.y)).toBeGreaterThan(20);
    await t.detach();
    await page.getByTestId('back').first().tap();
    await expect.poll(() => route(page)).not.toBe('controls-editor');
    if ((await route(page)) !== 'settings') {
      // A leave-confirmation for the unsaved layout: discard by touch.
      const discard = page.getByRole('button', { name: /discard|leave|don't save/i }).first();
      if (await discard.isVisible()) await discard.tap();
    }
    await waitRoute(page, 'settings');
    await page.getByTestId('settings-remap').tap();
    await waitRoute(page, 'remap');
    await page.getByTestId('back').first().tap();
    await waitRoute(page, 'settings');
    await page.getByTestId('back').first().tap();
    await waitRoute(page, 'main');
    for (const [id, want] of [['main-cup', 'cup'], ['main-practice', 'practice'], ['main-diagnostics', 'diagnostics']] as const) {
      await page.getByTestId(id).tap();
      await waitRoute(page, want);
      expect(await ring(page)).toBe(false);
      await page.getByTestId('back').first().tap();
      await waitRoute(page, 'main');
    }
    expect(errors).toEqual([]);
  });
});

test.describe('QF-3 in-match touch fixes', () => {
  /** Touch start -> Play now -> live match, taken past the kick-off; P1 then owns the ball at his feet (ATTACK). */
  async function touchMatchOwnBall(page: Page): Promise<void> {
    await page.goto('/');
    await page.touchscreen.tap(40, 410);
    await waitRoute(page, 'main');
    await page.getByTestId('main-kickoff').tap();
    await waitMatch(page);
    await page.waitForFunction(() => {
      const rt = (window as any).__dotkick.ctx.session.runtime?.();
      if (!rt) return false;
      const st = rt.curr;
      if (st.match.phase === 1 && st.match.restart.ready === 1 && st.match.restart.taken === 0) {
        // Take the kick-off for whichever side has it (the sim's own rules), then wait for open play.
        st.match.restart.timeoutT = 1;
      }
      return st.match.phase === 2;
    }, null, { timeout: 60_000 });
    await page.evaluate(() => {
      const st = (window as any).__dotkick.ctx.session.runtime().curr;
      const slot = st.ctrl[0].slot;
      const p = st.players[slot];
      const b = st.ball;
      b.owner = slot; b.heldBy = -1; b.lastTouch = slot; b.lastTouchTeam = p.team; b.passTarget = -1;
      b.x = p.x + 0.4; b.z = p.z; b.y = 0.11; b.vx = 0; b.vy = 0; b.vz = 0; b.px = b.x; b.pz = b.z; b.py = b.y;
    });
  }

  test('FIX-06: swipe hints around a held BIG button stay inside the viewport', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectConsole(page);
    await touchMatchOwnBall(page);
    const big = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.dk-tbtn--big');
      const r = el!.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const t = await Touch.open(page);
    await t.down(1, big.x, big.y);
    await expect.poll(() => page.locator('.dk-tbtn--big .dk-hint.is-on').count(), { timeout: 5000 }).toBeGreaterThan(0);
    await page.waitForTimeout(200); // the fade-in
    const boxes = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.dk-tbtn--big .dk-hint.is-on')).map((e) => {
      const r = e.getBoundingClientRect();
      return { dir: e.dataset.dir, l: r.left, t: r.top, r: r.right, b: r.bottom, w: innerWidth, h: innerHeight };
    }));
    await t.up();
    await t.detach();
    expect(boxes.length).toBeGreaterThanOrEqual(3);
    for (const b of boxes) {
      expect(b.l, `hint ${b.dir}`).toBeGreaterThanOrEqual(0);
      expect(b.t, `hint ${b.dir}`).toBeGreaterThanOrEqual(0);
      expect(b.r, `hint ${b.dir}`).toBeLessThanOrEqual(b.w);
      expect(b.b, `hint ${b.dir}`).toBeLessThanOrEqual(b.h);
    }
    expect(errors).toEqual([]);
  });

  test('FIX-07: a keyboard driving the touch player\'s side hides the touch controls; the next screen touch shows them', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectConsole(page);
    await touchMatchOwnBall(page);
    await expect(page.locator('.dk-touch')).toBeVisible();
    expect(await page.locator('.dk-touch.is-pad-hidden').count()).toBe(0);
    // The first key makes the keyboard a device (bound to P1 by Play now's wildcard); the next one drives.
    await page.keyboard.press('KeyD');
    await frames(page, 4);
    await page.keyboard.down('KeyD');
    await frames(page, 4);
    await page.keyboard.up('KeyD');
    await expect(page.locator('.dk-touch.is-pad-hidden')).toHaveCount(1);
    const t = await Touch.open(page);
    await t.tap(700, 300);
    await expect(page.locator('.dk-touch.is-pad-hidden')).toHaveCount(0);
    await t.detach();
    expect(errors).toEqual([]);
  });
});
