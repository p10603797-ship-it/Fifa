/**
 * [GFX-16] A scripted goal in the real app shows a replay that can be skipped (iPad-like 1180 x 820, touch). The loop is
 * stopped; the live state is driven frame by frame (a run and a shot into the +x goal, the GOAL phase with the ball in
 * the net), the sim's PHASE_CHANGE -> REPLAY event goes to the renderer, and the replay plays: the side angle, then
 * the behind-goal angle (GFX-15 cameras), within the draw budget. The sim leaving REPLAY (its skip) ends
 * playback at once; stopReplay() also skips. Screenshots: test-results/.../gfx-16-replay-*.png (look at them).
 * Run: npx vite build --outDir dist-e2e/gfx-15 --emptyOutDir && PW_DIST=dist-e2e/gfx-15 PW_PORT=4215 npx playwright test tests/e2e/gfx-16-replay.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function startMatch(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('splash-start').click();
  await page.getByTestId('main-kickoff').click();
  await page.waitForFunction(() => {
    const d = window.__dotkick;
    return !!d && d.ctx.router.current === 'match' && d.ctx.session.getState() !== null;
  }, null, { timeout: 30_000 });
  await page.waitForFunction(() => (window.__dotkick!.ctx.session.getState()?.tick ?? 0) > 10, null, { timeout: 15_000 });
  await page.evaluate(() => window.__dotkick!.app.loop.stop());
}

interface Step { replaying: boolean; shot: number; calls: number }

test.describe('GFX-16 goal replay', () => {
  test('a scripted goal replays from two angles and can be skipped (screenshots)', async ({ page }, testInfo) => {
    test.setTimeout(300_000); // software WebGL: ~0.3 s per drawn frame
    const errors = collectErrors(page);
    await startMatch(page);
    // Script the goal: 4 s of play, then 1 s of GOAL phase, drawn every 5 ticks (software WebGL is slow; 5-tick steps
    // are still one contiguous recording for the ring).
    await page.evaluate(() => {
      type P = { x: number; z: number; vx: number; vz: number; fx: number; fz: number; act: number };
      const app = window.__dotkick!.app;
      const s = app.ctx.session.getState()! as unknown as {
        tick: number; ball: Record<string, number>; players: P[]; match: { phase: number; goalTick: number };
      };
      const st = s as unknown as Parameters<typeof app.renderer.render>[0];
      const draw = (i: number): void => app.renderer.render(st, st, 1, { nowMs: i * 83, dtMs: 83, frame: i, ticks: 5, paused: false });
      const t0 = s.tick;
      for (let i = 0; i < 300; i += 5) {
        s.tick = t0 + i + 5;
        s.match.phase = 2;
        const b = s.ball;
        const shooting = i >= 240;
        // Dribble up the pitch, then a hard shot into the far side of the +x goal.
        b.x = shooting ? 30 + (i - 240) * 0.42 : -10 + i * 0.167;
        b.z = shooting ? 4 - (i - 240) * 0.06 : 4 + Math.sin(i / 20) * 2;
        b.y = shooting ? 0.4 + Math.sin(((i - 240) / 60) * Math.PI) * 0.8 : 0.11;
        b.vx = shooting ? 25 : 10; b.vy = 0; b.vz = shooting ? -3.6 : 0;
        b.owner = shooting ? -1 : 9; b.heldBy = -1; b.shotBy = shooting ? 9 : -1; b.inNet = 0;
        const runner = s.players[9]!;
        runner.x = shooting ? 29 : b.x - 0.7; runner.z = shooting ? 4 : b.z; runner.vx = shooting ? 0 : 10; runner.vz = 0; runner.fx = 1; runner.fz = 0;
        const keeper = s.players[11]!;
        keeper.x = 51.5; keeper.z = Math.max(-3, Math.min(3, b.z * 0.5)); keeper.fx = -1; keeper.fz = 0;
        draw(i);
      }
      s.match.goalTick = s.tick;
      for (let i = 0; i < 60; i += 5) {
        s.tick += 5;
        s.match.phase = 8;
        const b = s.ball;
        b.x = Math.min(53.8, b.x + 1); b.y = Math.max(0.11, b.y - 0.05); b.vx = b.x < 53.8 ? 12 : 0; b.vz = 0;
        b.inNet = b.x > 52.6 ? 1 : 0;
        draw(300 + i);
      }
      // Celebration (not recorded), then the sim enters REPLAY.
      s.tick += 240;
      s.match.phase = 10;
      const buf = { count: 1, get: () => ({ type: 11, tick: s.tick, a: 9, b: 10, c: 0, d: 0, x: 0, y: 0, z: 0 }), begin() {}, emit() {} };
      app.renderer.onEvents(buf as unknown as Parameters<typeof app.renderer.onEvents>[0], st);
    });
    const advance = (frames: number): Promise<Step> => page.evaluate((n) => {
      const app = window.__dotkick!.app;
      const s = app.ctx.session.getState()! as unknown as { tick: number };
      const st = s as unknown as Parameters<typeof app.renderer.render>[0];
      for (let i = 0; i < n; i++) {
        s.tick += 6;
        app.renderer.render(st, st, 1, { nowMs: i * 100, dtMs: 100, frame: i, ticks: 6, paused: false });
      }
      const cine = (window as unknown as { __dotkickCinematic: { shot: number } }).__dotkickCinematic;
      return { replaying: app.renderer.replaying, shot: cine.shot, calls: app.renderer.stats().drawCalls };
    }, frames);

    // First angle: the side close-up of the build-up.
    let r = await advance(8);
    expect(r.replaying).toBe(true);
    expect(r.shot).toBe(4); // CineShot.REPLAY_SIDE
    expect(r.calls).toBeLessThanOrEqual(80);
    await page.screenshot({ path: testInfo.outputPath('gfx-16-replay-side.png') });
    // Run to the finish (slow motion), then the second angle: low behind the goal.
    let sawGoalAngle = false;
    for (let k = 0; k < 12 && !sawGoalAngle; k++) {
      r = await advance(6);
      if (r.shot === 5) sawGoalAngle = true;
    }
    expect(sawGoalAngle).toBe(true);
    expect(r.replaying).toBe(true);
    r = await advance(6);
    expect(r.replaying).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('gfx-16-replay-behind-goal.png') });
    // Skip: the sim leaves REPLAY (its skip input) -> playback ends at once, the main camera is back.
    const after = await page.evaluate(() => {
      const app = window.__dotkick!.app;
      const s = app.ctx.session.getState()! as unknown as { tick: number; match: { phase: number }; ball: Record<string, number> };
      const st = s as unknown as Parameters<typeof app.renderer.render>[0];
      s.match.phase = 1;
      s.ball.x = 0; s.ball.z = 0; s.ball.y = 0.11; s.ball.inNet = 0; s.ball.vx = 0; s.ball.vz = 0;
      const buf = { count: 1, get: () => ({ type: 11, tick: s.tick, a: 10, b: 1, c: 0, d: 0, x: 0, y: 0, z: 0 }), begin() {}, emit() {} };
      app.renderer.onEvents(buf as unknown as Parameters<typeof app.renderer.onEvents>[0], st);
      const skipped = !app.renderer.replaying;
      s.tick++;
      app.renderer.render(st, st, 1, { nowMs: 0, dtMs: 16.7, frame: 0, ticks: 1, paused: false });
      const cine = (window as unknown as { __dotkickCinematic: { shot: number; active: boolean } }).__dotkickCinematic;
      const cineActive = cine.active;
      // Nothing played since the cut-scene: no replay. After a little play, stopReplay() skips a manual replay too.
      const none = !app.renderer.startReplay(3);
      s.match.phase = 2;
      for (let i = 0; i < 4; i++) {
        s.tick += 5;
        s.ball.x += 2;
        app.renderer.render(st, st, 1, { nowMs: i * 83, dtMs: 83, frame: i, ticks: 5, paused: false });
      }
      const started = app.renderer.startReplay(3);
      const playing = app.renderer.replaying;
      app.renderer.stopReplay();
      return { skipped, cineActive, none, started, playing, stopped: !app.renderer.replaying };
    });
    await page.screenshot({ path: testInfo.outputPath('gfx-16-replay-skipped.png') });
    expect(after).toEqual({ skipped: true, cineActive: false, none: true, started: true, playing: true, stopped: true });
    expect(errors).toEqual([]);
  });
});
