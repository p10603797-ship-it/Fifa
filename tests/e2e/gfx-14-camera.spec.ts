/**
 * [GFX-14] Main broadcast camera in the real app (iPad-like 1180 x 820, touch). The loop is stopped and the live
 * state posed (ball + the owning player) so each shot is deterministic; the renderer then draws ~2.5 s of camera
 * time (25 frames at the 100 ms dt clamp) and the page is captured. Checks per shot: the ball projects inside the
 * screen, above the bottom 15%, and not under any touch button; the camera turns toward the goal near each box.
 * Screenshots: test-results/.../gfx-14-<shot>.png (look at them).
 * Run: npx vite build --outDir dist-e2e/gfx-14 --emptyOutDir && PW_DIST=dist-e2e/gfx-14 PW_PORT=4214 npx playwright test tests/e2e/gfx-14-camera.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';

interface Shot {
  name: string;
  ball: [number, number, number];
  vel: [number, number, number];
  /** Owning slot (-1 loose). The owner is placed just behind the ball. */
  owner: number;
}

interface ShotResult {
  ok: boolean;
  bx: number; by: number;
  w: number; h: number;
  camX: number; fwdX: number;
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
  // Freeze the sim: from here only this test draws.
  await page.evaluate(() => window.__dotkick!.app.loop.stop());
}

async function pose(page: Page, shot: Shot): Promise<ShotResult> {
  return page.evaluate((sh) => {
    const app = window.__dotkick!.app;
    const s = app.ctx.session.getState()! as unknown as {
      ball: Record<string, number>; players: { x: number; z: number; vx: number; vz: number; fx: number; fz: number }[];
      match: { phase: number };
    };
    const b = s.ball;
    [b.x, b.y, b.z] = sh.ball;
    [b.vx, b.vy, b.vz] = sh.vel;
    b.owner = sh.owner;
    b.heldBy = -1;
    if (sh.owner >= 0) {
      const p = s.players[sh.owner]!;
      const dir = sh.owner < 11 ? 1 : -1;
      p.x = sh.ball[0] - 0.6 * dir; p.z = sh.ball[2]; p.vx = 0; p.vz = 0; p.fx = dir; p.fz = 0;
    }
    s.match.phase = 2; // IN_PLAY
    const st = s as unknown as Parameters<typeof app.renderer.render>[0];
    for (let i = 0; i < 25; i++) app.renderer.render(st, st, 1, { nowMs: i * 100, dtMs: 100, frame: i, ticks: 1, paused: false });
    const out = { x: 0, y: 0 };
    const ok = app.renderer.projector.pitchToScreen(b.x!, b.y!, b.z!, out);
    // Camera position / forward from two projector rays (screen centre on the ground vs camera x via the far point).
    const c = { x: 0, z: 0 }, l = { x: 0, z: 0 };
    app.renderer.projector.screenToPitch(window.innerWidth / 2, window.innerHeight * 0.5, c);
    app.renderer.projector.screenToPitch(window.innerWidth / 2, window.innerHeight * 0.95, l);
    const buttons = [...document.querySelectorAll('#touch .dk-tbtn')].map((el) => {
      const r = el.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, r: Math.max(r.width, r.height) / 2 };
    });
    return { ok, bx: out.x, by: out.y, w: window.innerWidth, h: window.innerHeight, camX: l.x, fwdX: c.x - l.x, buttons };
  }, shot);
}

const SHOTS: Shot[] = [
  { name: 'midfield', ball: [0, 0.11, 0], vel: [0, 0, 0], owner: 9 },
  { name: 'near-plus-x-box', ball: [38, 0.11, 8], vel: [3, 0, 0], owner: 9 },
  { name: 'near-minus-x-box', ball: [-38, 0.11, -6], vel: [-3, 0, 0], owner: 20 },
  { name: 'near-touchline-corner', ball: [47, 0.11, 33], vel: [0, 0, 0], owner: 9 },
  { name: 'high-ball', ball: [5, 17, 12], vel: [12, 6, 4], owner: -1 },
];

test.describe('GFX-14 broadcast camera', () => {
  test('framing at midfield, near each box, the near corner and a high ball (screenshots)', async ({ page }, testInfo) => {
    const errors = collectErrors(page);
    await startMatch(page);
    for (const shot of SHOTS) {
      const r = await pose(page, shot);
      await page.screenshot({ path: testInfo.outputPath(`gfx-14-${shot.name}.png`) });
      const tag = `${shot.name}: ball at (${r.bx.toFixed(0)}, ${r.by.toFixed(0)})`;
      expect(r.ok, tag).toBe(true);
      expect(r.bx, tag).toBeGreaterThan(0);
      expect(r.bx, tag).toBeLessThan(r.w);
      expect(r.by, tag).toBeGreaterThan(0);
      expect(r.by, tag).toBeLessThanOrEqual(r.h * 0.85 + 0.5);
      expect(r.buttons.length).toBeGreaterThan(0);
      for (const b of r.buttons) expect(Math.hypot(r.bx - b.cx, r.by - b.cy), `${tag} under a touch button`).toBeGreaterThan(b.r);
      // Turned toward the goal near either box: the view direction points along the attack.
      if (shot.name === 'near-plus-x-box') expect(r.fwdX, tag).toBeGreaterThan(2);
      if (shot.name === 'near-minus-x-box') expect(r.fwdX, tag).toBeLessThan(-2);
      if (shot.name === 'midfield') expect(Math.abs(r.fwdX), tag).toBeLessThan(3);
    }
    expect(errors).toEqual([]);
  });
});
