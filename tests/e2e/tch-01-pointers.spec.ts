/**
 * TCH-01 pointer manager in the real app (iPad-like 1180 x 820, touch), section 9 "Touch quality bar" and the
 * section 14 input glitch "stuck sprint or stick after pointercancel".
 *   npx vite build --outDir dist-e2e/tch-01 --emptyOutDir
 *   PW_DIST=dist-e2e/tch-01 PW_PORT=4201 npx playwright test tests/e2e/tch-01-pointers.spec.ts
 *  - Five simultaneous real touches (CDP) each drive their own control; a system cancel mid-hold leaves nothing held.
 *  - Dispatched touch PointerEvents: a thumb sliding off SPRINT keeps it; pointercancel releases only SPRINT; window
 *    blur and a resize mid-hold release everything; a right mouse button presses nothing.
 */
import { expect, test, type CDPSession, type Page } from '@playwright/test';

const SPRINT = 1 << 7; // Btn.SPRINT
const LAYER = '#touch .dk-touch';
const BIG = '#touch .dk-tbtn--big';
const STICK_ON = '#touch .dk-stick.is-active';

type Pt = { x: number; y: number; id: number };

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

/**
 * [QF-12 refit] The match opens with the PRE_MATCH intro (touch cluster hidden) and a KICK_OFF; the checks below need
 * open play. The kick-off is taken by the sim's own restart timeout; with `ownBall` the ball is then put at the
 * controlled player's feet so the attack cluster (PASS / THROUGH / SHOOT) shows.
 */
async function startMatch(page: Page, ownBall = false): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => window.__dotkick!.ctx.settings.update((s) => { s.controls.autoSwitch = 0; }));
  await page.getByTestId('splash-start').click();
  await page.getByTestId('main-kickoff').click();
  await page.waitForFunction(() => {
    const d = window.__dotkick;
    return !!d && d.ctx.router.current === 'match' && d.ctx.session.getState() !== null;
  }, null, { timeout: 30_000 });
  await page.waitForFunction(() => {
    const st = (window.__dotkick!.ctx.session as unknown as { runtime(): { curr: { match: { phase: number; restart: Record<string, number> } } } | null }).runtime()?.curr;
    if (!st) return false;
    const r = st.match.restart;
    if (st.match.phase === 1 && r.ready === 1 && r.taken === 0) r.timeoutT = 1;
    return st.match.phase === 2;
  }, null, { timeout: 60_000 });
  await waitTicks(page, 30);
  if (!ownBall) return;
  await page.evaluate(() => {
    const st = (window.__dotkick!.ctx.session as unknown as { runtime(): { curr: Record<string, any> } }).runtime().curr; // eslint-disable-line @typescript-eslint/no-explicit-any
    const slot = st.ctrl[0].slot;
    const p = st.players[slot];
    const b = st.ball;
    b.owner = slot; b.heldBy = -1; b.lastTouch = slot; b.lastTouchTeam = p.team; b.passTarget = -1;
    b.x = p.x + 0.4; b.z = p.z; b.y = 0.11; b.vx = 0; b.vy = 0; b.vz = 0; b.px = b.x; b.pz = b.z; b.py = b.y;
  });
  await expect(page.locator('#touch .dk-tbtn[data-btn="0"]')).toHaveCount(1);
}

async function tick(page: Page): Promise<number> {
  return page.evaluate(() => window.__dotkick!.ctx.session.getState()!.tick);
}

async function waitTicks(page: Page, ticks: number): Promise<void> {
  const from = await tick(page);
  await page.waitForFunction((t) => (window.__dotkick!.ctx.session.getState()?.tick ?? 0) >= t, from + ticks, { timeout: 30_000 });
}

/** Human 0's buttons and stick axes as the sim saw them on the last tick. */
async function ctrl0(page: Page): Promise<{ buttons: number; mx: number; mz: number }> {
  return page.evaluate(() => {
    const c = window.__dotkick!.ctx.session.getState()!.ctrl[0]!;
    return { buttons: c.buttons, mx: c.mx, mz: c.mz };
  });
}

async function centre(page: Page, sel: string): Promise<{ x: number; y: number }> {
  const b = (await page.locator(sel).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function touches(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', pts: Pt[]): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p) => ({ x: p.x, y: p.y, id: p.id })) });
}

/** Dispatch a synthetic PointerEvent on the touch layer (pointerType 'touch' unless overridden). */
async function ptr(page: Page, type: string, id: number, x: number, y: number, extra: Record<string, unknown> = {}): Promise<void> {
  await page.evaluate(({ type, id, x, y, extra }) => {
    const el = document.querySelector('#touch .dk-touch')!;
    const lifted = type === 'pointerup' || type === 'pointercancel';
    el.dispatchEvent(new PointerEvent(type, {
      pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: !lifted || type === 'pointerup',
      isPrimary: false, button: lifted || type === 'pointerdown' ? 0 : -1, buttons: lifted ? 0 : 1, ...extra,
    }));
  }, { type, id, x, y, extra });
}

test.describe('TCH-01 pointer manager', () => {
  test('five simultaneous touches each drive their own control; a system cancel mid-hold leaves no stuck sprint or stick', async ({ page }) => {
    const errors = collectErrors(page);
    await startMatch(page, true);
    await expect(page.locator(LAYER)).toHaveCount(1);
    const cdp = await page.context().newCDPSession(page);
    const big = await centre(page, BIG);
    const pass = await centre(page, '#touch .dk-tbtn[data-btn="0"]');
    const shoot = await centre(page, '#touch .dk-tbtn[data-btn="2"]');
    const stick: Pt = { x: 300, y: 520, id: 1 };
    const sprint: Pt = { ...big, id: 2 };
    const passPt: Pt = { ...pass, id: 3 };
    const shootPt: Pt = { ...shoot, id: 4 };
    const pitch: Pt = { x: 760, y: 260, id: 5 };
    const down: Pt[] = [];
    for (const p of [stick, sprint, passPt, shootPt, pitch]) {
      down.push(p);
      await touches(cdp, 'touchStart', down);
    }
    const moved = [{ ...stick, x: 400 }, sprint, passPt, shootPt, { ...pitch, x: 700 }];
    await touches(cdp, 'touchMove', moved);
    await expect(page.locator(STICK_ON)).toHaveCount(1);
    await expect(page.locator(BIG)).toHaveClass(/is-pressed/);
    await expect(page.locator('#touch .dk-tbtn[data-btn="0"]')).toHaveClass(/is-pressed/);
    await expect(page.locator('#touch .dk-tbtn[data-btn="2"]')).toHaveClass(/is-pressed/);
    await waitTicks(page, 6);
    let c = await ctrl0(page);
    expect(c.buttons & SPRINT).not.toBe(0);
    expect(c.mx).toBeGreaterThan(0.5);
    // iPadOS multitasking gesture: every touch is cancelled mid-hold.
    await touches(cdp, 'touchCancel', []);
    await expect(page.locator(STICK_ON)).toHaveCount(0);
    await expect(page.locator('#touch .dk-tbtn.is-pressed')).toHaveCount(0);
    await waitTicks(page, 10);
    c = await ctrl0(page);
    expect(c.buttons & SPRINT).toBe(0);
    expect(Math.abs(c.mx) + Math.abs(c.mz)).toBe(0);
    // Touch works normally afterwards.
    await touches(cdp, 'touchStart', [{ ...big, id: 9 }]);
    await expect(page.locator(BIG)).toHaveClass(/is-pressed/);
    await touches(cdp, 'touchEnd', []);
    await expect(page.locator(BIG)).not.toHaveClass(/is-pressed/);
    expect(errors).toEqual([]);
  });

  test('dispatched pointers: slide-off keeps SPRINT, pointercancel releases only SPRINT, blur and resize mid-hold release all', async ({ page }) => {
    const errors = collectErrors(page);
    await startMatch(page);
    let big = await centre(page, BIG);
    // A right mouse button on SPRINT presses nothing.
    await ptr(page, 'pointerdown', 1, big.x, big.y, { pointerType: 'mouse', button: 2, buttons: 2 });
    await expect(page.locator(BIG)).not.toHaveClass(/is-pressed/);
    await ptr(page, 'pointerup', 1, big.x, big.y, { pointerType: 'mouse', button: 2 });
    // SPRINT held by one finger, the stick by another.
    await ptr(page, 'pointerdown', 101, big.x, big.y);
    await ptr(page, 'pointerdown', 102, 300, 520);
    await ptr(page, 'pointermove', 102, 400, 520);
    await expect(page.locator(BIG)).toHaveClass(/is-pressed/);
    await expect(page.locator(STICK_ON)).toHaveCount(1);
    // The SPRINT thumb slides far off the button over the pitch: the hold stays.
    await ptr(page, 'pointermove', 101, big.x - 300, big.y - 250);
    await waitTicks(page, 6);
    await expect(page.locator(BIG)).toHaveClass(/is-pressed/);
    let c = await ctrl0(page);
    expect(c.buttons & SPRINT).not.toBe(0);
    expect(c.mx).toBeGreaterThan(0.5);
    // pointercancel on the SPRINT finger only: the stick keeps driving.
    await ptr(page, 'pointercancel', 101, big.x - 300, big.y - 250);
    await expect(page.locator(BIG)).not.toHaveClass(/is-pressed/);
    await expect(page.locator(STICK_ON)).toHaveCount(1);
    await waitTicks(page, 8);
    c = await ctrl0(page);
    expect(c.buttons & SPRINT).toBe(0);
    expect(c.mx).toBeGreaterThan(0.5);
    // Window blur mid-hold releases everything.
    await ptr(page, 'pointerdown', 103, big.x, big.y);
    await expect(page.locator(BIG)).toHaveClass(/is-pressed/);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(page.locator(BIG)).not.toHaveClass(/is-pressed/);
    await expect(page.locator(STICK_ON)).toHaveCount(0);
    // The released fingers keep moving: nothing comes back.
    await ptr(page, 'pointermove', 102, 450, 520);
    await ptr(page, 'pointermove', 103, big.x + 2, big.y);
    await waitTicks(page, 8);
    c = await ctrl0(page);
    expect(c.buttons & SPRINT).toBe(0);
    expect(Math.abs(c.mx) + Math.abs(c.mz)).toBe(0);
    await expect(page.locator(STICK_ON)).toHaveCount(0);
    for (const id of [102, 103]) await ptr(page, 'pointerup', id, 0, 0);
    // Resize mid-hold releases everything too.
    await ptr(page, 'pointerdown', 104, big.x, big.y);
    await ptr(page, 'pointerdown', 105, 300, 520);
    await ptr(page, 'pointermove', 105, 300, 440);
    await expect(page.locator(BIG)).toHaveClass(/is-pressed/);
    await expect(page.locator(STICK_ON)).toHaveCount(1);
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.locator(BIG)).not.toHaveClass(/is-pressed/);
    await expect(page.locator(STICK_ON)).toHaveCount(0);
    await waitTicks(page, 8);
    c = await ctrl0(page);
    expect(c.buttons & SPRINT).toBe(0);
    expect(Math.abs(c.mx) + Math.abs(c.mz)).toBe(0);
    for (const id of [104, 105]) await ptr(page, 'pointerup', id, 0, 0);
    // The relaid-out SPRINT still responds.
    big = await centre(page, BIG);
    await ptr(page, 'pointerdown', 106, big.x, big.y);
    await expect(page.locator(BIG)).toHaveClass(/is-pressed/);
    await ptr(page, 'pointerup', 106, big.x, big.y);
    await expect(page.locator(BIG)).not.toHaveClass(/is-pressed/);
    expect(errors).toEqual([]);
  });
});
