/**
 * INT-B e2e: every other local mode in the shipped app.
 *  - Same-iPad 1v1 (Play a Friend): controller vs controller and touch vs controller through the real menus; no input
 *    crosstalk (each human's device reaches only his frame; another human's pad never hides the touch controls), only
 *    the pauser resumes; played to full time (clock fast-forwarded), Change Teams goes back to team select.
 *  - Cup (8 teams): draw, play the human tie, win it (goals set, clock fast-forwarded), back on the cup screen with
 *    the result. Shoot-out: straight to penalties, kicks taken by pad, to the final screen with the shoot-out score.
 *    Practice free play (opponent keeper only) and the guided tutorial (coach card, quit returns to the tutorial).
 *
 *   npx vite build --outDir dist-e2e/int-b --emptyOutDir
 *   PW_DIST=dist-e2e/int-b PW_PORT=4317 npx playwright test tests/e2e/int-b-modes.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import {
  centreOf, collectConsole, fastForward, frames, PAD, padActivate, padInit, padStick, padTap, route, shot,
  stopFastForward, Touch, touchTestId, waitMatch, waitRoute,
} from './int-b-harness';

/* eslint-disable @typescript-eslint/no-explicit-any */

const paused = (page: Page): Promise<boolean> => page.evaluate(() => (window as any).__dotkick.ctx.session.paused);
const pausedBy = (page: Page): Promise<number> => page.evaluate(() => (window as any).__dotkick.ctx.session.pausedBy);

/** Max stick magnitude of each human's frame over `n` frames. */
async function stickMags(page: Page, n: number): Promise<[number, number]> {
  return page.evaluate((k) => new Promise<[number, number]>((res) => {
    let left = k;
    const mag: [number, number] = [0, 0];
    const step = (): void => {
      const fr = (window as any).__dotkick.ctx.session.runtime()?.frames;
      if (fr) for (let h = 0; h < 2; h++) mag[h] = Math.max(mag[h]!, Math.hypot(fr[h].mx, fr[h].mz));
      if (--left <= 0) res(mag); else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), n);
}

/**
 * Wait for `target` (a route, 'in-play' or 'finished') while both sides play: a kick-off the human's side must take is
 * taken by that side's device (`takers[team]`).
 */
async function playUntil(page: Page, target: string, takers: [() => Promise<void>, () => Promise<void>], timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const k = await page.evaluate(() => {
      const d = (window as any).__dotkick;
      const st = d.ctx.session.getState();
      return {
        route: d.ctx.router.current, finished: d.ctx.session.finished,
        phase: st ? st.match.phase : -1, phaseT: st ? st.match.phaseT : 0, team: st ? st.match.restart.team : -1,
      };
    });
    if (target === 'in-play' ? k.phase === 2 : target === 'finished' ? k.finished : k.route === target) return;
    if (k.phase === 1 && k.phaseT > 90 && (k.team === 0 || k.team === 1)) await takers[k.team]();
    await frames(page, 10);
  }
  throw new Error(`timed out waiting for ${target}`);
}

async function padsToMain(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('splash-start')).toBeVisible();
  for (let i = 0; i < 6 && (await route(page)) !== 'main'; i++) await padTap(page, 0, PAD.CROSS);
  await waitRoute(page, 'main', 15_000);
}

test.describe('INT-B local modes', () => {
  test('same-iPad 1v1: pad vs pad and touch vs pad, no crosstalk, only the pauser resumes, full time, Change Teams', async ({ page }) => {
    test.setTimeout(420_000);
    const errors = collectConsole(page);
    await page.addInitScript(padInit(2));
    await padsToMain(page);
    await page.evaluate(() => (window as any).__dotkick.ctx.settings.update((s: any) => { s.match.halfMinutes = 2; }));
    await padTap(page, 1, PAD.R2); // controller 2 appears (a trigger never confirms a menu)
    expect(await page.evaluate(() => (window as any).__dotkick.ctx.devices.list().filter((d: any) => d.kind === 'pad').length)).toBe(2);

    // ---- controller vs controller
    await padActivate(page, 0, 'main-friend');
    await waitRoute(page, 'mode-setup');
    await padActivate(page, 0, 'mode-friend-local');
    await waitRoute(page, 'team-select');
    await padActivate(page, 0, 'team-continue');
    await waitRoute(page, 'side-select');
    await shot(page, 'friend-side-select-pads');
    await padActivate(page, 0, 'side-continue');
    await waitRoute(page, 'match-settings');
    await padActivate(page, 0, 'settings-start');
    await waitMatch(page);
    const setup = await page.evaluate(() => (window as any).__dotkick.ctx.session.getSetup());
    expect(setup.config.mode).toBe(1); // FRIEND_LOCAL
    expect(setup.bindings.map((b: any) => b.human)).toEqual([0, 1]);
    const padTakers: [() => Promise<void>, () => Promise<void>] = [() => padTap(page, 0, PAD.CROSS), () => padTap(page, 1, PAD.CROSS)];
    await playUntil(page, 'in-play', padTakers, 60_000);

    await padStick(page, 0, 0.9, 0);
    let m = await stickMags(page, 12);
    expect(m[0]).toBeGreaterThan(0.5);
    expect(m[1]).toBe(0);
    await padStick(page, 0, 0, 0);
    await padStick(page, 1, 0, 0.9);
    m = await stickMags(page, 12);
    expect(m[1]).toBeGreaterThan(0.5);
    expect(m[0]).toBe(0);
    await padStick(page, 1, 0, 0);

    // P2 pauses; P1's Options cannot resume; P2's Options does.
    await padTap(page, 1, PAD.OPTIONS);
    await expect.poll(() => paused(page)).toBe(true);
    expect(await pausedBy(page)).toBe(1);
    await page.waitForTimeout(400);
    await padTap(page, 0, PAD.OPTIONS);
    await page.waitForTimeout(400);
    expect(await paused(page)).toBe(true);
    expect(await pausedBy(page)).toBe(1);
    await shot(page, 'friend-paused-by-p2');
    await padTap(page, 1, PAD.OPTIONS);
    await expect.poll(() => paused(page)).toBe(false);

    await fastForward(page);
    await playUntil(page, 'half-time', padTakers, 90_000);
    await padActivate(page, 0, 'ht-continue');
    await playUntil(page, 'full-time', padTakers, 120_000);
    if (!(await page.evaluate(() => (window as any).__dotkick.ctx.session.finished))) await padActivate(page, 0, 'ft-continue');
    await playUntil(page, 'finished', padTakers, 60_000);
    await stopFastForward(page);
    await expect(page.getByTestId('ft-change-teams')).toBeVisible();
    await shot(page, 'friend-full-time');
    await padActivate(page, 0, 'ft-change-teams');
    await waitRoute(page, 'team-select');
    expect(await page.evaluate(() => (window as any).__dotkick.ctx.session.active)).toBe(false);

    // ---- touch vs controller (touch is the last used device: it goes home, controller 2 away)
    const t = await Touch.open(page);
    await touchTestId(page, t, 'team-continue');
    await waitRoute(page, 'side-select');
    // Make sure: touch home, Controller 2 away, Controller 1 sits out.
    const ids = await page.evaluate(() => (window as any).__dotkick.ctx.devices.list().map((d: any) => d.id));
    const pad1 = ids.filter((id: string) => id.startsWith('pad:'))[0];
    const pad2 = ids.filter((id: string) => id.startsWith('pad:'))[1];
    // The last setup is restored (both pads on a side): clear the sides first so touch becomes P1 (first assigned).
    await touchTestId(page, t, `ss-lane-${pad1}-centre`);
    await touchTestId(page, t, `ss-lane-${pad2}-centre`);
    await touchTestId(page, t, 'ss-lane-touch-home');
    await touchTestId(page, t, `ss-lane-${pad2}-away`);
    await shot(page, 'friend-side-select-touch');
    await touchTestId(page, t, 'side-continue');
    await waitRoute(page, 'match-settings');
    await touchTestId(page, t, 'settings-start');
    await waitMatch(page);
    const b2 = await page.evaluate(() => (window as any).__dotkick.ctx.session.getSetup().bindings);
    expect(b2).toEqual([{ human: 0, deviceIds: ['touch'] }, { human: 1, deviceIds: [pad2] }]);
    const tapPass = async (): Promise<void> => {
      const c = await centreOf(page, '.dk-tbtn[data-btn="0"]');
      if (c) await t.tap(c.x, c.y);
    };
    const mixed: [() => Promise<void>, () => Promise<void>] = [tapPass, () => padTap(page, 1, PAD.CROSS)];
    await playUntil(page, 'in-play', mixed, 60_000);

    await t.down(1, 220, 600);
    for (let i = 1; i <= 6; i++) await t.move(1, 220 + i * 14, 600);
    m = await stickMags(page, 12);
    expect(m[0]).toBeGreaterThan(0.5);
    expect(m[1]).toBe(0);
    await t.up();
    await padStick(page, 1, -0.9, 0);
    m = await stickMags(page, 12);
    expect(m[1]).toBeGreaterThan(0.5);
    expect(m[0]).toBe(0);
    await padStick(page, 1, 0, 0);
    // Controller 2 drives the OTHER side: the touch controls stay up.
    expect(await page.locator('.dk-touch.is-pad-hidden').count()).toBe(0);
    // Controller 1 sits out: its stick reaches nobody.
    await padStick(page, 0, 0.9, 0.9);
    m = await stickMags(page, 10);
    expect(m).toEqual([0, 0]);
    await padStick(page, 0, 0, 0);

    // Touch pauses (P1); P2's Options cannot resume; Resume by touch does.
    const pb = await centreOf(page, '.dk-tbtn--pause');
    await t.tap(pb!.x, pb!.y);
    await expect.poll(() => paused(page)).toBe(true);
    expect(await pausedBy(page)).toBe(0);
    await page.waitForTimeout(400);
    await padTap(page, 1, PAD.OPTIONS);
    await page.waitForTimeout(400);
    expect(await pausedBy(page)).toBe(0);
    expect(await paused(page)).toBe(true);
    await touchTestId(page, t, 'pause-resume');
    await expect.poll(() => paused(page)).toBe(false);
    await page.evaluate(() => (window as any).__dotkick.ctx.session.quit());
    await waitRoute(page, 'main');
    await t.detach();
    expect(errors).toEqual([]);
  });

  test('cup tie, practice free play and tutorial reach their end screens', async ({ page }) => {
    test.setTimeout(420_000);
    const errors = collectConsole(page);
    await page.addInitScript(padInit(1));
    await padsToMain(page);
    const t = await Touch.open(page);

    // ---- Cup: 8 teams, draw, play the human tie and win it.
    await page.evaluate(() => (window as any).__dotkick.ctx.settings.clearProgress());
    await touchTestId(page, t, 'main-cup');
    await waitRoute(page, 'cup');
    await touchTestId(page, t, 'cup-size-8');
    const club = await page.evaluate(() => document.querySelector<HTMLElement>('[data-testid^="cup-club-"]')?.dataset.testid ?? null);
    if (club) await touchTestId(page, t, club);
    await touchTestId(page, t, 'cup-draw');
    await expect(page.getByTestId('cup-bracket')).toBeVisible();
    await touchTestId(page, t, 'cup-play');
    await waitMatch(page);
    const cupCfg = await page.evaluate(() => (window as any).__dotkick.ctx.session.getSetup().config);
    expect(cupCfg.mode).toBe(3);
    const side = cupCfg.humans[0].side;
    await page.evaluate((sd) => { (window as any).__dotkick.ctx.session.getState().teams[sd].goals = 2; }, side);
    await fastForward(page);
    const padKick = (): Promise<void> => padTap(page, 0, PAD.CROSS);
    const sideTakers: [() => Promise<void>, () => Promise<void>] = [padKick, padKick];
    // Half-time and full-time breaks continue by pad (Cross on the focused Continue).
    const end = Date.now() + 180_000;
    while ((await route(page)) !== 'cup' && Date.now() < end) {
      const r = await route(page);
      if (r === 'half-time' || r === 'full-time') {
        // [QF-12] A finished cup tie shows the final full-time screen; its Continue (ft-cup) returns to the cup.
        const id = r === 'half-time' ? 'ht-continue' : (await page.getByTestId('ft-cup').isVisible()) ? 'ft-cup' : 'ft-continue';
        if (await page.getByTestId(id).isVisible()) await padActivate(page, 0, id);
      }
      await playUntil(page, 'cup', sideTakers, 3000).catch(() => undefined);
    }
    await stopFastForward(page);
    await waitRoute(page, 'cup');
    await expect(page.getByTestId('cup-result')).toBeVisible();
    await shot(page, 'cup-result');
    await page.evaluate(() => (window as any).__dotkick.ctx.router.resetTo('main'));
    await waitRoute(page, 'main');

    // ---- Practice free play: the opponents' outfield players are off (keeper only); quit returns to Practice.
    await touchTestId(page, t, 'main-practice');
    await waitRoute(page, 'practice');
    await touchTestId(page, t, 'practice-free-play');
    await touchTestId(page, t, 'practice-start');
    await waitMatch(page);
    const active = await page.evaluate(() => {
      const st = (window as any).__dotkick.ctx.session.getState();
      let n = 0;
      for (let i = 11; i < 22; i++) if (st.players[i].active === 1) n++;
      return { n, clock: st.match.clockRunning };
    });
    expect(active.n).toBe(1);
    await frames(page, 30);
    expect(await page.evaluate(() => (window as any).__dotkick.ctx.session.getState().match.clockRunning)).toBe(0);
    await shot(page, 'practice-free-play');
    const pp = await centreOf(page, '.dk-tbtn--pause');
    await t.tap(pp!.x, pp!.y);
    await touchTestId(page, t, 'pause-quit');
    await touchTestId(page, t, 'pause-quit-confirm');
    await waitRoute(page, 'practice');

    // ---- Tutorial: practice -> tutorial screen -> Start -> coached match -> quit -> back on the tutorial.
    await touchTestId(page, t, 'practice-tutorial');
    await touchTestId(page, t, 'practice-start');
    await waitRoute(page, 'tutorial');
    await touchTestId(page, t, 'tut-start');
    await waitMatch(page);
    expect(await page.evaluate(() => (window as any).__dotkick.ctx.session.getSetup().config.practice)).toBe(5);
    await shot(page, 'tutorial-match');
    await page.evaluate(() => (window as any).__dotkick.ctx.session.quit());
    await waitRoute(page, 'tutorial');
    await t.detach();
    expect(errors).toEqual([]);
  });
  test('shoot-out: straight to penalties, the human kicks by touch swipe, to the final screen with the score', async ({ page }) => {
    test.setTimeout(420_000);
    const errors = collectConsole(page);
    await page.goto('/');
    const t = await Touch.open(page);
    await touchTestId(page, t, 'splash-start');
    await waitRoute(page, 'main', 15_000);
    await touchTestId(page, t, 'main-shootout');
    await waitRoute(page, 'mode-setup');
    await touchTestId(page, t, 'mode-continue');
    await waitRoute(page, 'team-select');
    await touchTestId(page, t, 'team-continue');
    await waitRoute(page, 'side-select');
    await touchTestId(page, t, 'side-continue');
    await waitRoute(page, 'match-settings');
    await touchTestId(page, t, 'settings-start');
    await waitMatch(page);
    const cfg = await page.evaluate(() => (window as any).__dotkick.ctx.session.getSetup().config);
    expect(cfg.mode).toBe(4); // SHOOT_OUT
    expect(cfg.startPhase).toBe(14);
    // The human's kick (team 0 at the spot, AIM): a real swipe from the ball toward a corner of the goal.
    await page.waitForFunction(() => {
      const st = (window as any).__dotkick.ctx.session.getState();
      const r = st.match.restart;
      return st.match.phase === 14 && r.ready === 1 && r.taken === 0 && r.team === 0;
    }, null, { timeout: 240_000 });
    await frames(page, 10);
    const aim = await page.evaluate(() => {
      const st = (window as any).__dotkick.ctx.session.getState();
      const pr = (window as any).__dotkick.app.renderer.projector;
      const b = { x: 0, y: 0 };
      const g = { x: 0, y: 0 };
      pr.pitchToScreen(st.ball.x, st.ball.y, st.ball.z, b);
      pr.pitchToScreen(st.teams[0].dir * 52.5, 1.5, 2.5, g);
      return { b, g, timeoutT: st.match.restart.timeoutT };
    });
    expect(aim.timeoutT).toBeGreaterThan(120); // well before the default kick
    const d = Math.hypot(aim.g.x - aim.b.x, aim.g.y - aim.b.y) || 1;
    await t.down(1, aim.b.x, aim.b.y);
    for (let i = 1; i <= 8; i++) await t.move(1, aim.b.x + ((aim.g.x - aim.b.x) / d) * 22 * i, aim.b.y + ((aim.g.y - aim.b.y) / d) * 22 * i);
    await t.up();
    await expect.poll(() => page.evaluate(() => (window as any).__dotkick.ctx.session.getState().match.restart.taken), { timeout: 20_000 }).toBe(1);
    await shot(page, 'shootout-kick');
    // Shorten the rest (a full shoot-out at this container's software-GL frame rate takes minutes): home 3-0 up after
    // three kicks each, so the next result decides it (RUL-07 shootoutDecided).
    await page.evaluate(() => {
      const so = (window as any).__dotkick.ctx.session.getState().match.shootout;
      so.goals[0] = 3; so.goals[1] = 0; so.taken[0] = 3; so.taken[1] = 3;
    });
    await page.waitForFunction(() => (window as any).__dotkick.ctx.session.finished === true, null, { timeout: 240_000 });
    await waitRoute(page, 'full-time');
    await expect(page.getByTestId('ft-rematch')).toBeVisible();
    const so = await page.evaluate(() => (window as any).__dotkick.ctx.session.lastSummary.shootout);
    expect(so).not.toBeNull();
    expect(so[0]).toBeGreaterThan(so[1]);
    await shot(page, 'shootout-final');
    await touchTestId(page, t, 'ft-quit');
    await waitRoute(page, 'main');
    await t.detach();
    expect(errors).toEqual([]);
  });
});
