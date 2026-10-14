/**
 * [GFX-08] Kits on real WebGL2 (Chromium + SwiftShader, iPad-like 1180 x 820).
 *  1. Harness page (tests/e2e/gfx-08-harness.ts, bundled here with esbuild): the generated atlas uploaded as a
 *     DataTexture with its manual 6-level mip chain, sampled through applyKitUv per-instance rects on cylinder torsos.
 *     Checks: no GL error and no console error / warning (shader patch compiles, texture complete); the chest shows
 *     the resolved shirt colour (unlit, so texel colour = pixel colour); the back carries the outlined number; keepers
 *     wear their own kit; torsos at broadcast distance sample the mips (an incomplete chain samples black); high
 *     contrast changes the colours; the number glyph atlas reads through the players' torso formula; the kit preview
 *     and 20 crest data URLs load as images. Screenshots of both teams (normal, high contrast, patterned fixtures).
 *  2. The real app at kick-off (both teams on the pitch) for looking at the kits against the grass.
 * Screenshots: attached to the test, and written to $GFX08_SHOT_DIR when set.
 * Run: npx vite build --outDir dist-e2e/gfx-08 --emptyOutDir && PW_DIST=dist-e2e/gfx-08 PW_PORT=4208 npx playwright test tests/e2e/gfx-08-kits.spec.ts
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import path, { join } from 'node:path';

/** Messages Chromium prints about the software GPU (not page bugs). */
const GPU_ENVIRONMENT_NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/, /GPU stall due to ReadPixels/];

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

async function shot(page: Page, info: TestInfo, name: string, style?: string): Promise<void> {
  const png = await page.screenshot(style ? { style } : {});
  await info.attach(name, { body: png, contentType: 'image/png' });
  const dir = process.env.GFX08_SHOT_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.png`), png);
  }
}

const rgb = (c: number): [number, number, number] => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
const diff = (p: number[], c: number): number => { const q = rgb(c); return Math.abs(p[0]! - q[0]) + Math.abs(p[1]! - q[1]) + Math.abs(p[2]! - q[2]); };
function mean(px: number[]): number[] {
  const m = [0, 0, 0];
  const n = px.length / 4;
  for (let i = 0; i < px.length; i += 4) { m[0]! += px[i]!; m[1]! += px[i + 1]!; m[2]! += px[i + 2]!; }
  return m.map((v) => v / n);
}
function countNear(px: number[], c: number, tol: number): number {
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (diff([px[i]!, px[i + 1]!, px[i + 2]!], c) <= tol) n++;
  return n;
}

test.describe('GFX-08 kit atlas on WebGL2', () => {
  let bundle = '';
  test.beforeAll(async () => {
    const r = await build({
      entryPoints: [path.resolve('tests/e2e/gfx-08-harness.ts')],
      bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent',
      define: { __DEV_BUILD__: 'true' },
    });
    bundle = r.outputFiles[0]!.text;
  });

  test('torsos wear the resolved kits: shirt colour, outlined back number, keepers, mips at distance, crests', async ({ page }, info) => {
    test.setTimeout(240_000);
    const messages = collectConsole(page);
    await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body></body></html>');
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => !!window.__gfx08?.ready);

    // Clubs 0 v 1 (default fixture): home plain red, away white / gold halves.
    const k = await page.evaluate(() => window.__gfx08!.show(0, 1, false));
    const pts = await page.evaluate(() => window.__gfx08!.points());
    expect(await page.evaluate(() => window.__gfx08!.glError())).toBe(0);
    // Chest below the small chest number (v ~ 0.2 -> 59 px under the centre).
    const chest0 = mean(await page.evaluate(([x, y]) => window.__gfx08!.pixels(x, y + 59, 6, 6), pts.front0!));
    expect(diff(chest0, k.shirt[0]!), `home chest ${chest0.map(Math.round)} vs ${k.shirt[0]!.toString(16)}`).toBeLessThan(12);
    const chest1 = await page.evaluate(([x, y]) => window.__gfx08!.pixels(x, y + 59, 40, 4), pts.front1!);
    expect(countNear(chest1, k.shirt[1]!, 12), 'away chest shows its primary colour').toBeGreaterThan(20);
    // Back: the big number in the number colour with its outline.
    const back0 = await page.evaluate(([x, y]) => window.__gfx08!.pixels(x, y - 5, 60, 70), pts.back0!);
    expect(countNear(back0, k.number[0]!, 30), 'home back number').toBeGreaterThan(250);
    expect(countNear(back0, 0x111111, 40), 'home number outline').toBeGreaterThan(60);
    const back1 = await page.evaluate(([x, y]) => window.__gfx08!.pixels(x, y - 5, 60, 70), pts.back1!);
    expect(countNear(back1, k.number[1]!, 30), 'away back number').toBeGreaterThan(200);
    // Keepers.
    for (const [name, t] of [['k0', 0], ['k1', 1]] as const) {
      const kp = mean(await page.evaluate(([x, y]) => window.__gfx08!.pixels(x, y + 59, 6, 6), pts[name]!));
      expect(diff(kp, k.keeper[t]!), `${name} ${kp.map(Math.round)} vs ${k.keeper[t]!.toString(16)}`).toBeLessThan(12);
    }
    // Broadcast distance (lit): the mip chain is complete, so the far torsos are their shirt colour, not black.
    for (const [name, t] of [['far0', 0], ['far1', 1]] as const) {
      const fp = mean(await page.evaluate(([x, y]) => window.__gfx08!.pixels(x, y, 2, 2), pts[name]!));
      expect(fp[0]! + fp[1]! + fp[2]!, `${name} not black`).toBeGreaterThan(90);
      expect(diff(fp, k.shirt[t]!), `${name} ${fp.map(Math.round)} near ${k.shirt[t]!.toString(16)}`).toBeLessThan(diff(fp, 0x000000) + 60);
    }
    // Number glyph atlas through the players' torso formula: number colour inside, outline ring around it.
    for (const [name, t] of [['g0', 0], ['g1', 0], ['g2', 1]] as const) {
      const g = await page.evaluate(([x, y]) => window.__gfx08!.pixels(x, y, 70, 56), pts[name]!);
      const outline = (k.number[t]! >> 16) + ((k.number[t]! >> 8) & 255) + (k.number[t]! & 255) > 3 * 150 ? 0x030303 : 0xe6e6e6;
      expect(countNear(g, k.number[t]!, 30), `${name} number`).toBeGreaterThan(150);
      expect(countNear(g, outline, 40), `${name} outline`).toBeGreaterThan(40);
      expect(countNear(g, k.shirt[t]!, 20), `${name} shirt around`).toBeGreaterThan(300);
    }
    await page.waitForFunction(() => window.__gfx08!.crestsLoaded() === 20 && window.__gfx08!.kitsLoaded() === 4, null, { timeout: 20_000 });
    await shot(page, info, 'gfx-08-kits-default');

    // High contrast: plain, boosted, separated; the chest follows the new colour.
    const hc = await page.evaluate(() => window.__gfx08!.show(0, 1, true));
    expect(hc.shirt[0]).not.toBe(k.shirt[0]);
    const chestHc = mean(await page.evaluate(([x, y]) => window.__gfx08!.pixels(x, y + 59, 6, 6), pts.front0!));
    expect(diff(chestHc, hc.shirt[0]!)).toBeLessThan(12);
    await shot(page, info, 'gfx-08-kits-high-contrast');

    // Patterned fixtures for looking at: sash v sash, stripes v hoops, halves v halves (clash resolved).
    for (const [h, a] of [[4, 9], [6, 7], [3, 8]] as const) {
      await page.evaluate(([hh, aa]) => window.__gfx08!.show(hh, aa, false), [h, a] as const);
      await shot(page, info, `gfx-08-kits-${h}-v-${a}`);
    }
    expect(await page.evaluate(() => window.__gfx08!.glError())).toBe(0);
    expect(messages, messages.join('\n')).toEqual([]);
  });
});

test.describe('GFX-08 kits in the real app', () => {
  test('kick-off: both teams on the pitch in their resolved kits, no console errors', async ({ page }, info) => {
    test.setTimeout(240_000);
    const messages = collectConsole(page);
    await page.goto('/');
    await page.getByTestId('splash-start').tap();
    await page.getByTestId('main-kickoff').tap();
    await page.waitForFunction(() => {
      const d = window.__dotkick;
      return !!d && d.ctx.router.current === 'match' && d.app.session.loaded && d.ctx.session.getState() !== null;
    }, null, { timeout: 60_000 });
    await page.waitForFunction(() => (window.__dotkick!.ctx.session.getState()?.tick ?? 0) > 10, null, { timeout: 30_000 });
    await page.evaluate(() => {
      const d = window.__dotkick!;
      d.app.loop.stop();
      const rt = d.app.session.runtime()!;
      const fi = { nowMs: 0, dtMs: 100, frame: 0, ticks: 1, paused: false };
      for (let i = 0; i < 16; i++) { fi.frame++; fi.nowMs += 100; d.app.renderer.render(rt.prev, rt.curr, 1, fi); }
    });
    await shot(page, info, 'gfx-08-app-kickoff', '#ui, #touch { visibility: hidden !important; }');
    expect(messages, messages.join('\n')).toEqual([]);
  });
});
