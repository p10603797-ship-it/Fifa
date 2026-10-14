/**
 * [GFX-06] Crowd in the real app (iPad-like 1180 x 820, Chromium + SwiftShader WebGL2): kick-off, loop stopped, the
 * stadium's 'far' debug view (close on the far stand), the crowd drawn idle, then a home GOAL event goes through
 * GameRenderer.onEvents and the reaction is drawn 1 s later. Checks: the crowd is one draw call within its triangle
 * budget, the GOAL raises the home side's jump level and the excitement, the reaction visibly changes the stand
 * (a large share of the stand pixels differ from the idle frame), the broadcast frame stays within 80 draw calls /
 * 200k triangles, zero console errors / warnings (the crowd shader compiles under ANGLE).
 * Screenshots (look at them): attached to the test, and written to $GFX06_SHOT_DIR when set.
 * Run: npx vite build --outDir dist-e2e/gfx-05 --emptyOutDir && PW_DIST=dist-e2e/gfx-05 PW_PORT=4206 npx playwright test tests/e2e/gfx-06-crowd.spec.ts
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

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  const png = await page.screenshot({ style: CANVAS_ONLY });
  await info.attach(name, { body: png, contentType: 'image/png' });
  const dir = process.env.GFX06_SHOT_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.png`), png);
  }
}

declare global {
  interface Window { __gfx06Idle?: Uint8Array }
}

interface Result {
  drawCalls: number;
  triangles: number;
  crowd: { instances: number; triangles: number; drawCalls: number; excitement: number; levels: number[] };
  /** Fraction of stand-band pixels that changed against the stored idle frame (0 when storing). */
  changed: number;
}

/**
 * Draw `frames` frames of 1/60 s (optionally after a GOAL event for `goalTeam`) with the given stadium view; store the
 * stand band as the idle reference or compare against it.
 */
async function draw(page: Page, view: string, frames: number, goalTeam: number, store: boolean): Promise<Result> {
  return page.evaluate(([v, n, team, keep]) => {
    const d = window.__dotkick!;
    const rt = d.app.session.runtime()!;
    const r = d.app.renderer;
    window.__dotkickStadium!.view(v);
    if (team >= 0) {
      const e = { type: 9, tick: rt.curr.tick, a: team, b: team === 0 ? 9 : 20, c: -1, d: 0, x: 0, y: 0, z: 0 };
      const buf = { count: 1, get: () => e, begin() { /* fixed */ }, emit() { /* fixed */ } };
      r.onEvents(buf as never, rt.curr);
    }
    const info = { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false };
    for (let i = 0; i < n; i++) {
      info.frame++; info.nowMs += info.dtMs;
      r.render(rt.prev, rt.curr, 1, info);
    }
    const stats = window.__dotkickRendererStats!();
    const c = window.__dotkickCrowd!.snapshot();
    const canvas = document.getElementById('game') as HTMLCanvasElement;
    const gl = canvas.getContext('webgl2')!;
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    // the stand band of the 'far' view (rows 35..65 % from the bottom of the buffer)
    const y0 = Math.floor(h * 0.35), y1 = Math.floor(h * 0.65);
    const px = new Uint8Array(w * (y1 - y0) * 4);
    gl.readPixels(0, y0, w, y1 - y0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let changed = 0;
    if (keep) window.__gfx06Idle = px;
    else if (window.__gfx06Idle) {
      const a = window.__gfx06Idle;
      let diff = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (Math.abs(px[i]! - a[i]!) + Math.abs(px[i + 1]! - a[i + 1]!) + Math.abs(px[i + 2]! - a[i + 2]!) > 60) diff++;
      }
      changed = diff / (px.length / 4);
    }
    return {
      drawCalls: stats.drawCalls, triangles: stats.triangles, changed,
      crowd: { instances: c.instances, triangles: c.triangles, drawCalls: c.drawCalls, excitement: c.excitement, levels: c.levels },
    };
  }, [view, frames, goalTeam, store] as const);
}

test.describe('GFX-06 crowd', () => {
  test('instanced crowd in the stands, then a GOAL: the scoring side jumps and cheers', async ({ page }, info) => {
    test.setTimeout(180_000);
    const messages = collectConsole(page);
    await page.goto('/');
    await page.getByTestId('splash-start').tap();
    await page.getByTestId('main-kickoff').tap();
    await page.waitForFunction(() => {
      const d = window.__dotkick;
      return !!d && d.ctx.router.current === 'match' && d.app.session.loaded && d.ctx.session.getState() !== null;
    }, null, { timeout: 30_000 });
    await page.waitForFunction(() => (window.__dotkick!.ctx.session.getState()?.tick ?? 0) > 10, null, { timeout: 20_000 });
    await page.evaluate(() => window.__dotkick!.app.loop.stop());

    const broadcast = await draw(page, '', 10, -1, false);
    await shot(page, info, 'gfx-06-broadcast-idle');
    const idle = await draw(page, 'far', 10, -1, true);
    await shot(page, info, 'gfx-06-crowd-idle');
    const goal = await draw(page, 'far', 60, 0, false);
    await shot(page, info, 'gfx-06-crowd-goal-home');
    const later = await draw(page, '', 30, -1, false);
    await shot(page, info, 'gfx-06-broadcast-goal');
    await draw(page, '', 1, -1, false);

    console.log(`GFX-06: ${JSON.stringify({ broadcast, idle, goal: { ...goal, crowd: { ...goal.crowd, levels: goal.crowd.levels.map((x) => +x.toFixed(2)) } }, later })}`);
    for (const f of [broadcast, idle, goal, later]) {
      expect(f.crowd.drawCalls).toBe(1);
      expect(f.crowd.instances).toBeGreaterThan(5000);
      expect(f.crowd.triangles).toBeLessThanOrEqual(60_000);
    }
    for (const f of [broadcast, later]) {
      expect(f.drawCalls).toBeLessThanOrEqual(80);
      expect(f.triangles).toBeLessThanOrEqual(200_000);
    }
    expect(idle.crowd.excitement).toBeLessThan(0.05);
    expect(goal.crowd.levels[3]).toBe(1); // home jump
    expect(goal.crowd.levels[7]).toBe(1); // away slump
    expect(goal.crowd.excitement).toBeGreaterThan(0.9);
    expect(goal.changed).toBeGreaterThan(0.05);
    expect(messages).toEqual([]);
  });
});
