/**
 * [INT-C] Exploratory: live match through the real app, screenshots per scene with draw-call / triangle numbers.
 */
import { expect, test, type Page } from '@playwright/test';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

type Res = Record<string, number | string>;
interface Intc {
  run(maxTicks: number, stopPhase: number, minAbsX: number, maxAbsX: number, render: boolean, dt: number): Res;
  show(frames: number, dt: number): Res;
  corner(): void;
  goal(): void;
  phases: number[];
}

async function startCpuMatch(page: Page, night: number, seed: number): Promise<void> {
  await page.goto('/');
  await page.getByTestId('splash-start').click();
  await page.getByTestId('main-kickoff').click();
  await page.waitForFunction(() => {
    const d = window.__dotkick;
    return !!d && d.ctx.router.current === 'match' && d.ctx.session.getState() !== null;
  }, null, { timeout: 30_000 });
  await page.evaluate(([n, sd]) => {
    const d = window.__dotkick!;
    const setup = d.ctx.session.getSetup()!;
    d.ctx.session.quit();
    const humans = setup.config.humans.map((h) => ({ ...h, kind: 0, side: -1 }));
    d.ctx.session.start({ ...setup, bindings: [], config: { ...setup.config, night: n!, seed: sd!, humans } });
  }, [night, seed]);
  await page.waitForFunction(() => {
    const d = window.__dotkick;
    return !!d && d.ctx.router.current === 'match' && d.app.session.loaded && d.ctx.session.getState() !== null;
  }, null, { timeout: 60_000 });
  await page.evaluate(() => {
    const d = window.__dotkick!;
    d.app.loop.stop();
    const w = window as unknown as Record<string, unknown>;
    let now = performance.now();
    const app = d.app;
    type B = Record<string, number>;
    type S = { tick: number; match: { phase: number }; ball: B; players: B[]; teams: { dir: number }[] };
    const st = (): S => d.ctx.session.getState() as unknown as S;
    const phases: number[] = [];
    const api: Intc = {
      phases,
      run(maxTicks, stopPhase, minAbsX, maxAbsX, render, dt) {
        const r = app.renderer as unknown as { render: (...a: unknown[]) => void };
        const orig = r.render;
        if (!render) r.render = () => {};
        const t0 = st().tick;
        let guard = 0;
        try {
          while (guard++ < 100000) {
            now += dt;
            app.loop.frame(now);
            const s = st();
            if (phases[phases.length - 1] !== s.match.phase) phases.push(s.match.phase, s.tick);
            if (s.tick - t0 >= maxTicks || !app.session.ticking) break;
            const ax = Math.abs(s.ball.x!);
            if ((stopPhase < 0 || s.match.phase === stopPhase) && ax >= minAbsX && ax <= maxAbsX) break;
          }
        } finally {
          r.render = orig;
        }
        const s = st();
        return { tick: s.tick, phase: s.match.phase, bx: s.ball.x!, bz: s.ball.z! };
      },
      show(frames, dt) {
        const t = performance.now();
        for (let i = 0; i < frames; i++) {
          now += dt;
          app.loop.frame(now);
        }
        const s = st();
        const r = app.renderer.stats();
        const cam = (app.renderer as unknown as { cameraX?: number }).cameraX;
        return { ms: Math.round(((performance.now() - t) / frames) * 10) / 10, tick: s.tick, phase: s.match.phase,
          bx: +s.ball.x!.toFixed(2), by: +s.ball.y!.toFixed(2), bz: +s.ball.z!.toFixed(2),
          calls: r.drawCalls, tris: r.triangles, tier: r.qualityTier, scale: r.resolutionScale, cam: cam ?? 'n/a' };
      },
      corner() {
        const s = st();
        const att = s.teams[0]!.dir > 0 ? 0 : 1; // home attacks +x
        const def = 1 - att;
        const b = s.ball;
        b.owner = -1; b.heldBy = -1; b.x = 50.5; b.z = 22; b.y = 0.3; b.vx = 10; b.vy = 0; b.vz = 0;
        b.px = b.x; b.py = b.y; b.pz = b.z; b.grounded = 0;
        b.lastTouch = def * 11 + 4; b.lastTouchTeam = def; b.lastTouchTick = s.tick; b.lastKickTeam = def; b.lastKickBy = def * 11 + 4;
        b.shotBy = -1; b.passTarget = -1;
      },
      goal() {
        const s = st();
        const b = s.ball;
        const att = s.teams[0]!.dir > 0 ? 0 : 1;
        const def = 1 - att;
        const k = s.players[def * 11]!;
        k.x = 51.5; k.z = -3.4;
        b.owner = -1; b.heldBy = -1; b.x = 36; b.z = 4; b.y = 0.6; b.vx = 26; b.vy = 1.5; b.vz = -0.7;
        b.px = b.x; b.py = b.y; b.pz = b.z; b.grounded = 0;
        b.lastTouch = att * 11 + 9; b.lastTouchTeam = att; b.lastTouchTick = s.tick; b.lastKickTeam = att; b.lastKickBy = att * 11 + 9;
        b.shotBy = att * 11 + 9; b.shotTick = s.tick; b.passTarget = -1;
      },
    };
    w.__intc = api;
  });
}

const intc = (page: Page) => ({
  run: (max: number, phase: number, minX: number, maxX: number, render = true, dt = 50) => page.evaluate(
    (a) => (window as unknown as { __intc: Intc }).__intc.run(a[0]!, a[1]!, a[2]!, a[3]!, a[4] === 1, a[5]!),
    [max, phase, minX, maxX, render ? 1 : 0, dt]),
  show: (frames: number, dt = 16.7) => page.evaluate((a) => (window as unknown as { __intc: Intc }).__intc.show(a[0]!, a[1]!), [frames, dt]),
  call: (name: 'corner' | 'goal') => page.evaluate((n) => (window as unknown as { __intc: Intc }).__intc[n](), name),
  phases: () => page.evaluate(() => (window as unknown as { __intc: Intc }).__intc.phases),
});

test('INT-C explore', async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  const errors = collectErrors(page);
  await startCpuMatch(page, 0, 12345);
  const h = intc(page);
  const shot = async (name: string, frames = 3): Promise<void> => {
    const r = await h.show(frames);
    console.log(name, JSON.stringify(r));
    await page.screenshot({ path: testInfo.outputPath(`int-c-${name}.png`) });
  };
  await shot('prematch', 2);
  console.log(JSON.stringify(await h.run(2000, 1, 0, 99)));
  await shot('kickoff', 2);
  console.log(JSON.stringify(await h.run(300, -1, 0, 0.1, true, 16.7)));
  console.log(JSON.stringify(await h.run(1200, 2, 0, 15)));
  await shot('openplay');
  console.log(JSON.stringify(await h.run(6000, 2, 32, 99, false)));
  await shot('attack');
  await h.call('corner');
  console.log(JSON.stringify(await h.run(400, 5, 0, 99, true, 16.7)));
  await shot('corner-award', 2);
  console.log(JSON.stringify(await h.run(120, -1, 99, 0, true, 16.7)));
  await shot('corner-setup', 2);
  console.log(JSON.stringify(await h.run(1500, 2, 0, 99, true, 50)));
  await shot('corner-taken', 4);
  console.log(JSON.stringify(await h.run(40000, 6, 0, 99, false)));
  await shot('freekick', 2);
  console.log(JSON.stringify(await h.run(120, -1, 99, 0, true, 16.7)));
  await shot('freekick-setup', 2);
  console.log('phases', JSON.stringify(await h.phases()));
  expect(errors).toEqual([]);
});

test('INT-C explore goal + night', async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  const errors = collectErrors(page);
  await startCpuMatch(page, 1, 777);
  const h = intc(page);
  const shot = async (name: string, frames = 3): Promise<void> => {
    const r = await h.show(frames);
    console.log(name, JSON.stringify(r));
    await page.screenshot({ path: testInfo.outputPath(`int-c-${name}.png`) });
  };
  console.log(JSON.stringify(await h.run(2000, 2, 0, 99, false)));
  console.log(JSON.stringify(await h.run(600, 2, 0, 99, true, 16.7)));
  await shot('night-openplay');
  await h.call('goal');
  console.log(JSON.stringify(await h.run(200, 8, 0, 99, true, 16.7)));
  await shot('goal', 2);
  console.log(JSON.stringify(await h.run(1200, 10, 0, 99, true, 50)));
  await shot('replay-start', 2);
  console.log(JSON.stringify(await h.run(90, -1, 99, 0, true, 16.7)));
  await shot('replay-mid', 2);
  console.log(JSON.stringify(await h.run(240, -1, 99, 0, true, 16.7)));
  await shot('replay-late', 2);
  console.log(JSON.stringify(await h.run(1200, 1, 0, 99, true, 50)));
  await shot('kickoff-after-goal', 2);
  console.log('phases', JSON.stringify(await h.phases()));
  expect(errors).toEqual([]);
});

test('INT-C night debug', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  await startCpuMatch(page, 1, 777);
  const h = intc(page);
  console.log(JSON.stringify(await h.run(300, 2, 0, 99, true, 16.7)));
  const info = await page.evaluate(() => {
    const s = window.__dotkick!.ctx.session.getState() as unknown as { config: { night: number } };
    const w = window as unknown as Record<string, { snapshot(): unknown }>;
    const st = w.__dotkickStadium ? w.__dotkickStadium.snapshot() : null;
    return { night: s.config.night, stadium: st ? JSON.stringify(st).slice(0, 600) : 'none' };
  });
  console.log(JSON.stringify(info));
  await page.screenshot({ path: testInfo.outputPath('int-c-night-debug.png') });
});
