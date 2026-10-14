/**
 * RUL-05 budgets: the per-tick free-kick paths (freeKickTick with the wall upkeep and the taker lining up,
 * freeKickInput for the taker's aim / curl and for the defenders moving the wall, the WALL_JUMP handler's swept
 * blocking test while the ball flies at the wall) are a tiny share of the 2.5 ms sim + AI tick and allocate nothing per
 * call; previewFlight (per rendered frame while aiming, not per tick) allocates nothing and stays well under a
 * millisecond; the Default (once per free kick) stays under a tenth of a millisecond.
 *
 * Measured on an esbuild bundle of the modules (one scope, like the production build), as RUL-03 / RUL-04 / RUL-11 do:
 * Vitest's module runner turns imported bindings into getter calls and makes V8 box doubles it would otherwise keep
 * unboxed.
 */
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';
import { ActionKind, ControllerKind, GestureKind, KickKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import type { EventBuffer, EventSink } from '../../src/contracts/events';
import { Btn, GestureFlag, type InputFrame } from '../../src/contracts/input';
import type { MatchConfig, SimState } from '../../src/contracts/state';
import type {
  ActionHandler, ActionRequest, BallPrediction, KickLaunch, KickSolver,
} from '../../src/contracts/systems';

interface Bundle {
  awardRestart: (s: SimState, kind: RestartKind, team: number, x: number, z: number, ev: EventBuffer) => void;
  step: (s: SimState, frames: readonly InputFrame[], ev: EventBuffer) => void;
  freeKickTick: (s: SimState, ev: EventSink) => void;
  freeKickInput: (s: SimState, c: number, f: InputFrame, ev: EventSink) => void;
  freeKickDefault: (s: SimState, ev: EventSink) => void;
  previewFlight: (s: SimState, out: BallPrediction, f?: InputFrame | null) => number;
  wallJumpHandler: ActionHandler;
  initMatch: (c: MatchConfig) => SimState;
  createMatchConfig: () => MatchConfig;
  createEventBuffer: () => EventBuffer;
  createInputFrame: () => InputFrame;
  createBallPrediction: () => BallPrediction;
  cloneState: (s: SimState) => SimState;
  copyState: (dst: SimState, src: SimState) => void;
  predictBall: (b: SimState['ball'], ticks: number, out: BallPrediction) => void;
  createBallState: () => SimState['ball'];
  prepareTakerKick: (s: SimState, slot: number) => number;
  startShot: (s: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink) => number;
  KICK_SOLVERS: readonly (KickSolver | null)[];
  createActionRequest: () => ActionRequest;
  createKickLaunch: () => KickLaunch;
}

const ROOT = resolve(__dirname, '../..');
let m: Bundle;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rul-05-bench-'));
  const src = (f: string): string => JSON.stringify(join(ROOT, f));
  const entry = join(dir, 'entry.ts');
  writeFileSync(entry, [
    `export { awardRestart, prepareTakerKick } from ${src('src/sim/rules/restart')};`,
    `export { startShot } from ${src('src/sim/kicks/shot')};`,
    `export { KICK_SOLVERS } from ${src('src/sim/actions/registry')};`,
    `export { freeKickTick, freeKickInput, freeKickDefault, previewFlight, wallJumpHandler } from ${src('src/sim/rules/freekick')};`,
    `export { step } from ${src('src/sim/step')};`,
    `export { initMatch } from ${src('src/sim/init')};`,
    `export { createMatchConfig, createBallState } from ${src('src/contracts/state')};`,
    `export { createInputFrame } from ${src('src/contracts/input')};`,
    `export { createBallPrediction, createActionRequest, createKickLaunch } from ${src('src/contracts/systems')};`,
    `export { createEventBuffer } from ${src('src/sim/core/events')};`,
    `export { cloneState, copyState } from ${src('src/sim/core/clone')};`,
    `export { predictBall } from ${src('src/sim/ball/flight')};`,
  ].join('\n'));
  const outfile = join(dir, 'bundle.mjs');
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'error',
    define: { __DEV_BUILD__: 'false' } });
  try {
    m = (await import(/* @vite-ignore */ pathToFileURL(outfile).href)) as Bundle;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const GX = 52.5;

/** Free kick for home 21 m out (human P1 takes it, human P2 defends), ready, wall formed. */
function readyFreeKick(ev: EventBuffer): SimState {
  const cfg = m.createMatchConfig();
  cfg.humans[1] = { ...cfg.humans[0]!, kind: ControllerKind.HUMAN, side: 1 };
  const s = m.initMatch(cfg);
  s.match.phase = MatchPhase.IN_PLAY;
  ev.begin(0);
  m.awardRestart(s, RestartKind.FREE_KICK, 0, GX - 21, 3, ev);
  const frames = [m.createInputFrame(), m.createInputFrame()];
  for (let i = 0; i < 80 && s.match.restart.ready !== 1; i++) m.step(s, frames, ev);
  const r = s.match.restart;
  if (r.ready !== 1 || !(r.wallCount > 0) || s.ctrl[0]!.slot !== r.taker) throw new Error('free kick not ready');
  r.timeoutT = 1e9; // never reach the Default while measuring
  return s;
}

/** The same free kick just struck: a firm ground pass straight at the wall (SIM-08 is real), the members braced. */
function struckAtWall(ev: EventBuffer): { s: SimState; w: number } {
  const s = readyFreeKick(ev);
  const r = s.match.restart;
  r.aimX = r.wallX + (r.wallX - r.x);
  r.aimZ = r.wallZ + (r.wallZ - r.z);
  const frames = [m.createInputFrame(), m.createInputFrame()];
  frames[0]!.buttons = Btn.PASS;
  frames[0]!.power = 127;
  for (let i = 0; i < 30 && r.taken === 0; i++) { m.step(s, frames, ev); frames[0]!.buttons = 0; frames[0]!.power = 0; }
  if (r.taken !== 1) throw new Error('free kick not taken');
  m.step(s, frames, ev);
  const w = r.wall[0]!;
  if (s.players[w]!.act !== ActionKind.WALL_JUMP) throw new Error('wall not braced');
  if (!(Math.hypot(s.ball.x - r.x, s.ball.z - r.z) < 6)) throw new Error('ball already at the wall');
  s.players[w]!.actDur = 1e9;
  return { s, w };
}

function bestBatchMs(fn: () => void, iterations: number, batches: number): number {
  for (let i = 0; i < iterations; i++) fn();
  let best = Infinity;
  for (let b = 0; b < batches; b++) {
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    best = Math.min(best, (performance.now() - t0) / iterations);
  }
  return best;
}

/** Heap bytes per call: the least of three measurements (a one-off JIT / GC bookkeeping blip is not per-call). */
function bytesPerCall(fn: () => void, n: number): number {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  for (let i = 0; i < n; i++) fn();
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    gc();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < n; i++) fn();
    best = Math.min(best, (process.memoryUsage().heapUsed - h0) / n);
  }
  return best;
}

describe('RUL-05 budgets', () => {
  it('per-tick paths are cheap: freeKickTick and freeKickInput < 0.005 ms, wall blocking < 0.01 ms, Default < 0.1 ms', () => {
    const ev = m.createEventBuffer();
    const s = readyFreeKick(ev);
    const r = s.match.restart;
    let flip = 0;
    const tick = (): void => { flip ^= 1; r.aimZ = flip ? 2 : -2; m.freeKickTick(s, ev); };
    const aim = m.createInputFrame();
    aim.mx = 100; aim.mz = -40; aim.ax = 30; aim.az = 90;
    const defend = m.createInputFrame();
    const c1 = s.ctrl[1]!;
    const input = (): void => {
      flip ^= 1;
      aim.mz = flip ? -40 : 40;
      m.freeKickInput(s, 0, aim, ev);
      c1.buttons = flip ? Btn.SHIELD : Btn.SPRINT;
      c1.prevButtons = c1.buttons;
      m.freeKickInput(s, 1, defend, ev);
    };
    expect(bestBatchMs(tick, 5000, 20)).toBeLessThan(0.005);
    expect(bestBatchMs(input, 5000, 20)).toBeLessThan(0.005);
    c1.buttons = 0;
    c1.prevButtons = 0;
    const taker = s.players[r.taker]!;
    const dflt = (): void => { m.freeKickDefault(s, ev); taker.act = ActionKind.SET_PIECE; };
    expect(bestBatchMs(dflt, 500, 10)).toBeLessThan(0.1);
    expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
    expect(r.taken).toBe(0);
    const st = struckAtWall(ev);
    const p = st.s.players[st.w]!;
    const block = (): void => { st.s.tick++; p.actT++; m.wallJumpHandler.update(st.s, st.w, ev); };
    expect(bestBatchMs(block, 5000, 20)).toBeLessThan(0.01);
    expect(st.s.ball.lastKickKind).not.toBe(KickKind.DEFLECTION);
  });

  it('previewFlight (per rendered frame while aiming) stays under 0.5 ms', () => {
    const ev = m.createEventBuffer();
    const s = readyFreeKick(ev);
    const pred = m.createBallPrediction();
    const swipe = m.createInputFrame();
    swipe.gesture = GestureKind.CURVED_SWIPE; swipe.gFlags = GestureFlag.FROM_BALL;
    swipe.gdx = 120; swipe.gdz = -20; swipe.gPower = 100; swipe.gCurve = 40;
    expect(bestBatchMs(() => { m.previewFlight(s, pred); }, 300, 10)).toBeLessThan(0.5);
    expect(bestBatchMs(() => { m.previewFlight(s, pred, swipe); }, 300, 10)).toBeLessThan(0.5);
    expect(pred.count).toBeGreaterThan(0);
  });

  it('per-tick paths and the preview allocate nothing', () => {
    const ev = m.createEventBuffer();
    const s = readyFreeKick(ev);
    const r = s.match.restart;
    let flip = 0;
    const aim = m.createInputFrame();
    aim.mx = 100; aim.mz = -40; aim.ax = 30; aim.az = 90;
    const defend = m.createInputFrame();
    const c1 = s.ctrl[1]!;
    const res: Record<string, number> = {};
    res.waitTick = bytesPerCall(() => { flip ^= 1; r.aimZ = flip ? 2 : -2; m.freeKickTick(s, ev); }, 50000);
    res.attackInput = bytesPerCall(() => { flip ^= 1; aim.mz = flip ? -40 : 40; m.freeKickInput(s, 0, aim, ev); }, 50000);
    res.defendInput = bytesPerCall(() => {
      flip ^= 1;
      c1.buttons = flip ? Btn.SHIELD : Btn.SPRINT;
      c1.prevButtons = c1.buttons;
      m.freeKickInput(s, 1, defend, ev);
    }, 50000);
    c1.buttons = 0;
    c1.prevButtons = 0;
    const st = struckAtWall(ev);
    const S = st.s, W = st.w;
    const p = S.players[W]!;
    res.wallHandler = bytesPerCall(() => { S.tick++; p.actT++; m.wallJumpHandler.update(S, W, ev); }, 50000);
    for (const [name, b] of Object.entries(res)) expect(b, `${name}: ${JSON.stringify(res)}`).toBeLessThan(1);
  });

  it('previewFlight allocates nothing of its own beyond the FND-03 copyState, the SIM-11 starter / solver and SIM-01 predictBall it builds on', () => {
    const ev = m.createEventBuffer();
    const s = readyFreeKick(ev);
    const r = s.match.restart;
    const pred = m.createBallPrediction();
    const res: Record<string, number> = {};
    // The floors: copying the state into the preview's scratch copy, and predicting a shot's flight at goal.
    const scr = m.cloneState(s);
    res.copyState = bytesPerCall(() => { m.copyState(scr, s); }, 3000);
    const b = m.createBallState();
    const shot = (): void => {
      b.x = r.x; b.y = 0.11; b.z = r.z; b.vx = 25; b.vy = 6; b.vz = -0.6; b.sx = 0; b.sy = 4; b.sz = 0; b.grounded = 0;
      b.bounces = 0; b.inNet = 0; b.owner = -1; b.heldBy = -1;
      m.predictBall(b, 60, pred);
    };
    res.predictBall = bytesPerCall(shot, 3000);
    // The kick module's own share: SIM-11 startShot + solveShot on the scratch copy (what the preview runs), refreshed
    // by copyState each call (so copyState is inside this figure).
    const req = m.createActionRequest();
    const launch = m.createKickLaunch();
    const t = r.taker;
    const kick = (): void => {
      m.copyState(scr, s);
      req.dirX = 1; req.dirZ = 0; req.hasTarget = 1; req.targetX = GX; req.targetZ = r.aimZ; req.power = 0.75;
      req.curve = 0.3; req.charging = 0; req.assist = 1; req.flags = 0;
      if (m.prepareTakerKick(scr, t) !== 1) throw new Error('prepare refused');
      if (m.startShot(scr, t, KickKind.FREE_KICK_SHOT, req, ev) !== 1) throw new Error('shot refused');
      scr.players[t]!.actCharging = 0;
      m.KICK_SOLVERS[scr.players[t]!.actKick]!(scr, t, launch);
    };
    res.kickModule = bytesPerCall(kick, 3000);
    res.previewAim = bytesPerCall(() => { m.previewFlight(s, pred); }, 3000);
    const swipe = m.createInputFrame();
    swipe.gesture = GestureKind.CURVED_SWIPE; swipe.gFlags = GestureFlag.FROM_BALL;
    swipe.gdx = 120; swipe.gdz = -20; swipe.gPower = 100; swipe.gCurve = 40;
    res.previewSwipe = bytesPerCall(() => { m.previewFlight(s, pred, swipe); }, 3000);
    const floor = Math.max(res.copyState!, res.kickModule!) + res.predictBall!;
    // Slack: a few boxed doubles (request geometry, the swipe's dcos / dsin; GC bookkeeping noise); no objects, arrays,
    // closures or state copies (each of those is kilobytes).
    expect(res.previewAim!, JSON.stringify(res)).toBeLessThan(floor + 256);
    expect(res.previewSwipe!, JSON.stringify(res)).toBeLessThan(floor + 256);
  });
});
