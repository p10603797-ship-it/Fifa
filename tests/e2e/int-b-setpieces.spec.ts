/**
 * INT-B e2e (INT-06): set pieces end to end on both input types in the shipped app. Free kick, corner and penalty in
 * set-piece practice (the practice restart is re-awarded by the app tick, MOD-04 practiceRulesTick), a throw-in in a
 * Kick-Off match (the ball is sent over the touchline off an away touch).
 *  - touch: swipes from the ball (free kick toward goal with the dotted flight preview drawn, corner into the box,
 *    penalty toward a corner); the throw-in by a tap on PASS;
 *  - controller: aim with the left stick, hold Circle / Cross (the HUD power bar shows), release; the throw-in by Cross.
 * Every kick is the human's (well before the 12 s default-action timeout) and the restart is taken.
 *
 *   npx vite build --outDir dist-e2e/int-b --emptyOutDir
 *   PW_DIST=dist-e2e/int-b PW_PORT=4317 npx playwright test tests/e2e/int-b-setpieces.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import {
  centreOf, collectConsole, frames, PAD, padActivate, padButton, padInit, padStick, padTap, route, shot, Touch, touchTestId,
  waitMatch, waitRoute,
} from './int-b-harness';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface RestartInfo { phase: number; ready: number; taken: number; team: number; t: number; timeoutT: number; dir: number }

const restart = (page: Page): Promise<RestartInfo> => page.evaluate(() => {
  const st = (window as any).__dotkick.ctx.session.getState();
  const r = st.match.restart;
  return { phase: st.match.phase, ready: r.ready, taken: r.taken, team: r.team, t: r.t, timeoutT: r.timeoutT, dir: st.teams[0].dir };
});

/** Wait until `phase` is up for the human's side (team 0), ready to be taken. */
async function waitReady(page: Page, phase: number, timeout = 60_000): Promise<RestartInfo> {
  await page.waitForFunction((ph) => {
    const st = (window as any).__dotkick?.ctx.session.getState();
    if (!st) return false;
    const r = st.match.restart;
    return st.match.phase === ph && r.ready === 1 && r.taken === 0 && r.team === 0;
  }, phase, { timeout });
  await frames(page, 20); // the set-piece camera settles; the cluster switches to SET_PIECE
  return restart(page);
}

/** Taken by the human: the phase went back to play (or a goal) well before the default-action timeout. */
async function expectTaken(page: Page, phase: number, before: RestartInfo): Promise<void> {
  await expect.poll(async () => {
    const r = await restart(page);
    return r.phase !== phase || r.taken === 1;
  }, { timeout: 10_000, message: `restart ${phase} taken` }).toBe(true);
  expect(before.t).toBeLessThan(before.timeoutT - 120);
}

/** Screen position of a pitch point through the live camera projector. */
function screenOf(page: Page, x: number, y: number, z: number): Promise<{ x: number; y: number } | null> {
  return page.evaluate(([px, py, pz]) => {
    const out = { x: 0, y: 0 };
    const ok = (window as any).__dotkick.app.renderer.projector.pitchToScreen(px, py, pz, out);
    return ok ? out : null;
  }, [x, y, z]);
}

const ballScreen = async (page: Page): Promise<{ x: number; y: number }> => {
  const b = await page.evaluate(() => {
    const st = (window as any).__dotkick.ctx.session.getState();
    return { x: st.ball.x, y: st.ball.y, z: st.ball.z };
  });
  const s = await screenOf(page, b.x, b.y, b.z);
  expect(s).not.toBeNull();
  return s!;
};

/** A real swipe from the ball toward a screen point (`len` px), in `steps` moves; returns the preview dots seen. */
async function swipeFromBall(page: Page, t: Touch, to: { x: number; y: number }, len = 220, steps = 10): Promise<number> {
  const from = await ballScreen(page);
  const dx = to.x - from.x, dy = to.y - from.y;
  const d = Math.hypot(dx, dy) || 1;
  const ux = (dx / d) * len, uy = (dy / d) * len;
  await t.down(1, from.x, from.y);
  let dots = 0;
  for (let i = 1; i <= steps; i++) {
    await t.move(1, from.x + (ux * i) / steps, from.y + (uy * i) / steps);
    if (i === steps - 2) dots = await page.locator('.dk-dot.is-on').count();
  }
  await t.up();
  return dots;
}

async function startPractice(page: Page, t: Touch | null, entry: string): Promise<void> {
  if ((await route(page)) !== 'practice') {
    if (t) await touchTestId(page, t, 'main-practice'); else await padActivate(page, 0, 'main-practice');
    await waitRoute(page, 'practice');
  }
  if (t) {
    await touchTestId(page, t, entry);
    await touchTestId(page, t, 'practice-start');
  } else {
    await padActivate(page, 0, entry);
    await padActivate(page, 0, 'practice-start');
  }
  await waitMatch(page);
}

async function quitToPractice(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__dotkick.ctx.session.quit());
  await waitRoute(page, 'practice');
}

/** Kick-Off match (human 0 home on every device), then send the ball over the near touchline off an away touch. */
async function throwInForHome(page: Page): Promise<RestartInfo> {
  await page.evaluate(() => (window as any).__dotkick.ctx.session.quit());
  await expect.poll(() => page.evaluate(() => (window as any).__dotkick.ctx.session.active)).toBe(false);
  await page.evaluate(() => {
    const ctx = (window as any).__dotkick.ctx;
    const human = { kind: 1, side: 0, assist: 0, autoSwitch: 1, fastPower: 0 };
    const none = { kind: 0, side: -1, assist: 0, autoSwitch: 1, fastPower: 0 };
    ctx.session.start({
      config: {
        seed: 515, mode: 0, homeClub: 0, awayClub: 1, homeKit: 0, awayKit: 1, homeFormation: 0, awayFormation: 0, halfMinutes: 4,
        cupRules: 0, night: 0, offside: 1, fouls: 1, difficulty: 0, humans: [human, none], practice: 0, startPhase: 2, replaySeconds: 0,
      },
      bindings: [{ human: 0, deviceIds: ['*'] }],
    });
  });
  await waitMatch(page);
  await page.waitForFunction(() => (window as any).__dotkick.ctx.session.getState().match.phase === 2, null, { timeout: 30_000 });
  await page.evaluate(() => {
    const st = (window as any).__dotkick.ctx.session.getState();
    const b = st.ball;
    b.owner = -1; b.heldBy = -1;
    b.x = 5; b.y = 0.11; b.z = 32.5; b.vx = 0; b.vy = 0; b.vz = 9; b.grounded = 1;
    b.px = b.x; b.py = b.y; b.pz = b.z;
    b.lastTouch = 14; b.lastTouchTeam = 1; b.lastTouchTick = st.tick;
  });
  return waitReady(page, 3);
}

test.describe('INT-B set pieces end to end', () => {
  test('touch: free kick (preview dots), corner, penalty by swipes from the ball; throw-in by PASS', async ({ page }) => {
    test.setTimeout(300_000);
    const errors = collectConsole(page);
    await page.goto('/');
    const t = await Touch.open(page);
    await touchTestId(page, t, 'splash-start');
    await waitRoute(page, 'main', 15_000);

    await startPractice(page, t, 'practice-free-kicks');
    let r = await waitReady(page, 6);
    const goal = await screenOf(page, r.dir * 52.5, 1.2, 0);
    expect(goal).not.toBeNull();
    const dots = await swipeFromBall(page, t, goal!, 200, 12);
    expect(dots, 'free-kick flight preview dots while dragging').toBeGreaterThan(0);
    await expectTaken(page, 6, r);
    await shot(page, 'setpiece-touch-fk');
    await quitToPractice(page);

    await startPractice(page, t, 'practice-corners');
    r = await waitReady(page, 5);
    const spot = await screenOf(page, r.dir * 41.5, 0, 0);
    await swipeFromBall(page, t, spot!, 160, 8);
    await expectTaken(page, 5, r);
    await quitToPractice(page);

    await startPractice(page, t, 'practice-penalties');
    r = await waitReady(page, 7);
    const corner = await screenOf(page, r.dir * 52.5, 1.5, 2.5);
    await swipeFromBall(page, t, corner!, 180, 8);
    await expectTaken(page, 7, r);
    await shot(page, 'setpiece-touch-pen');

    r = await throwInForHome(page);
    const pass = await centreOf(page, '.dk-tbtn[data-btn="0"]');
    expect(pass, 'PASS shows in the set-piece cluster').not.toBeNull();
    await t.tap(pass!.x, pass!.y);
    await expectTaken(page, 3, r);
    await t.detach();
    expect(errors).toEqual([]);
  });

  test('controller: free kick, corner, penalty with stick aim + held button (power bar); throw-in by Cross', async ({ page }) => {
    test.setTimeout(300_000);
    const errors = collectConsole(page);
    await page.addInitScript(padInit(1));
    await page.goto('/');
    await expect(page.getByTestId('splash-start')).toBeVisible();
    for (let i = 0; i < 6 && (await route(page)) !== 'main'; i++) await padTap(page, 0, PAD.CROSS);
    await waitRoute(page, 'main', 15_000);

    /**
     * Aim, hold `button` until the HUD power bar shows over the taker (a full bar kicks by itself), hold `hold` more
     * frames at most, release.
     */
    const charge = async (button: number, aimX: number, aimY: number, hold: number): Promise<void> => {
      await padStick(page, 0, aimX, aimY);
      await frames(page, 4);
      await padButton(page, 0, button, true);
      await expect(page.getByTestId('pb-p1')).toHaveClass(/is-on/, { timeout: 3000 });
      await frames(page, Math.min(hold, 2));
      await padButton(page, 0, button, false);
      await frames(page, 4);
      await padStick(page, 0, 0, 0);
    };

    await startPractice(page, null, 'practice-free-kicks');
    let r = await waitReady(page, 6);
    await charge(PAD.CIRCLE, r.dir, 0, 18);
    await expectTaken(page, 6, r);
    await shot(page, 'setpiece-pad-fk');
    await quitToPractice(page);

    await startPractice(page, null, 'practice-corners');
    r = await waitReady(page, 5);
    await charge(PAD.CROSS, 0, 0, 14);
    await expectTaken(page, 5, r);
    await quitToPractice(page);

    await startPractice(page, null, 'practice-penalties');
    r = await waitReady(page, 7);
    await charge(PAD.CIRCLE, r.dir, -0.4, 14);
    await expectTaken(page, 7, r);

    r = await throwInForHome(page);
    await padTap(page, 0, PAD.CROSS, 4);
    await expectTaken(page, 3, r);
    expect(errors).toEqual([]);
  });
});
