/**
 * [DAT-05] Dynamic attribute audit (BRIEF section 15: "Every attribute must visibly change play. Delete any that does
 * not."). One micro-test per audited attribute: the same scenario is played with only that attribute at 40 and at 90
 * (height 170 vs 195 cm, weakFoot / skillMoves 1 vs 5, foot left vs right) and a measurable outcome must move in the
 * right direction by a visible margin. The static half (which src/sim and src/ai modules read each attribute) is
 * `npx tsx tools/balance.ts --audit`; docs/ATTRIBUTE_AUDIT.md records consumer, measured effect and verdict.
 *
 * Levels: "pipeline" steps the real step() pipeline (or the sim's own stage functions in pipeline order), "solver"
 * runs the real kick solver at contact over many rng seeds (the launch the ball would get), "model" evaluates the
 * sim's own decision function on a scenario state (the chance it rolls against). No consumer is a stub any more, so
 * there are no it.todo entries; if a consumer is replaced by a stub later its micro-test fails loudly.
 *
 * DAT05_REPORT=1 prints the measured table (copied into docs/ATTRIBUTE_AUDIT.md):
 *   DAT05_REPORT=1 npx vitest run tests/sim/dat-05-attributes.test.ts
 */
import '../../src/sim/actions/dispatch'; // load the action registry first (import-cycle order)
import { afterAll, describe, expect, it } from 'vitest';
import { BALL_RADIUS, GOAL_HALF_WIDTH, GOAL_HEIGHT, HALF_LENGTH, NUM_SLOTS } from '../../src/contracts/constants';
import {
  ActionKind, AssistLevel, AutoSwitch, ControllerKind, Foot, KickKind, MatchPhase, SkillMove,
} from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { AXIS_SCALE, Btn } from '../../src/contracts/input';
import { createBallState, MoveMode, type PlayerAttrs, type SimState } from '../../src/contracts/state';
import { createActionRequest, createKickLaunch, type ActionRequest, type KickLaunch } from '../../src/contracts/systems';
import { T_TACKLE } from '../../src/contracts/tuning';
import { ballStepTick, ballTick } from '../../src/sim/ball/contact';
import { copyBallState, createLaunchSolution, solveLaunchSpin } from '../../src/sim/ball/flight';
import { cloneState } from '../../src/sim/core/clone';
import { createEventBuffer, NULL_SINK } from '../../src/sim/core/events';
import { rngSeed } from '../../src/sim/core/rng';
import { LOCAL_TUNING as TACKLE_L, startTackle } from '../../src/sim/defend/tackle';
import { keeperPickUp, solveKeeperRelease, startKeeperRelease } from '../../src/sim/keeper/handling';
import { idealKeeperSpot } from '../../src/sim/keeper/positioning';
import { solveCross, solveLob, startLob } from '../../src/sim/kicks/lob';
import { solveGroundPass, startPass } from '../../src/sim/kicks/pass';
import { solveShot, startShot } from '../../src/sim/kicks/shot';
import { startSkill } from '../../src/sim/kicks/skills';
import { solveThrough, startThrough } from '../../src/sim/kicks/through';
import { LOCAL_TUNING as TOUCH_L, touchQuality } from '../../src/sim/players/firstTouch';
import { accelFor, locomotionTick, topSpeedFor } from '../../src/sim/players/locomotion';
import { dribbleTick } from '../../src/sim/players/possession';
import { makeScenario, runTicks } from '../harness/scenario';

const LO = 40;
const HI = 90;
const EV = createEventBuffer();

// ---------------------------------------------------------------- report

type Level = 'pipeline' | 'solver' | 'model';
interface Row { key: string; level: Level; metric: string; lo: number; hi: number; loLabel: string; hiLabel: string }
const ROWS: Row[] = [];

/**
 * Record a measurement and assert it moved: dir * (hi - lo) >= minDelta (metric units). minDelta is the "visible"
 * margin for the metric (well above seed noise), not a tuning target.
 */
function moved(key: string, level: Level, metric: string, lo: number, hi: number, dir: 1 | -1, minDelta: number,
  labels: [string, string] = [String(LO), String(HI)]): void {
  ROWS.push({ key, level, metric, lo, hi, loLabel: labels[0], hiLabel: labels[1] });
  expect(Number.isFinite(lo) && Number.isFinite(hi), `${key}: finite measurements`).toBe(true);
  expect(dir * (hi - lo), `${key}: ${metric} ${labels[0]} -> ${labels[1]}: ${lo} -> ${hi}`).toBeGreaterThanOrEqual(minDelta);
}

afterAll(() => {
  if (!process.env.DAT05_REPORT) return;
  const f = (v: number): string => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
  const lines = ['| Attribute | Level | Measured outcome | Low | High |', '|---|---|---|---|---|'];
  for (const r of ROWS) lines.push(`| ${r.key} | ${r.level} | ${r.metric} | ${f(r.lo)} (${r.loLabel}) | ${f(r.hi)} (${r.hiLabel}) |`);
  console.log(`DAT-05 measured attribute effects:\n${lines.join('\n')}`);
});

// ---------------------------------------------------------------- shared set-up

/** Set attributes of a slot and refresh the derived top speed / acceleration (as sim/init.ts copyAttrs does). */
function setAttrs(s: SimState, slot: number, a: Partial<PlayerAttrs>): void {
  const t = s.attrs[slot]!;
  Object.assign(t, a);
  t.topSpeed = topSpeedFor(t);
  t.accel = accelFor(t);
}

/** Put slot at (x, z), idle and fresh, facing (fx, fz), optionally moving at v along the facing. */
function place(s: SimState, slot: number, x: number, z: number, fx = 1, fz = 0, v = 0): void {
  const p = s.players[slot]!;
  const l = Math.sqrt(fx * fx + fz * fz) || 1;
  p.active = 1;
  p.x = x; p.z = z; p.fx = fx / l; p.fz = fz / l; p.vx = p.fx * v; p.vz = p.fz * v;
  p.moveMode = MoveMode.STOP; p.ix = 0; p.iz = 0; p.tgtX = x; p.tgtZ = z; p.tgtSpeed = 0; p.wantSprint = 0;
  p.sprinting = 0; p.jockeying = 0; p.shielding = 0; p.lookAt = 0;
  p.act = ActionKind.NONE; p.actT = 0; p.actDur = 0; p.actDone = 0; p.actKick = KickKind.NONE; p.actSkill = SkillMove.NONE;
  p.stunT = 0; p.noTouchT = 0; p.touchCd = 0; p.stamina = 1;
}

/** Ball at rest at (x, z) on the ground, loose. */
function looseBall(s: SimState, x: number, z: number, vx = 0, vz = 0): void {
  const b = s.ball;
  b.x = x; b.y = BALL_RADIUS; b.z = z; b.px = x - vx / 60; b.py = BALL_RADIUS; b.pz = z - vz / 60;
  b.vx = vx; b.vy = 0; b.vz = vz; b.sx = 0; b.sy = 0; b.sz = 0;
  b.grounded = 1; b.bounces = 0; b.owner = -1; b.heldBy = -1; b.inNet = 0; b.shotBy = -1; b.passTarget = -1;
}

/** Ball owned by slot at (x, z). */
function ownBall(s: SimState, slot: number, x: number, z: number): void {
  looseBall(s, x, z);
  const b = s.ball;
  b.owner = slot; b.ownerT = 10; b.lastTouch = slot; b.lastTouchTeam = s.players[slot]!.team;
  b.lastTouchTick = s.tick - 5; b.touchedTick = s.tick - 5;
}

/**
 * IN_PLAY at tick 100 with nobody near the action: every player parked in a strip at x = parkX, CPU brains and
 * controllers off unless humans are asked for (those keep their slots).
 */
function quiet(seed: number, parkX = -46, humans: { side: number; slot: number }[] = []): SimState {
  const s = makeScenario({
    seed, phase: MatchPhase.IN_PLAY,
    humans: humans.map((h) => ({ side: h.side, slot: h.slot, autoSwitch: AutoSwitch.OFF })),
  });
  for (let c = 0; c < s.ctrl.length; c++) {
    const ctl = s.ctrl[c]!;
    if (ctl.kind === ControllerKind.HUMAN) continue;
    if (ctl.slot >= 0 && s.players[ctl.slot]!.ctrl === c) s.players[ctl.slot]!.ctrl = -1;
    ctl.kind = ControllerKind.NONE; ctl.side = -1; ctl.slot = -1;
  }
  s.teams[0]!.cpu.active = 0;
  s.teams[1]!.cpu.active = 0;
  for (let i = 0; i < NUM_SLOTS; i++) {
    if (humans.some((h) => h.slot === i)) continue;
    place(s, i, parkX + (i % 2) * 3, -32 + i * 3, i < 11 ? 1 : -1, 0);
  }
  for (let t = 0; t < 2; t++) s.teams[t]!.chaser = -1;
  s.tick = 100;
  return s;
}

function req(o: Partial<ActionRequest>): ActionRequest {
  return Object.assign(createActionRequest(), { assist: AssistLevel.ASSISTED }, o);
}

/** Every event of a run (copies). */
function stepRun(s: SimState, n: number, inputs?: Parameters<typeof runTicks>[2], until?: (s: SimState, ev: readonly SimEvent[]) => boolean): SimEvent[] {
  return runTicks(s, n, inputs, until ? { until } : {});
}

/** Fresh copy of base with the rng reseeded for trial k. */
function trial(base: SimState, k: number): SimState {
  const s = cloneState(base);
  rngSeed(s.rng, 1000 + k * 7919);
  return s;
}

// ---------------------------------------------------------------- solver helpers

/**
 * Launch-direction spread (degrees, standard deviation of the horizontal launch angle around its circular mean) of a
 * kick started by `start` on base and solved by `solve` over n rng seeds. Every start must be accepted.
 */
function launchSpread(base: SimState, slot: number, start: (s: SimState) => number,
  solve: (s: SimState, slot: number, out: KickLaunch) => number, n = 160): number {
  const ang: number[] = [];
  for (let k = 0; k < n; k++) {
    const s = cloneState(base);
    expect(start(s), 'kick start accepted').toBe(1);
    rngSeed(s.rng, 1000 + k * 7919);
    const out = createKickLaunch();
    expect(solve(s, slot, out), 'kick solved').toBe(1);
    ang.push(Math.atan2(out.vz, out.vx));
  }
  let cx = 0, cz = 0;
  for (const a of ang) { cx += Math.cos(a); cz += Math.sin(a); }
  const mean = Math.atan2(cz, cx);
  let ss = 0;
  for (const a of ang) {
    let d = a - mean;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    ss += d * d;
  }
  return (Math.sqrt(ss / ang.length) * 180) / Math.PI;
}

const SHOOTER = 9;
const GX = HALF_LENGTH;

/** Team-0 shooter at (x, z) facing the +x goal centre with the ball at his feet; the away keeper on his line. */
function shotScene(x: number, z: number, a: Partial<PlayerAttrs>): SimState {
  const s = quiet(3);
  const dx = GX - x, dz = -z;
  place(s, SHOOTER, x, z, dx, dz);
  const p = s.players[SHOOTER]!;
  ownBall(s, SHOOTER, x + p.fx * 0.5, z + p.fz * 0.5);
  place(s, 11, GX - 0.5, 0, -1, 0);
  setAttrs(s, SHOOTER, { finishing: 70, longShots: 70, shotPower: 70, curve: 70, composure: 70, ballControl: 70, weakFoot: 5, foot: Foot.RIGHT, ...a });
  return s;
}

/** Where a launched ball crosses the +x goal line (z, y), or null if it never gets there. */
function crossing(s: SimState, out: KickLaunch): { z: number; y: number } | null {
  const b = createBallState();
  copyBallState(b, s.ball);
  b.vx = out.vx; b.vy = out.vy; b.vz = out.vz; b.sx = out.sx; b.sy = out.sy; b.sz = out.sz;
  b.owner = -1; b.heldBy = -1; b.bounces = 0; b.grounded = out.vy > 0.5 ? 0 : b.grounded;
  for (let i = 0; i < 300; i++) {
    const px = b.x, py = b.y, pz = b.z;
    ballStepTick(b, null);
    if (px < GX && b.x >= GX) {
      const f = (GX - px) / (b.x - px);
      return { z: pz + (b.z - pz) * f, y: py + (b.y - py) * f };
    }
    if (b.vx <= 0) return null;
  }
  return null;
}

interface ShotStats {
  /** Share crossing the line inside the mouth. */
  onTarget: number;
  /** Mean |z| miss at the goal line from the solver's aim point (shots that got there), m. */
  placement: number;
  /** Mean launch speed, m/s, and mean |side spin|, rad/s. */
  speed: number;
  spin: number;
}

/** Shots of kind from base over n rng seeds through the real solver, flown with the sim's ball physics. */
function shots(base: SimState, kind: KickKind, o: Partial<ActionRequest>, n = 200): ShotStats {
  let on = 0, miss = 0, got = 0, sp = 0, spin = 0;
  const p = base.players[SHOOTER]!;
  for (let k = 0; k < n; k++) {
    const s = cloneState(base);
    expect(startShot(s, SHOOTER, kind, req({ power: 0.7, dirX: p.fx, dirZ: p.fz, ...o }), NULL_SINK)).toBe(1);
    rngSeed(s.rng, 1000 + k * 7919);
    const out = createKickLaunch();
    expect(solveShot(s, SHOOTER, out)).toBe(1);
    const c = crossing(s, out);
    if (c) {
      got++;
      miss += Math.abs(c.z - out.tz);
      if (Math.abs(c.z) < GOAL_HALF_WIDTH && c.y < GOAL_HEIGHT) on++;
    }
    sp += Math.sqrt(out.vx * out.vx + out.vy * out.vy + out.vz * out.vz);
    spin += Math.abs(out.sy);
  }
  return { onTarget: on / n, placement: got > 0 ? miss / got : Infinity, speed: sp / n, spin: spin / n };
}

const PASSER = 9;
const MATE = 10;

/** Team-0 passer at (x, z) facing +x with the ball 0.5 m ahead (bz = sideways offset of the ball), mate at (mx, mz). */
function passScene(x: number, z: number, mx: number, mz: number, a: Partial<PlayerAttrs>, bz = 0, fx = 1, fz = 0): SimState {
  const s = quiet(5);
  place(s, PASSER, x, z, fx, fz);
  const p = s.players[PASSER]!;
  ownBall(s, PASSER, x + p.fx * 0.45 - p.fz * bz, z + p.fz * 0.45 + p.fx * bz);
  place(s, MATE, mx, mz, -1, 0);
  setAttrs(s, PASSER, { shortPassing: 70, longPassing: 70, crossing: 70, vision: 70, curve: 70, weakFoot: 5, foot: Foot.RIGHT, ...a });
  return s;
}

// ---------------------------------------------------------------- pipeline helpers

const HUMAN = 9;

/** A human-controlled runner at (-45, 10), standing, the ball far away; stick(tick) gives the stick and sprint. */
function runTrace(a: Partial<PlayerAttrs>, ticks: number, stick: (t: number) => [number, number]): { s: SimState; speed: number[]; vx: number[]; vz: number[] } {
  const s = quiet(9, 46, [{ side: 0, slot: HUMAN }]);
  place(s, HUMAN, -45, 10, 1, 0);
  looseBall(s, 30, -30);
  setAttrs(s, HUMAN, a);
  const p = s.players[HUMAN]!;
  const speed: number[] = [], vx: number[] = [], vz: number[] = [];
  let t = 0;
  stepRun(s, ticks, (_tick, _st, out) => {
    const [mx, mz] = stick(t++);
    out[0]!.mx = Math.round(mx * AXIS_SCALE);
    out[0]!.mz = Math.round(mz * AXIS_SCALE);
    out[0]!.buttons = Btn.SPRINT;
  }, () => {
    speed.push(Math.sqrt(p.vx * p.vx + p.vz * p.vz));
    vx.push(p.vx);
    vz.push(p.vz);
    return false;
  });
  return { s, speed, vx, vz };
}

/** Sprint dribble on the stage pipeline (locomotion -> ball -> dribble): mean ball-to-player distance, m. */
function dribbleSpread(a: Partial<PlayerAttrs>, seeds = 6): number {
  let sum = 0, n = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const s = quiet(seed, 48);
    const p = s.players[HUMAN]!;
    place(s, HUMAN, -30, 0, 1, 0);
    ownBall(s, HUMAN, -29.5, 0);
    setAttrs(s, HUMAN, { dribbling: 70, ballControl: 70, agility: 70, ...a });
    for (let t = 0; t < 150; t++) {
      p.moveMode = MoveMode.DIRECT; p.ix = 1; p.iz = 0; p.wantSprint = 1;
      s.tick++;
      EV.begin(s.tick);
      locomotionTick(s, EV);
      ballTick(s, EV);
      dribbleTick(s, EV);
      if (t >= 30) { sum += Math.hypot(s.ball.x - p.x, s.ball.z - p.z); n++; }
    }
  }
  return sum / n;
}

const P1 = 9; // home carrier
const P2 = 20; // away challenger

/** Two humans (no input) for one-on-one duels, everyone else parked; fouls off so outcomes are the challenge's. */
function duelScene(seed: number): SimState {
  const s = quiet(seed, -46, [{ side: 0, slot: P1 }, { side: 1, slot: P2 }]);
  s.config.fouls = 0;
  for (const k of [P1, P2]) setAttrs(s, k, { dribbling: 65, ballControl: 65, strength: 65, standingTackle: 65, slidingTackle: 65, interceptions: 65, agility: 65 });
  return s;
}

/** Share of n trials in which P2's challenge `kind` (started on base) wins the ball (TACKLE event c = 1). */
function challengeWins(base: SimState, kind: ActionKind, ticks: number, n: number): number {
  let won = 0;
  for (let k = 0; k < n; k++) {
    const s = trial(base, k);
    expect(startTackle(s, P2, kind, -1, EV)).toBe(1);
    const ev = stepRun(s, ticks);
    if (ev.some((e) => e.type === EventType.TACKLE && e.a === P2 && e.c === 1)) won++;
  }
  return won / n;
}

const KEEPER = 0; // team 0 defends x = -52.5
const xAt = (u: number): number => u - HALF_LENGTH;

/** Keeper scene: everyone else parked up the pitch, the keeper on his ideal spot for a ball at (u, z). */
function keeperScene(seed: number, gk: Partial<PlayerAttrs>, u: number, z: number): SimState {
  const s = quiet(seed, 20);
  setAttrs(s, KEEPER, { gkDiving: 70, gkHandling: 70, gkReflexes: 70, gkPositioning: 70, gkKicking: 70, height: 188, ...gk });
  looseBall(s, xAt(u), z);
  const spot = { x: 0, z: 0 };
  idealKeeperSpot(s, 0, spot);
  place(s, KEEPER, spot.x, spot.z, 1, 0);
  return s;
}

/** Fire a ground shot from (u, z) to cross the goal line at tz at speed sp (team-1 shooter 20); run to an outcome. */
function keeperShot(s: SimState, u: number, z: number, tz: number, sp: number): { saved: boolean; caught: boolean; goal: boolean } {
  const dx = -HALF_LENGTH - xAt(u), dz = tz - z;
  const l = Math.sqrt(dx * dx + dz * dz);
  looseBall(s, xAt(u), z, (dx / l) * sp, (dz / l) * sp);
  const sh = 20;
  place(s, sh, xAt(u) + 1.2, z, -1, 0);
  const b = s.ball;
  b.lastTouch = sh; b.lastTouchTeam = 1; b.lastTouchTick = s.tick; b.touchedTick = s.tick;
  b.lastKickBy = sh; b.lastKickTeam = 1; b.lastKickKind = KickKind.SHOT_NORMAL; b.lastKickTick = s.tick;
  b.shotBy = sh; b.shotTick = s.tick; b.shotOnTarget = Math.abs(tz) < GOAL_HALF_WIDTH ? 1 : 0;
  let saved = false, caught = false, goal = false;
  stepRun(s, 150, undefined, (st) => {
    if (st.ball.heldBy === KEEPER) { saved = true; caught = true; return true; }
    if (st.ball.lastTouch === KEEPER) saved = true;
    if (st.ball.x < -HALF_LENGTH - BALL_RADIUS) { goal = !saved && Math.abs(st.ball.z) < GOAL_HALF_WIDTH; return true; }
    return saved && st.tick > 0 && st.ball.lastTouch === KEEPER && (st.ball.vx > 0 || st.ball.owner === KEEPER);
  });
  return { saved, caught, goal };
}

/** A fixed batch of on-target ground shots: [u, z, tz, speed]. */
function shotBatch(us: number[], speeds: number[], tzs: number[]): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  let i = 0;
  for (const u of us) for (const sp of speeds) for (const tz of tzs) out.push([u, ((i++ % 5) - 2) * 3, tz, sp]);
  return out;
}

function saveRate(gk: Partial<PlayerAttrs>, batch: [number, number, number, number][]): { saves: number; catches: number; n: number } {
  let saves = 0, catches = 0, n = 0;
  for (let i = 0; i < batch.length; i++) {
    const [u, z, tz, sp] = batch[i]!;
    const s = keeperScene(100 + i, gk, u, z);
    const r = keeperShot(s, u, z, tz, sp);
    if (!r.saved && !r.goal) continue; // wide after all (should not happen for these shots)
    n++;
    if (r.saved) saves++;
    if (r.caught) catches++;
  }
  return { saves: saves / n, catches: saves > 0 ? catches / saves : 0, n };
}

const ATT = 9;
const DEF = 13;
const SOL = createLaunchSolution();

/** Attacker (team 0) and defender shoulder to shoulder under a high ball dropping between them (SIM-12 duel). */
function aerialDuelWins(att: Partial<PlayerAttrs>, def: Partial<PlayerAttrs>, n = 30): number {
  const base: Partial<PlayerAttrs> = { heading: 65, strength: 65, height: 182, agility: 60 };
  let wins = 0;
  for (let seed = 1; seed <= n; seed++) {
    const s = quiet(seed, -40);
    place(s, ATT, 42, -0.45, 1, 0);
    place(s, DEF, 42, 0.45, -1, 0);
    setAttrs(s, ATT, { ...base, ...att });
    setAttrs(s, DEF, { ...base, ...def });
    const crosser = 7;
    place(s, crosser, 29.2, 0, 1, 0);
    solveLaunchSpin(42.6 - 30, 0, 0.9, BALL_RADIUS, 0, 0, SOL);
    looseBall(s, 30, 0);
    const b = s.ball;
    b.vx = SOL.vx; b.vy = SOL.vy; b.vz = SOL.vz; b.grounded = 0;
    b.lastTouch = crosser; b.lastTouchTeam = 0; b.lastTouchTick = s.tick; b.touchedTick = s.tick;
    b.lastKickBy = crosser; b.lastKickTeam = 0; b.lastKickKind = KickKind.CROSS; b.lastKickTick = s.tick;
    b.passTarget = ATT; b.passX = 42.6; b.passZ = 0;
    let winner = -1;
    stepRun(s, 200, undefined, (_st, ev) => {
      const a = ev.find((e) => e.type === EventType.AERIAL);
      if (a) winner = a.a;
      return winner >= 0;
    });
    if (winner === ATT) wins++;
  }
  return wins / n;
}

// ================================================================ the micro-tests

describe('DAT-05 attributes: movement', () => {
  it('sprintSpeed: top sprint speed (pipeline, human sprint 3 s)', () => {
    const peak = (v: number): number => Math.max(...runTrace({ sprintSpeed: v, acceleration: 70 }, 180, () => [1, 0]).speed);
    moved('sprintSpeed', 'pipeline', 'peak sprint speed, m/s', peak(LO), peak(HI), 1, 0.6);
  });

  it('acceleration: ticks from standstill to 6 m/s (pipeline, human sprint)', () => {
    const t6 = (v: number): number => runTrace({ acceleration: v, sprintSpeed: 70 }, 150, () => [1, 0]).speed.findIndex((x) => x >= 6);
    const lo = t6(LO), hi = t6(HI);
    expect(lo).toBeGreaterThan(0);
    moved('acceleration', 'pipeline', 'ticks from standstill to 6 m/s', lo, hi, -1, 4);
  });

  it('agility: ticks to turn a sprint through 75 degrees (pipeline, stick +x then +z)', () => {
    const turn = (v: number): number => {
      const r = runTrace({ agility: v, sprintSpeed: 70, acceleration: 70 }, 150, (t) => (t < 75 ? [1, 0] : [0, 1]));
      for (let t = 75; t < r.vx.length; t++) if (Math.atan2(r.vz[t]!, r.vx[t]!) >= (75 * Math.PI) / 180) return t - 75;
      return 75;
    };
    moved('agility', 'pipeline', 'ticks to turn a sprint 75 deg', turn(LO), turn(HI), -1, 2);
  });

  it('stamina: condition drained by sprinting (pipeline, 6 s sprint, per minute)', () => {
    // The drain rate is constant while he sprints, so the 6 s drain scales to a minute of sprinting.
    const drain = (v: number): number => (1 - runTrace({ stamina: v, sprintSpeed: 70, acceleration: 70 }, 360, () => [1, 0]).s.players[HUMAN]!.stamina) * 10;
    moved('stamina', 'pipeline', 'condition (0..1) drained per minute of sprinting', drain(LO), drain(HI), -1, 0.1);
  });
});

describe('DAT-05 attributes: ball control', () => {
  it('ballControl: clean first-touch chance on a 20 m/s pass (model: firstTouch touchQuality)', () => {
    const clean = (v: number): number => {
      const s = quiet(2);
      place(s, HUMAN, 0, 0, -1, 0);
      setAttrs(s, HUMAN, { ballControl: v });
      looseBall(s, 3, 0, -20, 0);
      const q = touchQuality(s, HUMAN, 20, BALL_RADIUS);
      return Math.min(1, Math.max(0, (q - TOUCH_L.qHeavyLo) / (TOUCH_L.qCleanHi - TOUCH_L.qHeavyLo)));
    };
    moved('ballControl', 'model', 'clean first-touch chance, 20 m/s pass', clean(LO), clean(HI), 1, 0.15);
  });

  it('dribbling: standing tackles against the carrier win less often (pipeline); closer sprint-dribble touches', () => {
    const rate = (v: number): number => {
      const s = duelScene(7);
      place(s, P1, 0, 0, 1, 0);
      ownBall(s, P1, 0.6, 0);
      place(s, P2, 1.9, 0, -1, 0);
      setAttrs(s, P1, { dribbling: v });
      return challengeWins(s, ActionKind.STAND_TACKLE, T_TACKLE.standWindup + T_TACKLE.standContactTicks + 2, 120);
    };
    moved('dribbling', 'pipeline', 'standing-tackle win rate against him', rate(LO), rate(HI), -1, 0.08);
    // Secondary (small by design: dribbling is 45% of the touch quality and the touch lead moves +-10%): touches stay closer.
    moved('dribbling', 'pipeline', 'mean ball-to-feet distance, sprint dribble, m', dribbleSpread({ dribbling: LO }), dribbleSpread({ dribbling: HI }), -1, 0.005);
  });

  it('skillMoves: skill moves the player may start (model: startSkill star gate)', () => {
    const count = (stars: number): number => {
      let n = 0;
      for (let k = SkillMove.BALL_ROLL; k <= SkillMove.KNOCK_ON; k++) {
        if (k === SkillMove.FAKE_SHOT) continue; // a cancel of a wind-up, not started from the stick
        const s = quiet(4);
        place(s, HUMAN, 0, 0, 1, 0);
        ownBall(s, HUMAN, 0.4, 0);
        setAttrs(s, HUMAN, { skillMoves: stars });
        if (startSkill(s, HUMAN, k as SkillMove, 1, 0, NULL_SINK) === 1) n++;
      }
      return n;
    };
    moved('skillMoves', 'model', 'skill moves available (of 7 stick moves)', count(1), count(5), 1, 2, ['1 star', '5 stars']);
  });
});

describe('DAT-05 attributes: passing', () => {
  const ground = (s: SimState): number => startPass(s, PASSER, KickKind.GROUND_PASS, req({ power: 0.5, dirX: 1, targetSlot: MATE }), NULL_SINK);

  it('shortPassing: launch-direction spread of a 15 m ground pass (solver)', () => {
    const spread = (v: number): number => launchSpread(passScene(-10, 0, 5, 0, { shortPassing: v }), PASSER, ground, solveGroundPass);
    moved('shortPassing', 'solver', 'direction spread, 15 m ground pass, deg', spread(LO), spread(HI), -1, 0.5);
  });

  it('longPassing: launch-direction spread of a 38 m lob (solver)', () => {
    const lob = (s: SimState): number => startLob(s, PASSER, KickKind.LOB_PASS, req({ power: 0.7, dirX: 1, targetSlot: MATE }), NULL_SINK);
    const spread = (v: number): number => launchSpread(passScene(-25, 0, 13, 0, { longPassing: v }), PASSER, lob, solveLob);
    moved('longPassing', 'solver', 'direction spread, 38 m lob, deg', spread(LO), spread(HI), -1, 0.5);
  });

  it('crossing: launch-direction spread of a cross from the right wing (solver)', () => {
    const cross = (s: SimState): number => startLob(s, PASSER, KickKind.CROSS, req({ power: 0.6, dirX: 0.3, dirZ: -1, targetSlot: MATE }), NULL_SINK);
    const spread = (v: number): number => launchSpread(passScene(38, 26, 45, 0, { crossing: v }, 0, 0.3, -1), PASSER, cross, solveCross);
    moved('crossing', 'solver', 'direction spread, cross from the wing, deg', spread(LO), spread(HI), -1, 0.5);
  });

  it('vision: launch-direction spread of a through ball (solver)', () => {
    const through = (s: SimState): number => startThrough(s, PASSER, KickKind.THROUGH_GROUND, req({ power: 0.6, dirX: 1, targetSlot: MATE }), NULL_SINK);
    const spread = (v: number): number => launchSpread(passScene(-10, 0, 5, 6, { vision: v }), PASSER, through, solveThrough);
    moved('vision', 'solver', 'direction spread, through ball, deg', spread(LO), spread(HI), -1, 0.3);
  });

  it('weakFoot: spread of a 15 m pass struck with the weaker foot (solver, ball on his left, right-footed)', () => {
    const spread = (wf: number): number => launchSpread(passScene(-10, 0, 5, 0, { weakFoot: wf }, -0.3), PASSER, ground, solveGroundPass);
    moved('weakFoot', 'solver', 'direction spread, weak-foot 15 m pass, deg', spread(1), spread(5), -1, 0.3, ['1', '5']);
  });

  it('foot: the preferred foot decides which side is the weak one (solver, ball on his left, weakFoot 1)', () => {
    const spread = (foot: Foot): number => launchSpread(passScene(-10, 0, 5, 0, { weakFoot: 1, foot }, -0.3), PASSER, ground, solveGroundPass);
    moved('foot', 'solver', 'direction spread, 15 m pass off the left side, deg', spread(Foot.RIGHT), spread(Foot.LEFT), -1, 0.3, ['right-footed', 'left-footed']);
  });
});

describe('DAT-05 attributes: shooting', () => {
  it('finishing: placement error at the goal line of a 14 m shot (solver + ball flight)', () => {
    const r = (v: number): ShotStats => shots(shotScene(GX - 14, 2, { finishing: v }), KickKind.SHOT_NORMAL, {});
    const lo = r(LO), hi = r(HI);
    moved('finishing', 'solver', 'placement error at the line, 14 m shot, m', lo.placement, hi.placement, -1, 0.1);
    moved('finishing', 'solver', 'on-target rate, 14 m shot', lo.onTarget, hi.onTarget, 1, 0);
  });

  it('longShots: on-target rate and placement error of a 28 m shot (solver + ball flight)', () => {
    const r = (v: number): ShotStats => shots(shotScene(GX - 28, 3, { longShots: v }), KickKind.SHOT_NORMAL, {});
    const lo = r(LO), hi = r(HI);
    moved('longShots', 'solver', 'on-target rate, 28 m shot', lo.onTarget, hi.onTarget, 1, 0.08);
    moved('longShots', 'solver', 'placement error at the line, 28 m shot, m', lo.placement, hi.placement, -1, 0.2);
  });

  it('shotPower: launch speed of a shot at 80% power (solver)', () => {
    const speed = (v: number): number => shots(shotScene(GX - 20, 0, { shotPower: v }), KickKind.SHOT_NORMAL, { power: 0.8 }, 20).speed;
    // Weak by tuning (shot.ts shotPowerMulMin 0.92: shotPower 1 -> 92% of the speed): see docs/ATTRIBUTE_AUDIT.md.
    moved('shotPower', 'solver', 'launch speed at 80% power, m/s', speed(LO), speed(HI), 1, 0.8);
  });

  it('curve: side spin of a curled finesse shot (solver)', () => {
    const spin = (v: number): number => shots(shotScene(GX - 18, 6, { curve: v }), KickKind.SHOT_FINESSE, { curve: 1 }, 20).spin;
    moved('curve', 'solver', 'side spin of a curled finesse shot, rad/s', spin(LO), spin(HI), 1, 0.5);
  });

  it('composure: placement error of a 14 m shot with a defender pressing at 1 m (solver + ball flight)', () => {
    const err = (v: number): number => {
      const s = shotScene(GX - 14, 2, { composure: v });
      place(s, 15, GX - 13.2, 2.6, -1, 0);
      return shots(s, KickKind.SHOT_NORMAL, {}).placement;
    };
    moved('composure', 'solver', 'placement error at the line, 14 m shot under pressure, m', err(LO), err(HI), -1, 0.05);
  });
});

describe('DAT-05 attributes: aerial and physical duels', () => {
  it('heading: aerial duel win rate against a 65-heading defender (pipeline, SIM-12 duel)', () => {
    moved('heading', 'pipeline', 'aerial duel win rate', aerialDuelWins({ heading: LO }, {}), aerialDuelWins({ heading: HI }, {}), 1, 0.2);
  });

  it('height: aerial duel win rate against a 182 cm defender (pipeline, SIM-12 duel)', () => {
    moved('height', 'pipeline', 'aerial duel win rate', aerialDuelWins({ height: 170 }, {}), aerialDuelWins({ height: 195 }, {}), 1, 0.2, ['170 cm', '195 cm']);
  });

  it('strength: shoulder-challenge win rate against a 65-strength carrier (pipeline)', () => {
    const rate = (v: number): number => {
      const s = duelScene(15);
      place(s, P1, 0, 0, 1, 0, 6);
      ownBall(s, P1, 0.9, 0);
      place(s, P2, 0, 0.8, 1, 0, 6);
      setAttrs(s, P2, { strength: v });
      return challengeWins(s, ActionKind.SHOULDER, TACKLE_L.shoulderWindup + TACKLE_L.shoulderContactTicks + 1, 100);
    };
    moved('strength', 'pipeline', 'shoulder-challenge win rate', rate(LO), rate(HI), 1, 0.15);
  });

  it('standingTackle: standing-tackle win rate against a 65-dribbling carrier (pipeline)', () => {
    const rate = (v: number): number => {
      const s = duelScene(7);
      place(s, P1, 0, 0, 1, 0);
      ownBall(s, P1, 0.6, 0);
      place(s, P2, 1.9, 0, -1, 0);
      setAttrs(s, P2, { standingTackle: v });
      return challengeWins(s, ActionKind.STAND_TACKLE, T_TACKLE.standWindup + T_TACKLE.standContactTicks + 2, 120);
    };
    moved('standingTackle', 'pipeline', 'standing-tackle win rate', rate(LO), rate(HI), 1, 0.1);
  });

  it('slidingTackle: sliding-tackle win rate against a 65-dribbling carrier (pipeline)', () => {
    const rate = (v: number): number => {
      const s = duelScene(8);
      place(s, P1, 0, 0, 1, 0);
      ownBall(s, P1, 0.6, 0);
      place(s, P2, 2.4, 1.2, -1, -0.5);
      setAttrs(s, P2, { slidingTackle: v });
      return challengeWins(s, ActionKind.SLIDE_TACKLE, T_TACKLE.slideWindup + T_TACKLE.slideContactTicks + 2, 120);
    };
    moved('slidingTackle', 'pipeline', 'sliding-tackle win rate', rate(LO), rate(HI), 1, 0.1);
  });

  it('interceptions: share of 14 m/s passes cut out by a defender 0.75 m off the line (pipeline)', () => {
    const rate = (v: number): number => {
      const base = duelScene(21);
      place(base, P1, -9, 0, 1, 0);
      place(base, P2, 0, 0.75, -1, 0);
      setAttrs(base, P2, { interceptions: v });
      looseBall(base, -8, 0, 14, 0);
      const b = base.ball;
      b.lastTouch = P1; b.lastTouchTeam = 0; b.lastTouchTick = base.tick; b.touchedTick = base.tick;
      b.lastKickBy = P1; b.lastKickTeam = 0; b.lastKickKind = KickKind.GROUND_PASS; b.lastKickTick = base.tick;
      let cut = 0;
      const n = 100;
      for (let k = 0; k < n; k++) {
        const s = trial(base, k);
        let hit = false;
        stepRun(s, 60, undefined, (st) => (hit = st.ball.lastTouch === P2));
        if (hit) cut++;
      }
      return cut / n;
    };
    moved('interceptions', 'pipeline', 'passes cut out by a defender 0.75 m off the line', rate(LO), rate(HI), 1, 0.1);
  });
});

describe('DAT-05 attributes: goalkeeping', () => {
  it('gkDiving: save rate on hard ground shots into the corners from 16-22 m (pipeline)', () => {
    const batch = shotBatch([16, 19, 22], [26, 29, 32], [-3.45, -3.0, 3.0, 3.45]);
    const rate = (v: number): number => saveRate({ gkDiving: v }, batch).saves;
    moved('gkDiving', 'pipeline', 'save rate, hard corner shots 16-22 m', rate(LO), rate(HI), 1, 0.1);
  });

  it('gkReflexes: save rate on close-range ground shots from 8-11 m (pipeline)', () => {
    const batch = shotBatch([8, 9.5, 11], [18, 22, 26], [-2.2, -1.2, 1.2, 2.2]);
    const rate = (v: number): number => saveRate({ gkReflexes: v }, batch).saves;
    moved('gkReflexes', 'pipeline', 'save rate, close-range shots 8-11 m', rate(LO), rate(HI), 1, 0.1);
  });

  it('gkHandling: share of saves held (caught, not parried) on shots near the keeper (pipeline)', () => {
    const batch = shotBatch([14, 18], [18, 22, 26], [-1.4, -0.6, 0.6, 1.4]);
    const rate = (v: number): number => saveRate({ gkHandling: v }, batch).catches;
    moved('gkHandling', 'pipeline', 'share of saves held', rate(LO), rate(HI), 1, 0.1);
  });

  it('gkPositioning: distance of his chosen spot from the ideal one, ball 18 m out wide (model: idealKeeperSpot)', () => {
    const off = (v: number): number => {
      let sum = 0, n = 0;
      for (const [u, z] of [[18, 10], [16, -12], [25, 5], [12, -6]] as const) {
        const s = keeperScene(1, { gkPositioning: v }, u, z);
        const a = { x: 0, z: 0 }, best = { x: 0, z: 0 };
        idealKeeperSpot(s, 0, a);
        setAttrs(s, KEEPER, { gkPositioning: 99 });
        idealKeeperSpot(s, 0, best);
        sum += Math.hypot(a.x - best.x, a.z - best.z);
        n++;
      }
      return sum / n;
    };
    moved('gkPositioning', 'model', 'distance from the ideal spot, m', off(LO), off(HI), -1, 0.15);
  });

  it('gkKicking: launch-direction spread of a drop kick (solver)', () => {
    const base = keeperScene(11, {}, 30, 0);
    place(base, KEEPER, xAt(6), 0, 1, 0);
    ownBall(base, KEEPER, xAt(6) + 0.4, 0);
    base.ball.owner = -1;
    base.ball.lastTouch = 15; base.ball.lastTouchTeam = 1; base.ball.lastKickBy = 15; base.ball.lastKickTeam = 1;
    base.ball.lastKickKind = KickKind.SHOT_NORMAL;
    keeperPickUp(base, KEEPER, NULL_SINK);
    expect(base.ball.heldBy).toBe(KEEPER);
    base.tick += 30;
    const kick = (s: SimState): number => startKeeperRelease(s, KEEPER, KickKind.GK_DROP_KICK, req({ power: 0.7, dirX: 1 }), NULL_SINK);
    const spread = (v: number): number => {
      const s = cloneState(base);
      setAttrs(s, KEEPER, { gkKicking: v });
      return launchSpread(s, KEEPER, kick, solveKeeperRelease);
    };
    moved('gkKicking', 'solver', 'direction spread, drop kick, deg', spread(LO), spread(HI), -1, 0.5);
  });
});
