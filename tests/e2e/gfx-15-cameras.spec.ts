/**
 * [GFX-15] Set-piece and intro cameras in the real app (iPad-like 1180 x 820, touch). The loop is stopped and the live
 * state posed per shot (phase, restart, ball, taker, a wall, the keeper); the sim's RESTART_AWARDED / PHASE_CHANGE
 * events go to the renderer, then ~1 s of frames is drawn and the page captured. Per shot: the director's choice
 * (window.__dotkickCinematic), the ball on screen and clear of the touch buttons, the stick rotation, the draw budget.
 * Screenshots: test-results/.../gfx-15-<shot>.png (look at them).
 * Run: npx vite build --outDir dist-e2e/gfx-15 --emptyOutDir && PW_DIST=dist-e2e/gfx-15 PW_PORT=4215 npx playwright test tests/e2e/gfx-15-cameras.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';

interface Shot {
  name: string;
  /** MatchPhase / RestartKind numbers. */
  phase: number;
  kind: number;
  team: number;
  spot: [number, number];
  /** Expected CineShot (0 none, 1 behind taker, 2 corner, 3 establishing). */
  shot: number;
}

interface ShotResult {
  shot: number; active: boolean; ok: boolean; bx: number; by: number; w: number; h: number; rot: number; calls: number; tris: number;
  buttons: { cx: number; cy: number; r: number }[];
}

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

async function pose(page: Page, sh: Shot): Promise<ShotResult> {
  return page.evaluate((shot) => {
    type P = { x: number; z: number; vx: number; vz: number; fx: number; fz: number; act: number; team: number };
    const app = window.__dotkick!.app;
    const s = app.ctx.session.getState()! as unknown as {
      tick: number; ball: Record<string, number>; players: P[]; teams: { dir: number }[];
      match: { phase: number; restart: Record<string, number> };
    };
    const [sx, sz] = shot.spot;
    const dir = s.teams[shot.team]!.dir;
    const from = s.match.phase;
    s.match.phase = shot.phase;
    const r = s.match.restart;
    r.kind = shot.kind; r.team = shot.team; r.x = sx; r.z = sz; r.ready = 0; r.taken = 0;
    const b = s.ball;
    b.x = sx; b.y = 0.11; b.z = sz; b.vx = 0; b.vy = 0; b.vz = 0; b.owner = -1; b.heldBy = -1; b.shotBy = -1; b.inNet = 0;
    // Aim: the attacked goal (goal kicks: up-field).
    const gx = dir * 52.5;
    let ax = gx - sx, az = -sz;
    const al = Math.hypot(ax, az) || 1;
    ax /= al; az /= al;
    const place = (p: P, x: number, z: number, fx: number, fz: number): void => {
      p.x = x; p.z = z; p.vx = 0; p.vz = 0; p.fx = fx; p.fz = fz; p.act = 0;
    };
    const atk = shot.team === 0 ? 0 : 11, def = shot.team === 0 ? 11 : 0;
    if (shot.phase >= 3 && shot.phase <= 7) {
      // Taker just behind the ball; a wall of 4 at 9.15 m; the defending keeper on his line; attackers in the box.
      place(s.players[atk + 9]!, sx - ax * 1.2, sz - az * 1.2, ax, az);
      for (let i = 0; i < 4; i++) {
        const wx = sx + ax * 9.15 - az * (i - 1.5) * 0.7, wz = sz + az * 9.15 + ax * (i - 1.5) * 0.7;
        place(s.players[def + 2 + i]!, wx, wz, -ax, -az);
      }
      place(s.players[def]!, gx - dir * 0.5, 0, -dir, 0);
      for (let i = 0; i < 4; i++) place(s.players[atk + 5 + i]!, gx - dir * (8 + i * 2.5), (i - 1.5) * 5, dir, 0);
    }
    const events = shot.phase === 0 ? [[11, from, 0]] : [[15, shot.kind, shot.team], [11, from, shot.phase]];
    const buf = {
      count: events.length,
      get: (i: number) => ({ type: events[i]![0], tick: s.tick, a: events[i]![1], b: events[i]![2], c: 0, d: 0, x: sx, y: 0, z: sz }),
      begin() {}, emit() {},
    };
    const st = s as unknown as Parameters<typeof app.renderer.render>[0];
    app.renderer.onEvents(buf as unknown as Parameters<typeof app.renderer.onEvents>[0], st);
    for (let i = 0; i < 12; i++) {
      s.tick++;
      app.renderer.render(st, st, 1, { nowMs: i * 100, dtMs: 100, frame: i, ticks: 1, paused: false });
    }
    const cine = (window as unknown as { __dotkickCinematic: { shot: number; active: boolean } }).__dotkickCinematic;
    const out = { x: 0, y: 0 };
    const ok = app.renderer.projector.pitchToScreen(sx, 0.11, sz, out);
    const stats = app.renderer.stats();
    const buttons = [...document.querySelectorAll('#touch .dk-tbtn')].map((el) => {
      const rc = el.getBoundingClientRect();
      return { cx: rc.left + rc.width / 2, cy: rc.top + rc.height / 2, r: Math.max(rc.width, rc.height) / 2 };
    });
    return {
      shot: cine.shot, active: cine.active, ok, bx: out.x, by: out.y, w: window.innerWidth, h: window.innerHeight,
      rot: app.renderer.projector.stickRotation(), calls: stats.drawCalls, tris: stats.triangles, buttons,
    };
  }, sh);
}

const SHOTS: Shot[] = [
  { name: 'free-kick-near-goal', phase: 6, kind: 5, team: 0, spot: [27, -9], shot: 1 },
  { name: 'penalty', phase: 7, kind: 6, team: 1, spot: [-41.5, 0], shot: 1 },
  { name: 'goal-kick', phase: 4, kind: 3, team: 1, spot: [47, 4.6], shot: 1 },
  { name: 'corner', phase: 5, kind: 4, team: 0, spot: [52, 33.5], shot: 2 },
  { name: 'throw-in-main-camera', phase: 3, kind: 2, team: 0, spot: [10, 34], shot: 0 },
  { name: 'establishing-pre-match', phase: 0, kind: 0, team: 0, spot: [0, 0], shot: 3 },
];

test.describe('GFX-15 set-piece and intro cameras', () => {
  test('behind the taker, corner view, main camera for throw-ins, establishing shot (screenshots)', async ({ page }, testInfo) => {
    const errors = collectErrors(page);
    await startMatch(page);
    for (const shot of SHOTS) {
      const r = await pose(page, shot);
      await page.screenshot({ path: testInfo.outputPath(`gfx-15-${shot.name}.png`) });
      const tag = `${shot.name}: ball at (${r.bx.toFixed(0)}, ${r.by.toFixed(0)})`;
      expect(r.shot, tag).toBe(shot.shot);
      expect(r.active, tag).toBe(shot.shot !== 0);
      expect(r.calls, `${tag} draw calls`).toBeLessThanOrEqual(80);
      expect(r.tris, `${tag} triangles`).toBeLessThanOrEqual(200_000);
      if (shot.shot === 3) continue;
      expect(r.ok, tag).toBe(true);
      expect(r.bx, tag).toBeGreaterThan(0);
      expect(r.bx, tag).toBeLessThan(r.w);
      expect(r.by, tag).toBeGreaterThan(0);
      expect(r.by, tag).toBeLessThanOrEqual(r.h * 0.85 + 0.5);
      for (const b of r.buttons) expect(Math.hypot(r.bx - b.cx, r.by - b.cy), `${tag} under a touch button`).toBeGreaterThan(b.r);
      // Behind-the-taker / corner views rotate the stick with the view; the main camera does not.
      if (shot.shot === 0) expect(r.rot, tag).toBe(0);
      else expect(r.rot, tag).not.toBe(0);
    }
    expect(errors).toEqual([]);
  });
});
