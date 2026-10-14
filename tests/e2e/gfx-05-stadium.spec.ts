/**
 * [GFX-05] Stadium in the real app (iPad-like 1180 x 820, Chromium + SwiftShader WebGL2): kick-off, loop stopped,
 * then the match is re-applied by day and at night and drawn from the broadcast camera and from the stadium's debug
 * views (far stand, corner, aerial). Checks: the whole frame stays within 80 draw calls / 200k triangles, the stadium
 * within 10 draw calls / 40k triangles, night is clearly darker above the pitch than day, the stands and boards are
 * drawn (the far view is not sky-coloured), zero console errors / warnings (every shader compiles under ANGLE).
 * Screenshots (look at them): attached to the test, and written to $GFX05_SHOT_DIR when set.
 * Run: npx vite build --outDir dist-e2e/gfx-05 --emptyOutDir && PW_DIST=dist-e2e/gfx-05 PW_PORT=4205 npx playwright test tests/e2e/gfx-05-stadium.spec.ts
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
  const dir = process.env.GFX05_SHOT_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.png`), png);
  }
}

interface Frame {
  drawCalls: number;
  triangles: number;
  stadiumCalls: number;
  stadiumTris: number;
  /** Mean luma of the top 30 % of the buffer, and of the centre band (far view: stands). */
  topLuma: number;
  midLuma: number;
  /** Mean colour of the centre band. */
  mid: [number, number, number];
}

/** Re-apply the match (day / night), optionally set a stadium debug view, draw 12 frames and read stats + pixels. */
async function draw(page: Page, night: boolean, view: string): Promise<Frame> {
  return page.evaluate(([nightOn, v]) => {
    const d = window.__dotkick!;
    const rt = d.app.session.runtime()!;
    const r = d.app.renderer;
    type St = typeof rt.curr;
    const curr = { ...rt.curr, config: { ...rt.curr.config, night: nightOn ? 1 : 0 } } as St;
    const prev = { ...rt.prev, config: { ...rt.prev.config, night: nightOn ? 1 : 0 } } as St;
    r.setMatch(curr, d.ctx.clubs);
    window.__dotkickStadium!.view(v);
    const info = { nowMs: 0, dtMs: 100, frame: 0, ticks: 1, paused: false };
    for (let i = 0; i < 12; i++) {
      info.frame++; info.nowMs += 100;
      r.render(prev, curr, 1, info);
    }
    const stats = window.__dotkickRendererStats!();
    const snap = window.__dotkickStadium!.snapshot();
    const canvas = document.getElementById('game') as HTMLCanvasElement;
    const gl = canvas.getContext('webgl2')!;
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const mean = (y0: number, y1: number): [number, number, number, number] => {
      let r0 = 0, g0 = 0, b0 = 0, n = 0;
      for (let y = Math.floor(y0 * h); y < Math.floor(y1 * h); y += 2) {
        for (let x = 0; x < w; x += 2) {
          const o = (y * w + x) * 4;
          r0 += px[o]!; g0 += px[o + 1]!; b0 += px[o + 2]!; n++;
        }
      }
      r0 /= n; g0 /= n; b0 /= n;
      return [r0, g0, b0, 0.299 * r0 + 0.587 * g0 + 0.114 * b0];
    };
    const top = mean(0.7, 1); // readPixels rows start at the bottom
    const mid = mean(0.35, 0.65);
    return {
      drawCalls: stats.drawCalls, triangles: stats.triangles, stadiumCalls: snap.drawCalls, stadiumTris: snap.triangles,
      topLuma: top[3], midLuma: mid[3], mid: [mid[0], mid[1], mid[2]] as [number, number, number],
    };
  }, [night, view] as const);
}

test.describe('GFX-05 stadium', () => {
  test('day and floodlit night: stands, boards, sky and floodlights within budget; night darker', async ({ page }, info) => {
    test.setTimeout(180_000);
    const messages = collectConsole(page);
    await kickOff(page);

    const day = await draw(page, false, '');
    await shot(page, info, 'gfx-05-broadcast-day');
    const dayFar = await draw(page, false, 'far');
    await shot(page, info, 'gfx-05-far-day');
    await draw(page, false, 'corner');
    await shot(page, info, 'gfx-05-corner-day');
    const aerial = await draw(page, false, 'aerial');
    await shot(page, info, 'gfx-05-aerial-day');

    const night = await draw(page, true, '');
    await shot(page, info, 'gfx-05-broadcast-night');
    const nightFar = await draw(page, true, 'far');
    await shot(page, info, 'gfx-05-far-night');
    await draw(page, true, 'corner');
    await shot(page, info, 'gfx-05-corner-night');
    await draw(page, false, '');

    console.log(`GFX-05 frames: ${JSON.stringify({ day, dayFar, aerial, night, nightFar })}`);
    for (const f of [day, dayFar, aerial, night, nightFar]) {
      expect(f.drawCalls).toBeGreaterThan(0);
      expect(f.drawCalls).toBeLessThanOrEqual(80);
      expect(f.triangles).toBeLessThanOrEqual(200_000);
      expect(f.stadiumCalls).toBeLessThanOrEqual(10);
      expect(f.stadiumTris).toBeLessThanOrEqual(40_000);
    }
    expect(night.stadiumCalls).toBe(day.stadiumCalls + 1); // halos at night only
    // Night is clearly darker above the pitch (sky / stands) and in the far view.
    expect(night.topLuma).toBeLessThan(day.topLuma * 0.85);
    expect(nightFar.topLuma).toBeLessThan(dayFar.topLuma * 0.6);
    // The far view's centre band shows stands and crowd, not an empty sky (sky by day is light blue: b >> r).
    expect(dayFar.mid[2] - dayFar.mid[0]).toBeLessThan(60);
    expect(messages).toEqual([]);
  });
});
