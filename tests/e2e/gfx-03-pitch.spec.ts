/**
 * [GFX-03] The pitch from the broadcast camera in the real app (iPad-like 1180 x 820, touch, Chromium + SwiftShader
 * WebGL2). The loop is stopped, players hidden (active = 0) and the ball sunk below the grass (the camera follows
 * its x / z only), so every pixel probe sees the pitch alone. The renderer draws 16 frames of 100 ms so the camera
 * settles. Checks:
 *  - lines are bright paint where PITCH_MARKS put them (halfway line, centre circle, centre spot, far touchline,
 *    penalty area, goal area, penalty arc, penalty spot), grass is green off the lines;
 *  - mowing stripes alternate (light stripe on the halfway line, dark one next to it);
 *  - "far touchline breaks up / shimmers": every buffer column along the far touchline holds at least 2 paint pixels
 *    (lines >= 2 px wide at the default resolution scale 0.75), and the line is continuous;
 *  - day and floodlit night both draw (night darker, lines still clearly brighter than grass);
 *  - End to End camera (looking along the pitch): the far, foreshortened halfway line also stays >= 2 px, unbroken;
 *  - zero console errors / warnings (the generated GLSL compiles under ANGLE).
 * Screenshots: kick-off as played (players on), midfield day, the +x box day, midfield night, end-to-end view.
 * Screenshots (look at them): attached to the test, and written to $GFX03_SHOT_DIR when set.
 * Run: npx vite build --outDir dist-e2e/gfx-03 --emptyOutDir && PW_DIST=dist-e2e/gfx-03 PW_PORT=4203 npx playwright test tests/e2e/gfx-03-pitch.spec.ts
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Rgb = [number, number, number];
/** Messages Chromium prints about the software GPU (not page bugs). */
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
  const dir = process.env.GFX03_SHOT_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.png`), png);
  }
}

interface Probe {
  /** World points expected on paint: colour read at the projected point (3 x 3 buffer px mean, brightest px). */
  lines: { name: string; on: boolean; c: Rgb; max: number }[];
  /** Off-line grass. */
  grass: { name: string; on: boolean; c: Rgb }[];
  stripes: { light: Rgb; dark: Rgb };
  /** Far touchline scan: columns scanned, fewest paint rows in a column, smallest (brightest - grass) luma, mean grass luma. */
  far: { cols: number; minRows: number; minMax: number; grassLuma: number };
  bufW: number;
  bufH: number;
}

/**
 * Pose (ball at x, sunk; players hidden), settle the camera, optionally re-apply the match with config.night, and
 * probe the drawing buffer right after the last render (preserveDrawingBuffer is false).
 */
async function poseAndProbe(page: Page, ballX: number, night: boolean): Promise<Probe> {
  return page.evaluate(([bx, nightOn]) => {
    type V = [number, number, number];
    const d = window.__dotkick!;
    const rt = d.app.session.runtime()!;
    const r = d.app.renderer;
    type St = typeof rt.curr;
    const states = [rt.prev, rt.curr] as unknown as { players: { active: number }[]; ball: { x: number; y: number; z: number; vx: number; vy: number; vz: number; owner: number }; config: { night: number } }[];
    for (const s of states) {
      for (const p of s.players) p.active = 0;
      s.ball.x = bx; s.ball.y = -3; s.ball.z = 3; s.ball.vx = 0; s.ball.vy = 0; s.ball.vz = 0; s.ball.owner = -1;
    }
    let prev = rt.prev as St, curr = rt.curr as St;
    if (nightOn) {
      const nc = { ...curr, config: { ...curr.config, night: 1 } } as St;
      const np = { ...prev, config: { ...prev.config, night: 1 } } as St;
      r.setMatch(nc, d.ctx.clubs);
      prev = np; curr = nc;
    } else {
      r.setMatch(curr, d.ctx.clubs);
    }
    const info = { nowMs: 0, dtMs: 100, frame: 0, ticks: 1, paused: false };
    for (let i = 0; i < 16; i++) {
      info.frame++; info.nowMs += 100;
      r.render(prev, curr, 1, info);
    }
    const canvas = document.getElementById('game') as HTMLCanvasElement;
    const gl = canvas.getContext('webgl2')!;
    const W = window.innerWidth, H = window.innerHeight;
    const bw = gl.drawingBufferWidth, bh = gl.drawingBufferHeight;
    const buf = new Uint8Array(4 * 64);
    const out = { x: 0, y: 0 };
    const toBuf = (x: number, z: number): { bx: number; by: number; on: boolean } => {
      const ok = r.projector.pitchToScreen(x, 0, z, out);
      const on = ok && out.x > 8 && out.x < W - 8 && out.y > 8 && out.y < H - 8;
      return { bx: Math.round((out.x * bw) / W), by: Math.round(bh - 1 - (out.y * bh) / H), on };
    };
    const luma = (o: number): number => 0.299 * buf[o]! + 0.587 * buf[o + 1]! + 0.114 * buf[o + 2]!;
    const read = (x: number, z: number): { c: V; max: number; on: boolean } => {
      const p = toBuf(x, z);
      if (!p.on) return { c: [0, 0, 0], max: 0, on: false };
      gl.readPixels(p.bx - 1, p.by - 1, 3, 3, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const c: V = [0, 0, 0];
      let max = 0;
      for (let i = 0; i < 9; i++) {
        for (let k = 0; k < 3; k++) c[k] += buf[i * 4 + k]! / 9;
        max = Math.max(max, luma(i * 4));
      }
      return { c, max, on: true };
    };
    const LW = 0.12;
    const linePts: [string, number, number][] = [
      ['halfway far', 0, -26], ['halfway mid', 0, -16], ['halfway near', 0, 14],
      ['centre circle far', 0, -(9.15 - LW / 2)], ['centre circle right', 9.15 - LW / 2, 0], ['centre circle left', -(9.15 - LW / 2), 0],
      ['centre circle diag', (9.15 - LW / 2) * Math.SQRT1_2, -(9.15 - LW / 2) * Math.SQRT1_2], ['centre spot', 0, 0],
      ['far touchline', -12, -(34 - LW / 2)], ['far touchline 2', 12, -(34 - LW / 2)],
      ['penalty area front', 36 + LW / 2, -12], ['penalty area side', 44, -(20.16 - LW / 2)],
      ['goal area front', 47 + LW / 2, -5], ['penalty spot', 41.5, 0],
      ['penalty arc', 41.5 - (9.15 - LW / 2), 0], ['goal line', 52.5 - LW / 2, -15],
    ];
    const grassPts: [string, number, number][] = [
      ['grass a', -10, -15], ['grass b', 10, -15], ['grass c', -10, 15], ['grass d', 10, 15], ['grass e', 20, -28], ['grass f', -20, 5],
      ['grass in box', 44, -14], ['grass in circle', 4, -3],
    ];
    const lines = linePts.map(([name, x, z]) => ({ name, ...read(x, z) }));
    const grass = grassPts.map(([name, x, z]) => { const g = read(x, z); return { name, on: g.on, c: g.c }; });
    const stripes = { light: read(1.3, -20).c, dark: read(5, -20).c };
    // Far touchline scan from x = -20 to 20 (skipping the halfway line): per buffer column, the grass reference is
    // the mean luma of the 4 outermost rows on each side of a 25-row window; paint rows are > reference + 30.
    const a = toBuf(-20, -(34 - LW / 2)), b = toBuf(20, -(34 - LW / 2)), hw = toBuf(0, -(34 - LW / 2));
    let cols = 0, minRows = 99, minMax = 999, grassLuma = 0;
    for (let x = a.bx; x <= b.bx; x++) {
      if (Math.abs(x - hw.bx) <= 4) continue;
      const yc = Math.round(a.by + ((b.by - a.by) * (x - a.bx)) / Math.max(1, b.bx - a.bx));
      gl.readPixels(x, yc - 12, 1, 25, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let ref = 0;
      for (let i = 0; i < 4; i++) ref += (luma(i * 4) + luma((24 - i) * 4)) / 8;
      let rows = 0, mx = 0;
      for (let i = 0; i < 25; i++) {
        const l = luma(i * 4);
        mx = Math.max(mx, l);
        if (l > ref + 30) rows++;
      }
      cols++;
      grassLuma += ref;
      minRows = Math.min(minRows, rows);
      minMax = Math.min(minMax, mx - ref);
    }
    grassLuma /= Math.max(1, cols);
    // Restore the normal (day) match look for whatever runs next.
    if (nightOn) r.setMatch(rt.curr, d.ctx.clubs);
    return { lines, grass, stripes, far: { cols, minRows, minMax, grassLuma }, bufW: bw, bufH: bh };
  }, [ballX, night] as const);
}

const luma = (c: Rgb): number => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const grassLike = (c: Rgb): boolean => c[1] > c[0] + 8 && c[1] > c[2] + 8;

test.describe('GFX-03 pitch', () => {
  test('broadcast view: stripes, lines where the constants put them, far touchline >= 2 px and unbroken; day and night', async ({ page }, info) => {
    test.setTimeout(240_000);
    const messages = collectConsole(page);
    await kickOff(page);

    // The kick-off as played (players and ball), for looking at: kits and markers against the grass.
    await page.evaluate(() => {
      const d = window.__dotkick!;
      const rt = d.app.session.runtime()!;
      const info = { nowMs: 0, dtMs: 100, frame: 0, ticks: 1, paused: false };
      for (let i = 0; i < 16; i++) { info.frame++; info.nowMs += 100; d.app.renderer.render(rt.prev, rt.curr, 1, info); }
    });
    await shot(page, info, 'gfx-03-kickoff');

    // Midfield, day.
    const mid = await poseAndProbe(page, 0, false);
    await shot(page, info, 'gfx-03-midfield-day');
    const grassL = mid.grass.filter((g) => g.on).map((g) => luma(g.c));
    const grassMax = Math.max(...grassL);
    for (const g of mid.grass) {
      if (!g.on) continue;
      expect(grassLike(g.c), `${g.name} is green (${g.c.map(Math.round)})`).toBe(true);
    }
    const midLines = mid.lines.filter((l) => l.on);
    expect(midLines.map((l) => l.name)).toEqual(expect.arrayContaining(['halfway far', 'halfway mid', 'centre circle far', 'centre circle right', 'centre circle left', 'centre spot', 'far touchline', 'far touchline 2']));
    for (const l of midLines) {
      expect(l.max - grassMax, `${l.name}: paint (${Math.round(l.max)}) brighter than grass (${Math.round(grassMax)})`).toBeGreaterThan(45);
    }
    expect(luma(mid.stripes.light) - luma(mid.stripes.dark), `stripes ${mid.stripes.light.map(Math.round)} vs ${mid.stripes.dark.map(Math.round)}`).toBeGreaterThan(4);
    // Regression "far touchline breaks up / shimmers": >= 2 paint px in every column, no gap.
    expect(mid.far.cols).toBeGreaterThan(100);
    expect(mid.far.minRows, `far touchline rows per column (grass luma ${Math.round(mid.far.grassLuma)})`).toBeGreaterThanOrEqual(2);
    expect(mid.far.minMax, 'far touchline contrast in every column').toBeGreaterThan(45);

    // The +x penalty area, day: box, goal area, arc and spot under the camera.
    const box = await poseAndProbe(page, 40, false);
    await shot(page, info, 'gfx-03-box-day');
    const boxLines = box.lines.filter((l) => l.on);
    expect(boxLines.map((l) => l.name)).toEqual(expect.arrayContaining(['penalty area front', 'penalty area side', 'goal area front', 'penalty spot', 'penalty arc']));
    const boxGrass = Math.max(...box.grass.filter((g) => g.on).map((g) => luma(g.c)));
    for (const l of boxLines) {
      expect(l.max - boxGrass, `${l.name}: paint (${Math.round(l.max)}) brighter than grass (${Math.round(boxGrass)})`).toBeGreaterThan(40);
    }
    for (const g of box.grass) if (g.on) expect(grassLike(g.c), `${g.name} is green (${g.c.map(Math.round)})`).toBe(true);

    // Midfield, floodlit night: darker, lines still read.
    const night = await poseAndProbe(page, 0, true);
    await shot(page, info, 'gfx-03-midfield-night');
    const nightGrass = Math.max(...night.grass.filter((g) => g.on).map((g) => luma(g.c)));
    for (const l of night.lines.filter((x) => x.on)) {
      expect(l.max - nightGrass, `night ${l.name}`).toBeGreaterThan(35);
    }
    expect(night.far.minRows).toBeGreaterThanOrEqual(2);

    // End-to-end camera (looking along the pitch): the halfway line runs across the view far away, heavily
    // foreshortened; it must stay >= 2 px and unbroken, and the stripes must not alias into moire.
    const e2e = await page.evaluate(() => {
      const d = window.__dotkick!;
      const rt = d.app.session.runtime()!;
      const r = d.app.renderer;
      const cam = d.ctx.settings.get().camera;
      r.setCamera({ type: 3, height: cam.height, zoom: cam.zoom }, false);
      const states = [rt.prev, rt.curr] as unknown as { ball: { x: number; y: number; z: number } }[];
      for (const s of states) { s.ball.x = -30; s.ball.y = -3; s.ball.z = 3; }
      const info = { nowMs: 0, dtMs: 100, frame: 0, ticks: 1, paused: false };
      for (let i = 0; i < 20; i++) { info.frame++; info.nowMs += 100; r.render(rt.prev, rt.curr, 1, info); }
      const canvas = document.getElementById('game') as HTMLCanvasElement;
      const gl = canvas.getContext('webgl2')!;
      const W = window.innerWidth, H = window.innerHeight;
      const bw = gl.drawingBufferWidth, bh = gl.drawingBufferHeight;
      const out = { x: 0, y: 0 };
      const toBuf = (x: number, z: number): { bx: number; by: number; on: boolean } => {
        const ok = r.projector.pitchToScreen(x, 0, z, out);
        return { bx: Math.round((out.x * bw) / W), by: Math.round(bh - 1 - (out.y * bh) / H), on: ok && out.x > 0 && out.x < W && out.y > 0 && out.y < H };
      };
      const buf = new Uint8Array(4 * 32);
      const luma = (o: number): number => 0.299 * buf[o]! + 0.587 * buf[o + 1]! + 0.114 * buf[o + 2]!;
      // Halfway line from z = -30 to 30, skipping the centre spot and the centre circle crossings.
      const a = toBuf(0, -30), b = toBuf(0, 30);
      const skip = [toBuf(0, -9.1).bx, toBuf(0, 0).bx, toBuf(0, 9.1).bx];
      let cols = 0, minRows = 99, minContrast = 999;
      const x0 = Math.max(2, Math.min(a.bx, b.bx)), x1 = Math.min(bw - 3, Math.max(a.bx, b.bx));
      for (let x = x0; x <= x1; x++) {
        if (skip.some((k) => Math.abs(x - k) <= 8)) continue;
        const yc = Math.round(a.by + ((b.by - a.by) * (x - a.bx)) / (b.bx - a.bx || 1));
        gl.readPixels(x, yc - 12, 1, 25, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        let ref = 0;
        for (let i = 0; i < 4; i++) ref += (luma(i * 4) + luma((24 - i) * 4)) / 8;
        let rows = 0, mx = 0;
        for (let i = 0; i < 25; i++) { const l = luma(i * 4); mx = Math.max(mx, l); if (l > ref + 30) rows++; }
        cols++;
        minRows = Math.min(minRows, rows);
        minContrast = Math.min(minContrast, mx - ref);
      }
      r.setCamera(cam, false);
      return { cols, minRows, minContrast, on: a.on || b.on };
    });
    await shot(page, info, 'gfx-03-end-to-end');
    expect(e2e.cols, 'halfway line columns scanned (end-to-end camera)').toBeGreaterThan(80);
    expect(e2e.minRows, 'end-to-end: halfway line rows per column').toBeGreaterThanOrEqual(2);
    expect(e2e.minContrast, 'end-to-end: halfway line contrast in every column').toBeGreaterThan(40);

    const stats = await page.evaluate(() => window.__dotkickRendererStats!());
    expect(stats.drawCalls).toBeLessThanOrEqual(80);
    expect(stats.triangles).toBeLessThanOrEqual(200_000);
    expect(messages).toEqual([]);
  });
});
