/**
 * [GFX-04] Goals and nets in the real app (iPad-like 1180 x 820, touch, Chromium + SwiftShader WebGL2). The loop is
 * stopped; the test poses the live state, feeds NET / POST events to the renderer and draws frames itself. Checks:
 *  - goal close-up through the debug camera hook (window.__dotkickGoals.closeUp): white posts and bar, see-through
 *    net (the stand shows through it: many distinct colours inside the goal), 2 draw calls for both goals;
 *  - NET event: the ripple visibly moves the net (pixel difference in the goal far above the frame-to-frame noise
 *    of the animated crowd), then dies out exactly (no ripple left, net back to the rest picture);
 *  - POST event: the frame shakes (sway at bar height) and settles back to exactly 0;
 *  - broadcast camera view of a goal (screenshot) and zero console errors / warnings.
 * Screenshots (look at them): attached to the test, and written to $GFX04_SHOT_DIR when set.
 * Run: npx vite build --outDir dist-e2e/gfx-04 --emptyOutDir && PW_DIST=dist-e2e/gfx-04 PW_PORT=4204 npx playwright test tests/e2e/gfx-04-goals.spec.ts
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
  const dir = process.env.GFX04_SHOT_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.png`), png);
  }
}

interface Grab {
  /** Snapshot of the goals module after the frames. */
  ripples: number;
  maxAmp: number;
  sway: [number, number];
  drawCalls: number;
  frameDrawCalls: number;
  /** Mean per-pixel RGB difference (0..255) of the goal box against the stored picture `cmp` (-1 when none). */
  diff: number;
  /** Fraction of pixels in the goal box that changed by more than 24 against `cmp` (-1 when none). */
  changed: number;
  /** Distinct colours (5 bits per channel) and near-white pixels in the goal box. */
  colours: number;
  white: number;
}

interface Step {
  /** Debug close-up: 1 / -1 = that goal, 0 = broadcast camera. */
  closeUp: number;
  frames: number;
  dtMs: number;
  /** Events fed to the renderer before the frames: [type, a, b, c, x, y, z]. */
  events?: [number, number, number, number, number, number, number][];
  /** Ball centre and velocity. */
  ball?: [number, number, number];
  vel?: [number, number, number];
  /** Store the final picture under this name / compare against the stored picture of that name. */
  store?: string;
  cmp?: string;
}

/** Pose the state, feed events, draw frames, then probe the goal box of the drawing buffer right after the last render. */
async function run(page: Page, st: Step): Promise<Grab> {
  return page.evaluate((ps) => {
    const d = window.__dotkick!;
    const app = d.app;
    const s = app.ctx.session.getState()! as unknown as {
      tick: number; ball: Record<string, number>; ctrl: { kind: number; slot: number }[]; match: { phase: number };
      players: { ctrl: number }[];
    };
    s.match.phase = 2; // IN_PLAY (no humans: no aids in the picture)
    for (const c of s.ctrl) { c.kind = 0; c.slot = -1; }
    for (const p of s.players) p.ctrl = -1;
    const b = s.ball;
    if (ps.ball) { [b.x, b.y, b.z] = ps.ball; }
    if (ps.vel) { [b.vx, b.vy, b.vz] = ps.vel; }
    b.owner = -1; b.heldBy = -1; b.shotBy = 9; b.passTarget = -1; b.sx = 0; b.sy = 0; b.sz = 0;
    const goals = window.__dotkickGoals!;
    goals.closeUp(ps.closeUp);
    const st0 = s as unknown as Parameters<typeof app.renderer.render>[0];
    if (ps.events && ps.events.length > 0) {
      const evs = ps.events.map((e) => ({ type: e[0], tick: s.tick, a: e[1], b: e[2], c: e[3], d: 0, x: e[4], y: e[5], z: e[6] }));
      const buf = { count: evs.length, get: (i: number) => evs[i]!, begin() { /* fixed */ }, emit() { /* fixed */ } };
      app.renderer.onEvents(buf as unknown as Parameters<typeof app.renderer.onEvents>[0], st0);
    }
    const w = window as unknown as { __gfx04Info?: { nowMs: number; dtMs: number; frame: number; ticks: number; paused: boolean } };
    const info = w.__gfx04Info ?? (w.__gfx04Info = { nowMs: 0, dtMs: 16, frame: 0, ticks: 1, paused: false });
    for (let i = 0; i < ps.frames; i++) {
      info.frame++; info.dtMs = ps.dtMs; info.nowMs += ps.dtMs;
      app.renderer.render(st0, st0, 1, info);
    }
    const snap = goals.snapshot();
    const stats = app.renderer.stats();
    // Goal box on screen: the close-up frames the goal around the centre.
    const canvas = document.getElementById('game') as HTMLCanvasElement;
    const gl = canvas.getContext('webgl2')!;
    const bw = gl.drawingBufferWidth, bh = gl.drawingBufferHeight;
    const x0 = Math.floor(bw * 0.2), x1 = Math.floor(bw * 0.8);
    const y0 = Math.floor(bh * 0.2), y1 = Math.floor(bh * 0.8);
    const gw = x1 - x0, gh = y1 - y0;
    const px = new Uint8Array(gw * gh * 4);
    gl.readPixels(x0, y0, gw, gh, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const store = window as unknown as { __gfx04Pics?: Record<string, Uint8Array> };
    const pics = store.__gfx04Pics ?? (store.__gfx04Pics = {});
    let diff = -1, changed = -1;
    const ref = ps.cmp ? pics[ps.cmp] : undefined;
    if (ref && ref.length === px.length) {
      let sum = 0, n = 0;
      for (let i = 0; i < px.length; i += 4) {
        const dd = Math.abs(px[i]! - ref[i]!) + Math.abs(px[i + 1]! - ref[i + 1]!) + Math.abs(px[i + 2]! - ref[i + 2]!);
        sum += dd / 3;
        if (dd / 3 > 24) n++;
      }
      diff = sum / (px.length / 4);
      changed = n / (px.length / 4);
    }
    if (ps.store) pics[ps.store] = px;
    const seen = new Uint8Array(32768);
    let colours = 0, white = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i]!, g = px[i + 1]!, bl = px[i + 2]!;
      const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (bl >> 3);
      if (seen[k] === 0) { seen[k] = 1; colours++; }
      if (r > 215 && g > 215 && bl > 215) white++;
    }
    let maxAmp = 0;
    for (const r of snap.ripples) maxAmp = Math.max(maxAmp, Math.abs(r.amp));
    return {
      ripples: snap.ripples.length, maxAmp, sway: snap.sway, drawCalls: snap.drawCalls, frameDrawCalls: stats.drawCalls,
      diff, changed, colours, white,
    };
  }, st);
}

const GL = 52.5, GW = 3.66;
const NET = 3, POST = 2;

test.describe('GFX-04 goals and nets', () => {
  test('goal close-up: frame, see-through net, ripple on NET, shake on POST, broadcast view (screenshots)', async ({ page }, testInfo) => {
    const errors = collectConsole(page);
    await kickOff(page);

    // Close-up of the +x goal at rest; the ball sits in front of the back net.
    const rest = await run(page, { closeUp: 1, frames: 6, dtMs: 100, ball: [GL + 1.5, 1.2, 0.6], vel: [0, 0, 0], store: 'restA' });
    await shot(page, testInfo, 'gfx-04-closeup');
    expect(rest.drawCalls, 'both goals in 2 draw calls').toBe(2);
    expect(rest.ripples).toBe(0);
    expect(rest.white, 'white posts, bar and net cords').toBeGreaterThan(2000);
    expect(rest.colours, 'see-through net: the stand and pitch show through').toBeGreaterThan(60);
    console.log(`GFX-04 close-up: ${rest.frameDrawCalls} frame draw calls, ${rest.colours} colours, ${rest.white} white px`);

    // Frame-to-frame noise of the animated scene (crowd) with the net at rest.
    const restB = await run(page, { closeUp: 1, frames: 10, dtMs: 16, cmp: 'restA', store: 'restB' });
    expect(restB.ripples).toBe(0);

    // NET: a 25 m/s shot enters the goal mouth; the ripple bulges where it meets the back net.
    const hit = await run(page, {
      closeUp: 1, frames: 10, dtMs: 16, vel: [25, 0, 0], cmp: 'restB',
      events: [[NET, 1, 0, 25, GL + 0.3, 1.2, 0.6]],
    });
    await shot(page, testInfo, 'gfx-04-ripple');
    expect(hit.ripples).toBeGreaterThanOrEqual(1);
    expect(hit.maxAmp).toBeGreaterThan(0.3);
    console.log(`GFX-04 ripple: diff ${hit.diff.toFixed(2)} changed ${(hit.changed * 100).toFixed(2)}% (noise ${restB.diff.toFixed(2)} / ${(restB.changed * 100).toFixed(2)}%)`);
    expect(hit.changed, 'the ripple visibly moves the net').toBeGreaterThan(restB.changed * 3 + 0.004);

    // 1.5 s later the ripple is gone: no slot in use and the picture is back to rest (noise level).
    const after = await run(page, { closeUp: 1, frames: 15, dtMs: 100, vel: [0, 0, 0], cmp: 'restB' });
    console.log(`GFX-04 after: diff ${after.diff.toFixed(2)} changed ${(after.changed * 100).toFixed(2)}%`);
    expect(after.ripples).toBe(0);
    expect(after.changed, 'net back at rest').toBeLessThan(restB.changed * 3 + 0.004);

    // POST: a 20 m/s hit on the near post shakes the frame, which settles back to exactly 0.
    const post = await run(page, { closeUp: 1, frames: 3, dtMs: 16, events: [[POST, 1, 0, 20, GL - 0.06, 1.4, GW + 0.06]] });
    await shot(page, testInfo, 'gfx-04-post');
    expect(Math.abs(post.sway[1]), 'the +x goal sways').toBeGreaterThan(0.01);
    expect(post.sway[0]).toBe(0);
    const settled = await run(page, { closeUp: 1, frames: 12, dtMs: 100 });
    expect(settled.sway).toEqual([0, 0]);

    // Broadcast camera with the ball by the goal: how the goal reads in play.
    await run(page, { closeUp: 0, frames: 30, dtMs: 100, ball: [GL - 8, 0.11, 4], vel: [0, 0, 0] });
    await shot(page, testInfo, 'gfx-04-broadcast');

    expect(errors).toEqual([]);
  });
});
