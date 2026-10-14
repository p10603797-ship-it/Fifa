/**
 * [GFX-07] The part-based player model in the real app (iPad-like 1180 x 820, touch, Chromium + SwiftShader WebGL2).
 * The loop is stopped after kick-off; frames are drawn with GameRenderer.render (dt 100 ms) and probed with
 * readPixels in the same task (preserveDrawingBuffer is false). Uses the debug hook window.__dotkickPlayers
 * (close-up camera, held poses, joint points, applied colours). Checks:
 *  - budgets: 8 player draw calls (<= 14), <= 30k player triangles; whole frame <= 80 calls, <= 200k triangles;
 *  - the shaders compile (zero console errors / warnings) and colour each region from its instance colours: in a
 *    front close-up the chest shows the shirt (or its pattern colour), the shorts, socks, thigh and face show the
 *    shorts, sock and skin colours (chroma match under the stadium light);
 *  - the shirt number is drawn on the back: pixels across the back panel change when the number is removed;
 *  - a held kick pose swings the leg forward (joint points) and draws it there;
 *  - a sent-off player is hidden.
 * Screenshots (look at them): broadcast kick-off, front / back / side close-ups, keeper, attached to the test and
 * written to $GFX07_SHOT_DIR when set.
 * Run: npx vite build --outDir dist-e2e/gfx-07 --emptyOutDir && PW_DIST=dist-e2e/gfx-07 PW_PORT=4207 npx playwright test tests/e2e/gfx-07-players.spec.ts
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPose, PoseIdx } from '../../src/contracts/render';

type Rgb = [number, number, number];
const GPU_ENVIRONMENT_NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/];
const CANVAS_ONLY = '#ui, #hud, #touch { visibility: hidden !important; }';
/** Joint indices (src/render/players/fk.ts Joint). */
const J = { ROOT: 0, SPINE: 1, HEAD: 2, HIP_L: 7, KNEE_L: 8, ANKLE_R: 12 } as const;
const STRIKER = 9;
const KEEPER = 0;

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
  const dir = process.env.GFX07_SHOT_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.png`), png);
  }
}

/** Draw n frames of 100 ms with the stopped loop's prev / curr states. */
async function draw(page: Page, n: number): Promise<void> {
  await page.evaluate((count) => {
    const d = window.__dotkick!;
    const rt = d.app.session.runtime()!;
    const info = { nowMs: 0, dtMs: 100, frame: 0, ticks: 1, paused: false };
    for (let i = 0; i < count; i++) { info.frame++; info.nowMs += 100; d.app.renderer.render(rt.prev, rt.curr, 1, info); }
  }, n);
}

/**
 * Place slots in prev and curr (x, z, facing +x), park everyone else far away, freeze velocities, ball aside.
 */
async function stage(page: Page, placed: [number, number, number][]): Promise<void> {
  await page.evaluate((list) => {
    const rt = window.__dotkick!.app.session.runtime()!;
    for (const s of [rt.prev, rt.curr] as unknown as { players: { x: number; z: number; fx: number; fz: number; vx: number; vz: number; active: number }[]; ball: { x: number; y: number; z: number; vx: number; vy: number; vz: number; owner: number } }[]) {
      s.players.forEach((p, i) => {
        p.x = i < 11 ? -40 + i * 2.5 : 15 + (i - 11) * 2.5; p.z = -30; p.fx = 1; p.fz = 0; p.vx = 0; p.vz = 0; p.active = 1;
      });
      for (const [slot, x, z] of list) { const p = s.players[slot]!; p.x = x; p.z = z; }
      s.ball.x = 0; s.ball.y = 0.11; s.ball.z = 12; s.ball.vx = 0; s.ball.vy = 0; s.ball.vz = 0; s.ball.owner = -1;
    }
  }, placed);
}

/** Probe colours at world points (3 x 3 buffer px mean) after drawing `frames` frames, in one task. */
async function probe(page: Page, pts: [number, number, number][], frames = 3): Promise<{ c: Rgb; on: boolean }[]> {
  return page.evaluate(([list, n]) => {
    const d = window.__dotkick!;
    const rt = d.app.session.runtime()!;
    const r = d.app.renderer;
    const info = { nowMs: 0, dtMs: 100, frame: 0, ticks: 1, paused: false };
    for (let i = 0; i < n; i++) { info.frame++; info.nowMs += 100; r.render(rt.prev, rt.curr, 1, info); }
    const gl = (document.getElementById('game') as HTMLCanvasElement).getContext('webgl2')!;
    const W = window.innerWidth, H = window.innerHeight, bw = gl.drawingBufferWidth, bh = gl.drawingBufferHeight;
    const buf = new Uint8Array(36);
    const out = { x: 0, y: 0 };
    return list.map(([x, y, z]) => {
      const ok = r.projector.pitchToScreen(x, y, z, out);
      const on = ok && out.x > 4 && out.x < W - 4 && out.y > 4 && out.y < H - 4;
      if (!on) return { c: [0, 0, 0] as [number, number, number], on: false };
      const bx = Math.round((out.x * bw) / W), by = Math.round(bh - 1 - (out.y * bh) / H);
      gl.readPixels(bx - 1, by - 1, 3, 3, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const c: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < 9; i++) for (let k = 0; k < 3; k++) c[k] += buf[i * 4 + k]! / 9;
      return { c, on: true };
    });
  }, [pts, frames] as const);
}

const hexRgb = (h: number): Rgb => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const dist = (a: Rgb, b: Rgb): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const luma = (c: Rgb): number => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
/** Chroma match under a near-white light: cosine of the colour vectors (dark colours: just dark). */
function sameColour(measured: Rgb, hex: number): boolean {
  const e = hexRgb(hex);
  if (luma(e) < 40) return luma(measured) < 70;
  const dot = e[0] * measured[0] + e[1] * measured[1] + e[2] * measured[2];
  const cos = dot / (Math.hypot(...e) * Math.hypot(...measured) + 1e-6);
  return cos > 0.97;
}

test.describe('GFX-07 player model', () => {
  test('part model: budgets, region colours, back numbers, poses, sent-off hidden; screenshots', async ({ page }, info) => {
    test.setTimeout(300_000);
    const messages = collectConsole(page);
    await kickOff(page);

    // Budgets and the debug hook.
    const meta = await page.evaluate(() => window.__dotkickPlayers!.info());
    expect(meta.drawCalls).toBe(8);
    expect(meta.instances).toEqual([22, 22, 22, 44, 44, 44, 44, 44]);
    expect(meta.trianglesPerPlayer * 22).toBeLessThanOrEqual(30_000);
    expect(meta.numberAtlas).toBe(true);

    // Broadcast view of the kick-off as played.
    await draw(page, 16);
    const stats = await page.evaluate(() => window.__dotkickRendererStats!());
    expect(stats.drawCalls).toBeLessThanOrEqual(80);
    expect(stats.triangles).toBeLessThanOrEqual(200_000);
    expect(stats.triangles).toBeGreaterThan(22_000); // the players alone are ~23k
    await shot(page, info, 'gfx-07-broadcast');

    // Front close-up of the striker: region colours.
    await stage(page, [[STRIKER, 0, 4], [KEEPER, -6, 4]]);
    await page.evaluate((s) => window.__dotkickPlayers!.closeUp(s, 4.5, 15, 1.4), STRIKER);
    await draw(page, 2);
    const pts = await page.evaluate((s) => {
      const P = window.__dotkickPlayers!;
      return [
        P.point(s, 1, 0.16, 0.22, 0.09), // chest (right of centre: stripes / halves / sash all show a kit colour)
        P.point(s, 0, 0.13, -0.07, -0.05), // shorts front
        P.point(s, 8, 0.1, -0.24, 0), // left sock (shin front)
        P.point(s, 7, 0.12, -0.31, 0), // left thigh skin
        P.point(s, 2, 0.16, 0.19, 0.03), // face
      ] as [number, number, number][];
    }, STRIKER);
    const look = await page.evaluate((s) => window.__dotkickPlayers!.look(s), STRIKER);
    const px = await probe(page, pts, 1);
    for (const p of px) expect(p.on).toBe(true);
    const [chest, shorts, sock, thigh, face] = px.map((p) => p.c) as Rgb[];
    expect(sameColour(chest!, look.shirt) || sameColour(chest!, look.shirt2), `chest ${chest!.map(Math.round)} vs shirt ${look.shirt.toString(16)} / ${look.shirt2.toString(16)}`).toBe(true);
    expect(sameColour(shorts!, look.shorts), `shorts ${shorts!.map(Math.round)} vs ${look.shorts.toString(16)}`).toBe(true);
    expect(sameColour(sock!, look.socks), `sock ${sock!.map(Math.round)} vs ${look.socks.toString(16)}`).toBe(true);
    expect(sameColour(thigh!, look.skin), `thigh ${thigh!.map(Math.round)} vs skin ${look.skin.toString(16)}`).toBe(true);
    expect(sameColour(face!, look.skin), `face ${face!.map(Math.round)} vs skin ${look.skin.toString(16)}`).toBe(true);
    await shot(page, info, 'gfx-07-closeup-front');

    // Back close-up: the number on the back panel (pixels change when the number is removed).
    await page.evaluate((s) => window.__dotkickPlayers!.closeUp(s, 3.6, 180, 1.45), STRIKER);
    await draw(page, 2);
    const grid = await page.evaluate((s) => {
      const P = window.__dotkickPlayers!;
      const g: [number, number, number][] = [];
      for (let iy = 0; iy < 5; iy++) for (let iz = 0; iz < 7; iz++) g.push(P.point(s, 1, -0.14, 0.25 + iy * 0.04, -0.09 + iz * 0.03));
      return g;
    }, STRIKER);
    const withNo = await probe(page, grid, 1);
    const number = (await page.evaluate((s) => window.__dotkickPlayers!.look(s), STRIKER)).shirtNumber;
    expect(number).toBeGreaterThan(0);
    await shot(page, info, 'gfx-07-closeup-back');
    await page.evaluate((s) => {
      const rt = window.__dotkick!.app.session.runtime()!;
      (rt.prev as unknown as { attrs: { shirt: number }[] }).attrs[s]!.shirt = 0;
      (rt.curr as unknown as { attrs: { shirt: number }[] }).attrs[s]!.shirt = 0;
    }, STRIKER);
    const without = await probe(page, grid, 2);
    const changed = withNo.filter((p, i) => p.on && without[i]!.on && dist(p.c, without[i]!.c) > 60).length;
    expect(changed, `back-number pixels changed by removing number ${number}`).toBeGreaterThanOrEqual(4);
    expect((await page.evaluate((s) => window.__dotkickPlayers!.look(s), STRIKER)).shirtNumber).toBe(0);
    await page.evaluate(([s, n]) => {
      const rt = window.__dotkick!.app.session.runtime()!;
      (rt.prev as unknown as { attrs: { shirt: number }[] }).attrs[s]!.shirt = n;
      (rt.curr as unknown as { attrs: { shirt: number }[] }).attrs[s]!.shirt = n;
    }, [STRIKER, number] as const);

    // Side view of a held kick pose: the right foot is well in front of the hips, and drawn there.
    const kick = createPose();
    kick[PoseIdx.HIP_R_PITCH] = 1.05; kick[PoseIdx.KNEE_R] = 0.15; kick[PoseIdx.ANKLE_R] = -0.5;
    kick[PoseIdx.HIP_L_PITCH] = -0.15; kick[PoseIdx.KNEE_L] = 0.35; kick[PoseIdx.ANKLE_L] = 0.2;
    kick[PoseIdx.SHOULDER_L_PITCH] = 0.5; kick[PoseIdx.SHOULDER_L_ROLL] = 0.9; kick[PoseIdx.SHOULDER_R_PITCH] = -0.7;
    kick[PoseIdx.ELBOW_L] = 0.4; kick[PoseIdx.ELBOW_R] = 0.5; kick[PoseIdx.SPINE_PITCH] = -0.12; kick[PoseIdx.ROOT_ROLL] = -0.1;
    await page.evaluate(([s, pose]) => {
      const P = window.__dotkickPlayers!;
      P.holdPose(s, pose);
      P.closeUp(s, 6, -90, 1.2); // from his left side
    }, [STRIKER, Array.from(kick)] as const);
    await draw(page, 2);
    const foot = await page.evaluate((s) => {
      const P = window.__dotkickPlayers!;
      return { toe: P.point(s, 12, 0.2, -0.08, 0), hip: P.joint(s, 0) };
    }, STRIKER);
    expect(foot.toe[0] - foot.hip[0]).toBeGreaterThan(0.6); // he faces +x
    expect(foot.toe[1]).toBeGreaterThan(0.25);
    // The raised right boot vs empty space behind the standing leg at the same height (grass / stand behind).
    const bootMid = await page.evaluate((s) => window.__dotkickPlayers!.point(s, 12, 0.06, -0.04, 0), STRIKER);
    const [footPx, airPx] = await probe(page, [bootMid, [foot.hip[0] - 0.75, bootMid[1], foot.hip[2]]], 1);
    expect(footPx!.on && airPx!.on).toBe(true);
    expect(dist(footPx!.c, airPx!.c), 'the raised boot is drawn where the pose put it').toBeGreaterThan(40);
    await shot(page, info, 'gfx-07-closeup-kick');

    // Keeper: keeper kit, long sleeves and gloves, ready pose.
    const ready = createPose();
    ready[PoseIdx.ROOT_Y] = -0.16; ready[PoseIdx.ROOT_PITCH] = 0.25; ready[PoseIdx.HIP_L_PITCH] = 0.45; ready[PoseIdx.HIP_R_PITCH] = 0.45;
    ready[PoseIdx.HIP_L_ROLL] = 0.15; ready[PoseIdx.HIP_R_ROLL] = 0.15; ready[PoseIdx.KNEE_L] = 0.8; ready[PoseIdx.KNEE_R] = 0.8;
    ready[PoseIdx.ANKLE_L] = 0.1; ready[PoseIdx.ANKLE_R] = 0.1; ready[PoseIdx.SHOULDER_L_PITCH] = 0.9; ready[PoseIdx.SHOULDER_R_PITCH] = 0.9;
    ready[PoseIdx.SHOULDER_L_ROLL] = 0.5; ready[PoseIdx.SHOULDER_R_ROLL] = 0.5; ready[PoseIdx.ELBOW_L] = 1.1; ready[PoseIdx.ELBOW_R] = 1.1;
    await page.evaluate(([k, s, pose]) => {
      const P = window.__dotkickPlayers!;
      P.holdPose(s, null);
      P.holdPose(k, pose);
      P.closeUp(k, 4.5, 25, 1.3);
    }, [KEEPER, STRIKER, Array.from(ready)] as const);
    await draw(page, 1); // the held pose is applied by the next update: read joint points after it
    const kLook = await page.evaluate((k) => window.__dotkickPlayers!.look(k), KEEPER);
    expect(kLook.keeper).toBe(true);
    const gl = await page.evaluate((k) => window.__dotkickPlayers!.point(k, 4, 0, -0.3, 0), KEEPER); // left glove
    const [glovePx] = await probe(page, [gl], 2);
    await shot(page, info, 'gfx-07-keeper');
    expect(glovePx!.on).toBe(true);
    expect(sameColour(glovePx!.c, kLook.hand), `glove ${glovePx!.c.map(Math.round)} vs ${kLook.hand.toString(16)} at ${gl.map((v) => v.toFixed(2))}`).toBe(true);

    // A sent-off player is hidden: the close-up falls back to the broadcast camera and he is not drawn.
    await page.evaluate((k) => {
      window.__dotkickPlayers!.holdPose(k, null);
      const rt = window.__dotkick!.app.session.runtime()!;
      (rt.prev as unknown as { players: { active: number }[] }).players[k]!.active = 0;
      (rt.curr as unknown as { players: { active: number }[] }).players[k]!.active = 0;
    }, KEEPER);
    await draw(page, 1);
    expect((await page.evaluate(() => window.__dotkickPlayers!.info())).hidden).toEqual([KEEPER]);
    await page.evaluate(() => window.__dotkickPlayers!.closeUp(-1));

    expect(messages, messages.join('\n')).toEqual([]);
  });
});
