/**
 * [FEEL-1] The playtest fixes in the shipped app (Chromium, simulated pad): in a real Kick-Off match the human's
 * sprint dribble keeps the ball about a stride ahead, R1 keeps it tight, and L2 + Circle strikes a trivela.
 *
 *   npx vite build --outDir dist-e2e/feel1 --emptyOutDir
 *   PW_DIST=dist-e2e/feel1 PW_PORT=4531 npx playwright test tests/e2e/feel-1-feel.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import {
  collectConsole, frames, PAD, padActivate, padButton, padInit, padStick, padTap, route, waitMatch, waitRoute,
} from './int-b-harness';

/* eslint-disable @typescript-eslint/no-explicit-any */

async function padKickOff(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('splash-start')).toBeVisible();
  for (let i = 0; i < 6 && (await route(page)) !== 'main'; i++) await padTap(page, 0, PAD.CROSS);
  await waitRoute(page, 'main', 15_000);
  await padActivate(page, 0, 'main-mode-kickoff');
  await waitRoute(page, 'mode-setup');
  await padActivate(page, 0, 'mode-continue');
  await waitRoute(page, 'team-select');
  await padActivate(page, 0, 'team-continue');
  await waitRoute(page, 'side-select');
  await padActivate(page, 0, 'side-continue');
  await waitRoute(page, 'match-settings');
  await padActivate(page, 0, 'settings-start');
  await waitMatch(page);
}

/** Until IN_PLAY (a kick-off of ours is taken with Cross). */
async function untilInPlay(page: Page): Promise<void> {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    const k = await page.evaluate(() => {
      const st = (window as any).__dotkick.ctx.session.getState();
      return st ? { phase: st.match.phase, phaseT: st.match.phaseT, team: st.match.restart.team } : null;
    });
    if (k && k.phase === 2) return;
    if (k && k.phase === 1 && k.team === 0 && k.phaseT > 90) await padTap(page, 0, PAD.CROSS);
    await frames(page, 10);
  }
  throw new Error('never in play');
}

/** Give human 0's player the ball at his feet at (x along his attack, z), outfield opponents sent behind him; returns his attack dir. */
async function giveBall(page: Page, ax: number, z: number): Promise<number> {
  return page.evaluate(([along, zz]) => {
    const st = (window as any).__dotkick.ctx.session.runtime().curr;
    const slot = st.ctrl[0].slot;
    const p = st.players[slot];
    const dir = st.teams[p.team].dir;
    p.x = dir * along; p.z = zz; p.vx = 0; p.vz = 0; p.fx = dir; p.fz = 0;
    for (let i = 0; i < 22; i++) {
      const q = st.players[i];
      if (q.team === p.team || q.isKeeper === 1) continue;
      q.x = -dir * 48; q.z = -30 + (i % 11) * 6; q.vx = 0; q.vz = 0; // behind him: they cannot catch a sprinter
    }
    const b = st.ball;
    Object.assign(b, { x: p.x + dir * 0.5, y: 0.11, z: zz, px: p.x + dir * 0.5, py: 0.11, pz: zz, vx: 0, vy: 0, vz: 0,
      sx: 0, sy: 0, sz: 0, grounded: 1, owner: slot, heldBy: -1, lastTouch: slot, lastTouchTeam: p.team });
    return dir;
  }, [ax, z] as const);
}

/** Ball distance from the human's player each animation frame for n frames (only while he owns it) + frames lost. */
async function sampleDist(page: Page, n: number): Promise<{ mean: number; max: number; lost: number; speed: number }> {
  return page.evaluate((k) => new Promise<{ mean: number; max: number; lost: number; speed: number }>((res) => {
    let left = k, sum = 0, cnt = 0, max = 0, lost = 0, sp = 0;
    const step = (): void => {
      const st = (window as any).__dotkick.ctx.session.runtime().curr;
      const slot = st.ctrl[0].slot;
      const p = st.players[slot];
      if (st.ball.owner === slot) {
        const d = Math.hypot(st.ball.x - p.x, st.ball.z - p.z);
        sum += d; cnt++; if (d > max) max = d; sp += Math.hypot(p.vx, p.vz);
      } else lost++;
      if (--left <= 0) res({ mean: sum / Math.max(1, cnt), max, lost, speed: sp / Math.max(1, cnt) }); else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), n);
}

test.describe('FEEL-1 in a real match', () => {
  test('sprint dribble a stride ahead, R1 tight, L2 + Circle trivela', async ({ page }) => {
    test.setTimeout(240_000);
    const errors = collectConsole(page);
    await page.addInitScript(padInit(1));
    await padKickOff(page);
    await untilInPlay(page);

    // R2 sprint dribble (warm up 40 frames, then sample).
    let dir = await giveBall(page, -35, 0);
    await padStick(page, 0, dir, 0);
    await padButton(page, 0, PAD.R2, true);
    await frames(page, 40);
    const sprint = await sampleDist(page, 90);
    await padButton(page, 0, PAD.R2, false);
    console.log(`FEEL-1 e2e sprint dribble: ${JSON.stringify(sprint)}`);
    expect(sprint.lost).toBeLessThan(5);
    expect(sprint.max).toBeLessThan(2.0); // was ~2.4 m peaks before FEEL-1
    expect(sprint.mean).toBeGreaterThan(0.6);

    // R1 controlled sprint: tight.
    dir = await giveBall(page, -35, 0);
    await padStick(page, 0, dir, 0);
    await padButton(page, 0, PAD.R1, true);
    await frames(page, 40);
    const r1 = await sampleDist(page, 90);
    await padButton(page, 0, PAD.R1, false);
    expect(r1.lost).toBeLessThan(5);
    expect(r1.mean).toBeLessThan(0.9);
    expect(r1.mean).toBeLessThan(sprint.mean);
    console.log(`FEEL-1 e2e R1 dribble: ${JSON.stringify(r1)}`);

    // L2 + Circle in front of goal: a trivela.
    await padStick(page, 0, 0, 0);
    dir = await giveBall(page, 30, -6);
    await padStick(page, 0, dir, 0.2);
    await padButton(page, 0, PAD.L2, true);
    await frames(page, 4);
    await padTap(page, 0, PAD.CIRCLE, 4);
    await padButton(page, 0, PAD.L2, false);
    await expect.poll(() => page.evaluate(() => (window as any).__dotkick.ctx.session.runtime().curr.ball.lastKickKind), { timeout: 10_000 }).toBe(43);
    await padStick(page, 0, 0, 0);
    expect(errors).toEqual([]);
  });
});
