/**
 * RUL-05: free kicks and walls. Wall size by distance and angle, wall placement (9.15 m kept, near post covered,
 * goal-line wall), setup (spot clamped, best taker), "choose the taker" (SPRINT cycling), attacking input (stick aim,
 * curl / dip, SHOOT / finesse / chip / driven, PASS, LOB, THROUGH, touch swipes and taps), defending input (wall jump,
 * wall charge, move wall), blocking (shot / curl / chip paths clear or hit the wall exactly as the ball physics says;
 * a jumping wall blocks higher balls and lets low ones under it), the dotted preview (equals the actual flight), the
 * Default at the human timeout and the CPU fallback, correct team, and the glitch-list lines on free kicks.
 *
 * The real pipeline runs (step.ts, RUL-01 machine, RUL-11 restart flow, SIM-15/16 resolver and switching, SIM-08 KICK
 * handler, locomotion, bodies, SIM-01/02 ball physics). Mocked:
 *  - SIM-11 startShot / solveShot, SIM-09 startLob / solveLob / solveCross, SIM-10 startThrough / solveThrough (still
 *    stubs): every request is recorded; when `K.accept` is set the starter begins a KICK action (SIM-08's handler
 *    plays it at contact through the registry's KICK_SOLVERS) and the solver returns a deterministic launch
 *    (`launchFor`: toward the target, elevation / speed by kind or K overrides, curl spin from the request curve);
 *  - SIM-08 startPass: recorded, then the real starter runs;
 *  - team AI, CPU brains and contacts: no-ops (only the rules and the wall decide; nothing else touches the ball).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BALL_RADIUS, GOAL_AREA_DEPTH, GOAL_HALF_WIDTH, HALF_LENGTH, HALF_WIDTH, PLAYERS_PER_TEAM, RESTART_DISTANCE,
  teamFirstSlot,
} from '../../src/contracts/constants';
import { ActionKind, GestureKind, KickKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EventType, type EventSink, type SimEvent } from '../../src/contracts/events';
import { AXIS_SCALE, Btn, GESTURE_POS_SCALE, GestureFlag, UNIT_SCALE, createInputFrame, type InputFrame } from '../../src/contracts/input';
import { RosterStatus, createBallState, type SimState } from '../../src/contracts/state';
import { ReqFlag, createBallPrediction, type ActionRequest, type KickLaunch } from '../../src/contracts/systems';
import { T_RULES } from '../../src/contracts/tuning';
import { beginAction, isFree } from '../../src/sim/actions/dispatch';
import { curlSpinY, launchSpin, predictBall } from '../../src/sim/ball/flight';
import { cloneState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { INVARIANT_NAMES, createInvariantChecker } from '../../src/sim/debug/invariants';
import { bodyRadiusOf } from '../../src/sim/players/bodies';
import { awardRestart, isLegalRestartPosition } from '../../src/sim/rules/restart';
import {
  LOCAL_TUNING as LT, WallMode, freeKickDefault, freeKickSetup, freeKickWallCount, goalMouthAngle, isWallMember,
  previewFlight, wallCoverSide, wallIndexOf, wallLift, wallSlot,
} from '../../src/sim/rules/freekick';
import { step } from '../../src/sim/step';
import { makeScenario, type ScenarioHuman, type ScenarioInputs } from '../harness/scenario';

// ---------------------------------------------------------------- mocks

interface Call {
  fn: string;
  slot: number;
  kind: number;
  flags: number;
  power: number;
  charging: number;
  dirX: number;
  dirZ: number;
  hasTarget: number;
  targetX: number;
  targetZ: number;
  targetSlot: number;
  curve: number;
  tick: number;
  phase: number;
}

const K = vi.hoisted(() => ({
  accept: true,
  calls: [] as unknown[],
  /** Launch elevation override, rad (< 0: by kind). */
  elev: -1,
  /** Launch speed override, m/s (<= 0: by kind and power). */
  speed: -1,
  /** Curl spin per unit of request curve, rad/s. */
  curlSpin: 9,
}));

const WINDUP = 8;
const SPIN = { x: 0, y: 0, z: 0 };

function calls(): Call[] {
  return K.calls as Call[];
}

function record(fn: string, s: SimState, slot: number, kind: number, req: ActionRequest): void {
  calls().push({
    fn, slot, kind, flags: req.flags, power: req.power, charging: req.charging, dirX: req.dirX, dirZ: req.dirZ,
    hasTarget: req.hasTarget, targetX: req.targetX, targetZ: req.targetZ, targetSlot: req.targetSlot, curve: req.curve,
    tick: s.tick, phase: s.match.phase,
  });
}

function isShotKind(k: number): boolean {
  return k === KickKind.FREE_KICK_SHOT || (k >= KickKind.SHOT_NORMAL && k <= KickKind.SHOT_LOW_DRIVEN);
}

/** The deterministic launch of the mocked kick modules (used by the mocked solvers and by the physics model). */
function launchFor(bx: number, bz: number, ux0: number, uz0: number, kind: number, power: number, curve: number,
  out: KickLaunch): void {
  const l = Math.hypot(ux0, uz0);
  const ux = l > 1e-9 ? ux0 / l : 1, uz = l > 1e-9 ? uz0 / l : 0;
  const shot = isShotKind(kind);
  const lob = (kind >= KickKind.LOB_PASS && kind <= KickKind.LOW_CROSS) || kind === KickKind.THROUGH_LOBBED;
  const elev = K.elev >= 0 ? K.elev : kind === KickKind.SHOT_CHIP ? 0.55 : shot ? 0.12 : lob ? 0.6 : 0;
  const sp = K.speed > 0 ? K.speed : shot ? 18 + 10 * power : lob ? 17 : 10 + 8 * power;
  out.vx = ux * sp * Math.cos(elev);
  out.vy = sp * Math.sin(elev);
  out.vz = uz * sp * Math.cos(elev);
  launchSpin(ux, uz, curlSpinY(curve * K.curlSpin), 0, SPIN);
  out.sx = SPIN.x; out.sy = SPIN.y; out.sz = SPIN.z;
  out.kind = kind;
  out.target = -1;
  out.tx = bx + ux * 20;
  out.tz = bz + uz * 20;
  out.onTarget = 0;
}

function mockStart(fn: string, s: SimState, slot: number, kind: number, req: ActionRequest): number {
  record(fn, s, slot, kind, req);
  if (!K.accept) return 0;
  const p = s.players[slot]!;
  if (!isFree(p)) return 0;
  beginAction(p, ActionKind.KICK, WINDUP + 20, WINDUP);
  p.actKick = kind;
  p.actPower = Math.min(1, Math.max(0, req.power));
  p.actCharging = req.charging === 1 ? 1 : 0;
  const dl = Math.hypot(req.dirX, req.dirZ);
  p.actDirX = dl > 1e-9 ? req.dirX / dl : 0;
  p.actDirZ = dl > 1e-9 ? req.dirZ / dl : 0;
  p.actCurve = req.curve;
  p.actSlot = -1;
  p.actB = req.hasTarget === 1 ? 1 : 0;
  p.actX = req.targetX;
  p.actZ = req.targetZ;
  p.actA = req.flags & 0xff;
  return 1;
}

function mockSolve(s: SimState, slot: number, out: KickLaunch): number {
  const p = s.players[slot]!;
  const b = s.ball;
  let ux = p.actDirX, uz = p.actDirZ;
  if (p.actB === 1) { ux = p.actX - b.x; uz = p.actZ - b.z; }
  launchFor(b.x, b.z, ux, uz, p.actKick, p.actPower, p.actCurve, out);
  return 1;
}

vi.mock('../../src/sim/kicks/shot', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/kicks/shot')>()),
  startShot: (s: SimState, slot: number, kind: number, req: ActionRequest) => mockStart('shot', s, slot, kind, req),
  solveShot: (s: SimState, slot: number, out: KickLaunch) => mockSolve(s, slot, out),
}));
vi.mock('../../src/sim/kicks/lob', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/kicks/lob')>()),
  startLob: (s: SimState, slot: number, kind: number, req: ActionRequest) => mockStart('lob', s, slot, kind, req),
  solveLob: (s: SimState, slot: number, out: KickLaunch) => mockSolve(s, slot, out),
  solveCross: (s: SimState, slot: number, out: KickLaunch) => mockSolve(s, slot, out),
}));
vi.mock('../../src/sim/kicks/through', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/kicks/through')>()),
  startThrough: (s: SimState, slot: number, kind: number, req: ActionRequest) => mockStart('through', s, slot, kind, req),
  solveThrough: (s: SimState, slot: number, out: KickLaunch) => mockSolve(s, slot, out),
}));
vi.mock('../../src/sim/kicks/pass', async (orig) => {
  const mod = await orig<typeof import('../../src/sim/kicks/pass')>();
  return {
    ...mod,
    startPass: (s: SimState, slot: number, kind: number, req: ActionRequest, ev: EventSink) => {
      record('pass', s, slot, kind, req);
      return mod.startPass(s, slot, kind, req, ev);
    },
  };
});
vi.mock('../../src/ai/index', async (orig) => ({
  ...(await orig<typeof import('../../src/ai/index')>()),
  teamAiTick: () => { /* none */ },
}));
vi.mock('../../src/ai/cpu/index', async (orig) => ({
  ...(await orig<typeof import('../../src/ai/cpu/index')>()),
  cpuThink: () => { /* none */ },
}));
vi.mock('../../src/sim/contacts', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/contacts')>()),
  contactsTick: () => { /* none */ },
}));

beforeEach(() => {
  K.accept = true;
  K.calls.length = 0;
  K.elev = -1;
  K.speed = -1;
  K.curlSpin = 9;
});

// ---------------------------------------------------------------- helpers

/** Every invariant except the loose-ball chaser (team AI is mocked out). */
const CHECKS = INVARIANT_NAMES.filter((n) => n !== 'chaser');
const H2: ScenarioHuman[] = [{ side: 0 }, { side: 1 }];
const GX = HALF_LENGTH; // team 0 attacks +x in the first half

function copyEvent(e: Readonly<SimEvent>): SimEvent {
  return { type: e.type, tick: e.tick, a: e.a, b: e.b, c: e.c, d: e.d, x: e.x, y: e.y, z: e.z };
}

/** Step the real pipeline with every invariant checked; returns the events. Stops early when `until` holds. */
function run(s: SimState, n: number, inputs?: ScenarioInputs, until?: (s: SimState) => boolean): SimEvent[] {
  const events = createEventBuffer();
  const frames: InputFrame[] = [createInputFrame(), createInputFrame()];
  const checker = createInvariantChecker(CHECKS);
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    for (const f of frames) Object.assign(f, createInputFrame());
    if (inputs) inputs(s.tick + 1, s, frames);
    step(s, frames, events);
    for (let k = 0; k < events.count; k++) all.push(copyEvent(events.get(k)));
    const fails = checker.check(s, events);
    if (fails.length > 0) throw new Error(`invariant failure at t=${s.tick}:\n  ${fails.join('\n  ')}`);
    if (until && until(s)) break;
  }
  return all;
}

/** A free kick for `team` at (x, z) awarded in open play. */
function award(team: number, x: number, z: number, humans: ScenarioHuman[] | number = H2, seed = 11): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans, seed });
  const ev = createEventBuffer();
  ev.begin(s.tick);
  awardRestart(s, RestartKind.FREE_KICK, team, x, z, ev);
  expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
  expect(s.match.restart.kind).toBe(RestartKind.FREE_KICK);
  return s;
}

/** Run to ready (players legal, wall snapped onto its slots). */
function toReady(s: SimState): void {
  run(s, T_RULES.restartSetupTicks + 5, undefined, (st) => st.match.restart.ready === 1);
  expect(s.match.restart.ready).toBe(1);
}

/** Ready free kick for `team` at (x, z). */
function readyFK(team: number, x: number, z: number, humans: ScenarioHuman[] | number = H2, seed = 11): SimState {
  const s = award(team, x, z, humans, seed);
  toReady(s);
  return s;
}

function members(s: SimState): number[] {
  const r = s.match.restart;
  return r.wall.slice(0, r.wallCount);
}

function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

/** Distance from (px, pz) to the segment (ax, az) - (bx, bz). */
function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/** Controller index of the human on `side` (H2: 0 = home, 1 = away). */
function press(side: number, f: Partial<InputFrame>): ScenarioInputs {
  return (_t, _s, out) => { Object.assign(out[side]!, f); };
}

/** Run one tick with these frame fields for human `side` (and nothing for the other). */
function tick1(s: SimState, side: number, f: Partial<InputFrame>): SimEvent[] {
  return run(s, 1, press(side, f));
}

function kicks(evs: readonly SimEvent[]): SimEvent[] {
  return evs.filter((e) => e.type === EventType.KICK);
}

function deflections(s: SimState, evs: readonly SimEvent[]): SimEvent[] {
  return evs.filter((e) => e.type === EventType.KICK && e.b === KickKind.DEFLECTION && isWallMember(s, e.a));
}

/** Unit stick toward (x, z) from the ball, quantised. */
function stickTo(s: SimState, x: number, z: number): { mx: number; mz: number } {
  const r = s.match.restart;
  const dx = x - r.x, dz = z - r.z;
  const d = Math.hypot(dx, dz);
  return { mx: Math.round((dx / d) * AXIS_SCALE), mz: Math.round((dz / d) * AXIS_SCALE) };
}

/** Explicit power p (0..1) in a frame. */
function pw(p: number): number {
  return Math.round(p * UNIT_SCALE);
}

/** Shoot now (SHOOT with explicit power so nothing charges), then run until the ball has passed the wall. */
function shootAndFly(s: SimState, power = 0.8, extra: Partial<InputFrame> = {}, maxTicks = 90): SimEvent[] {
  const r = s.match.restart;
  const evs = tick1(s, r.team, { buttons: Btn.SHOOT, power: pw(power), ...extra });
  const D = RESTART_DISTANCE + 4;
  evs.push(...run(s, maxTicks, undefined, (st) => dist(st.ball.x, st.ball.z, r.x, r.z) > D || st.ball.lastKickKind === KickKind.DEFLECTION));
  return evs;
}

// ---------------------------------------------------------------- wall size

describe('RUL-05 wall size by distance and angle', () => {
  it('central free kicks: 5 men close in, fewer further out, none beyond 35 m', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const ds = [12, 17, 19, 22, 25, 28, 31, 34, 34.9, 35.5, 40, 60];
    const counts = ds.map((u) => freeKickWallCount(s, 0, GX - u, 0));
    expect(counts[0]).toBe(5);
    expect(counts[1]).toBe(5);
    expect(counts[7]).toBe(2);
    expect(counts[9]).toBe(0);
    expect(counts[10]).toBe(0);
    expect(counts[11]).toBe(0);
    for (let i = 1; i < counts.length; i++) expect(counts[i]!, `at ${ds[i]} m`).toBeLessThanOrEqual(counts[i - 1]!);
    for (let i = 0; i <= 8; i++) {
      expect(counts[i]!).toBeGreaterThanOrEqual(2);
      expect(counts[i]!).toBeLessThanOrEqual(5);
    }
    // Every size from 5 down to 2 is used along the way.
    expect(new Set(counts.slice(0, 9))).toEqual(new Set([5, 4, 3, 2]));
  });

  it('an angle shrinks the wall (never grows it), tight angles get none; symmetric and the same for both teams', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    expect(s.teams[0]!.dir).toBe(1);
    expect(s.teams[1]!.dir).toBe(-1);
    for (const u of [8, 14, 18, 22, 26, 30]) {
      let prev = 99;
      for (const z of [0, 4, 8, 12, 16, 20, 25, 30]) {
        const n = freeKickWallCount(s, 0, GX - u, z);
        expect(n, `u=${u} z=${z}`).toBeLessThanOrEqual(prev);
        prev = n;
        expect(freeKickWallCount(s, 0, GX - u, -z)).toBe(n);
        expect(freeKickWallCount(s, 1, -(GX - u), z)).toBe(n);
        expect(n === 0 || (n >= 2 && n <= 5)).toBe(true);
        if (n > 0) expect(Math.hypot(u, z)).toBeLessThanOrEqual(LT.wallMaxDist);
      }
    }
    // 20 m central: 5; same distance at a sharp angle: fewer.
    expect(freeKickWallCount(s, 0, GX - 20, 0)).toBe(5);
    expect(freeKickWallCount(s, 0, GX - 12, 16)).toBeLessThan(5);
    // Near the goal line out wide (crossing position): no wall.
    expect(goalMouthAngle(s, 0, GX - 2, 25)).toBeLessThan(LT.wallMinAngle);
    expect(freeKickWallCount(s, 0, GX - 2, 25)).toBe(0);
    expect(freeKickWallCount(s, 0, GX - 5, 30)).toBe(0);
    // A free kick in the own half, or beyond the goal line: none.
    expect(freeKickWallCount(s, 0, -10, 0)).toBe(0);
    expect(freeKickWallCount(s, 0, GX + 1, 0)).toBe(0);
    expect(freeKickWallCount(s, 0, Number.NaN, 0)).toBe(0);
  });

  it('setup forms the wall from active outfield defenders (never the keeper), sized by freeKickWallCount', () => {
    for (const [x, z] of [[GX - 18, 0], [GX - 24, -6], [GX - 29, 10], [GX - 33, 2]] as const) {
      const s = award(0, x, z);
      const r = s.match.restart;
      const want = freeKickWallCount(s, 0, r.x, r.z);
      expect(want).toBeGreaterThan(0);
      expect(r.wallCount).toBe(want);
      const ms = members(s);
      expect(new Set(ms).size).toBe(ms.length);
      for (const w of ms) {
        const p = s.players[w]!;
        expect(p.team).toBe(1);
        expect(p.isKeeper).toBe(0);
        expect(p.active).toBe(1);
      }
      for (let i = r.wallCount; i < r.wall.length; i++) expect(r.wall[i]).toBe(-1);
    }
    // No wall far out.
    const far = award(0, -5, 10);
    expect(far.match.restart.wallCount).toBe(0);
    expect(far.match.restart.wall.every((w) => w === -1)).toBe(true);
  });
});

// ---------------------------------------------------------------- wall placement

describe('RUL-05 wall placement', () => {
  it('9.15 m kept: members stand at least 9.15 m from the ball, side by side without overlapping', () => {
    for (const [x, z] of [[GX - 18, 0], [GX - 20, 6], [GX - 24, -9], [GX - 30, 12], [GX - 26, -18]] as const) {
      const s = readyFK(0, x, z);
      const r = s.match.restart;
      const ms = members(s);
      expect(ms.length).toBeGreaterThanOrEqual(2);
      for (let i = 0; i < ms.length; i++) {
        const p = s.players[ms[i]!]!;
        const d = dist(p.x, p.z, r.x, r.z);
        expect(d, `member ${i} at (${x}, ${z})`).toBeGreaterThanOrEqual(RESTART_DISTANCE);
        expect(d).toBeLessThan(RESTART_DISTANCE + 1);
        expect(isLegalRestartPosition(s, ms[i]!)).toBe(true);
        wallSlot(s, i, PT);
        expect(dist(p.x, p.z, PT.x, PT.z)).toBeLessThan(1e-9);
        if (i > 0) {
          const q = s.players[ms[i - 1]!]!;
          const gap = dist(p.x, p.z, q.x, q.z);
          expect(gap).toBeGreaterThanOrEqual(bodyRadiusOf(s, ms[i]!) + bodyRadiusOf(s, ms[i - 1]!));
          // ... but close enough that the ball cannot pass between two neighbours.
          expect(gap / 2).toBeLessThan(LT.wallBlockRadius + BALL_RADIUS);
        }
        // Facing the ball.
        const fx = r.x - p.x, fz = r.z - p.z, fl = Math.hypot(fx, fz);
        expect(p.fx * fx / fl + p.fz * fz / fl).toBeGreaterThan(0.99);
      }
      // Between the ball and the goal.
      const c = { x: 0, z: 0 };
      for (const w of ms) { c.x += s.players[w]!.x / ms.length; c.z += s.players[w]!.z / ms.length; }
      expect(c.x).toBeGreaterThan(r.x);
    }
  });

  it('an angled wall covers the near post and extends inward; a central one is centred on the ball-goal line', () => {
    for (const zs of [1, -1]) {
      const s = readyFK(0, GX - 22, zs * 9);
      const r = s.match.restart;
      const ms = members(s);
      // The line from the ball to the near post runs through the wall.
      const near = Math.min(...ms.map((w) => segDist(s.players[w]!.x, s.players[w]!.z, r.x, r.z, GX, zs * GOAL_HALF_WIDTH)));
      expect(near).toBeLessThan(LT.wallBlockRadius);
      // The wall's centre lies inside that line (toward the goal centre), so it covers the near post side.
      const cz = ms.reduce((a, w) => a + s.players[w]!.z, 0) / ms.length;
      const cx = ms.reduce((a, w) => a + s.players[w]!.x, 0) / ms.length;
      const zLine = r.z + ((cx - r.x) / (GX - r.x)) * (zs * GOAL_HALF_WIDTH - r.z);
      expect(zs * (cz - zLine)).toBeLessThan(0);
      expect(wallCoverSide(s)).toBe(zs);
    }
    const c = readyFK(0, GX - 20, 0);
    const r = c.match.restart;
    const ms = members(c);
    const cz = ms.reduce((a, w) => a + c.players[w]!.z, 0) / ms.length;
    expect(Math.abs(cz)).toBeLessThan(0.05);
    expect(Math.abs(r.wallZ)).toBeLessThan(1e-9);
    expect(wallCoverSide(c)).toBe(0);
  });

  it('a free kick closer than 9.15 m to the goal line puts the wall on the goal line between the posts', () => {
    const s = readyFK(0, GX - 7, -1.5);
    const r = s.match.restart;
    expect(r.x).toBeCloseTo(GX - 7, 9);
    expect(r.wallCount).toBe(5);
    for (const w of members(s)) {
      const p = s.players[w]!;
      expect(p.x).toBeGreaterThan(GX - 0.7);
      expect(p.x).toBeLessThanOrEqual(GX);
      expect(Math.abs(p.z)).toBeLessThanOrEqual(GOAL_HALF_WIDTH);
      expect(isLegalRestartPosition(s, w)).toBe(true);
    }
  });

  it('members hold their slots and keep facing the ball while the kick is pending', () => {
    const s = readyFK(0, GX - 21, 4);
    const ms = members(s);
    const before = ms.map((w) => [s.players[w]!.x, s.players[w]!.z]);
    run(s, 180);
    expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
    ms.forEach((w, i) => {
      const p = s.players[w]!;
      expect(dist(p.x, p.z, before[i]![0]!, before[i]![1]!)).toBeLessThan(0.02);
    });
  });
});

const PT = { x: 0, z: 0 };

/** A red card the way RUL-09 applies one (roster SENT_OFF, off the pitch, out of control). */
function sendOff(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  const t = s.teams[p.team]!;
  p.active = 0;
  p.act = ActionKind.NONE;
  if (p.ctrl >= 0) { s.ctrl[p.ctrl]!.slot = -1; p.ctrl = -1; }
  p.x = 0; p.z = -42;
  t.roster[p.rosterIdx] = RosterStatus.SENT_OFF;
  t.onPitch--;
}

// ---------------------------------------------------------------- setup

describe('RUL-05 setup', () => {
  function setupAt(team: number, x: number, z: number): SimState {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: H2 });
    const r = s.match.restart;
    r.kind = RestartKind.FREE_KICK;
    r.team = team;
    r.x = x;
    r.z = z;
    s.ball.owner = 5;
    s.ball.vx = 7;
    const ev = createEventBuffer();
    ev.begin(s.tick);
    freeKickSetup(s, ev);
    return s;
  }

  it('the ball rests on the foul spot, clamped inside the pitch and out of the attacked goal area', () => {
    let s = setupAt(0, 20, -3);
    expect([s.match.restart.x, s.match.restart.z]).toEqual([20, -3]);
    expect([s.ball.x, s.ball.y, s.ball.z, s.ball.vx, s.ball.owner]).toEqual([20, BALL_RADIUS, -3, 0, -1]);
    s = setupAt(0, 60, 40);
    expect(s.match.restart.x).toBeCloseTo(HALF_LENGTH - LT.spotInset, 9);
    expect(s.match.restart.z).toBeCloseTo(HALF_WIDTH - LT.spotInset, 9);
    // Attackers inside the opponents' goal area: onto its 5.5 m line.
    s = setupAt(0, GX - 2, 1);
    expect(s.match.restart.x).toBeCloseTo(GX - GOAL_AREA_DEPTH, 9);
    s = setupAt(1, -(GX - 2), -1);
    expect(s.match.restart.x).toBeCloseTo(-(GX - GOAL_AREA_DEPTH), 9);
    // In their own goal area: stays.
    s = setupAt(1, GX - 2, 1);
    expect(s.match.restart.x).toBeCloseTo(GX - 2, 9);
    expect(s.ball.x).toBeCloseTo(GX - 2, 9);
    // Hostile input.
    s = setupAt(0, Number.NaN, Number.POSITIVE_INFINITY);
    expect(Number.isFinite(s.match.restart.x) && Number.isFinite(s.match.restart.z)).toBe(true);
  });

  it('the taker is the best free-kick taker: curve + shot power + long shots with a wall, passing otherwise', () => {
    const shooting = award(0, GX - 22, 3);
    expect(shooting.match.restart.wallCount).toBeGreaterThan(0);
    const passing = award(0, -10, 5);
    expect(passing.match.restart.wallCount).toBe(0);
    for (const [s, score] of [
      [shooting, (a: SimState['attrs'][number]) => a.curve + a.shotPower + a.longShots],
      [passing, (a: SimState['attrs'][number]) => a.shortPassing + a.longPassing + a.crossing],
    ] as const) {
      let best = -1, bestS = -1;
      for (let i = 0; i < PLAYERS_PER_TEAM; i++) {
        const p = s.players[i]!;
        if (p.isKeeper === 1 || p.active !== 1) continue;
        const v = score(s.attrs[i]!);
        if (v > bestS) { bestS = v; best = i; }
      }
      expect(s.match.restart.taker).toBe(best);
    }
    // The two criteria pick different men in this squad (so the test means something).
    expect(shooting.match.restart.taker).not.toBe(passing.match.restart.taker);
  });

  it('the aim starts on the goal centre with a wall, and toward goal without one', () => {
    const s = award(0, GX - 25, -7);
    expect([s.match.restart.aimX, s.match.restart.aimZ]).toEqual([GX, 0]);
    expect(s.match.restart.aimCurve).toBe(0);
    const far = award(0, -20, 10);
    const r = far.match.restart;
    expect(dist(r.aimX, r.aimZ, r.x, r.z)).toBeCloseTo(LT.aimPassDist, 6);
    expect(r.aimX).toBeGreaterThan(r.x);
  });
});

// ---------------------------------------------------------------- choose the taker

describe('RUL-05 choose the taker (SPRINT)', () => {
  it('SPRINT cycles through the three best takers (wrapping); new and old taker swap places', () => {
    const s = readyFK(0, GX - 23, -2);
    const r = s.match.restart;
    const ranked = Array.from({ length: PLAYERS_PER_TEAM }, (_, i) => i)
      .filter((i) => s.players[i]!.isKeeper === 0)
      .sort((a, b) => {
        const A = s.attrs[a]!, B = s.attrs[b]!;
        return (B.curve + B.shotPower + B.longShots) - (A.curve + A.shotPower + A.longShots) || a - b;
      })
      .slice(0, LT.takerChoices);
    expect(r.taker).toBe(ranked[0]);
    expect(s.ctrl[0]!.slot).toBe(ranked[0]);
    const seq: number[] = [];
    for (let k = 0; k < 4; k++) {
      const old = r.taker;
      const next = ranked[(k + 1) % ranked.length]!;
      const nx = s.players[next]!.x, nz = s.players[next]!.z;
      tick1(s, 0, { buttons: Btn.SPRINT });
      seq.push(r.taker);
      expect(r.taker).toBe(next);
      // The old taker went where the new one stood; the new one is behind the ball, waiting.
      expect(dist(s.players[old]!.x, s.players[old]!.z, nx, nz)).toBeLessThan(0.3);
      expect(dist(s.players[next]!.x, s.players[next]!.z, r.x, r.z)).toBeLessThan(1.0);
      expect(s.players[next]!.act).toBe(ActionKind.SET_PIECE);
      run(s, 2); // SIM-16 hands the controller to the new taker
      expect(s.ctrl[0]!.slot).toBe(next);
    }
    expect(seq).toEqual([ranked[1], ranked[2], ranked[0], ranked[1]]);
    expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
    expect(calls()).toHaveLength(0);
    // The new taker then takes the kick.
    const evs = shootAndFly(s);
    expect(kicks(evs)[0]!.a).toBe(ranked[1]);
  });

  it('a held SPRINT cycles once (edges only); the defending side cannot change the taker', () => {
    const s = readyFK(0, GX - 23, -2);
    const r = s.match.restart;
    const t0 = r.taker;
    run(s, 1, press(0, { buttons: Btn.SPRINT }));
    const t1 = r.taker;
    expect(t1).not.toBe(t0);
    run(s, 30, press(0, { buttons: Btn.SPRINT }));
    expect(r.taker).toBe(t1);
    run(s, 1);
    run(s, 1, press(1, { buttons: Btn.SPRINT }));
    expect(r.taker).toBe(t1);
  });
});

// ---------------------------------------------------------------- attacking input

describe('RUL-05 attacking input', () => {
  it('SHOOT / R1+SHOOT / L1+SHOOT / L1+R1+SHOOT: free-kick shot, finesse, chip, driven, at the aim with the curl', () => {
    K.accept = false;
    const base = readyFK(0, GX - 24, 5);
    const r0 = base.match.restart;
    const taker = r0.taker;
    const cases: [number, number, number][] = [
      [Btn.SHOOT, KickKind.FREE_KICK_SHOT, 0],
      [Btn.SHOOT | Btn.MOD_R, KickKind.SHOT_FINESSE, 0],
      [Btn.SHOOT | Btn.MOD_L, KickKind.SHOT_CHIP, 0],
      [Btn.SHOOT | Btn.MOD_L | Btn.MOD_R, KickKind.FREE_KICK_SHOT, ReqFlag.DRIVEN],
    ];
    for (const [buttons, kind, extra] of cases) {
      const s = cloneState(base);
      s.match.restart.aimCurve = -0.6;
      calls().length = 0;
      tick1(s, 0, { buttons });
      expect(calls()).toHaveLength(1);
      const c = calls()[0]!;
      expect(c.fn).toBe('shot');
      expect(c.slot).toBe(taker);
      expect(c.kind).toBe(kind);
      expect(c.flags).toBe(ReqFlag.SET_PIECE | extra);
      expect(c.hasTarget).toBe(1);
      expect([c.targetX, c.targetZ]).toEqual([GX, 0]);
      const d = Math.hypot(GX - r0.x, -r0.z);
      expect(c.dirX).toBeCloseTo((GX - r0.x) / d, 9);
      expect(c.dirZ).toBeCloseTo(-r0.z / d, 9);
      expect(c.curve).toBeCloseTo(-0.6, 9);
      expect(c.charging).toBe(1); // power from the hold (SIM-15 power bar)
      expect(c.phase).toBe(MatchPhase.FREE_KICK);
    }
    // Explicit power in the frame: no charging.
    const s = cloneState(base);
    calls().length = 0;
    tick1(s, 0, { buttons: Btn.SHOOT, power: pw(0.5) });
    expect(calls()[0]!.charging).toBe(0);
    expect(calls()[0]!.power).toBeCloseTo(pw(0.5) / UNIT_SCALE, 9);
  });

  it('the left stick aims at the goal mouth or a pitch point; the right stick sets curl and dip', () => {
    K.accept = false;
    const s = readyFK(0, GX - 25, 0);
    const r = s.match.restart;
    // Toward the far side of the left post (z = -3): on the goal line.
    tick1(s, 0, stickTo(s, GX, -3));
    expect(r.aimX).toBe(GX);
    expect(r.aimZ).toBeCloseTo(-3, 0);
    // Outside the post but within the slack (curlers): still on the goal line.
    tick1(s, 0, stickTo(s, GX, GOAL_HALF_WIDTH + 1.5));
    expect(r.aimX).toBe(GX);
    expect(r.aimZ).toBeGreaterThan(GOAL_HALF_WIDTH);
    // Sideways: a pitch point aimPassDist away.
    tick1(s, 0, { mx: 0, mz: AXIS_SCALE });
    expect(r.aimX).toBeCloseTo(r.x, 6);
    expect(r.aimZ).toBeCloseTo(r.z + LT.aimPassDist, 6);
    // A small stick deflection keeps the aim.
    tick1(s, 0, { mx: 20, mz: -20 });
    expect(r.aimZ).toBeCloseTo(r.z + LT.aimPassDist, 6);
    // Back on goal; right stick across the aim for 0.5 s: curl += curlRate * 0.5 (right = +z kicking toward +x).
    tick1(s, 0, stickTo(s, GX, 0));
    expect([r.aimX, r.aimZ]).toEqual([GX, 0]);
    run(s, 30, press(0, { az: AXIS_SCALE }));
    expect(r.aimCurve).toBeCloseTo(LT.curlRate * 0.5, 6);
    run(s, 60, press(0, { az: -AXIS_SCALE }));
    expect(r.aimCurve).toBeCloseTo(-LT.curlRate * 0.5, 6);
    run(s, 120, press(0, { az: -AXIS_SCALE }));
    expect(r.aimCurve).toBe(-1);
    run(s, 10); // released: kept
    expect(r.aimCurve).toBe(-1);
    // Along the aim: dip (topspin) up, back: float.
    run(s, 30, press(0, { ax: AXIS_SCALE }));
    expect(r.side).toBeCloseTo(LT.dipRate * 0.5, 6);
    run(s, 30, press(0, { ax: -AXIS_SCALE }));
    expect(r.side).toBeCloseTo(0, 6);
    // frame.curve sets the curl directly (CPU, touch).
    tick1(s, 0, { curve: 64 });
    expect(r.aimCurve).toBeCloseTo(64 / AXIS_SCALE, 9);
    // The shot carries the curl.
    tick1(s, 0, { buttons: Btn.SHOOT });
    expect(calls()[0]!.curve).toBeCloseTo(64 / AXIS_SCALE, 9);
  });

  it('PASS plays a ground pass along the aim (R1 driven), LOB a cross into the box or a lob, THROUGH a through ball', () => {
    K.accept = false;
    const base = readyFK(0, GX - 26, 3);
    const r0 = base.match.restart;
    const one = (buttons: number, aim?: [number, number]): Call => {
      const s = cloneState(base);
      if (aim) { s.match.restart.aimX = aim[0]; s.match.restart.aimZ = aim[1]; }
      calls().length = 0;
      tick1(s, 0, { buttons });
      expect(calls()).toHaveLength(1);
      return calls()[0]!;
    };
    let c = one(Btn.PASS);
    expect([c.fn, c.kind, c.flags]).toEqual(['pass', KickKind.GROUND_PASS, ReqFlag.SET_PIECE]);
    expect(c.dirX).toBeGreaterThan(0.98);
    c = one(Btn.PASS | Btn.MOD_R);
    expect(c.kind).toBe(KickKind.DRIVEN_PASS);
    c = one(Btn.PASS | Btn.MOD_L);
    expect(c.flags).toBe(ReqFlag.SET_PIECE | ReqFlag.PASS_AND_GO);
    // LOB with the aim on goal: a cross landing in the box on the aim line.
    c = one(Btn.LOB);
    expect([c.fn, c.kind, c.hasTarget]).toEqual(['lob', KickKind.CROSS, 1]);
    expect(c.targetX).toBeCloseTo(GX - LT.lobLandDepth, 9);
    expect(Math.abs(c.targetZ)).toBeLessThan(Math.abs(r0.z));
    c = one(Btn.LOB | Btn.MOD_L);
    expect([c.kind, c.flags]).toEqual([KickKind.CROSS, ReqFlag.SET_PIECE | ReqFlag.LOFTED]);
    c = one(Btn.LOB | Btn.MOD_L | Btn.MOD_R);
    expect(c.kind).toBe(KickKind.LOW_CROSS);
    // LOB to a pitch point outside the box: a lob pass along the aim.
    c = one(Btn.LOB, [r0.x - 5, r0.z + 19]);
    expect([c.fn, c.kind, c.hasTarget]).toEqual(['lob', KickKind.LOB_PASS, 0]);
    c = one(Btn.LOB | Btn.MOD_L, [r0.x - 5, r0.z + 19]);
    expect(c.kind).toBe(KickKind.HIGH_LOB);
    c = one(Btn.THROUGH);
    expect([c.fn, c.kind]).toEqual(['through', KickKind.THROUGH_GROUND]);
    c = one(Btn.THROUGH | Btn.MOD_L);
    expect(c.kind).toBe(KickKind.THROUGH_LOBBED);
  });

  it('a swipe from the ball toward goal is a shot: power and height from the swipe speed, curl from its curve', () => {
    K.accept = false;
    const base = readyFK(0, GX - 22, -4);
    const r0 = base.match.restart;
    const d = Math.hypot(GX - r0.x, 1 - r0.z);
    const gdx = Math.round(((GX - r0.x) / d) * AXIS_SCALE), gdz = Math.round(((1 - r0.z) / d) * AXIS_SCALE);
    for (const [gesture, extra] of [[GestureKind.SWIPE, 0], [GestureKind.CURVED_SWIPE, 0], [GestureKind.BACK_FORTH_SWIPE, ReqFlag.DRIVEN]] as const) {
      const s = cloneState(base);
      calls().length = 0;
      tick1(s, 0, { gesture, gFlags: GestureFlag.FROM_BALL, gdx, gdz, gPower: 100, gCurve: -70 });
      expect(calls()).toHaveLength(1);
      const c = calls()[0]!;
      expect([c.fn, c.kind]).toEqual(['shot', KickKind.FREE_KICK_SHOT]);
      expect(c.flags).toBe(ReqFlag.SET_PIECE | ReqFlag.GESTURE | extra);
      expect(c.power).toBeCloseTo(100 / UNIT_SCALE, 9);
      expect(c.charging).toBe(0);
      expect(c.curve).toBeCloseTo(-70 / AXIS_SCALE, 9);
      expect(c.hasTarget).toBe(1);
      expect(c.targetX).toBe(GX);
      expect(c.targetZ).toBeCloseTo(1, 0);
      expect(s.match.restart.aimCurve).toBeCloseTo(-70 / AXIS_SCALE, 9);
    }
    // Not from the ball: ignored.
    const s = cloneState(base);
    calls().length = 0;
    tick1(s, 0, { gesture: GestureKind.SWIPE, gFlags: 0, gdx, gdz, gPower: 100 });
    expect(calls()).toHaveLength(0);
  });

  it('wide free kicks by touch: a swipe toward the box is a cross (height by speed), away a pass; taps pass or chip', () => {
    K.accept = false;
    const base = readyFK(0, GX - 12, 28); // wide, crossing range, too tight for a wall
    expect(base.match.restart.wallCount).toBe(0);
    const r0 = base.match.restart;
    const one = (f: Partial<InputFrame>): Call => {
      const s = cloneState(base);
      calls().length = 0;
      tick1(s, 0, f);
      expect(calls()).toHaveLength(1);
      return calls()[0]!;
    };
    const sw = { gesture: GestureKind.SWIPE, gFlags: GestureFlag.FROM_BALL, gdx: 90, gdz: -90 };
    let c = one({ ...sw, gPower: 10 });
    expect(c.kind).toBe(KickKind.GROUND_CROSS);
    c = one({ ...sw, gPower: 40 });
    expect(c.kind).toBe(KickKind.LOW_CROSS);
    c = one({ ...sw, gPower: 80 });
    expect([c.kind, c.flags & ReqFlag.LOFTED]).toEqual([KickKind.CROSS, 0]);
    c = one({ ...sw, gPower: 120 });
    expect([c.kind, c.flags & ReqFlag.LOFTED]).toEqual([KickKind.CROSS, ReqFlag.LOFTED]);
    expect(c.hasTarget).toBe(1);
    expect(GX - c.targetX).toBeLessThanOrEqual(16.5);
    // Swipe backwards: a pass along it.
    c = one({ gesture: GestureKind.SWIPE, gFlags: GestureFlag.FROM_BALL, gdx: -AXIS_SCALE, gdz: 0, gPower: 20 });
    expect([c.fn, c.kind]).toEqual(['pass', KickKind.GROUND_PASS]);
    c = one({ gesture: GestureKind.SWIPE, gFlags: GestureFlag.FROM_BALL, gdx: -AXIS_SCALE, gdz: 0, gPower: 90 });
    expect([c.fn, c.kind]).toEqual(['lob', KickKind.LOB_PASS]);
    // Tap a teammate nearby (outside the box): a ground pass to him; a double tap: a lob.
    let mate = -1;
    for (let i = 1; i < PLAYERS_PER_TEAM; i++) {
      const p = base.players[i]!;
      const d = dist(p.x, p.z, r0.x, r0.z);
      const nearBox = GX - p.x <= 16.5 + LT.crossAreaExtra && Math.abs(p.z) <= 20.16;
      if (i !== r0.taker && p.isKeeper === 0 && d > LT.tapMinDist && d < LT.tapGroundMax && !nearBox) { mate = i; break; }
    }
    if (mate < 0) {
      // Put a teammate there (legal: own team, outside the box).
      mate = r0.taker === 6 ? 7 : 6;
      base.players[mate]!.x = r0.x - 12;
      base.players[mate]!.z = r0.z - 6;
    }
    expect(mate).toBeGreaterThanOrEqual(0);
    c = one({ gesture: GestureKind.TAP, gSlot: mate });
    expect([c.fn, c.kind, c.targetSlot]).toEqual(['pass', KickKind.GROUND_PASS, mate]);
    c = one({ gesture: GestureKind.DOUBLE_TAP, gSlot: mate });
    expect([c.fn, c.kind, c.targetSlot]).toEqual(['lob', KickKind.LOB_PASS, mate]);
    // Tap a spot in the box: a cross there.
    c = one({ gesture: GestureKind.TAP, gx: (GX - 8) * GESTURE_POS_SCALE, gz: 2 * GESTURE_POS_SCALE });
    expect([c.fn, c.kind, c.targetX, c.targetZ]).toEqual(['lob', KickKind.CROSS, GX - 8, 2]);
    // Tap on the goal mouth: a chip at goal.
    c = one({ gesture: GestureKind.TAP, gx: GX * GESTURE_POS_SCALE, gz: 10, gFlags: GestureFlag.ON_GOAL });
    expect([c.fn, c.kind, c.targetX]).toEqual(['shot', KickKind.SHOT_CHIP, GX]);
    // A tap on the taker himself (the ball) does nothing.
    const s = cloneState(base);
    calls().length = 0;
    tick1(s, 0, { gesture: GestureKind.TAP, gSlot: r0.taker });
    expect(calls()).toHaveLength(0);
  });

  it('correct team: the free kick is taken by the awarded team; the defending side cannot kick it', () => {
    K.accept = false;
    const s = readyFK(1, -(GX - 22), 2);
    const r = s.match.restart;
    expect(r.team).toBe(1);
    expect(s.players[r.taker]!.team).toBe(1);
    for (const w of members(s)) expect(s.players[w]!.team).toBe(0);
    // Team 1 attacks -x: the wall stands between the ball and x = -52.5.
    expect(r.wallX).toBeLessThan(r.x);
    expect([r.aimX, r.aimZ]).toEqual([-GX, 0]);
    // Home (defending) presses every kick button: nothing.
    for (const b of [Btn.SHOOT, Btn.PASS, Btn.LOB]) { tick1(s, 0, { buttons: b }); run(s, 1); }
    expect(calls()).toHaveLength(0);
    // Away (taking) shoots.
    tick1(s, 1, { buttons: Btn.SHOOT });
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.slot).toBe(r.taker);
    expect(calls()[0]!.targetX).toBe(-GX);
  });

  it('a kick by the taker ends the free kick: phase IN_PLAY, the ball launched from the spot', () => {
    const s = readyFK(0, GX - 30, -6);
    const r = s.match.restart;
    const evs = tick1(s, 0, { buttons: Btn.PASS, power: pw(0.6) });
    evs.push(...run(s, WINDUP + 3));
    const k = kicks(evs);
    expect(k).toHaveLength(1);
    expect(k[0]!.a).toBe(r.taker);
    expect(k[0]!.x).toBeCloseTo(r.x, 6);
    expect(k[0]!.z).toBeCloseTo(r.z, 6);
    expect(r.taken).toBe(1);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
  });
});

// ---------------------------------------------------------------- defending input

describe('RUL-05 defending input', () => {
  it('THROUGH: the whole wall jumps (~0.5 s in the air, ~0.35 m), then lands back in its slots', () => {
    const s = readyFK(0, GX - 20, 2);
    const ms = members(s);
    const evs = tick1(s, 1, { buttons: Btn.THROUGH });
    const walls = evs.filter((e) => e.type === EventType.WALL);
    expect(walls.map((e) => e.a).sort()).toEqual([...ms].sort());
    expect(walls.every((e) => e.b === WallMode.JUMP)).toBe(true);
    for (const w of ms) {
      expect(s.players[w]!.act).toBe(ActionKind.WALL_JUMP);
      expect(s.players[w]!.actA).toBe(WallMode.JUMP);
    }
    let peak = 0, air = 0;
    for (let i = 0; i < 60; i++) {
      run(s, 1);
      const l = wallLift(s, ms[0]!);
      peak = Math.max(peak, l);
      if (l > 0) air++;
      expect(s.players[ms[0]!]!.actB).toBeCloseTo(l, 12);
    }
    expect(air / 60).toBeGreaterThan(0.45);
    expect(air / 60).toBeLessThan(0.6);
    expect(peak).toBeGreaterThan(0.3);
    expect(peak).toBeLessThan(0.4);
    for (let i = 0; i < ms.length; i++) {
      const p = s.players[ms[i]!]!;
      expect(p.act).toBe(ActionKind.NONE);
      wallSlot(s, i, PT);
      expect(dist(p.x, p.z, PT.x, PT.z)).toBeLessThan(0.05);
    }
    expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
    // The taking side's THROUGH is a through ball, not a jump.
    K.accept = false;
    tick1(s, 0, { buttons: Btn.THROUGH });
    expect(ms.every((w) => s.players[w]!.act === ActionKind.NONE)).toBe(true);
  });

  it('PASS: the wall is armed and charges at the ball when it is struck (stopping short of it)', () => {
    const s = readyFK(0, GX - 22, -3);
    const r = s.match.restart;
    const ms = members(s);
    tick1(s, 1, { buttons: Btn.PASS });
    for (const w of ms) expect([s.players[w]!.act, s.players[w]!.actA]).toEqual([ActionKind.WALL_JUMP, WallMode.ARMED]);
    // Armed indefinitely while the taker waits (no overrun: the checker runs every tick).
    run(s, 300);
    for (const w of ms) expect(s.players[w]!.actA).toBe(WallMode.ARMED);
    const d0 = ms.map((w) => dist(s.players[w]!.x, s.players[w]!.z, r.x, r.z));
    // A pass sideways (does not hit them): the wall charges.
    s.match.restart.aimX = r.x;
    s.match.restart.aimZ = r.z - 20;
    const evs = tick1(s, 0, { buttons: Btn.PASS, power: pw(0.7) });
    evs.push(...run(s, WINDUP + 2));
    expect(kicks(evs)).toHaveLength(1);
    const charge = evs.filter((e) => e.type === EventType.WALL && e.b === WallMode.CHARGE);
    expect(charge.map((e) => e.a).sort()).toEqual([...ms].sort());
    run(s, LT.chargeTicks);
    ms.forEach((w, i) => {
      const p = s.players[w]!;
      const d = dist(p.x, p.z, r.x, r.z);
      // chargeSpeed for chargeTicks (the first tick of the charge is the kick tick).
      expect(d).toBeLessThan(d0[i]! - LT.chargeSpeed * (LT.chargeTicks - 2) / 60);
      expect(d).toBeGreaterThan(LT.chargeStopDist - 0.5);
    });
    run(s, 40);
    for (const w of ms) expect(s.players[w]!.act).toBe(ActionKind.NONE);
  });

  it('SHIELD / SPRINT move the wall sideways around the ball, 9.15 m kept, at most wallMoveMax', () => {
    const s = readyFK(0, GX - 21, 0);
    const r = s.match.restart;
    const c0 = { x: r.wallX, z: r.wallZ };
    const D = dist(c0.x, c0.z, r.x, r.z);
    // SHIELD: toward +p = (-uz, ux) = +z here (the defenders' left as they face the ball).
    run(s, 30, press(1, { buttons: Btn.SHIELD }));
    expect(dist(r.wallX, r.wallZ, r.x, r.z)).toBeCloseTo(D, 6);
    expect(r.wallZ).toBeCloseTo(D * Math.sin((LT.wallMoveSpeed * 0.5) / D), 3);
    run(s, 120, press(1, { buttons: Btn.SHIELD }));
    expect(r.wallZ).toBeCloseTo(D * Math.sin(LT.wallMoveMax / D), 3);
    run(s, 30); // members slide into the moved slots
    for (let i = 0; i < r.wallCount; i++) {
      const p = s.players[r.wall[i]!]!;
      wallSlot(s, i, PT);
      expect(dist(p.x, p.z, PT.x, PT.z)).toBeLessThan(0.01);
      expect(dist(p.x, p.z, r.x, r.z)).toBeGreaterThanOrEqual(RESTART_DISTANCE);
    }
    // SPRINT: the other way, to the opposite limit.
    run(s, 300, press(1, { buttons: Btn.SPRINT }));
    expect(r.wallZ).toBeCloseTo(-D * Math.sin(LT.wallMoveMax / D), 3);
    // Both at once: no move.
    const z = r.wallZ;
    run(s, 20, press(1, { buttons: Btn.SHIELD | Btn.SPRINT }));
    expect(r.wallZ).toBe(z);
    // The attacking side's SHIELD does not move it.
    run(s, 20, press(0, { buttons: Btn.SHIELD }));
    expect(r.wallZ).toBe(z);
  });
});

// ---------------------------------------------------------------- blocking

/** Ball and member heights of the physics model. */
const H_M = 1.8;
const PRED = createBallPrediction();
const LAUNCH: KickLaunch = {
  vx: 0, vy: 0, vz: 0, sx: 0, sy: 0, sz: 0, kind: KickKind.NONE, target: -1, tx: 0, tz: 0, onTarget: 0,
};

/**
 * Physics model of the wall: the predicted flight (SIM-01 predictBall from the mocked launch) against every member's
 * body cylinder (radius wallBlockRadius + ball radius, from his feet + lift to his head + ball radius). 'hit' if some
 * point of the flight is clearly inside, 'clear' if every point is clearly outside, else 'edge'.
 */
function model(s: SimState, kind: number, power: number, curve: number, lift = 0): 'hit' | 'clear' | 'edge' {
  const r = s.match.restart;
  launchFor(r.x, r.z, r.aimX - r.x, r.aimZ - r.z, kind, power, curve, LAUNCH);
  const b = createBallState();
  b.x = r.x; b.y = BALL_RADIUS; b.z = r.z;
  b.vx = LAUNCH.vx; b.vy = LAUNCH.vy; b.vz = LAUNCH.vz;
  b.sx = LAUNCH.sx; b.sy = LAUNCH.sy; b.sz = LAUNCH.sz;
  b.grounded = LAUNCH.vy > 0.5 ? 0 : 1;
  predictBall(b, 80, PRED);
  const rr = LT.wallBlockRadius + BALL_RADIUS;
  const m = 0.04;
  let edge = false;
  for (let k = 1; k < PRED.count; k++) {
    for (let j = 0; j <= 40; j++) {
      const t = j / 40;
      const x = PRED.x[k - 1]! + (PRED.x[k]! - PRED.x[k - 1]!) * t;
      const y = PRED.y[k - 1]! + (PRED.y[k]! - PRED.y[k - 1]!) * t;
      const z = PRED.z[k - 1]! + (PRED.z[k]! - PRED.z[k - 1]!) * t;
      for (const w of members(s)) {
        const p = s.players[w]!;
        const d = Math.hypot(x - p.x, z - p.z);
        const lo = lift - BALL_RADIUS, hi = lift + H_M + BALL_RADIUS;
        if (d < rr - m && y > lo + m && y < hi - m) return 'hit';
        if (!(d > rr + m || y < lo - m || y > hi + m)) edge = true;
      }
    }
    if (dist(PRED.x[k]!, PRED.z[k]!, r.x, r.z) > RESTART_DISTANCE + 3) break;
  }
  return edge ? 'edge' : 'clear';
}

describe('RUL-05 blocking: shot, curl and chip paths clear or hit the wall as physics says', () => {
  function wallScene(x: number, z: number): SimState {
    const s = readyFK(0, x, z);
    for (const w of members(s)) s.attrs[w]!.height = H_M * 100;
    return s;
  }

  it('a sweep of elevations, curls and aims: the sim deflects exactly the flights the physics model puts into the wall', () => {
    const base = wallScene(GX - 20, 0);
    expect(base.match.restart.wallCount).toBe(5);
    K.speed = 24;
    let hits = 0, clears = 0;
    for (const aimZ of [0, 2.4, -3.2]) {
      for (const curve of [-1, 0, 1]) {
        for (let e = 0; e <= 12; e++) {
          K.elev = 0.02 + e * 0.03;
          const s = cloneState(base);
          s.match.restart.aimX = GX;
          s.match.restart.aimZ = aimZ;
          s.match.restart.aimCurve = curve;
          const want = model(s, KickKind.FREE_KICK_SHOT, 0.8, curve);
          const evs = shootAndFly(s, 0.8);
          expect(kicks(evs)[0]!.b).toBe(KickKind.FREE_KICK_SHOT);
          const got = deflections(s, evs).length > 0;
          const tag = `aimZ=${aimZ} curve=${curve} elev=${K.elev.toFixed(2)} model=${want}`;
          if (want === 'hit') { expect(got, tag).toBe(true); hits++; }
          if (want === 'clear') { expect(got, tag).toBe(false); clears++; }
        }
      }
    }
    // The sweep covers both outcomes plenty of times.
    expect(hits).toBeGreaterThan(20);
    expect(clears).toBeGreaterThan(20);
  });

  it('a curler around the end of an angled wall clears it; the same shot without curl hits it', () => {
    K.speed = 25;
    K.elev = 0.1;
    K.curlSpin = 12;
    const base = wallScene(GX - 21, 8);
    expect(wallCoverSide(base)).toBe(1);
    // Aim outside the near post (over the outer end of the wall): straight it hits the wall's end.
    let s = cloneState(base);
    s.match.restart.aimX = GX;
    s.match.restart.aimZ = GOAL_HALF_WIDTH + 0.2;
    expect(model(s, KickKind.FREE_KICK_SHOT, 0.8, 0)).toBe('hit');
    expect(deflections(s, shootAndFly(s)).length).toBe(1);
    // Aimed further out and curled back in (left of travel = -z kicking toward +x: curve < 0): around the wall.
    s = cloneState(base);
    s.match.restart.aimX = GX;
    s.match.restart.aimZ = GOAL_HALF_WIDTH + 2.4;
    s.match.restart.aimCurve = -1;
    expect(model(s, KickKind.FREE_KICK_SHOT, 0.8, -1)).toBe('clear');
    const evs = shootAndFly(s);
    expect(deflections(s, evs)).toHaveLength(0);
  });

  it('a chip clears the wall; a low driven shot at it is blocked and deflected back off a member (after restart.kind is cleared)', () => {
    const base = wallScene(GX - 19, 0);
    let s = cloneState(base);
    expect(model(s, KickKind.SHOT_CHIP, 0.8, 0)).toBe('clear');
    let evs = shootAndFly(s, 0.8, { buttons: Btn.SHOOT | Btn.MOD_L });
    expect(kicks(evs)[0]!.b).toBe(KickKind.SHOT_CHIP);
    expect(deflections(s, evs)).toHaveLength(0);
    s = cloneState(base);
    expect(model(s, KickKind.FREE_KICK_SHOT, 0.9, 0)).toBe('hit');
    evs = shootAndFly(s, 0.9);
    const d = deflections(s, evs);
    expect(d).toHaveLength(1);
    // Regression: the wall blocks in the IN_PLAY that follows the strike, where RUL-01 has cleared restart.kind.
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(s.match.restart.kind).toBe(RestartKind.NONE);
    // Deflected: slower, no longer heading at goal, the member at the contact, live from the wall.
    const b = s.ball;
    expect(b.lastKickKind).toBe(KickKind.DEFLECTION);
    expect(b.lastTouch).toBe(d[0]!.a);
    expect(b.vx).toBeLessThan(5);
    expect(dist(d[0]!.x, d[0]!.z, s.players[d[0]!.a]!.x, s.players[d[0]!.a]!.z)).toBeLessThan(LT.wallBlockRadius + BALL_RADIUS + 0.01);
    expect(s.ball.shotBy).toBe(-1);
    // One deflection only, then the ball is left to play (no ping-pong between members).
    evs = run(s, 60);
    expect(deflections(s, evs).length).toBeLessThanOrEqual(1);
  });

  it('wall jump blocks: a ball that clears the standing wall is stopped by the jumping wall', () => {
    K.speed = 24;
    const base = wallScene(GX - 20, 0);
    // Elevation whose flight passes the wall line ~0.15 m above the standing members' reach.
    let lo = 0.02, hi = 0.5;
    for (let i = 0; i < 40; i++) {
      K.elev = (lo + hi) / 2;
      if (heightAtWall(base) > H_M + BALL_RADIUS + 0.15) hi = K.elev; else lo = K.elev;
    }
    K.elev = hi;
    expect(model(base, KickKind.FREE_KICK_SHOT, 0.8, 0)).toBe('clear');
    expect(model(base, KickKind.FREE_KICK_SHOT, 0.8, 0, 0.28)).toBe('hit');
    // Standing wall: over it.
    let s = cloneState(base);
    let evs = shootAndFly(s);
    expect(deflections(s, evs)).toHaveLength(0);
    const kickTick = kicks(evs)[0]!.tick;
    // The defenders jump as the ball is struck (the latest moment their input still counts).
    s = cloneState(base);
    evs = run(s, 70, (t, _st, out) => {
      if (t === base.tick + 1) { out[0]!.buttons = Btn.SHOOT; out[0]!.power = pw(0.8); }
      if (t === kickTick) out[1]!.buttons = Btn.THROUGH;
    }, (st) => st.ball.lastKickKind === KickKind.DEFLECTION);
    expect(kicks(evs)[0]!.tick).toBe(kickTick);
    const d = deflections(s, evs);
    expect(d).toHaveLength(1);
    expect(d[0]!.y).toBeGreaterThan(H_M);
    const m = s.players[d[0]!.a]!;
    expect([m.act, m.actA]).toEqual([ActionKind.WALL_JUMP, WallMode.JUMP]);
    expect(wallLift(s, d[0]!.a)).toBeGreaterThan(0.2);
    // Deflected down / back, not on toward goal.
    expect(s.ball.vx).toBeLessThan(10);
  });

  it('an early wall jump leaves no hole: members who land before the ball arrives brace and still block it', () => {
    K.speed = 24;
    K.elev = 0;
    const base = wallScene(GX - 20, 0);
    const t0 = base.tick + 1;
    const s = cloneState(base);
    let modes = '';
    // Jump at t0, shoot 30 ticks later: the wall is landing as the ball is struck.
    const evs = run(s, 120, (t, _st, out) => {
      if (t === t0) out[1]!.buttons = Btn.THROUGH;
      if (t === t0 + 30) { out[0]!.buttons = Btn.SHOOT; out[0]!.power = pw(0.8); }
    }, (st) => {
      if (st.ball.lastKickKind === KickKind.DEFLECTION) return true;
      modes = members(st).map((w) => `${st.players[w]!.act}/${st.players[w]!.actA}`).join(' ');
      return false;
    });
    expect(evs.filter((e) => e.type === EventType.WALL && e.b === WallMode.JUMP)).toHaveLength(5);
    const kick = kicks(evs)[0]!;
    expect(kick.tick).toBeGreaterThan(t0 + 30);
    const d = deflections(s, evs);
    expect(d).toHaveLength(1);
    expect(d[0]!.tick).toBeGreaterThan(t0 + LT.jumpCrouchTicks + LT.jumpAirTicks + LT.jumpLandTicks);
    // The tick before the ball reached them, all of them stood braced (landed from the jump, not out of the wall).
    const brace = `${ActionKind.WALL_JUMP}/${WallMode.BRACE}`;
    expect(modes).toBe([brace, brace, brace, brace, brace].join(' '));
  });

  it('a jumping wall lets a low shot through under it; a standing wall stops it', () => {
    K.speed = 24;
    K.elev = 0;
    const base = wallScene(GX - 20, 0);
    let s = cloneState(base);
    expect(model(s, KickKind.FREE_KICK_SHOT, 0.8, 0)).toBe('hit');
    let evs = shootAndFly(s);
    expect(deflections(s, evs)).toHaveLength(1);
    const kickTick = kicks(evs)[0]!.tick;
    s = cloneState(base);
    let minLift = Infinity;
    const D = dist(base.match.restart.wallX, base.match.restart.wallZ, base.match.restart.x, base.match.restart.z);
    evs = run(s, 70, (t, _st, out) => {
      if (t === base.tick + 1) { out[0]!.buttons = Btn.SHOOT; out[0]!.power = pw(0.8); }
      if (t === kickTick) out[1]!.buttons = Btn.THROUGH;
    }, (st) => {
      // Members' lift while the ball passes the wall line.
      const r = st.match.restart;
      const d = dist(st.ball.x, st.ball.z, r.x, r.z);
      if (Math.abs(d - D) < LT.wallBlockRadius + BALL_RADIUS) for (const w of members(st)) minLift = Math.min(minLift, wallLift(st, w));
      return false;
    });
    expect(deflections(s, evs)).toHaveLength(0);
    expect(minLift).toBeGreaterThan(2 * BALL_RADIUS);
    expect(minLift).toBeLessThan(Infinity);
    expect(s.ball.x).toBeGreaterThan(base.match.restart.x + RESTART_DISTANCE + 2);
  });
});

/** Ball centre height where the flight of the current aim (K launch) crosses the wall line, m. */
function heightAtWall(s: SimState): number {
  const r = s.match.restart;
  launchFor(r.x, r.z, r.aimX - r.x, r.aimZ - r.z, KickKind.FREE_KICK_SHOT, 0.8, 0, LAUNCH);
  const b = createBallState();
  b.x = r.x; b.y = BALL_RADIUS; b.z = r.z;
  b.vx = LAUNCH.vx; b.vy = LAUNCH.vy; b.vz = LAUNCH.vz;
  b.grounded = LAUNCH.vy > 0.5 ? 0 : 1;
  predictBall(b, 80, PRED);
  const D = dist(r.wallX, r.wallZ, r.x, r.z);
  for (let k = 1; k < PRED.count; k++) {
    const d0 = dist(PRED.x[k - 1]!, PRED.z[k - 1]!, r.x, r.z), d1 = dist(PRED.x[k]!, PRED.z[k]!, r.x, r.z);
    if (d0 <= D && d1 > D) return PRED.y[k - 1]! + ((PRED.y[k]! - PRED.y[k - 1]!) * (D - d0)) / (d1 - d0);
  }
  return 0;
}

// ---------------------------------------------------------------- preview

describe('RUL-05 preview (dotted flight for touch)', () => {
  function flightAfterKick(s: SimState, inputs: ScenarioInputs, n: number): { x: number[]; y: number[]; z: number[] } {
    const out = { x: [] as number[], y: [] as number[], z: [] as number[] };
    let kicked = false;
    run(s, 40 + n, inputs, (st) => {
      if (!kicked && st.ball.lastKickTick === st.tick && st.ball.lastKickBy === st.match.restart.taker) kicked = true;
      if (kicked) { out.x.push(st.ball.x); out.y.push(st.ball.y); out.z.push(st.ball.z); }
      return out.x.length >= n;
    });
    return out;
  }

  it('previewFlight equals the actual flight start (curled shot over the wall, pad aim)', () => {
    K.speed = 26;
    K.elev = 0.3;
    const s = readyFK(0, GX - 25, -5);
    const r = s.match.restart;
    r.aimX = GX;
    r.aimZ = 2.5;
    r.aimCurve = 0.7;
    r.aimPower = pw(0.8) / UNIT_SCALE;
    const pred = createBallPrediction();
    const h0 = hashState(s);
    expect(previewFlight(s, pred)).toBe(1);
    expect(hashState(s)).toBe(h0); // never touches the state
    expect(pred.count).toBe(LT.previewTicks);
    const n = 30;
    const t0 = s.tick + 1;
    const fl = flightAfterKick(s, (t, _st, out) => {
      if (t === t0) { out[0]!.buttons = Btn.SHOOT; out[0]!.power = pw(0.8); }
    }, n);
    expect(fl.x).toHaveLength(n);
    for (let i = 0; i < n; i++) {
      expect(fl.x[i]).toBeCloseTo(pred.x[i]!, 9);
      expect(fl.y[i]).toBeCloseTo(pred.y[i]!, 9);
      expect(fl.z[i]).toBeCloseTo(pred.z[i]!, 9);
    }
    // It curls (sideways bend) and rises.
    expect(Math.max(...fl.y)).toBeGreaterThan(1);
  });

  it('the preview of a swipe in progress equals the swipe kick (up to the wall: the preview is the free flight)', () => {
    K.speed = -1;
    K.elev = 0.25;
    const s = readyFK(0, GX - 23, 3);
    const swipe: Partial<InputFrame> = { gesture: GestureKind.CURVED_SWIPE, gFlags: GestureFlag.FROM_BALL, gdx: 125, gdz: -15, gPower: 110, gCurve: 50 };
    const f = Object.assign(createInputFrame(), swipe);
    const pred = createBallPrediction();
    expect(previewFlight(s, pred, f)).toBe(1);
    const n = 25;
    const t0 = s.tick + 1;
    const fl = flightAfterKick(s, (t, _st, out) => { if (t === t0) Object.assign(out[0]!, swipe); }, n);
    // This one hits the wall (~9 m out): identical up to there, then deflected.
    const r = s.match.restart;
    const upTo = fl.x.findIndex((x, i) => dist(x, fl.z[i]!, r.x, r.z) > RESTART_DISTANCE - 0.6);
    expect(upTo).toBeGreaterThan(15);
    expect(s.ball.lastKickKind).toBe(KickKind.DEFLECTION);
    for (let i = 0; i < upTo; i++) {
      expect(fl.x[i]).toBeCloseTo(pred.x[i]!, 9);
      expect(fl.y[i]).toBeCloseTo(pred.y[i]!, 9);
      expect(fl.z[i]).toBeCloseTo(pred.z[i]!, 9);
    }
  });

  it('the preview follows the aim, follows a charging kick, and is empty when there is no free kick to preview', () => {
    K.elev = 0.2;
    const s = readyFK(0, GX - 24, 0);
    const a = createBallPrediction(), b = createBallPrediction();
    s.match.restart.aimZ = -3;
    previewFlight(s, a);
    s.match.restart.aimZ = 3;
    previewFlight(s, b);
    expect(a.z[30]!).toBeLessThan(b.z[30]!);
    // While he charges (SHOOT held): the live action's flight.
    run(s, 3, press(0, { buttons: Btn.SHOOT }));
    expect(s.players[s.match.restart.taker]!.act).toBe(ActionKind.KICK);
    expect(previewFlight(s, a)).toBe(1);
    expect(a.count).toBe(LT.previewTicks);
    // Kicked: nothing to preview.
    run(s, 40);
    expect(s.match.restart.taken).toBe(1);
    expect(previewFlight(s, a)).toBe(0);
    expect(a.count).toBe(0);
    const open = makeScenario({ phase: MatchPhase.IN_PLAY });
    expect(previewFlight(open, a)).toBe(0);
  });

  it('when the kick module refuses (stub), the preview falls back to an estimated launch', () => {
    K.accept = false;
    const s = readyFK(0, GX - 24, 0);
    const pred = createBallPrediction();
    expect(previewFlight(s, pred)).toBe(2);
    expect(pred.count).toBe(LT.previewTicks);
    expect(pred.x[20]!).toBeGreaterThan(s.match.restart.x + 5);
    for (let i = 0; i < pred.count; i++) expect(Number.isFinite(pred.x[i]! + pred.y[i]! + pred.z[i]!)).toBe(true);
  });
});

// ---------------------------------------------------------------- default

describe('RUL-05 default after the timeout and the CPU fallback', () => {
  it('a human who does not act: at 12 s a shot over the wall to the inside of the covered post, curling in', () => {
    const s = readyFK(0, GX - 22, 7);
    const r = s.match.restart;
    const readyTick = s.tick;
    const side = wallCoverSide(s);
    expect(side).toBe(1);
    const evs = run(s, T_RULES.restartTimeoutTicks + 40, undefined, (st) => st.match.phase === MatchPhase.IN_PLAY);
    expect(calls()).toHaveLength(1);
    const c = calls()[0]!;
    expect(c.tick - readyTick).toBeGreaterThanOrEqual(T_RULES.restartTimeoutTicks - 2);
    expect(c.tick - readyTick).toBeLessThanOrEqual(T_RULES.restartTimeoutTicks + 2);
    expect([c.fn, c.kind, c.hasTarget, c.charging]).toEqual(['shot', KickKind.FREE_KICK_SHOT, 1, 0]);
    expect(c.targetX).toBe(GX);
    expect(c.targetZ).toBeCloseTo(side * (GOAL_HALF_WIDTH - LT.defaultPostInset), 9);
    // Curls back toward the goal centre: left of travel (-z) when kicking toward +x at a +z post.
    expect(c.curve).toBeLessThan(-0.25);
    expect(c.power).toBeGreaterThanOrEqual(LT.defaultPowerMin);
    expect(c.power).toBeLessThanOrEqual(LT.defaultPowerMax);
    expect(kicks(evs)).toHaveLength(1);
    expect(r.taken).toBe(1);
    expect(evs.filter((e) => e.type === EventType.WATCHDOG)).toHaveLength(0);
  });

  it('no wall: the default is a pass to an open teammate; in the crossing zone a cross into the box', () => {
    let s = readyFK(0, -15, -8);
    let evs = run(s, T_RULES.restartTimeoutTicks + 40, undefined, (st) => st.match.phase === MatchPhase.IN_PLAY);
    expect(calls().length).toBeGreaterThanOrEqual(1);
    let c = calls()[0]!;
    expect(c.fn).toMatch(/pass|lob/);
    expect(c.targetSlot).toBeGreaterThanOrEqual(0);
    expect(s.players[c.targetSlot]!.team).toBe(0);
    expect(s.players[c.targetSlot]!.isKeeper).toBe(0);
    expect(kicks(evs).length).toBeGreaterThanOrEqual(1);
    calls().length = 0;
    s = readyFK(0, GX - 8, -27);
    expect(s.match.restart.wallCount).toBe(0);
    evs = run(s, T_RULES.restartTimeoutTicks + 40, undefined, (st) => st.match.phase === MatchPhase.IN_PLAY);
    c = calls()[0]!;
    expect([c.fn, c.kind, c.hasTarget]).toEqual(['lob', KickKind.CROSS, 1]);
    expect(GX - c.targetX).toBeLessThanOrEqual(16.5);
    expect(Math.abs(c.targetZ)).toBeLessThanOrEqual(20.16);
    expect(kicks(evs)).toHaveLength(1);
  });

  it('every refused default falls through to the next choice (stub kick modules never leave the restart stuck)', () => {
    K.accept = false; // shots and lobs refused; startPass (SIM-08) is real
    const s = readyFK(0, GX - 22, 7);
    const evs = run(s, T_RULES.restartTimeoutTicks + 40, undefined, (st) => st.match.phase === MatchPhase.IN_PLAY);
    const fns = calls().map((c) => c.fn);
    expect(fns[0]).toBe('shot'); // refused (stub)
    expect(fns[fns.length - 1]).toBe('pass'); // SIM-08's real ground pass, the last resort, is played
    expect(fns.length).toBeLessThanOrEqual(4);
    expect(kicks(evs)).toHaveLength(1);
    expect(evs.filter((e) => e.type === EventType.WATCHDOG)).toHaveLength(0);
  });

  it('a side without a human: the CPU fallback takes the kick shortly after the CPU delay, never the watchdog', () => {
    const s = readyFK(0, GX - 24, -4, [{ side: 1 }]);
    const readyTick = s.tick;
    const evs = run(s, 400, undefined, (st) => st.match.phase === MatchPhase.IN_PLAY);
    expect(calls()).toHaveLength(1);
    const c = calls()[0]!;
    expect(c.flags & ReqFlag.SET_PIECE).toBe(ReqFlag.SET_PIECE);
    expect(c.tick - readyTick).toBe(T_RULES.cpuRestartDelay + LT.cpuGraceTicks);
    expect(kicks(evs)).toHaveLength(1);
    expect(evs.filter((e) => e.type === EventType.WATCHDOG)).toHaveLength(0);
  });

  it('freeKickDefault does nothing outside a pending free kick and never double-kicks', () => {
    const s = readyFK(0, GX - 24, -4);
    const ev = createEventBuffer();
    ev.begin(s.tick);
    freeKickDefault(s, ev);
    expect(calls()).toHaveLength(1);
    freeKickDefault(s, ev); // the taker is already kicking
    expect(calls()).toHaveLength(1);
    const open = makeScenario({ phase: MatchPhase.IN_PLAY });
    freeKickDefault(open, ev);
    expect(calls()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- glitch list

describe('RUL-05 glitch list (restarts)', () => {
  it('glitch: restart given to the wrong team (free kick) - the awarded side takes it, the other side walls', () => {
    for (const team of [0, 1]) {
      const s = readyFK(team, team === 0 ? GX - 21 : -(GX - 21), 3);
      const r = s.match.restart;
      expect(r.team).toBe(team);
      expect(s.players[r.taker]!.team).toBe(team);
      for (const w of members(s)) expect(s.players[w]!.team).toBe(1 - team);
      const evs = shootAndFly(s, 0.8, {});
      expect(kicks(evs)[0]!.a).toBe(r.taker);
    }
  });

  it('glitch: opponents inside the required distance blocking forever - the wall keeps 9.15 m all the time', () => {
    const s = readyFK(0, GX - 20, -5);
    const r = s.match.restart;
    let minD = Infinity;
    // The defending human moves the wall back and forth and jumps; the wall never comes closer than 9.15 m.
    run(s, 400, (t, _st, out) => {
      out[1]!.buttons = (t >> 6) % 2 === 0 ? Btn.SHIELD : Btn.SPRINT;
      if (t % 97 === 0) out[1]!.buttons |= Btn.THROUGH;
    }, (st) => {
      for (const w of members(st)) {
        const p = st.players[w]!;
        minD = Math.min(minD, dist(p.x, p.z, r.x, r.z));
      }
      return false;
    });
    expect(minD).toBeGreaterThanOrEqual(RESTART_DISTANCE);
    expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
    for (let i = teamFirstSlot(1); i < teamFirstSlot(1) + PLAYERS_PER_TEAM; i++) {
      expect(isLegalRestartPosition(s, i), `slot ${i}`).toBe(true);
    }
  });

  it('glitch: taker missing or sent off - a valid taker still takes the free kick', () => {
    const s = readyFK(0, GX - 24, 2);
    const r = s.match.restart;
    const t0 = r.taker;
    sendOff(s, t0); // while waiting
    const evs = run(s, 80, undefined, (st) => st.match.restart.taker !== t0 && st.players[st.match.restart.taker]!.act === ActionKind.SET_PIECE);
    expect(r.taker).not.toBe(t0);
    expect(s.players[r.taker]!.team).toBe(0);
    expect(s.players[r.taker]!.active).toBe(1);
    evs.push(...shootAndFly(s));
    expect(kicks(evs)[0]!.a).toBe(r.taker);
  });

  it('glitch: wall member sent off - the wall is re-picked from active defenders and keeps its size', () => {
    const s = readyFK(0, GX - 19, 0);
    const r = s.match.restart;
    const n = r.wallCount;
    const gone = r.wall[2]!;
    sendOff(s, gone);
    run(s, 2);
    expect(r.wallCount).toBe(n);
    expect(members(s)).not.toContain(gone);
    for (const w of members(s)) expect(s.players[w]!.active).toBe(1);
    expect(wallIndexOf(s, gone)).toBe(-1);
  });

  it('glitch: ball out of play during a restart - the free-kick spot is always inside the pitch', () => {
    for (const [x, z] of [[GX + 3, 0], [-GX - 1, 10], [10, HALF_WIDTH + 0.5], [GX - 1, -HALF_WIDTH - 2], [GX - 0.1, 0.5]] as const) {
      for (const team of [0, 1]) {
        const s = readyFK(team, x, z);
        const r = s.match.restart;
        expect(Math.abs(r.x)).toBeLessThan(HALF_LENGTH - BALL_RADIUS);
        expect(Math.abs(r.z)).toBeLessThan(HALF_WIDTH - BALL_RADIUS);
        expect([s.ball.x, s.ball.z]).toEqual([r.x, r.z]);
        expect(s.ball.cross).toBe(0);
      }
    }
  });
});
