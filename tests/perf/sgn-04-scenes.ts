/**
 * [SGN-04] Draw calls, triangles and texture memory per scene at each quality tier (BRIEF section 13: 80 draw calls,
 * 200,000 triangles; section 3: 64 MB of textures) in the shipped single-file build, Chromium + SwiftShader, 1180 x 820.
 * Per tier (Performance, Balanced, Quality, set in Settings and the page reloaded, so the renderer starts in that tier
 * as on a device, MSAA included for Quality): Play now, then a CPU v CPU match stepped deterministically through the
 * real loop (as tests/e2e/qf-4-look.spec.ts does): kick-off, open play, a crowded penalty area (all 22 players inside
 * it around the ball), the corner camera, a goal, its replay, and a night match's open play. Each scene reports the
 * renderer's draw calls and triangles of the last frame, the texture memory of everything the scene draws
 * (render/index.ts textureMemory: RGBA8, x4/3 with mipmaps, shadow maps included), GPU textures and geometries.
 *
 *   npx tsx tests/perf/sgn-04-scenes.ts --dist dist-e2e/sgn-04 [--tiers 1,2,3] [--json out.json]
 * Exit 1 when a scene is over a budget. A scene drawn at a lower tier than asked (Quality steps down when it cannot hold
 * 50 fps) is printed as a note; its row shows the tier it was drawn at.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { chromium, type Page } from '@playwright/test';
import { serveDir } from '../../tools/bench';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (k: string, d: string): string => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : d;
};
const BUDGET = { calls: 80, tris: 200_000, texMB: 64 };
const TIER_NAMES: Record<number, string> = { 1: 'Performance', 2: 'Balanced', 3: 'Quality' };
const READY = `(() => { const d = window.__dotkick; return !!d && d.ctx.router.current === 'match' && !!d.app.session.loaded && d.ctx.session.getState() !== null; })()`;

/** In-page helpers (strings: tsx helpers do not exist in the page). Same pokes as qf-4-look.spec.ts. */
const HELPERS = `(() => {
  const d = window.__dotkick, w = window;
  d.app.loop.stop();
  let now = performance.now();
  const st = () => d.ctx.session.getState();
  const r = d.app.renderer;
  w.__sgn04s = {
    run(max, phase, render, dt) {
      const orig = r.render;
      if (!render) r.render = () => {};
      const t0 = st().tick;
      try {
        for (let g = 0; g < 200000; g++) {
          now += dt; d.app.loop.frame(now);
          const s = st();
          if (s.tick - t0 >= max || !d.app.session.ticking) break;
          if (phase >= 0 && s.match.phase === phase) break;
        }
      } finally { r.render = orig; }
      return st().match.phase;
    },
    show(n) {
      for (let i = 0; i < n; i++) { now += 1000 / 60; d.app.loop.frame(now); }
      const rs = r.stats(), tm = w.__dotkickTextureMemory();
      return { calls: rs.drawCalls, tris: rs.triangles, texMB: +(tm.bytes / 1048576).toFixed(2), textures: tm.textures, gpuTextures: rs.textures,
        geometries: rs.geometries, tier: rs.qualityTier, scale: rs.resolutionScale, phase: st().match.phase, msaa: r.msaa ? 1 : 0 };
    },
    loose(x, z, vx, defTouch) {
      const s = st(), a = s.teams[0].dir > 0 ? 0 : 1, team = defTouch ? 1 - a : a, b = s.ball;
      b.owner = -1; b.heldBy = -1; b.x = x; b.z = z; b.y = 0.3; b.vx = vx; b.vy = 0; b.vz = 0; b.px = x; b.py = 0.3; b.pz = z;
      b.grounded = 0; b.shotBy = -1; b.passTarget = -1; b.lastTouch = team * 11 + 4; b.lastTouchTeam = team;
      b.lastTouchTick = s.tick; b.lastKickTeam = team; b.lastKickBy = team * 11 + 4;
    },
    crowd() {
      const s = st(), e = s.teams[0].dir > 0 ? 1 : -1, b = s.ball;
      for (let i = 0; i < 22; i++) {
        const p = s.players[i], col = i % 6, row = Math.floor(i / 6);
        p.x = e * (38 + col * 2.2); p.z = -12 + row * 7 + (i % 2) * 1.5; p.vx = 0; p.vz = 0;
      }
      b.owner = -1; b.heldBy = -1; b.x = e * 44; b.z = 0; b.y = 0.6; b.vx = 0; b.vy = 2; b.vz = 0.5; b.px = b.x; b.py = b.y; b.pz = b.z; b.grounded = 0;
    },
    shotOnGoal() {
      const s = st(), a = s.teams[0].dir > 0 ? 0 : 1, k = s.players[(1 - a) * 11], b = s.ball;
      k.x = 51.5; k.z = -3.4;
      b.owner = -1; b.heldBy = -1; b.x = 36; b.z = 4; b.y = 0.6; b.vx = 26; b.vy = 1.5; b.vz = -0.7; b.px = 36; b.py = 0.6; b.pz = 4;
      b.grounded = 0; b.passTarget = -1; b.lastTouch = a * 11 + 9; b.lastTouchTeam = a; b.lastTouchTick = s.tick;
      b.lastKickTeam = a; b.lastKickBy = a * 11 + 9; b.shotBy = a * 11 + 9; b.shotTick = s.tick;
    },
  };
})()`;

async function startCpu(page: Page, night: number, seed: number): Promise<void> {
  await page.evaluate(`(() => {
    const d = window.__dotkick, setup = d.ctx.session.getSetup();
    d.ctx.session.quit();
    const humans = setup.config.humans.map((h) => ({ ...h, kind: 0, side: -1 }));
    d.ctx.session.start({ ...setup, bindings: [], config: { ...setup.config, night: ${night}, seed: ${seed}, humans } });
  })()`);
  await page.waitForFunction(READY, null, { timeout: 180_000, polling: 250 });
  await page.evaluate(HELPERS);
}

async function main(): Promise<void> {
  const tiers = arg('tiers', '1,2,3').split(',').map(Number);
  const s = await serveDir(resolve(ROOT, arg('dist', 'dist-e2e/sgn-04')));
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const report: Record<string, Record<string, Record<string, number>>> = {};
  const fails: string[] = [];
  try {
    for (const tier of tiers) {
      const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1, hasTouch: true });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await page.goto(`${s.url}index.html`, { timeout: 180_000 });
      await page.waitForSelector('[data-testid="splash-start"]', { timeout: 120_000 });
      await page.evaluate(`window.__dotkick.ctx.settings.update((st) => { st.graphics.tier = ${tier}; st.graphics.resolutionScale = 0; })`);
      await page.reload({ timeout: 180_000 });
      await page.waitForSelector('[data-testid="splash-start"]', { timeout: 120_000 });
      await page.touchscreen.tap(40, 410);
      await page.waitForFunction(`window.__dotkick && window.__dotkick.ctx.router.current === 'main'`, null, { timeout: 60_000 });
      const box = await page.getByTestId('main-kickoff').boundingBox();
      await page.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await page.waitForFunction(READY, null, { timeout: 300_000, polling: 250 });
      const run = (max: number, phase: number, render = false, dt = 50): Promise<number> =>
        page.evaluate(`window.__sgn04s.run(${max}, ${phase}, ${render}, ${dt})`) as Promise<number>;
      const rows: Record<string, Record<string, number>> = {};
      const scene = async (name: string, n = 3): Promise<void> => {
        const r = await page.evaluate(`window.__sgn04s.show(${n})`) as Record<string, number>;
        rows[name] = r;
        if (r.calls! > BUDGET.calls || r.tris! > BUDGET.tris || r.texMB! > BUDGET.texMB) fails.push(`${TIER_NAMES[tier]} ${name}: ${JSON.stringify(r)}`);
        // Quality steps down when it cannot hold 50 fps (BRIEF section 13), as it does on SwiftShader: reported, not a failure.
        if (r.tier !== tier) console.error(`note: ${TIER_NAMES[tier]} ${name} drawn at tier ${r.tier} (step-down)`);
        console.error(TIER_NAMES[tier], name, JSON.stringify(r));
      };
      await startCpu(page, 0, 20261014);
      await run(600, 1);
      await run(20, -1, true, 1000 / 60);
      await scene('kickoff');
      await run(1200, 2);
      await run(900, -1);
      await run(30, -1, true, 1000 / 60);
      await scene('openplay');
      await page.evaluate('window.__sgn04s.crowd()');
      await run(12, -1, true, 1000 / 60);
      await scene('crowdedBox');
      await run(6000, 2);
      await page.evaluate('window.__sgn04s.loose(50.5, 22, 10, true)');
      await run(300, 5);
      await run(70, -1, true, 1000 / 60);
      await scene('corner');
      await run(6000, 2);
      // Rendered frames at 60 Hz steps (a 20 Hz step makes the tier controller see 20 fps and step Quality down).
      await run(120, -1, true, 1000 / 60);
      await page.evaluate('window.__sgn04s.shotOnGoal()');
      await run(240, 8, true, 1000 / 60);
      await scene('goal', 2);
      await run(1500, 10);
      await run(12, -1, true, 1000 / 60);
      await scene('replay', 2);
      await startCpu(page, 1, 4242);
      await run(2000, 2);
      await run(40, -1, true, 1000 / 60);
      await scene('night');
      if (errors.length > 0) fails.push(`${TIER_NAMES[tier]} errors: ${errors.slice(0, 3).join(' | ')}`);
      report[TIER_NAMES[tier]!] = rows;
      await context.close();
    }
  } finally {
    await browser.close();
    await new Promise<void>((r) => s.server.close(() => r()));
  }
  console.log(JSON.stringify(report));
  if (arg('json', '') !== '') writeFileSync(resolve(ROOT, arg('json', '')), JSON.stringify({ report, fails }, null, 2));
  for (const f of fails) console.error('FAIL', f);
  process.exit(fails.length > 0 ? 1 : 0);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
