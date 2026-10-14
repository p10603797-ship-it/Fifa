/**
 * [GFX-09..12] Animation in the real app (iPad-like 1180 x 820, Chromium + SwiftShader WebGL2), through the GFX-07
 * player model's debug hook window.__dotkickPlayers (held clips, close-up camera, joint points):
 *  - [GFX-09/10/11] pose gallery: jog / sprint / idle side view, shot / header / volley at their contact frames, the
 *    three right-side keeper dives at full stretch, slide / knee slide / dejection / fist pump; joint checks (stride
 *    apart, kicking foot ahead at contact, dive hands out to the side, slide pelvis low) and screenshots to look at;
 *  - [GFX-12] live play: the app loop is stopped and driven at a fixed 60 Hz (loop.frame) through the kick-off; every
 *    joint of every player is sampled each frame in its pelvis frame (turning on the spot excluded): no joint pops
 *    (bounded per-frame motion), and the console stays clean.
 * Screenshots are attached and written to $GFX12_SHOT_DIR when set.
 * Run: npx vite build --outDir dist-e2e/gfx-12 --emptyOutDir && PW_DIST=dist-e2e/gfx-12 PW_PORT=4212 npx playwright test tests/e2e/gfx-12-anim.spec.ts
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const GPU_ENVIRONMENT_NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/];
const CANVAS_ONLY = '#ui, #hud, #touch { visibility: hidden !important; }';
/** fk.ts Joint indices. */
const J = { ROOT: 0, SPINE: 1, HEAD: 2, ELBOW_L: 4, ELBOW_R: 6, ANKLE_L: 9, ANKLE_R: 12 } as const;
/** contracts/render.ts AnimId values used here. */
const A = {
  IDLE: 0, JOG: 1, SPRINT: 2, SHOT: 5, HEADER: 8, VOLLEY: 9, SLIDE: 13, DIVE_LOW_R: 20, DIVE_MID_R: 22, DIVE_HIGH_R: 24,
  CELEBRATE_1: 29, CELEBRATE_3: 31, DEJECTION: 32,
} as const;

function collectConsole(page: Page): string[] {
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

async function kickOff(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('splash-start').tap();
  await page.getByTestId('main-kickoff').tap();
  await page.waitForFunction(() => {
    const d = window.__dotkick;
    return !!d && d.ctx.router.current === 'match' && d.app.session.loaded && d.ctx.session.getState() !== null;
  }, null, { timeout: 30_000 });
  await page.waitForFunction(() => (window.__dotkick!.ctx.session.getState()?.tick ?? 0) > 10, null, { timeout: 20_000 });
  await page.evaluate(() => window.__dotkick!.app.loop.stop());
}

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  const png = await page.screenshot({ style: CANVAS_ONLY });
  await info.attach(name, { body: png, contentType: 'image/png' });
  const dir = process.env.GFX12_SHOT_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.png`), png);
  }
}

/**
 * Stage a group: everyone else parked far away, the listed slots at (x, z) facing +x, standing still; hold the listed
 * clips; close-up camera on `focus`; draw two frames.
 */
async function gallery(page: Page, items: [number, number, number, number, number, number, number][], focus: number, dist: number, angle: number, eyeY: number): Promise<void> {
  await page.evaluate(([list, f, d, a, e]) => {
    const dk = window.__dotkick!;
    const rt = dk.app.session.runtime()!;
    type P = { x: number; z: number; fx: number; fz: number; vx: number; vz: number; active: number };
    for (const s of [rt.prev, rt.curr] as unknown as { players: P[]; ball: { x: number; y: number; z: number; owner: number } }[]) {
      s.players.forEach((p, i) => { p.x = -45 + i * 3; p.z = -32; p.fx = 1; p.fz = 0; p.vx = 0; p.vz = 0; p.active = 1; });
      for (const [slot, x, z] of list) { const p = s.players[slot]!; p.x = x; p.z = z; }
      s.ball.x = 30; s.ball.y = 0.11; s.ball.z = 20; s.ball.owner = -1;
    }
    const P = window.__dotkickPlayers!;
    for (let i = 0; i < 22; i++) P.holdPose(i, null);
    for (const [slot, , , anim, t, cycle, speed] of list) P.holdClip(slot, anim, t, cycle, speed, 1, 0);
    P.closeUp(f, d, a, e);
    const info = { nowMs: 0, dtMs: 16, frame: 0, ticks: 0, paused: false };
    for (let i = 0; i < 2; i++) { info.frame++; dk.app.renderer.render(rt.prev, rt.curr, 1, info); }
  }, [items, focus, dist, angle, eyeY] as const);
}

async function joint(page: Page, slot: number, j: number): Promise<[number, number, number]> {
  return page.evaluate(([s, jj]) => window.__dotkickPlayers!.joint(s, jj), [slot, j] as const);
}

async function hand(page: Page, slot: number, side: number): Promise<[number, number, number]> {
  return page.evaluate(([s, sd]) => window.__dotkickPlayers!.point(s, sd < 0 ? 4 : 6, 0, -0.35, 0), [slot, side] as const);
}

test.describe('GFX-09..12 animation', () => {
  test('[GFX-09][GFX-10][GFX-11] pose gallery: run cycle, kicks, dives, slide and celebrations', async ({ page }, info) => {
    test.setTimeout(240_000);
    const messages = collectConsole(page);
    await kickOff(page);

    // [GFX-09] Side view: jog (5 m/s) and sprint (8.5 m/s) mid-stride, idle.
    await gallery(page, [[9, 1.5, 0, A.JOG, 0, 0.05, 5], [8, 0, 0, A.SPRINT, 0, 0.05, 8.5], [7, -1.5, 0, A.IDLE, 0.3, 0, 0]], 8, 6.5, 90, 1.2);
    for (const slot of [9, 8]) {
      const l = await joint(page, slot, J.ANKLE_L), r = await joint(page, slot, J.ANKLE_R);
      expect(Math.abs(l[0] - r[0]), `slot ${slot} stride`).toBeGreaterThan(0.3);
      expect(Math.min(l[1], r[1]), `slot ${slot} a foot on the grass`).toBeLessThan(0.12);
    }
    await shot(page, info, 'gfx-09-run-cycle');

    // [GFX-10] Shot, header and volley at their contact frames (side view, from the players' right).
    await gallery(page, [[9, 1.8, 0, A.SHOT, 0.42, 0, 0], [8, 0, 0, A.HEADER, 0.5, 0, 0], [7, -1.8, 0, A.VOLLEY, 0.45, 0, 0]], 8, 7, 90, 1.2);
    const kick = await joint(page, 9, J.ANKLE_R), pelvis = await joint(page, 9, J.ROOT);
    expect(kick[0] - pelvis[0], 'kicking foot ahead at contact').toBeGreaterThan(0.25);
    expect(kick[1], 'kicking foot at ball height').toBeLessThan(0.3);
    const headerFeet = await joint(page, 8, J.ANKLE_L);
    expect(headerFeet[1], 'header: airborne at contact').toBeGreaterThan(0.25);
    const volley = await joint(page, 7, J.ANKLE_R);
    expect(volley[1], 'volley: foot raised').toBeGreaterThan(0.4);
    await shot(page, info, 'gfx-10-kicks-contact');

    // [GFX-11] Keeper dives to his right at full stretch: low, mid, high (front view, from the shooter).
    await gallery(page, [[0, 0, -3.2, A.DIVE_LOW_R, 0.35, 0, 0], [12, 0, 0, A.DIVE_MID_R, 0.35, 0, 0], [13, 0, 3.2, A.DIVE_HIGH_R, 0.35, 0, 0]], 12, 11, 0, 1.3);
    const ys: number[] = [];
    for (const [slot, z0] of [[0, -3.2], [12, 0], [13, 3.2]] as const) {
      const h = await hand(page, slot, 1);
      expect(h[2] - z0, `slot ${slot}: hands out to his right (+z)`).toBeGreaterThan(0.8);
      ys.push(h[1]);
    }
    expect(ys[1]!).toBeGreaterThan(ys[0]!);
    expect(ys[2]!).toBeGreaterThan(ys[1]!);
    await shot(page, info, 'gfx-11-dives');

    // [GFX-11] Slide, knee slide, dejection, fist pump (side view).
    await gallery(page, [[9, 2.2, 0, A.SLIDE, 0.3, 0, 0], [8, 0.4, 0, A.CELEBRATE_1, 0.4, 0, 0], [7, -1.1, 0, A.DEJECTION, 0.3, 0, 0], [6, -2.6, 0, A.CELEBRATE_3, 0.55 / 3, 0, 0]], 8, 8, 90, 1.1);
    expect((await joint(page, 9, J.ROOT))[1], 'slide: pelvis near the grass').toBeLessThan(0.4);
    expect((await hand(page, 8, 1))[1], 'knee slide: arms up').toBeGreaterThan((await joint(page, 8, J.HEAD))[1]);
    await shot(page, info, 'gfx-11-slide-celebrations');

    await page.evaluate(() => { const P = window.__dotkickPlayers!; P.closeUp(-1); for (let i = 0; i < 22; i++) P.holdPose(i, null); });
    expect(messages, messages.join('\n')).toEqual([]);
  });

  test('[GFX-12] live play at 60 Hz: poses blend, no joint pops', async ({ page }, info) => {
    test.setTimeout(240_000);
    const messages = collectConsole(page);
    await kickOff(page);
    const res = await page.evaluate(() => {
      const dk = window.__dotkick!;
      const P = window.__dotkickPlayers!;
      const loop = dk.app.loop;
      let now = performance.now();
      const prev: number[] = new Array(22 * 13 * 3).fill(NaN);
      let worst = 0, worstAt = '';
      let frames = 0, moving = 0;
      const ticks0 = dk.ctx.session.getState()!.tick;
      for (let f = 0; f < 240; f++) {
        now += 1000 / 60;
        loop.frame(now);
        frames++;
        const st = dk.ctx.session.getState()!;
        for (let s = 0; s < 22; s++) {
          if (st.players[s]!.active !== 1) continue;
          const root = P.joint(s, 0);
          if (Math.hypot(st.players[s]!.vx, st.players[s]!.vz) > 1) moving++;
          // Pelvis frame axes (world, scaled by the height scale): joint offsets in it exclude turning on the spot.
          const ax = P.point(s, 0, 1, 0, 0), ay = P.point(s, 0, 0, 1, 0), az = P.point(s, 0, 0, 0, 1);
          const ex = [ax[0] - root[0], ax[1] - root[1], ax[2] - root[2]];
          const ey = [ay[0] - root[0], ay[1] - root[1], ay[2] - root[2]];
          const ez = [az[0] - root[0], az[1] - root[1], az[2] - root[2]];
          const k2 = ex[0]! * ex[0]! + ex[1]! * ex[1]! + ex[2]! * ex[2]!;
          for (let j = 1; j < 13; j++) {
            const q = P.joint(s, j);
            const o = (s * 13 + j) * 3;
            const wx = q[0] - root[0], wy = q[1] - root[1], wz = q[2] - root[2];
            const rx = (wx * ex[0]! + wy * ex[1]! + wz * ex[2]!) / k2;
            const ry = (wx * ey[0]! + wy * ey[1]! + wz * ey[2]!) / k2;
            const rz = (wx * ez[0]! + wy * ez[1]! + wz * ez[2]!) / k2;
            if (prev[o] === prev[o]) {
              const d = Math.hypot(rx - prev[o]!, ry - prev[o + 1]!, rz - prev[o + 2]!);
              if (d > worst) { worst = d; worstAt = `slot ${s} joint ${j} frame ${f} act ${st.players[s]!.act}`; }
            }
            prev[o] = rx; prev[o + 1] = ry; prev[o + 2] = rz;
          }
        }
      }
      return { worst, worstAt, frames, ticks: dk.ctx.session.getState()!.tick - ticks0, moving };
    });
    await shot(page, info, 'gfx-12-live-after-4s');
    console.log(`GFX-12 live: ${JSON.stringify(res)}`);
    expect(res.ticks, 'the sim ran at 60 Hz with the frames').toBeGreaterThan(200);
    expect(res.moving, 'players were running').toBeGreaterThan(100);
    // Fastest real motion is a kicking foot (~15-20 m/s relative to the pelvis): ~0.33 m per 60 Hz frame. A pop
    // (a clip switching without a cross-fade) moves limbs by ~0.5-1 m in one frame.
    expect(res.worst, res.worstAt).toBeLessThan(0.45);
    expect(messages, messages.join('\n')).toEqual([]);
  });
});
