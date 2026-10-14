/**
 * [INT-C] Sim -> render in a live match (BRIEF section 8, 13): the real app (iPad viewport 1180 x 820, DPR 1, touch)
 * runs a CPU v CPU match through the real loop; the test drives loop.frame() itself (deterministic timing) and
 * visits the scenes: establishing shot, kick-off, open play mid-pitch, attack near the box, corner (award, set-up,
 * taken), goal kick, free kick (a foul through the sim's own challenge pipeline), goal + replay (both angles),
 * kick-off after the goal. Per scene: screenshot (<output>/int-c-<scene>.png: LOOK at them), draw calls and triangles
 * within budget (<= 80, <= 200k), the camera shot the director chose, the ball on screen and clear of the HUD radar.
 * During open play it also measures the GFX-12 animation in the world: the kicking boot meets the ball on KICK events
 * and planted boots do not slide.
 * Run: npx vite build --outDir dist-e2e/int-c --emptyOutDir &&
 *      PW_DIST=dist-e2e/int-c PW_PORT=4293 npx playwright test tests/e2e/int-c-live.spec.ts --output=tmp/int-c-results
 */
import { expect, test, type Page } from '@playwright/test';

const BUDGET_CALLS = 80;
const BUDGET_TRIS = 200_000;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

type Res = Record<string, number>;
interface Intc {
  run(maxTicks: number, stopPhase: number, minAbsX: number, maxAbsX: number, render: boolean, dt: number): Res;
  show(frames: number, dt: number): Res;
  corner(): void;
  goalKick(): void;
  foul(): void;
  goal(): void;
  anim(frames: number): Res;
}
type Win = Window & { __intc: Intc };

/** Start a CPU v CPU match (both humans off) with a fixed seed, then stop the rAF loop and install the driver. */
async function startCpuMatch(page: Page, night: number, seed: number, reload = true): Promise<void> {
  if (reload) await page.goto('/');
  await page.getByTestId('splash-start').click();
  await page.getByTestId('main-kickoff').click();
  await page.waitForFunction(() => {
    const d = window.__dotkick;
    return !!d && d.ctx.router.current === 'match' && d.app.session.loaded && d.ctx.session.getState() !== null;
  }, null, { timeout: 60_000, polling: 250 });
  await page.evaluate(([n, sd]) => {
    const d = window.__dotkick!;
    const setup = d.ctx.session.getSetup()!;
    d.ctx.session.quit();
    const humans = setup.config.humans.map((h) => ({ ...h, kind: 0, side: -1 }));
    d.ctx.session.start({ ...setup, bindings: [], config: { ...setup.config, night: n!, seed: sd!, humans } });
  }, [night, seed]);
  await page.waitForFunction(() => {
    const d = window.__dotkick!;
    return d.ctx.router.current === 'match' && d.app.session.loaded && d.ctx.session.getState() !== null;
  }, null, { timeout: 120_000, polling: 250 });
  await page.evaluate(installDriver);
}

/** In-page driver (serialised by page.evaluate: everything it uses is inside). */
function installDriver(): void {
  const d = window.__dotkick!;
  const app = d.app;
  app.loop.stop();
  let now = performance.now();
  type B = Record<string, number>;
  type P = B & { act: number };
  type S = { tick: number; match: { phase: number; challenges: B[] }; ball: B; players: P[]; teams: { dir: number }[] };
  const st = (): S => d.ctx.session.getState() as unknown as S;
  const W = window as unknown as Record<string, unknown>;
  const cine = (): number => {
    const c = W.__dotkickCinematic as { shot?: number } | undefined;
    return c && typeof c.shot === 'number' ? c.shot : -1;
  };
  const scr = { x: 0, y: 0 };
  // KICK events (type 0: a = slot, x/y/z = ball at contact) as the loop hands them to the renderer.
  type Ev = { type: number; a: number; x: number; y: number; z: number };
  const kicks: { slot: number; x: number; y: number; z: number }[] = [];
  const r = app.renderer as unknown as {
    render: (...a: unknown[]) => void;
    onEvents: (ev: { count: number; get(i: number): Ev }, s: unknown) => void;
    cameraX?: () => number;
  };
  const origEvents = r.onEvents.bind(r);
  r.onEvents = (ev, s) => {
    const ss = s as S;
    for (let i = 0; i < ev.count; i++) {
      const e = ev.get(i);
      if (e.type !== 0) continue;
      // Foot kick actions (KICK / SHOT: clips with a contact phase) with the ball within a boot's reach.
      const p = ss.players[e.a]!;
      if ((p.act === 1 || p.act === 2) && Math.hypot(e.x - p.x!, e.z - p.z!) <= 1 && e.y <= 0.5) {
        kicks.push({ slot: e.a, x: e.x, y: e.y, z: e.z });
      }
    }
    origEvents(ev, s);
  };
  const att = (): number => (st().teams[0]!.dir > 0 ? 0 : 1); // team attacking +x
  const looseBall = (x: number, z: number, y: number, vx: number, vy: number, vz: number, team: number, slot: number): void => {
    const s = st();
    const b = s.ball;
    b.owner = -1; b.heldBy = -1; b.x = x; b.z = z; b.y = y; b.vx = vx; b.vy = vy; b.vz = vz;
    b.px = x; b.py = y; b.pz = z; b.grounded = 0; b.shotBy = -1; b.passTarget = -1;
    b.lastTouch = slot; b.lastTouchTeam = team; b.lastTouchTick = s.tick; b.lastKickTeam = team; b.lastKickBy = slot;
  };
  const api: Intc = {
    run(maxTicks, stopPhase, minAbsX, maxAbsX, render, dt) {
      const orig = r.render;
      if (!render) r.render = () => {};
      const t0 = st().tick;
      let guard = 0;
      try {
        while (guard++ < 200000) {
          now += dt;
          app.loop.frame(now);
          const s = st();
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
      const rs = app.renderer.stats();
      app.renderer.projector.pitchToScreen(s.ball.x!, s.ball.y!, s.ball.z!, scr);
      return {
        msPerFrame: Math.round(((performance.now() - t) / frames) * 10) / 10, tick: s.tick, phase: s.match.phase,
        bx: +s.ball.x!.toFixed(2), by: +s.ball.y!.toFixed(2), bz: +s.ball.z!.toFixed(2), sx: Math.round(scr.x), sy: Math.round(scr.y),
        calls: rs.drawCalls, tris: rs.triangles, tier: rs.qualityTier, scale: rs.resolutionScale, shot: cine(),
        camX: r.cameraX ? +r.cameraX().toFixed(2) : NaN,
      };
    },
    // Ball over the goal line wide of the post, last touched by the defenders: the sim awards a corner.
    corner() { const def = 1 - att(); looseBall(50.5, 22, 0.3, 10, 0, 0, def, def * 11 + 4); },
    // Ball over the goal line, last touched by the attackers: goal kick.
    goalKick() { const a = att(); looseBall(50.5, -14, 0.3, 10, 0, 0, a, a * 11 + 9); },
    foul() {
      // A late hard challenge from behind on an attacker 26 m from goal, written into the sim's challenge list (RUL-09
      // classifies it next tick). The offending side holds the ball, so no advantage is played.
      const s = st();
      const a = att();
      const def = 1 - a;
      const victim = s.players[a * 11 + 9]!;
      const off = s.players[def * 11 + 5]!;
      victim.x = 26; victim.z = 6; victim.vx = 0; victim.vz = 0;
      off.x = 25.2; off.z = 6; off.vx = 0; off.vz = 0;
      const b = s.ball;
      b.owner = def * 11 + 5; b.heldBy = -1; b.x = 25.6; b.z = 6; b.y = 0.11; b.vx = 0; b.vy = 0; b.vz = 0;
      b.px = b.x; b.py = b.y; b.pz = b.z;
      const c = s.match.challenges[0]!;
      c.active = 1; c.tackler = def * 11 + 5; c.victim = a * 11 + 9; c.kind = 1; c.ballFirst = 0; c.fromBehind = 1;
      c.closingSpeed = 6; c.x = 26; c.z = 6; c.tick = s.tick;
    },
    goal() {
      // A hard low shot from 16 m into the far side of the +x goal, the keeper drawn to the near post.
      const s = st();
      const a = att();
      const k = s.players[(1 - a) * 11]!;
      k.x = 51.5; k.z = -3.4;
      looseBall(36, 4, 0.6, 26, 1.5, -0.7, a, a * 11 + 9);
      s.ball.shotBy = a * 11 + 9; s.ball.shotTick = s.tick;
    },
    anim(frames) {
      // Rendered open play at one tick per frame. (1) Kick contact: distance from the kicker's nearest boot point to the
      // ball at each KICK event of a foot kick action in reach (the frame after the contact tick). (2) Planting: for running players (> 2 m/s, no action), every boot point on the grass
      // (< 3 mm) in two consecutive frames; its world speed relative to the body speed is ~0 while planted. The toe-off
      // and heel-strike frames skim the grass at swing speed (GFX-09 keeps the swing foot inside the ground snap), so
      // the test reads the median and the stationary share, as for an ideal straight run (p50 0.01, share 0.64-0.85;
      // before INT-C's foot lock / live cross-fades / lean pivot live play read p50 0.46, share 0.23).
      const pl = W.__dotkickPlayers as { point(slot: number, j: number, x: number, y: number, z: number): [number, number, number] };
      const ANKLE = [9, 12];
      const FOOT = [[0.2, -0.08], [-0.07, -0.08]]; // toe, heel (fk.ts BODY.toeX / heelX, -ankleY)
      const prev: (number[] | undefined)[] = [];
      const ratios: number[] = [];
      const contact: number[] = [];
      kicks.length = 0;
      for (let f = 0; f < frames; f++) {
        now += 1000 / 60;
        app.loop.frame(now);
        const s = st();
        for (const k of kicks) {
          let best = 1e9;
          for (const j of ANKLE) {
            for (const fp of FOOT) {
              const q = pl.point(k.slot, j, fp[0]!, fp[1]!, 0);
              best = Math.min(best, Math.hypot(q[0] - k.x, q[1] - k.y, q[2] - k.z));
            }
          }
          contact.push(best);
        }
        kicks.length = 0;
        for (let slot = 0; slot < 22; slot++) {
          const p = s.players[slot]!;
          const speed = Math.hypot(p.vx!, p.vz!);
          for (let j = 0; j < 2; j++) {
            for (let fpi = 0; fpi < 2; fpi++) {
              const key = slot * 4 + j * 2 + fpi;
              const fp = FOOT[fpi]!;
              const q = pl.point(slot, ANKLE[j]!, fp[0]!, fp[1]!, 0);
              const was = prev[key];
              if (was && speed > 2 && q[1] < 0.003 && was[1]! < 0.003 && p.act === 0) {
                ratios.push((Math.hypot(q[0] - was[0]!, q[2] - was[2]!) * 60) / speed);
              }
              prev[key] = q;
            }
          }
        }
      }
      contact.sort((x, y) => x - y);
      ratios.sort((x, y) => x - y);
      let still = 0;
      for (const v of ratios) if (v < 0.1) still++;
      return {
        kicks: contact.length,
        contactMedian: contact.length ? +contact[(contact.length - 1) >> 1]!.toFixed(3) : -1,
        contactMax: contact.length ? +contact[contact.length - 1]!.toFixed(3) : -1,
        groundedFrames: ratios.length,
        slipP50: ratios.length ? +ratios[(ratios.length - 1) >> 1]!.toFixed(3) : -1,
        stationaryShare: ratios.length ? +(still / ratios.length).toFixed(3) : -1,
      };
    },
  };
  W.__intc = api;
}

function driver(page: Page) {
  return {
    run: (max: number, phase: number, minX = 0, maxX = 99, render = true, dt = 50) =>
      page.evaluate((g) => (window as unknown as Win).__intc.run(g[0]!, g[1]!, g[2]!, g[3]!, g[4] === 1, g[5]!),
        [max, phase, minX, maxX, render ? 1 : 0, dt]),
    /** Advance n ticks, drawing every frame at 60 Hz. */
    play: (n: number) => page.evaluate((m) => (window as unknown as Win).__intc.run(m, -1, 99, 0, true, 1000 / 60), n),
    show: (frames = 3) => page.evaluate((f) => (window as unknown as Win).__intc.show(f, 1000 / 60), frames),
    corner: () => page.evaluate(() => (window as unknown as Win).__intc.corner()),
    goalKick: () => page.evaluate(() => (window as unknown as Win).__intc.goalKick()),
    foul: () => page.evaluate(() => (window as unknown as Win).__intc.foul()),
    goal: () => page.evaluate(() => (window as unknown as Win).__intc.goal()),
    anim: (frames: number) => page.evaluate((f) => (window as unknown as Win).__intc.anim(f), frames),
  };
}

/** CineShot (render/camera/cinematic.ts). */
const SHOT = { NONE: 0, BEHIND_TAKER: 1, CORNER: 2, ESTABLISHING: 3, REPLAY_SIDE: 4, REPLAY_GOAL: 5 } as const;
const PHASE = { PRE_MATCH: 0, KICK_OFF: 1, IN_PLAY: 2, GOAL_KICK: 4, CORNER: 5, FREE_KICK: 6, GOAL: 8, REPLAY: 10 } as const;
/** HUD radar top edge at 820 px (ui/hud/radar.ts: 110 px canvas, 16 px above the bottom). */
const RADAR_TOP = 820 - 16 - 110;

test.describe('INT-C live match render integration', () => {
  test('scenes, budgets, cameras and animation contact in a CPU v CPU match (screenshots)', async ({ page }, testInfo) => {
    test.setTimeout(480_000);
    const errors = collectErrors(page);
    const t0 = Date.now();
    await startCpuMatch(page, 0, 20261014);
    console.log(`match ready in ${Math.round((Date.now() - t0) / 1000)} s`);
    const h = driver(page);
    const report: Record<string, Res> = {};
    let tLast = Date.now();
    const scene = async (name: string, frames = 3): Promise<Res> => {
      const r = await h.show(frames);
      report[name] = r;
      const ts = Date.now();
      await page.screenshot({ path: testInfo.outputPath(`int-c-${name}.png`) });
      console.log(`[t] ${name}: steps ${Math.round((ts - tLast) / 100) / 10} s, screenshot ${Math.round((Date.now() - ts) / 100) / 10} s`);
      tLast = Date.now();
      expect(r.calls, `${name} draw calls`).toBeLessThanOrEqual(BUDGET_CALLS);
      expect(r.calls, `${name} drew`).toBeGreaterThan(5);
      expect(r.tris, `${name} triangles`).toBeLessThanOrEqual(BUDGET_TRIS);
      expect(Number.isFinite(r.camX), `${name} cameraX`).toBe(true);
      return r;
    };
    const onScreen = (r: Res, name: string): void => {
      expect(r.sx, `${name} ball x`).toBeGreaterThan(0);
      expect(r.sx, `${name} ball x`).toBeLessThan(1180);
      expect(r.sy, `${name} ball y`).toBeGreaterThan(0.05 * 820);
      expect(r.sy, `${name} ball above the bottom 15%`).toBeLessThan(0.85 * 820 + 2);
      if (Math.abs(r.sx - 590) < 84) expect(r.sy, `${name} ball above the radar`).toBeLessThan(RADAR_TOP);
    };

    // Establishing shot (PRE_MATCH), then the kick-off on the main camera.
    const pre = await scene('establishing', 2);
    expect(pre.phase).toBe(PHASE.PRE_MATCH);
    expect(pre.shot).toBe(SHOT.ESTABLISHING);
    await h.run(600, PHASE.KICK_OFF, 0, 99, false);
    await h.play(10);
    const ko = await scene('kickoff');
    expect(ko.shot).toBe(SHOT.NONE);
    onScreen(ko, 'kickoff');

    // Open play: animation contact and boot sliding over 6 s of rendered play, then mid-pitch and an attack.
    await h.run(1200, PHASE.IN_PLAY, 0, 99, false);
    await h.play(30);
    const anim = await h.anim(150);
    report.anim = anim;
    console.log("anim", JSON.stringify(anim));
    expect(anim.groundedFrames).toBeGreaterThan(500);
    expect(anim.slipP50).toBeLessThan(0.1);
    expect(anim.stationaryShare).toBeGreaterThan(0.55);
    if (anim.kicks > 0) {
      expect(anim.contactMedian).toBeLessThan(0.25);
      expect(anim.contactMax).toBeLessThan(0.5);
    }
    await h.run(3000, PHASE.IN_PLAY, 0, 15, false);
    onScreen(await scene('openplay'), 'openplay');
    await h.run(9000, PHASE.IN_PLAY, 30, 99, false);
    onScreen(await scene('attack'), 'attack');

    // Corner: awarded by the sim, the raised corner view, the taker set up, then taken (main camera again).
    await h.corner();
    await h.run(300, PHASE.CORNER, 0, 99, false);
    await h.play(10);
    const ca = await scene('corner-award');
    expect(ca.phase).toBe(PHASE.CORNER);
    expect(ca.shot).toBe(SHOT.CORNER);
    expect(ca.sy, 'corner ball above the radar').toBeLessThan(RADAR_TOP - 40);
    await h.play(40);
    await scene('corner-setup');
    await h.run(1500, PHASE.IN_PLAY, 0, 99, false);
    await h.play(8);
    await scene('corner-taken');

    // Goal kick: the behind-the-taker rig in front of the goal.
    await h.run(6000, PHASE.IN_PLAY, 0, 99, false);
    await h.goalKick();
    await h.run(300, PHASE.GOAL_KICK, 0, 99, false);
    await h.play(40);
    const gk = await scene('goal-kick');
    expect(gk.phase).toBe(PHASE.GOAL_KICK);
    expect(gk.shot).toBe(SHOT.BEHIND_TAKER);

    // Free kick from a foul 26 m out: behind the taker, goal in view.
    await h.run(6000, PHASE.IN_PLAY, 0, 99, false);
    let awarded = false;
    for (let attempt = 0; attempt < 12 && !awarded; attempt++) {
      await h.run(30, PHASE.IN_PLAY, 0, 99, false);
      await h.foul();
      awarded = (await h.run(6, PHASE.FREE_KICK, 0, 99, false)).phase === PHASE.FREE_KICK;
    }
    expect(awarded, 'a free kick was awarded').toBe(true);
    await h.play(40);
    const fk = await scene('free-kick');
    expect(fk.phase).toBe(PHASE.FREE_KICK);
    expect(fk.shot).toBe(SHOT.BEHIND_TAKER);

    // Goal + replay: 6 s of play drawn every third tick feed the replay ring, then the shot, the goal, both angles.
    await h.run(6000, PHASE.IN_PLAY, 0, 99, false);
    await h.run(360, -1, 99, 0, true, 50);
    await h.goal();
    await h.run(240, PHASE.GOAL, 0, 99, true, 50);
    const goal = await scene('goal', 2);
    expect(goal.phase).toBe(PHASE.GOAL);
    await h.run(1500, PHASE.REPLAY, 0, 99, false);
    await h.play(10);
    const rs = await scene('replay-side', 2);
    expect(rs.phase).toBe(PHASE.REPLAY);
    const seen = new Set<number>([rs.shot]);
    for (let i = 0; i < 40 && !seen.has(SHOT.REPLAY_GOAL); i++) {
      await h.run(18, -1, 99, 0, true, 100); // 100 ms frames: the replay plays on real frame time
      seen.add((await h.show(1)).shot);
    }
    expect(seen.has(SHOT.REPLAY_SIDE)).toBe(true);
    expect(seen.has(SHOT.REPLAY_GOAL)).toBe(true);
    await scene('replay-goal', 1);
    await h.run(1500, PHASE.KICK_OFF, 0, 99, false);
    await h.play(10);
    const ko2 = await scene('kickoff-after-goal');
    expect(ko2.phase).toBe(PHASE.KICK_OFF);
    expect(ko2.shot).toBe(SHOT.NONE);

    console.log('INT-C scenes', JSON.stringify(report));
    expect(errors).toEqual([]);
  });

  test('night match at the QUALITY tier (MSAA context, shadow map), then a WebGL context loss and restore', async ({ page }, testInfo) => {
    test.setTimeout(300_000);
    const errors = collectErrors(page);
    // Choose QUALITY in the settings and reload: the context is created with multisampling (INT-C MSAA decision).
    await page.goto('/');
    await page.waitForFunction(() => !!window.__dotkick, null, { timeout: 30_000 });
    await page.evaluate(() => window.__dotkick!.ctx.settings.update((s) => { s.graphics.tier = 3; }));
    await page.reload();
    await startCpuMatch(page, 1, 4242, false);
    const ctxInfo = await page.evaluate(() => {
      const r = window.__dotkick!.app.renderer as unknown as { msaa: boolean };
      const c = document.getElementById('game') as HTMLCanvasElement;
      const gl = c.getContext('webgl2');
      return { msaa: r.msaa, antialias: gl?.getContextAttributes()?.antialias ?? null };
    });
    expect(ctxInfo).toEqual({ msaa: true, antialias: true });
    const h = driver(page);
    await h.run(2000, PHASE.IN_PLAY, 0, 99, false);
    await h.play(40);
    const night = await h.show(3);
    await page.screenshot({ path: testInfo.outputPath('int-c-night-quality.png') });
    console.log('night QUALITY', JSON.stringify(night));
    expect(night.tier).toBe(3);
    expect(night.calls).toBeLessThanOrEqual(BUDGET_CALLS);
    expect(night.tris).toBeLessThanOrEqual(BUDGET_TRIS);
    const stadium = await page.evaluate(() => (window as unknown as { __dotkickStadium: { snapshot(): { night: boolean } } }).__dotkickStadium.snapshot().night);
    expect(stadium).toBe(true);

    // Context loss: the session pauses, nothing is drawn; restore: rebuilt before the session hears about it.
    const lost = await page.evaluate(async () => {
      const d = window.__dotkick!;
      const c = document.getElementById('game') as HTMLCanvasElement;
      const ext = c.getContext('webgl2')!.getExtension('WEBGL_lose_context')!;
      const r = d.app.renderer as unknown as { contextLost: boolean; onContextRestored(fn: () => void): () => void; lastRebuild: { materials: number } | null };
      (window as unknown as { __intcExt: WEBGL_lose_context }).__intcExt = ext;
      ext.loseContext();
      for (let i = 0; i < 50 && !r.contextLost; i++) await new Promise((res) => setTimeout(res, 20));
      return { contextLost: r.contextLost, paused: d.ctx.session.paused };
    });
    expect(lost).toEqual({ contextLost: true, paused: true });
    const restored = await page.evaluate(async () => {
      const d = window.__dotkick!;
      const r = d.app.renderer as unknown as { contextLost: boolean; lastRebuild: { materials: number; missingTextures: number } | null; onContextRestored(fn: () => void): () => void };
      let lostAtNotice: boolean | null = null;
      const off = r.onContextRestored(() => { lostAtNotice = r.contextLost; });
      (window as unknown as { __intcExt: WEBGL_lose_context }).__intcExt.restoreContext();
      for (let i = 0; i < 100 && r.contextLost; i++) await new Promise((res) => setTimeout(res, 20));
      off();
      return { contextLost: r.contextLost, lostAtNotice, rebuild: r.lastRebuild };
    });
    expect(restored.contextLost).toBe(false);
    expect(restored.lostAtNotice).toBe(false);
    expect(restored.rebuild!.materials).toBeGreaterThan(5);
    expect(restored.rebuild!.missingTextures).toBe(0);
    // Resume and draw: the same scene comes back within budget.
    await page.evaluate(() => { const d = window.__dotkick!; d.ctx.session.resume(-1); });
    await h.play(30);
    const after = await h.show(3);
    await page.screenshot({ path: testInfo.outputPath('int-c-after-restore.png') });
    console.log('after restore', JSON.stringify(after));
    expect(after.calls).toBeGreaterThan(5);
    expect(after.calls).toBeLessThanOrEqual(BUDGET_CALLS);
    expect(Math.abs(after.calls - night.calls)).toBeLessThanOrEqual(4);
    expect(errors.filter((e) => !/context lost|CONTEXT_LOST/i.test(e))).toEqual([]);
  });
});
