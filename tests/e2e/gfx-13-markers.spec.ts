/**
 * [GFX-13] Ball, blob shadows and on-pitch aids in the real app (iPad-like 1180 x 820, touch, Chromium + SwiftShader
 * WebGL2). The loop is stopped; the test poses the live state and draws frames itself. Checks:
 *  - all aids at once: P1 ember chevron + ring, P2 cyan diamond + ring, faint next-switch marker, receiver ring,
 *    charging power bar, high-ball landing target: ember / cyan pixels above the controlled players' heads;
 *  - the aids cost exactly 2 draw calls (ground + overlay batch) on top of the rest of the frame;
 *  - colour-blind mode adds the "1" label beside P1's marker (more ember pixels to its right) and dashes P2's ring;
 *  - off-screen arrow: a ball placed off the side of the screen and a ball high above it get a white arrow at the
 *    edge (one 1 ms frame after the placement, before the broadcast camera's glide brings it back into view);
 *  - zero console errors / warnings.
 * Screenshots (look at them): attached to the test, and written to $GFX13_SHOT_DIR when set.
 * Run: npx vite build --outDir dist-e2e/gfx-13 --emptyOutDir && PW_DIST=dist-e2e/gfx-13 PW_PORT=4213 npx playwright test tests/e2e/gfx-13-markers.spec.ts
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const GPU_ENVIRONMENT_NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/];
const CANVAS_ONLY = '#ui, #hud, #touch { visibility: hidden !important; }';

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
  const dir = process.env.GFX13_SHOT_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.png`), png);
  }
}

interface Pose {
  /** Show the aids (humans, receiver, landing ball); false = same scene with every aid off. */
  aids: boolean;
  ball: [number, number, number];
  vel: [number, number, number];
  /** Frames drawn (100 ms each, camera settles); the last frame can be short (camera barely moves). */
  frames: number;
  lastDtMs?: number;
  /**
   * Last frame only: move the ball off screen before the camera follows. A placement shorter than the broadcast
   * camera's cut distance (25 m) glides, so for one 1 ms frame the camera still frames the old spot. 'side' searches
   * a ground point 24 m away that projects off screen, 'high' the lowest point straight up (<= 24.5 m) above the top.
   */
  jump?: 'side' | 'high';
}

interface Probe {
  drawCalls: number;
  triangles: number;
  /** Ember pixels in a box above P1's head, cyan pixels above P2's head, ember pixels right of P1's marker. */
  emberHead: number;
  cyanHead: number;
  emberRight: number;
  /** White pixels around the expected arrow centre and the arrow centre itself (CSS px). */
  arrowWhite: number;
  arrowX: number;
  arrowY: number;
  ballOn: boolean;
}

/** Pose the live state, draw the frames, probe the drawing buffer right after the last render. */
async function poseAndProbe(page: Page, pose: Pose): Promise<Probe> {
  return page.evaluate((ps) => {
    const d = window.__dotkick!;
    const app = d.app;
    type P = { x: number; z: number; vx: number; vz: number; fx: number; fz: number; ctrl: number; active: number };
    type C = { kind: number; side: number; slot: number; nextSwitch: number; powerBtn: number; power: number; receiver: number };
    const s = app.ctx.session.getState()! as unknown as {
      tick: number; ball: Record<string, number>; players: P[]; ctrl: C[]; match: { phase: number }; attrs: { height: number }[];
    };
    s.match.phase = 2; // IN_PLAY
    const place = (slot: number, x: number, z: number, fx: number): void => {
      const p = s.players[slot]!;
      p.x = x; p.z = z; p.vx = 0; p.vz = 0; p.fx = fx; p.fz = 0; p.active = 1;
    };
    place(9, -5, 5, 1); place(7, -11, -5, 1); place(10, 7, 10, 1); place(20, 4, -3, -1);
    for (const c of s.ctrl) { c.nextSwitch = -1; c.powerBtn = 0; c.power = 0; c.receiver = -1; }
    const c0 = s.ctrl[0]!, c1 = s.ctrl[1]!;
    for (const p of s.players) p.ctrl = -1;
    if (ps.aids) {
      c0.kind = 1; c0.side = 0; c0.slot = 9; s.players[9]!.ctrl = 0;
      c1.kind = 1; c1.side = 1; c1.slot = 20; s.players[20]!.ctrl = 1;
      c0.nextSwitch = 7; c0.powerBtn = 1; c0.power = 0.6;
    } else {
      c0.kind = 0; c0.slot = -1; c1.kind = 0; c1.slot = -1;
    }
    const b = s.ball;
    [b.x, b.y, b.z] = ps.ball;
    [b.vx, b.vy, b.vz] = ps.vel;
    b.sx = 0; b.sy = 0; b.sz = 4;
    b.owner = -1; b.heldBy = -1; b.inNet = 0; b.grounded = b.y > 0.2 ? 0 : 1;
    b.passTarget = ps.aids ? 10 : -1; b.lastTouchTeam = 0;
    b.shotBy = ps.aids ? -1 : 9; // a shot gets no landing target
    b.lastKickTick = s.tick; b.touchedTick = s.tick;
    const st = s as unknown as Parameters<typeof app.renderer.render>[0];
    const info = { nowMs: 0, dtMs: 100, frame: 0, ticks: 1, paused: false };
    const W = window.innerWidth, H = window.innerHeight;
    const proj = app.renderer.projector;
    const o = { x: 0, y: 0 };
    const offScreen = (x: number, y: number, z: number): boolean =>
      !proj.pitchToScreen(x, y, z, o) || o.x < -10 || o.x > W + 10 || o.y < -10 || o.y > H + 10;
    for (let i = 0; i < ps.frames; i++) {
      const last = i === ps.frames - 1;
      if (last && ps.jump === 'side') {
        for (let a = 0; a < 360; a += 5) {
          const x = b.x! + 24 * Math.cos((a * Math.PI) / 180), z = b.z! + 24 * Math.sin((a * Math.PI) / 180);
          if (Math.abs(z) < 33 && offScreen(x, 0.11, z)) { b.x = x; b.z = z; break; }
        }
      } else if (last && ps.jump === 'high') {
        for (let y = 8; y <= 24.5; y += 0.5) if (offScreen(b.x!, y, b.z!)) { b.y = y; break; }
      }
      info.frame++; info.dtMs = last && ps.lastDtMs ? ps.lastDtMs : 100; info.nowMs += info.dtMs;
      app.renderer.render(st, st, 1, info);
    }
    const stats = app.renderer.stats();
    const canvas = document.getElementById('game') as HTMLCanvasElement;
    const gl = canvas.getContext('webgl2')!;
    const bw = gl.drawingBufferWidth, bh = gl.drawingBufferHeight;
    /** Count pixels matching `test` in the CSS box [x0, x1] x [y0, y1]. */
    const count = (x0: number, y0: number, x1: number, y1: number, test: (r: number, g: number, b: number) => boolean): number => {
      const bx0 = Math.max(0, Math.floor((x0 * bw) / W)), bx1 = Math.min(bw - 1, Math.ceil((x1 * bw) / W));
      const by0 = Math.max(0, Math.floor(bh - 1 - (y1 * bh) / H)), by1 = Math.min(bh - 1, Math.ceil(bh - 1 - (y0 * bh) / H));
      const w = bx1 - bx0 + 1, h = by1 - by0 + 1;
      if (w <= 0 || h <= 0) return 0;
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(bx0, by0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let n = 0;
      for (let i = 0; i < buf.length; i += 4) if (test(buf[i]!, buf[i + 1]!, buf[i + 2]!)) n++;
      return n;
    };
    const ember = (r: number, g: number, bl: number): boolean => r > 200 && g > 60 && g < 160 && bl < 110;
    const cyan = (r: number, g: number, bl: number): boolean => r < 130 && g > 150 && bl > 190;
    const white = (r: number, g: number, bl: number): boolean => r > 225 && g > 225 && bl > 225;
    const head = (slot: number): { x: number; y: number } => {
      const p = s.players[slot]!;
      const ht = s.attrs[slot]!.height / 180;
      proj.pitchToScreen(p.x, 2.25 * ht, p.z, o);
      return { x: o.x, y: o.y };
    };
    const h1 = head(9), h2 = head(20);
    const emberHead = count(h1.x - 25, h1.y - 45, h1.x + 25, h1.y, ember);
    const cyanHead = count(h2.x - 25, h2.y - 45, h2.x + 25, h2.y, cyan);
    const emberRight = count(h1.x + 12, h1.y - 40, h1.x + 50, h1.y, ember);
    // Expected arrow centre: the ray from the screen centre toward the projected ball meets the 30 px inset.
    const ballOn = proj.pitchToScreen(b.x!, b.y!, b.z!, o) && o.x >= 0 && o.x <= W && o.y >= 0 && o.y <= H;
    let ax = -1, ay = -1, arrowWhite = 0;
    if (!ballOn) {
      const dx = o.x - W / 2, dy = o.y - H / 2;
      const l = Math.hypot(dx, dy);
      const ux = dx / l, uy = dy / l;
      const t = Math.min(Math.abs(ux) > 1e-9 ? (W / 2 - 30) / Math.abs(ux) : Infinity, Math.abs(uy) > 1e-9 ? (H / 2 - 30) / Math.abs(uy) : Infinity);
      ax = W / 2 + ux * t; ay = H / 2 + uy * t;
      arrowWhite = count(ax - 22, ay - 22, ax + 22, ay + 22, white);
    }
    return {
      drawCalls: stats.drawCalls, triangles: stats.triangles, emberHead, cyanHead, emberRight, arrowWhite, arrowX: ax,
      arrowY: ay, ballOn,
    };
  }, pose);
}

async function setColourBlind(page: Page, on: boolean): Promise<void> {
  await page.evaluate((v) => window.__dotkick!.ctx.settings.update((s) => { s.accessibility.colourBlindMarkers = v; }), on);
}

test.describe('GFX-13 ball, shadows and on-pitch aids', () => {
  test('markers, rings, power bar, landing target, colour-blind labels and off-screen arrows (screenshots)', async ({ page }, testInfo) => {
    const errors = collectConsole(page);
    await kickOff(page);
    await setColourBlind(page, false);

    const high: Pose = { aids: true, ball: [-1, 6, 4], vel: [7, 3, 1], frames: 25 };
    const a = await poseAndProbe(page, high);
    await shot(page, testInfo, 'gfx-13-aids');
    expect(a.ballOn).toBe(true);
    expect(a.emberHead, 'P1 ember chevron above the head').toBeGreaterThan(25);
    expect(a.cyanHead, 'P2 cyan diamond above the head').toBeGreaterThan(25);

    // Same scene with every aid off: the aids are exactly two draw calls.
    const off = await poseAndProbe(page, { ...high, aids: false });
    expect(off.emberHead).toBeLessThan(a.emberHead / 4);
    expect(a.drawCalls - off.drawCalls, `draw calls ${a.drawCalls} vs ${off.drawCalls}`).toBe(2);
    console.log(`GFX-13 frame: ${a.drawCalls} draw calls, ${a.triangles} triangles (aids off: ${off.drawCalls})`);

    // Colour-blind mode: "1" beside P1's chevron (and P2's dashed ring, see the screenshot).
    await setColourBlind(page, true);
    const cb = await poseAndProbe(page, high);
    await shot(page, testInfo, 'gfx-13-colourblind');
    expect(cb.emberRight, `label pixels ${cb.emberRight} vs ${a.emberRight}`).toBeGreaterThan(a.emberRight + 15);
    await setColourBlind(page, false);

    // Ball placed off the side of the screen, before the camera follows: arrow on that edge.
    const side = await poseAndProbe(page, { aids: true, ball: [0, 0.11, 0], vel: [0, 0, 0], frames: 20, lastDtMs: 1, jump: 'side' });
    await shot(page, testInfo, 'gfx-13-arrow-side');
    expect(side.ballOn).toBe(false);
    const onEdge = side.arrowX < 31 || side.arrowX > 1180 - 31 || side.arrowY < 31 || side.arrowY > 820 - 31;
    expect(onEdge, `arrow at (${side.arrowX.toFixed(0)}, ${side.arrowY.toFixed(0)})`).toBe(true);
    expect(side.arrowWhite, 'white arrow at the edge').toBeGreaterThan(30);

    // A high ball above the top of the screen: arrow on the top edge.
    const up = await poseAndProbe(page, { aids: true, ball: [0, 0.11, 0], vel: [0, 0, 0], frames: 20, lastDtMs: 1, jump: 'high' });
    await shot(page, testInfo, 'gfx-13-arrow-high');
    expect(up.ballOn).toBe(false);
    expect(up.arrowY).toBeLessThan(40);
    expect(up.arrowWhite, 'white arrow at the top edge').toBeGreaterThan(30);

    expect(errors).toEqual([]);
  });
});
