/**
 * TAI-13 CPU set pieces against the documented input contracts of modules that are still stubs in Wave 1:
 * SIM-08/09/11 starters (startPass / startLob / startShot) become immediate kicks, and the RUL-02/05/06/07 set-piece
 * inputs are replaced by small fakes that read the frame exactly as their briefs specify (TAP / DOUBLE_TAP gesture
 * with gSlot or gx/gz = kick there; PASS press = short pass; LOB / SHOOT held then released = kick along the stick
 * with power = hold / powerFillTicks, curl from frame.curve; THROUGH press by the defending side = wall jump), kicking
 * through core/kick applyKick. RUL-01's kick-off, RUL-03's goal-kick and RUL-04's corner inputs are the real ones.
 * The rule-module fakes are complete modules (no importActual): evaluating a real module that sits in the
 * restart <-> kind-module import cycle inside a mock factory makes Vitest hand the importers the unmocked module.
 *
 * Proves, through the real step pipeline (resolver routing, SIM-16 switching, RUL-11 timing), that the CPU completes
 * every restart kind within a few seconds and before any safety net (no WATCHDOG), with sensible targets, and that a
 * refused first input is retried with the button equivalent. The real-module version of this lives in
 * tai-13-setpieces.test.ts and switches itself on when the modules land.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BALL_RADIUS, GOAL_HALF_WIDTH, HALF_LENGTH, PENALTY_AREA_HALF_WIDTH } from '../../src/contracts/constants';
import { ActionKind, GestureKind, KickKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EventType, type EventSink, type SimEvent } from '../../src/contracts/events';
import { AXIS_SCALE, Btn, type InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { createKickLaunch, type ActionRequest } from '../../src/contracts/systems';
import { T_PASS, T_RULES } from '../../src/contracts/tuning';
import { LOCAL_TUNING } from '../../src/ai/setpieces';
import { applyKick } from '../../src/sim/core/kick';
import { NULL_SINK } from '../../src/sim/core/events';
import { setupKickOff } from '../../src/sim/rules/machine';
import { awardRestart, prepareTakerKick } from '../../src/sim/rules/restart';
import { makeScenario, runTicks } from '../harness/scenario';

interface KickRec {
  via: string; kind: number; slot: number; tx: number; tz: number; target: number; power: number; curve: number;
  tick: number; age: number;
}

type StartFn = (via: string, s: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink) => number;
type InputFn = (kind: RestartKind, s: SimState, ci: number, f: InputFrame, ev: EventSink) => void;

const H = vi.hoisted(() => ({
  kicks: [] as KickRec[],
  wallJumps: [] as number[],
  refuseFirstGesture: false,
  refuseFirstStart: false,
  refused: 0,
  start: null as unknown as StartFn,
  input: null as unknown as InputFn,
  shoot: null as unknown as (s: SimState, ci: number, f: InputFrame, ev: EventSink) => void,
  /** Stick and curl captured at the press edge of LOB / SHOOT, per controller. */
  press: [] as { x: number; z: number; curve: number }[],
}));

vi.mock('../../src/sim/kicks/pass', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/kicks/pass')>()),
  startPass: (s: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink) => H.start('pass', s, slot, kind, req, ev),
}));
vi.mock('../../src/sim/kicks/lob', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/kicks/lob')>()),
  startLob: (s: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink) => H.start('lob', s, slot, kind, req, ev),
}));
vi.mock('../../src/sim/kicks/shot', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/kicks/shot')>()),
  startShot: (s: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink) => H.start('shot', s, slot, kind, req, ev),
}));
// RestartKind values (imports are not visible inside hoisted factories): THROW_IN 2, FREE_KICK 5, PENALTY 6.
vi.mock('../../src/sim/rules/throwin', () => ({
  throwInSetup: () => { /* RUL-11 picks the taker */ },
  throwInTick: () => { /* none */ },
  throwInDefault: () => { /* none */ },
  throwInInput: (s: SimState, ci: number, f: InputFrame, ev: EventSink) => H.input(2, s, ci, f, ev),
  throwInHandler: { update() { /* none */ }, end() { /* none */ } },
  noGoalDirectFromThrow: () => false,
}));
vi.mock('../../src/sim/rules/freekick', () => ({
  freeKickSetup: () => { /* RUL-11 picks the taker */ },
  freeKickTick: () => { /* none */ },
  freeKickDefault: () => { /* none */ },
  freeKickInput: (s: SimState, ci: number, f: InputFrame, ev: EventSink) => H.input(5, s, ci, f, ev),
  wallJumpHandler: { update() { /* none */ }, end() { /* none */ } },
}));
vi.mock('../../src/sim/rules/penalty', () => ({
  penaltySetup: () => { /* RUL-11 picks the taker */ },
  penaltyTick: () => { /* none */ },
  penaltyDefault: () => { /* none */ },
  penaltyInput: (s: SimState, ci: number, f: InputFrame, ev: EventSink) => H.input(6, s, ci, f, ev),
}));
vi.mock('../../src/sim/rules/shootout', () => ({
  shootoutStart: () => { /* scenario sets it up */ },
  shootoutTick: () => { /* none */ },
  shootoutInput: (s: SimState, ci: number, f: InputFrame, ev: EventSink) => H.shoot(s, ci, f, ev),
}));

const SETUP = T_RULES.restartSetupTicks;
const DELAY = T_RULES.cpuRestartDelay;
const FILL = T_PASS.powerFillTicks;
const L = createKickLaunch();

function isLofted(kind: KickKind): boolean {
  return kind === KickKind.LOB_PASS || kind === KickKind.HIGH_LOB || kind === KickKind.DRIVEN_LOB || kind === KickKind.CROSS ||
    kind === KickKind.THROW_IN;
}

/** Kick the ball from `slot` toward (tx, tz) (a plain launch through applyKick) and record it. */
function fakeKick(s: SimState, slot: number, kind: KickKind, tx: number, tz: number, target: number, via: string,
  power: number, curve: number, ev: EventSink): void {
  const b = s.ball;
  const dx = tx - b.x, dz = tz - b.z;
  const d = Math.hypot(dx, dz) || 1;
  const shot = kind === KickKind.PENALTY || kind === KickKind.FREE_KICK_SHOT || kind === KickKind.SHOT_NORMAL;
  const v = shot ? 24 : 14;
  L.vx = (dx / d) * v; L.vz = (dz / d) * v; L.vy = isLofted(kind) ? 6 : shot ? 2 : 0;
  L.sx = 0; L.sy = 0; L.sz = 0;
  L.kind = kind; L.target = target; L.tx = tx; L.tz = tz; L.onTarget = shot ? 1 : 0;
  applyKick(s, slot, L, power, ev);
  H.kicks.push({ via, kind, slot, tx, tz, target, power, curve, tick: s.tick, age: s.match.restart.t - SETUP });
}

H.start = (via, s, slot, kind, req, ev) => {
  const p = s.players[slot]!;
  if (p.active !== 1 || p.act !== ActionKind.NONE || p.stunT > 0) return 0;
  if (H.refuseFirstStart && H.refused === 0) { H.refused++; return 0; }
  let tx: number, tz: number;
  if (req.targetSlot >= 0) { tx = s.players[req.targetSlot]!.x; tz = s.players[req.targetSlot]!.z; }
  else if (req.hasTarget === 1) { tx = req.targetX; tz = req.targetZ; }
  else { tx = s.ball.x + req.dirX * 20; tz = s.ball.z + req.dirZ * 20; }
  fakeKick(s, slot, kind, tx, tz, req.targetSlot, via, req.power, req.curve, ev);
  return 1;
};

const bitIndex = (bit: number): number => Math.round(Math.log2(bit));

/** Release of a held LOB / SHOOT: kick along the stick captured at the press, power = hold / fill. */
function releaseKick(s: SimState, ci: number, kind: RestartKind, bit: number, ev: EventSink): void {
  const c = s.ctrl[ci]!;
  const r = s.match.restart;
  const st = H.press[ci] ?? { x: 0, z: 0, curve: 0 };
  const hold = s.tick - c.pressTick[bitIndex(bit)]!;
  const power = Math.min(1, hold / FILL);
  const b = s.ball;
  let dx = st.x, dz = st.z;
  if (Math.hypot(dx, dz) < 0.2) { dx = s.teams[r.team]!.dir; dz = 0; }
  let tx: number, tz: number;
  if (bit === Btn.SHOOT) {
    tx = Math.sign(dx) * HALF_LENGTH;
    tz = b.z + (tx - b.x) * (dz / dx);
  } else {
    const n = Math.hypot(dx, dz);
    tx = b.x + (dx / n) * 30 * power;
    tz = b.z + (dz / n) * 30 * power;
  }
  if (prepareTakerKick(s, r.taker) !== 1 && kind !== RestartKind.THROW_IN) return;
  const kk = bit === Btn.SHOOT ? (kind === RestartKind.PENALTY ? KickKind.PENALTY : KickKind.FREE_KICK_SHOT)
    : kind === RestartKind.THROW_IN ? KickKind.THROW_IN : KickKind.CROSS;
  fakeKick(s, r.taker, kk, tx, tz, -1, bit === Btn.SHOOT ? 'shoot' : 'lob', power, st.curve, ev);
}

H.input = (kind, s, ci, f, ev) => {
  const r = s.match.restart;
  if (r.kind !== kind || r.taken === 1 || r.ready !== 1) return;
  const c = s.ctrl[ci]!;
  const pressed = c.buttons & ~c.prevButtons;
  const released = c.prevButtons & ~c.buttons;
  if (c.side !== r.team) {
    if ((pressed & Btn.THROUGH) !== 0 && kind === RestartKind.FREE_KICK) H.wallJumps.push(s.tick);
    return;
  }
  if (c.slot !== r.taker) return;
  const t = r.taker;
  if (f.gesture === GestureKind.TAP || f.gesture === GestureKind.DOUBLE_TAP) {
    if (H.refuseFirstGesture && H.refused === 0) { H.refused++; return; }
    let tx: number, tz: number;
    if (f.gSlot >= 0) {
      const q = s.players[f.gSlot]!;
      if (q.team !== r.team || f.gSlot === t) return;
      tx = q.x; tz = q.z;
    } else { tx = f.gx / 10; tz = f.gz / 10; }
    if (kind !== RestartKind.THROW_IN && prepareTakerKick(s, t) !== 1) return;
    const kk = kind === RestartKind.THROW_IN ? KickKind.THROW_IN
      : kind === RestartKind.CORNER || f.gesture === GestureKind.DOUBLE_TAP ? KickKind.CROSS : KickKind.GROUND_PASS;
    fakeKick(s, t, kk, tx, tz, f.gSlot, 'gesture', 0.5, f.gCurve, ev);
    return;
  }
  if ((pressed & (Btn.LOB | Btn.SHOOT)) !== 0) H.press[ci] = { x: f.mx / AXIS_SCALE, z: f.mz / AXIS_SCALE, curve: f.curve };
  if ((pressed & Btn.PASS) !== 0) {
    const sx = f.mx / AXIS_SCALE, sz = f.mz / AXIS_SCALE;
    const n = Math.hypot(sx, sz) || 1;
    if (kind !== RestartKind.THROW_IN && prepareTakerKick(s, t) !== 1) return;
    fakeKick(s, t, kind === RestartKind.THROW_IN ? KickKind.THROW_IN : KickKind.GROUND_PASS, s.ball.x + (sx / n) * 10,
      s.ball.z + (sz / n) * 10, -1, 'pass', 0.3, 0, ev);
    return;
  }
  if ((released & Btn.SHOOT) !== 0) releaseKick(s, ci, kind, Btn.SHOOT, ev);
  else if ((released & Btn.LOB) !== 0) releaseKick(s, ci, kind, Btn.LOB, ev);
};

H.shoot = (s, ci, f, ev) => {
  const so = s.match.shootout;
  if (so.active !== 1) return;
  const c = s.ctrl[ci]!;
  if (c.side !== so.team || c.slot !== so.kicker) return;
  const pressed = c.buttons & ~c.prevButtons;
  const released = c.prevButtons & ~c.buttons;
  if ((pressed & Btn.SHOOT) !== 0) H.press[ci] = { x: f.mx / AXIS_SCALE, z: f.mz / AXIS_SCALE, curve: f.curve };
  if ((released & Btn.SHOOT) === 0) return;
  const st = H.press[ci]!;
  const b = s.ball;
  const tx = Math.sign(st.x) * HALF_LENGTH;
  const tz = b.z + (tx - b.x) * (st.z / st.x);
  const hold = s.tick - c.pressTick[bitIndex(Btn.SHOOT)]!;
  fakeKick(s, so.kicker, KickKind.PENALTY, tx, tz, -1, 'shoot', Math.min(1, hold / FILL), 0, ev);
};

beforeEach(() => {
  H.kicks.length = 0;
  H.wallJumps.length = 0;
  H.refuseFirstGesture = false;
  H.refuseFirstStart = false;
  H.refused = 0;
  H.press.length = 0;
});

// ---------------------------------------------------------------- helpers

function awarded(kind: RestartKind, team: number, x: number, z: number, shift = 0, seed = 1): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0, seed });
  if (shift) for (const p of s.players) if (p.isKeeper === 0) p.x = Math.max(-48, Math.min(48, p.x + shift));
  awardRestart(s, kind, team, x, z, NULL_SINK);
  expect(s.match.restart.kind).toBe(kind);
  return s;
}

/** Budget for one CPU restart: ready + delay + the longest arrival wait + aim + a full power hold + slack. */
const BUDGET = SETUP + DELAY + LOCAL_TUNING.maxArrivalWait + LOCAL_TUNING.shotAimTicks + FILL + 10;

function takeIt(s: SimState, label: string, budget = BUDGET): { kick: KickRec; events: SimEvent[] } {
  const taker = s.match.restart.taker;
  const events = runTicks(s, budget, undefined, { until: () => H.kicks.length > 0 });
  expect(H.kicks.length, `${label}: no kick within ${budget} ticks`).toBeGreaterThan(0);
  const kick = H.kicks[0]!;
  expect(kick.slot, label).toBe(taker);
  runTicks(s, 2);
  expect(s.match.phase, label).toBe(MatchPhase.IN_PLAY);
  expect(events.filter((e) => e.type === EventType.WATCHDOG), `${label}: safety net used`).toEqual([]);
  expect(s.match.watchdogCount, label).toBe(0);
  return { kick, events };
}

// ---------------------------------------------------------------- tests

describe('TAI-13 CPU completes every restart kind within a few seconds (contract fakes for stubbed modules)', () => {
  it('kick-off (real RUL-01 input): PASS -> kick-off pass', () => {
    const s = makeScenario({ phase: MatchPhase.KICK_OFF, humans: 0 });
    setupKickOff(s, 1, NULL_SINK);
    const { kick } = takeIt(s, 'kick-off');
    expect(kick.kind).toBe(KickKind.KICK_OFF);
    expect(kick.age).toBe(DELAY);
  });

  it('throw-in: TAP an open teammate', () => {
    for (const [team, x, z, shift] of [[0, 10, 34, 15], [1, -25, -34, -25], [0, 48, -34, 35]] as const) {
      H.kicks.length = 0;
      const s = awarded(RestartKind.THROW_IN, team, x, z, shift);
      const { kick } = takeIt(s, `throw-in ${team} ${x} ${z}`);
      expect(kick.via).toBe('gesture');
      expect(kick.target).toBeGreaterThanOrEqual(team === 0 ? 0 : 11);
      expect(kick.target).toBeLessThan(team === 0 ? 11 : 22);
      expect(kick.age).toBe(DELAY);
    }
  });

  it('goal kick (real RUL-03 input): gesture -> RUL-03 kick to a teammate ahead', () => {
    for (const [team, x, z] of [[0, -50, 4], [1, 50, -7]] as const) {
      H.kicks.length = 0;
      const s = awarded(RestartKind.GOAL_KICK, team, x, z);
      const { kick } = takeIt(s, `goal kick ${team}`);
      expect(kick.via === 'pass' || kick.via === 'lob').toBe(true);
      expect(s.teams[team]!.dir * (kick.tx - s.match.restart.x)).toBeGreaterThan(0);
    }
  });

  it('corner (real RUL-04 input): a cross to a header in the box (or the short option), both corners and both teams', () => {
    for (const [team, x, z, shift] of [[0, 52.5, 34, 30], [0, 52.5, -34, 30], [1, -52.5, 34, -30], [1, -52.5, -34, -30]] as const) {
      H.kicks.length = 0;
      const s = awarded(RestartKind.CORNER, team, x, z, shift);
      const { kick } = takeIt(s, `corner ${team} ${z}`);
      const dir = s.teams[team]!.dir;
      if (kick.via === 'lob') {
        expect(kick.kind).toBe(KickKind.CROSS);
        expect(HALF_LENGTH - dir * kick.tx).toBeLessThan(LOCAL_TUNING.boxDepth + 5);
        expect(Math.abs(kick.tz)).toBeLessThan(PENALTY_AREA_HALF_WIDTH + 1);
        expect(kick.age).toBeLessThanOrEqual(DELAY + LOCAL_TUNING.maxArrivalWait);
      } else {
        expect(kick.via).toBe('pass');
      }
    }
  });

  it('free kicks: in range (shot or cross), wide (cross / short), deep (pass to a teammate)', () => {
    const cases: [string, number, number, number, number][] = [
      ['shoot', 0, 30, 3, 25], ['shoot away', 1, -26, -8, -25], ['wide', 0, 26, 27, 25], ['deep', 1, 10, 12, 0],
    ];
    for (const [label, team, x, z, shift] of cases) {
      H.kicks.length = 0;
      const s = awarded(RestartKind.FREE_KICK, team, x, z, shift);
      const { kick } = takeIt(s, `free kick ${label}`);
      if (kick.via === 'shoot') {
        expect(kick.kind).toBe(KickKind.FREE_KICK_SHOT);
        expect(Math.abs(kick.tz)).toBeLessThan(GOAL_HALF_WIDTH + 1.5);
        expect(kick.curve).not.toBe(0);
        expect(kick.power).toBeGreaterThanOrEqual(LOCAL_TUNING.fkPowerMin - 0.05);
        expect(kick.power).toBeLessThanOrEqual(LOCAL_TUNING.fkPowerMax + 0.05);
      } else if (label === 'deep') {
        expect(kick.via).toBe('gesture');
        expect(kick.target).toBeGreaterThanOrEqual(team === 0 ? 0 : 11);
      }
    }
  });

  it('free kicks in range are shot more often than not by a specialist', () => {
    let shots = 0;
    for (let seed = 1; seed <= 10; seed++) {
      H.kicks.length = 0;
      const s = awarded(RestartKind.FREE_KICK, 0, 32, -2, 25, seed);
      const a = s.attrs[s.match.restart.taker]!;
      a.curve = 88; a.longShots = 85; a.shotPower = 85;
      const { kick } = takeIt(s, `fk seed ${seed}`);
      if (kick.via === 'shoot') shots++;
    }
    expect(shots).toBeGreaterThanOrEqual(6);
  });

  it('penalty: shot inside the goal at 64-86% power, both teams', () => {
    for (const team of [0, 1]) {
      H.kicks.length = 0;
      const s = awarded(RestartKind.PENALTY, team, team === 0 ? 41.5 : -41.5, 0);
      const { kick } = takeIt(s, `penalty ${team}`);
      expect(kick.via).toBe('shoot');
      expect(kick.kind).toBe(KickKind.PENALTY);
      expect(Math.sign(kick.tx)).toBe(s.teams[team]!.dir);
      expect(Math.abs(kick.tz)).toBeLessThan(GOAL_HALF_WIDTH + 0.6);
      expect(kick.power).toBeGreaterThanOrEqual(LOCAL_TUNING.penPowerMin - 0.03);
      expect(kick.power).toBeLessThanOrEqual(LOCAL_TUNING.penPowerMax + 0.03);
    }
  });

  it('shoot-out: the CPU kicker shoots once the ball is set on the spot', () => {
    const s = makeScenario({ phase: MatchPhase.SHOOT_OUT, humans: 0 });
    const so = s.match.shootout;
    so.active = 1; so.team = 1; so.kicker = 20;
    const b = s.ball;
    b.x = -(HALF_LENGTH - 11); b.y = BALL_RADIUS; b.z = 0; b.px = b.x; b.py = b.y; b.pz = 0;
    b.vx = 0; b.vy = 0; b.vz = 0; b.owner = -1; b.heldBy = -1;
    const k = s.players[20]!;
    k.x = b.x + 0.8; k.z = 0; k.vx = 0; k.vz = 0;
    const events = runTicks(s, DELAY + LOCAL_TUNING.shotAimTicks + FILL + 20, undefined, { until: () => H.kicks.length > 0 });
    expect(H.kicks.length).toBe(1);
    const kick = H.kicks[0]!;
    expect(kick.slot).toBe(20);
    expect(kick.tx).toBe(-HALF_LENGTH);
    expect(Math.abs(kick.tz)).toBeLessThan(GOAL_HALF_WIDTH + 0.6);
    expect(events.filter((e) => e.type === EventType.WATCHDOG)).toEqual([]);
  });

  it('a refused first input is retried with the button equivalent, still before any safety net', () => {
    H.refuseFirstGesture = true;
    const s = awarded(RestartKind.FREE_KICK, 1, -25, -27, -25);
    const { kick } = takeIt(s, 'free kick retry', BUDGET + LOCAL_TUNING.retryTicks + 20);
    expect(H.refused).toBe(1);
    expect(['lob', 'pass', 'shoot']).toContain(kick.via);
    expect(kick.age).toBeLessThan(240); // RUL-11's 4 s CPU timeout
  });

  it('corner (real RUL-04): a cross refused by the starter is retried by LOB with the reticle steered onto the target', () => {
    H.refuseFirstStart = true;
    const s = awarded(RestartKind.CORNER, 0, 52.5, -34, 30, 4);
    s.teams[0]!.style = 1; // counter: rarely short
    const events = runTicks(s, BUDGET + LOCAL_TUNING.retryTicks + LOCAL_TUNING.reticleMaxAimTicks + FILL, undefined,
      { until: () => H.kicks.length > 0 });
    expect(H.refused).toBe(1);
    expect(H.kicks.length).toBe(1);
    const kick = H.kicks[0]!;
    if (kick.via === 'lob') {
      // RUL-04 crosses to its reticle: the CPU steered it to (near) the header it chose.
      expect(HALF_LENGTH - kick.tx).toBeLessThan(LOCAL_TUNING.boxDepth + 1);
      expect(Math.abs(kick.tz)).toBeLessThan(PENALTY_AREA_HALF_WIDTH);
    }
    expect(events.filter((e) => e.type === EventType.WATCHDOG)).toEqual([]);
  });

  it('the defending CPU never presses THROUGH at a free kick it is not shooting at (no wall, or a pass)', () => {
    const s = awarded(RestartKind.FREE_KICK, 0, -10, 12);
    takeIt(s, 'deep fk');
    expect(H.wallJumps).toEqual([]);
  });
});
