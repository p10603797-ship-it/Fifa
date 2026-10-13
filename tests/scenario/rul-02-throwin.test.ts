/**
 * RUL-02 throw-ins in the real pipeline (step.ts: resolver + switching, actions, locomotion, bodies, ball physics,
 * contacts, RUL-01 machine, RUL-11 restart flow, RUL-08 offside, the watchdog). Team AI and CPU brains are mocked out
 * so players stay where a test puts them (RUL-11 still moves illegal opponents; RUL-02 drives the taker; the CPU side
 * throws through RUL-02's own CPU fallback).
 *
 * Covers: correct team and spot, valid taker (nearest outfield, never the keeper, re-picked when sent off / turned
 * keeper), ball above the head outside the line, opponents at 2 m, moving along the line (+-3 m), short throw (PASS) and
 * long throw (hold LOB) reaching teammates, gestures, MANUAL aim, the timeout default, the CPU taking throw-ins, and
 * the glitch-list lines: no offside from throw-ins; no goal direct from a throw-in; ball out of play during a restart;
 * restart given to the wrong team; players staying off the pitch; taker missing or sent off; power bar stuck full.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BALL_RADIUS, HALF_LENGTH, HALF_WIDTH, PLAYERS_PER_TEAM, THROW_IN_DISTANCE, teamFirstSlot } from '../../src/contracts/constants';
import {
  ActionKind, AssistLevel, CrossKind, GestureKind, KickKind, MatchPhase, RestartKind,
} from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { AXIS_SCALE, Btn, GESTURE_POS_SCALE, createInputFrame, type InputFrame } from '../../src/contracts/input';
import { RosterStatus, type SimState } from '../../src/contracts/state';
import { T_PASS, T_RULES } from '../../src/contracts/tuning';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { INVARIANT_NAMES, createInvariantChecker } from '../../src/sim/debug/invariants';
import { BALL_OUT_Z } from '../../src/sim/pitch/geometry';
import { isOffsidePosition } from '../../src/sim/rules/offside';
import { awardRestart, forceRestartKick, restartTakerSpot } from '../../src/sim/rules/restart';
import {
  LOCAL_TUNING, ThrowFlag, ThrowState, throwHandsHeight, throwInDefault,
} from '../../src/sim/rules/throwin';
import { step } from '../../src/sim/step';
import { makeScenario, type ScenarioHuman } from '../harness/scenario';

vi.mock('../../src/ai/index', async (orig) => ({
  ...(await orig<typeof import('../../src/ai/index')>()),
  teamAiTick: () => { /* none: players stay where the test puts them */ },
}));
vi.mock('../../src/ai/cpu/index', async (orig) => ({
  ...(await orig<typeof import('../../src/ai/cpu/index')>()),
  cpuThink: () => { /* none: CPU sides rely on RUL-02's own CPU fallback */ },
}));

const T = LOCAL_TUNING;
const CHECKS = INVARIANT_NAMES.filter((n) => n !== 'chaser'); // team AI is mocked out

// ---------------------------------------------------------------- scene

/** Team 0 (attacks +x): keeper, 1 next to the spot (10, 34), 2 open short option, 3 another short option, 4 far. */
const HOME: readonly [number, number][] = [
  [-50, 0], [8, 30.5], [18, 26], [2, 24], [31, 20], [-20, 0], [-10, -10], [0, -20], [20, -5], [25, -15], [-30, 10],
];
/** Team 1: keeper, 12 too close to the spot (RUL-11 moves him to 2 m), the rest away from the throw. */
const AWAY: readonly [number, number][] = [
  [50, 0], [11, 32.8], [30, 5], [35, -10], [10, -15], [0, 5], [-5, -25], [40, 15], [25, -25], [-15, 20], [5, 10],
];

interface SceneOpts {
  humans?: ScenarioHuman[];
  /** -1 mirrors the layout onto the far touchline (z -> -z). */
  side?: number;
  /** Position overrides [slot, x, z] (given in the un-mirrored frame). */
  place?: [number, number, number][];
  seed?: number;
}

function put(s: SimState, slot: number, x: number, z: number): void {
  const p = s.players[slot]!;
  p.x = x; p.z = z; p.vx = 0; p.vz = 0;
  p.fx = s.teams[p.team]!.dir; p.fz = 0;
}

function scene(o: SceneOpts = {}): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: o.humans ?? 0, seed: o.seed });
  const side = o.side ?? 1;
  for (let i = 0; i < PLAYERS_PER_TEAM; i++) {
    put(s, i, HOME[i]![0], side * HOME[i]![1]);
    put(s, PLAYERS_PER_TEAM + i, AWAY[i]![0], side * AWAY[i]![1]);
  }
  for (const [slot, x, z] of o.place ?? []) put(s, slot, x, side * z);
  const b = s.ball;
  b.x = 0; b.y = BALL_RADIUS; b.z = 0; b.px = 0; b.py = BALL_RADIUS; b.pz = 0;
  b.vx = 0; b.vy = 0; b.vz = 0; b.owner = -1; b.heldBy = -1;
  return s;
}

function award(s: SimState, team: number, x: number, z: number): void {
  const ev = createEventBuffer();
  ev.begin(s.tick);
  awardRestart(s, RestartKind.THROW_IN, team, x, z, ev);
  expect(s.match.phase).toBe(MatchPhase.THROW_IN);
  expect(s.match.restart.kind).toBe(RestartKind.THROW_IN);
}

type Inputs = (tick: number, s: SimState, out: InputFrame[]) => void;
type Until = (s: SimState, tickEv: readonly SimEvent[]) => boolean;

/** Step the real pipeline with the invariant checker (all but the chaser rule) and optional human inputs. */
function run(s: SimState, n: number, inputs?: Inputs, until?: Until): SimEvent[] {
  const events = createEventBuffer();
  const frames = [createInputFrame(), createInputFrame()];
  const checker = createInvariantChecker(CHECKS);
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    for (const f of frames) Object.assign(f, createInputFrame());
    inputs?.(s.tick + 1, s, frames);
    step(s, frames, events);
    const tickEv = events.toArray();
    all.push(...tickEv);
    const fails = checker.check(s, events);
    if (fails.length > 0) throw new Error(`invariant failure at t=${s.tick}:\n  ${fails.join('\n  ')}`);
    if (until?.(s, tickEv)) break;
  }
  return all;
}

const ofType = (ev: readonly SimEvent[], t: EventType): SimEvent[] => ev.filter((e) => e.type === t);
const throws = (ev: readonly SimEvent[]): SimEvent[] => ev.filter((e) => e.type === EventType.KICK && e.b === KickKind.THROW_IN);

/** Run until the restart is ready; returns the tick it became ready. */
function toReady(s: SimState, inputs?: Inputs): number {
  run(s, T_RULES.restartSetupTicks + 10, inputs, (st) => st.match.restart.ready === 1);
  expect(s.match.restart.ready).toBe(1);
  return s.tick;
}

/** Stick (pitch space) toward (x, z) from the ball. */
function stickTo(s: SimState, f: InputFrame, x: number, z: number): void {
  const dx = x - s.ball.x, dz = z - s.ball.z;
  const d = Math.hypot(dx, dz);
  f.mx = Math.round((dx / d) * AXIS_SCALE);
  f.mz = Math.round((dz / d) * AXIS_SCALE);
}

/** Nearest active outfield player of `team` to (x, z) (brute force, for expectations). */
function nearestOutfield(s: SimState, team: number, x: number, z: number): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = teamFirstSlot(team); i < teamFirstSlot(team) + PLAYERS_PER_TEAM; i++) {
    const p = s.players[i]!;
    if (p.active !== 1 || p.isKeeper === 1 || p.stunT > 0) continue;
    const d = Math.hypot(p.x - x, p.z - z);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

interface Flight { landX: number; landZ: number; apex: number; receivedBy: number; kickTick: number; speed: number }

/**
 * After a throw (call right after the KICK tick): run until the ball first lands or a player takes it; records the
 * first landing point, the apex and who received it.
 */
function follow(s: SimState, kickTick: number, speed: number): Flight {
  const out: Flight = { landX: NaN, landZ: NaN, apex: s.ball.y, receivedBy: -1, kickTick, speed };
  run(s, 240, undefined, (st) => {
    const b = st.ball;
    if (b.y > out.apex) out.apex = b.y;
    if (b.owner >= 0) { out.receivedBy = b.owner; return true; }
    if (b.lastTouchTick > kickTick) { out.receivedBy = b.lastTouch; return true; }
    if (b.bounces > 0 || b.grounded === 1) { out.landX = b.x; out.landZ = b.z; return true; }
    return false;
  });
  return out;
}

/** A throw as it left the hands: the KICK event, the ball speed at the end of that tick, the target (ball.passX/Z)
 *  and where the intended receiver stood. */
interface Thrown { kick: SimEvent; speed: number; events: SimEvent[]; target: number; tx: number; tz: number; rx: number; rz: number }

/** Run until the throw-in is thrown. */
function untilThrow(s: SimState, inputs?: Inputs, max = 900): Thrown {
  const o = { speed: 0, target: -1, tx: NaN, tz: NaN, rx: NaN, rz: NaN };
  const events = run(s, max, inputs, (st, ev) => {
    if (throws(ev).length === 0) return false;
    const b = st.ball;
    o.speed = Math.hypot(b.vx, b.vy, b.vz);
    o.target = b.passTarget;
    o.tx = b.passX;
    o.tz = b.passZ;
    if (b.passTarget >= 0) { o.rx = st.players[b.passTarget]!.x; o.rz = st.players[b.passTarget]!.z; }
    return true;
  });
  const k = throws(events);
  expect(k).toHaveLength(1);
  return { kick: k[0]!, events, ...o };
}

/**
 * The throw reached `slot`: thrown to him (ball.passTarget), aimed where he stood, and it first lands within `tol` m
 * of that spot (unless he takes it first). Where the receiver runs after the throw is SIM-15 / TAI-14's receiver
 * logic, not the throw's.
 */
function expectReached(th: Thrown, f: Flight, slot: number, tol = 1.0): void {
  expect(th.target).toBe(slot);
  expect(Math.hypot(th.tx - th.rx, th.tz - th.rz)).toBeLessThan(0.3);
  if (f.receivedBy >= 0) {
    expect(f.receivedBy).toBe(slot);
  } else {
    expect(Math.hypot(f.landX - th.rx, f.landZ - th.rz)).toBeLessThan(tol);
  }
}

beforeEach(() => { /* each test builds its own scene */ });

// ================================================================ setup: team, spot, taker

describe('RUL-02 setup: team, spot and taker', () => {
  for (const side of [1, -1]) {
    for (const lastTeam of [0, 1]) {
      it(`glitch "restart given to the wrong team": last touch by team ${lastTeam} over the ${side > 0 ? 'near' : 'far'} touchline -> throw-in to team ${1 - lastTeam}, at the crossing point, nearest outfield taker`, () => {
        const s = scene({ side });
        const b = s.ball;
        const toucher = lastTeam === 0 ? 8 : 15;
        b.x = 12; b.y = BALL_RADIUS; b.z = side * 33.6; b.px = b.x; b.py = b.y; b.pz = b.z;
        b.vx = 0.5; b.vz = side * 6; b.grounded = 1;
        b.lastTouch = toucher; b.lastTouchTeam = lastTeam; b.lastTouchTick = s.tick;
        const ev = run(s, 30, undefined, (st) => st.match.phase === MatchPhase.THROW_IN);
        expect(s.match.phase).toBe(MatchPhase.THROW_IN);
        const awards = ofType(ev, EventType.RESTART_AWARDED);
        expect(awards).toHaveLength(1);
        const r = s.match.restart;
        expect([awards[0]!.a, awards[0]!.b]).toEqual([RestartKind.THROW_IN, 1 - lastTeam]);
        expect(r.team).toBe(1 - lastTeam);
        expect(r.z).toBe(side * HALF_WIDTH);
        expect(Math.abs(r.x - 12.05)).toBeLessThan(0.2);
        expect(r.taker).toBe(nearestOutfield(s, r.team, r.x, r.z));
        expect(s.players[r.taker]!.team).toBe(r.team);
        expect(s.players[r.taker]!.isKeeper).toBe(0);
        expect(s.players[r.taker]!.act).toBe(ActionKind.THROW_IN);
      });
    }
  }

  it('the keeper never takes a throw-in, even when he is nearest', () => {
    const s = scene({ place: [[0, 10, 33]] });
    award(s, 0, 10, HALF_WIDTH);
    expect(s.match.restart.taker).toBe(1);
    toReady(s);
    expect(s.match.restart.taker).toBe(1);
    expect(s.ball.owner).toBe(1);
  });

  it('a player who is down is not chosen as the taker', () => {
    const s = scene();
    s.players[1]!.stunT = 300;
    award(s, 0, 10, HALF_WIDTH);
    expect(s.match.restart.taker).toBe(2);
  });

  it('the taker walks to the ball, then holds it above his head just outside the touchline; opponents >= 2 m', () => {
    for (const side of [1, -1]) {
      const s = scene({ side });
      award(s, 0, 10, side * HALF_WIDTH);
      const r = s.match.restart;
      const t = r.taker;
      const spot = { x: 0, z: 0 };
      restartTakerSpot(s, spot);
      const d0 = Math.hypot(s.players[t]!.x - spot.x, s.players[t]!.z - spot.z);
      run(s, 20);
      expect(Math.hypot(s.players[t]!.x - spot.x, s.players[t]!.z - spot.z)).toBeLessThan(d0 - 1);
      toReady(s);
      // Ready: taker on the spot outside the line, ball in his hands above his head (never heldBy), at rest.
      const check = (st: SimState): void => {
        const p = st.players[t]!;
        const b = st.ball;
        expect(st.match.restart.taker).toBe(t);
        expect(p.act).toBe(ActionKind.THROW_IN);
        expect(p.z).toBeCloseTo(spot.z, 9);
        expect(side * p.z).toBeGreaterThan(HALF_WIDTH);
        expect(b.owner).toBe(t);
        expect(b.heldBy).toBe(-1);
        expect(b.y).toBeCloseTo(throwHandsHeight(st, t), 9);
        // Held over the line (just inside the out-of-play plane), never behind it: a kick from there starts in play.
        expect(Math.abs(b.z)).toBeCloseTo(BALL_OUT_Z - T.releaseInside, 9);
        expect(Math.abs(b.z)).toBeGreaterThan(HALF_WIDTH);
        expect(Math.hypot(b.x - p.x, b.z - p.z)).toBeLessThan(0.5);
        expect(-side * p.fz).toBeGreaterThanOrEqual(T.minInward - 1e-9); // facing the pitch
        for (let i = teamFirstSlot(1); i < teamFirstSlot(1) + PLAYERS_PER_TEAM; i++) {
          const o = st.players[i]!;
          expect(Math.hypot(o.x - b.x, o.z - b.z)).toBeGreaterThanOrEqual(THROW_IN_DISTANCE - 0.05);
        }
      };
      check(s);
      // ... every tick until the CPU side throws.
      run(s, T_RULES.cpuRestartDelay, undefined, (st) => { check(st); return false; });
      expect(s.match.restart.taken).toBe(0);
    }
  });
});

// ================================================================ human taker

describe('RUL-02 human taker', () => {
  it('left stick moves the taker along the line, at most 3 m from the spot, never onto the pitch; the ball goes with him', () => {
    const s = scene({ humans: [{ side: 0 }] });
    award(s, 0, 10, HALF_WIDTH);
    toReady(s);
    const r = s.match.restart;
    const t = r.taker;
    const p = s.players[t]!;
    expect(p.ctrl).toBe(0); // the human controls the taker
    const z0 = p.z;
    const hold = (mx: number, mz: number, n: number): void => {
      run(s, n, (_t, _s, out) => { out[0]!.mx = mx; out[0]!.mz = mz; }, (st) => {
        expect(Math.abs(p.x - r.x)).toBeLessThanOrEqual(T.lineLeash + 1e-6);
        expect(p.z).toBe(z0);
        expect(st.ball.owner).toBe(t);
        expect(Math.abs(st.ball.x - p.x)).toBeLessThan(0.3);
        expect(st.match.restart.taken).toBe(0);
        return false;
      });
    };
    hold(127, 0, 120);
    expect(p.x).toBeGreaterThan(r.x + T.lineLeash - 0.05);
    hold(-127, 0, 240);
    expect(p.x).toBeLessThan(r.x - T.lineLeash + 0.05);
    const x1 = p.x;
    hold(0, -127, 60); // straight into the pitch: no movement
    expect(p.x).toBeCloseTo(x1, 6);
    expect(s.match.phase).toBe(MatchPhase.THROW_IN);
  });

  for (const target of [2, 3]) {
    it(`PASS: short throw to the teammate the stick points at (slot ${target}); it reaches him; play resumes`, () => {
      const s = scene({ humans: [{ side: 0 }] });
      award(s, 0, 10, HALF_WIDTH);
      const ready = toReady(s);
      const q = s.players[target]!;
      const t = s.match.restart.taker;
      const press = ready + 3;
      const res = untilThrow(s, (tick, st, out) => {
        if (tick === press) { stickTo(st, out[0]!, q.x, q.z); out[0]!.buttons = Btn.PASS; }
      });
      expect(res.kick.a).toBe(t);
      expect(res.kick.tick).toBe(press + T.windupTicks - 1); // committed in the resolver stage; actions run the same tick
      expect(s.ball.passTarget).toBe(target);
      expect(res.speed).toBeGreaterThanOrEqual(T.speedMin - 0.5);
      expect(res.speed).toBeLessThanOrEqual(T.speedMax + 0.5);
      expect(s.match.restart.taken).toBe(1);
      expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
      expect(Math.abs(s.ball.z)).toBeLessThanOrEqual(BALL_OUT_Z); // in play from the release
      const f = follow(s, res.kick.tick, res.speed);
      expectReached(res, f, target);
    });
  }

  it('hold LOB: long throw, power from the hold, lofted, to the far teammate in the stick direction', () => {
    const s = scene({ humans: [{ side: 0 }] });
    award(s, 0, 10, HALF_WIDTH);
    const ready = toReady(s);
    const q = s.players[4]!;
    const press = ready + 3;
    const holdTicks = 28;
    const res = untilThrow(s, (tick, st, out) => {
      if (tick >= press) stickTo(st, out[0]!, q.x, q.z);
      if (tick >= press && tick < press + holdTicks) out[0]!.buttons = Btn.LOB;
    });
    expect(res.kick.tick).toBe(press + holdTicks + T.windupTicks - 1); // released at press + holdTicks
    expect(res.kick.c).toBeCloseTo(holdTicks / T_PASS.powerFillTicks, 2);
    expect(s.ball.passTarget).toBe(4);
    expect(res.speed).toBeLessThanOrEqual(T.speedMax + 0.5);
    const f = follow(s, res.kick.tick, res.speed);
    expect(f.apex).toBeGreaterThan(throwHandsHeight(s, s.match.restart.taker) + 2);
    expectReached(res, f, 4, 1.2);
  });

  it('glitch "power bar stuck full": LOB held forever auto-releases a full-power long throw', () => {
    const s = scene({ humans: [{ side: 0 }] });
    award(s, 0, 10, HALF_WIDTH);
    const ready = toReady(s);
    const press = ready + 2;
    const res = untilThrow(s, (tick, _st, out) => { if (tick >= press) out[0]!.buttons = Btn.LOB; });
    expect(res.kick.c).toBe(1);
    expect(res.kick.tick - press).toBeLessThanOrEqual(T_PASS.powerFillTicks + T.chargeAutoReleaseTicks + T.windupTicks + 1);
    expect(s.players[res.kick.a]!.actCharging).toBe(0);
  });

  it('presses before the restart is ready, and the defending side\'s presses, do nothing', () => {
    const s = scene({ humans: [{ side: 0 }, { side: 1 }] });
    award(s, 0, 10, HALF_WIDTH);
    const ev = run(s, T_RULES.restartSetupTicks - 2, (tick, _st, out) => {
      out[0]!.buttons = tick % 2 === 0 ? Btn.PASS : Btn.LOB;
      out[1]!.buttons = tick % 2 === 0 ? Btn.PASS : Btn.LOB;
    });
    expect(throws(ev)).toHaveLength(0);
    toReady(s);
    const ev2 = run(s, 60, (tick, _st, out) => { out[1]!.buttons = tick % 2 === 0 ? Btn.PASS : Btn.LOB; out[1]!.mx = 127; });
    expect(throws(ev2)).toHaveLength(0);
    expect(s.match.restart.taken).toBe(0);
    expect(s.players[s.match.restart.taker]!.actA).toBe(ThrowState.HOLD);
  });

  it('gestures: tap a teammate -> short throw to him; double-tap -> long throw; tap a spot -> throw to that spot', () => {
    const cases: { g: GestureKind; slot: number; x: number; z: number; long: number }[] = [
      { g: GestureKind.TAP, slot: 2, x: 18, z: 26, long: 0 },
      { g: GestureKind.DOUBLE_TAP, slot: 2, x: 18, z: 26, long: 1 },
      { g: GestureKind.TAP, slot: -1, x: 15, z: 18, long: 0 },
    ];
    for (const c of cases) {
      const s = scene({ humans: [{ side: 0 }] });
      award(s, 0, 10, HALF_WIDTH);
      toReady(s);
      const t = s.match.restart.taker;
      const tap = s.tick + 1;
      run(s, 1, (tick, _st, out) => {
        expect(tick).toBe(tap);
        out[0]!.gesture = c.g;
        out[0]!.gx = Math.round(c.x * GESTURE_POS_SCALE);
        out[0]!.gz = Math.round(c.z * GESTURE_POS_SCALE);
        out[0]!.gSlot = c.slot;
      });
      const p = s.players[t]!;
      expect(p.actA).toBe(ThrowState.WINDUP);
      expect(p.actB & ThrowFlag.LONG).toBe(c.long);
      const res = untilThrow(s);
      expect(s.ball.passTarget).toBe(c.slot);
      const f = follow(s, res.kick.tick, res.speed);
      if (c.slot >= 0) expectReached(res, f, c.slot, 1.2);
      else expect(Math.hypot(f.landX - c.x, f.landZ - c.z)).toBeLessThan(1.0);
    }
  });

  it('MANUAL assistance throws along the stick (at the receiver\'s distance)', () => {
    const s = scene({ humans: [{ side: 0, assist: AssistLevel.MANUAL }] });
    award(s, 0, 10, HALF_WIDTH);
    const ready = toReady(s);
    const bx = s.ball.x, bz = s.ball.z;
    const ang = -1.1; // into the pitch, 0.29 rad off slot 2 (inside the receiver cone, but the ball lands 3 m from him)
    const ux = Math.cos(ang), uz = Math.sin(ang);
    const res = untilThrow(s, (tick, _st, out) => {
      if (tick === ready + 2) {
        out[0]!.mx = Math.round(ux * AXIS_SCALE);
        out[0]!.mz = Math.round(uz * AXIS_SCALE);
        out[0]!.buttons = Btn.PASS;
      }
    });
    // Aimed along the stick from the ball, at the distance of the receiver in that direction (slot 2).
    const want = Math.atan2(Math.round(uz * AXIS_SCALE), Math.round(ux * AXIS_SCALE));
    expect(Math.abs(Math.atan2(res.tz - bz, res.tx - bx) - want)).toBeLessThan(0.01);
    expect(Math.hypot(res.tx - bx, res.tz - bz)).toBeCloseTo(Math.hypot(18 - bx, 26 - bz), 1);
    // ... and the ball flies there: first landing within 1 m of the aim point (2.9 m from slot 2's spot).
    expect(Math.hypot(res.tx - 18, res.tz - 26)).toBeGreaterThan(2.5);
    const f = follow(s, res.kick.tick, res.speed);
    if (f.receivedBy < 0) expect(Math.hypot(f.landX - res.tx, f.landZ - res.tz)).toBeLessThan(1.0);
    else expect(Math.abs(Math.atan2(s.ball.z - bz, s.ball.x - bx) - want)).toBeLessThan(0.2);
  });

  it('timeout: a human who does nothing gets the default after 12 s: a short throw to the best open teammate, no watchdog', () => {
    // Slot 3 is marked tightly: slot 2 is the best open option.
    const s = scene({ humans: [{ side: 0 }], place: [[16, 2.6, 23.3]] });
    award(s, 0, 10, HALF_WIDTH);
    const ready = toReady(s);
    const res = untilThrow(s, undefined, T_RULES.restartTimeoutTicks + 60);
    expect(res.kick.tick).toBe(ready + T_RULES.restartTimeoutTicks + T.windupTicks);
    expect(s.ball.passTarget).toBe(2);
    expect(ofType(res.events, EventType.WATCHDOG)).toHaveLength(0);
    const f = follow(s, res.kick.tick, res.speed);
    expectReached(res, f, 2);
  });

  it('the default during a long-throw charge throws long at the current power', () => {
    const s = scene({ humans: [{ side: 0 }] });
    award(s, 0, 10, HALF_WIDTH);
    const ready = toReady(s);
    run(s, 21, (tick, st, out) => { if (tick > ready) { out[0]!.buttons = Btn.LOB; stickTo(st, out[0]!, 31, 20); } });
    const t = s.match.restart.taker;
    const p = s.players[t]!;
    expect(p.actA).toBe(ThrowState.CHARGE);
    const power = p.actPower;
    expect(power).toBeGreaterThan(0.3);
    const ev = createEventBuffer();
    ev.begin(s.tick);
    throwInDefault(s, ev);
    expect(p.actA).toBe(ThrowState.WINDUP);
    expect(p.actB & ThrowFlag.LONG).toBe(ThrowFlag.LONG);
    expect(p.actPower).toBe(power);
    const res = untilThrow(s);
    expect(res.kick.c).toBeCloseTo(power, 9);
  });
});

// ================================================================ CPU taker

describe('RUL-02 CPU taker', () => {
  for (const team of [0, 1]) {
    it(`a side without a human (team ${team}) throws by itself soon after ready, to a teammate, without the watchdog`, () => {
      const s = scene();
      const x = team === 0 ? 10 : 11;
      award(s, team, x, HALF_WIDTH);
      const ready = toReady(s);
      const res = untilThrow(s, undefined, 300);
      expect(res.kick.tick - ready).toBeLessThanOrEqual(T_RULES.cpuRestartDelay + T.cpuGraceTicks + T.windupTicks);
      expect(s.players[res.kick.a]!.team).toBe(team);
      const q = s.ball.passTarget;
      expect(q).toBeGreaterThanOrEqual(teamFirstSlot(team));
      expect(q).toBeLessThan(teamFirstSlot(team) + PLAYERS_PER_TEAM);
      expect(s.players[q]!.isKeeper).toBe(0);
      expect(ofType(res.events, EventType.WATCHDOG)).toHaveLength(0);
      const f = follow(s, res.kick.tick, res.speed);
      expectReached(res, f, q, 1.2);
    });
  }
});

// ================================================================ glitch list

describe('RUL-02 glitch list', () => {
  it('glitch "offside given from a throw-in": a throw to a teammate in an offside position is never flagged', () => {
    // Team 1 (defends +x) has every outfield player at x <= 24: slot 4 at (36, 24) is beyond them and ahead of the ball.
    const s = scene({
      humans: [{ side: 0 }],
      place: [[1, 31, 31], [2, -10, 20], [3, -5, 15], [4, 36, 24], [8, -20, -5], [9, -15, -15],
        [12, 20, 5], [13, 24, -10], [14, 20, -12], [17, 22, 15], [18, 15, -25], [19, 12, -18], [20, -15, 20], [21, 5, 10]],
    });
    award(s, 0, 30, HALF_WIDTH);
    const ready = toReady(s);
    let offsidePosAtThrow = false;
    const res = untilThrow(s, (tick, st, out) => {
      if (tick === ready + 2) { stickTo(st, out[0]!, 36, 24); out[0]!.buttons = Btn.PASS; }
      if (tick === ready + 2 + T.windupTicks - 1) offsidePosAtThrow = isOffsidePosition(st, 4); // the throw tick, before it runs
    });
    expect(offsidePosAtThrow).toBe(true); // he was in an offside position when the ball was thrown
    expect(s.ball.passTarget).toBe(4);
    expect(s.match.offside.flags & (1 << 4)).toBe(0);
    const ev = run(s, 150);
    expect(ofType(res.events, EventType.OFFSIDE)).toHaveLength(0);
    expect(ofType(ev, EventType.OFFSIDE)).toHaveLength(0);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
  });

  for (const team of [0, 1]) {
    const name = team === 0 ? 'into the opponents\' goal -> goal kick' : 'into his own goal -> corner';
    it(`glitch "goal scored direct from a throw-in": thrown straight ${name}`, () => {
      // Throw-in near the +x corner; nobody near the path; the keeper of the +x goal (team 1) far away.
      const taker = team === 0 ? 1 : 12;
      const s = scene({
        humans: [{ side: team }],
        place: [[taker, 46, 31], [11, 20, -20], [18, 10, 15], [4, 0, 20]],
      });
      award(s, team, 48, HALF_WIDTH);
      const ready = toReady(s);
      expect(s.match.restart.taker).toBe(taker);
      // Aim along the line from the ball to the middle of the goal mouth, short throw landing 21 m away.
      const b = s.ball;
      const gx = HALF_LENGTH, gz = 0;
      const dl = Math.hypot(gx - b.x, gz - b.z);
      const tx = b.x + ((gx - b.x) / dl) * 21, tz = b.z + ((gz - b.z) / dl) * 21;
      let crossed = CrossKind.NONE;
      const ev = run(s, 400, (tick, _st, out) => {
        if (tick === ready + 2) { // P1 plays for the throwing side
          out[0]!.gesture = GestureKind.TAP;
          out[0]!.gx = Math.round(tx * GESTURE_POS_SCALE);
          out[0]!.gz = Math.round(tz * GESTURE_POS_SCALE);
          out[0]!.gSlot = -1;
        }
      }, (st, tickEv) => {
        if (st.ball.cross !== CrossKind.NONE && crossed === CrossKind.NONE) crossed = st.ball.cross;
        return ofType(tickEv, EventType.RESTART_AWARDED).length > 0;
      });
      expect(throws(ev)).toHaveLength(1);
      expect(crossed).toBe(CrossKind.GOAL); // it really went in between the posts, under the bar
      expect(ofType(ev, EventType.GOAL)).toHaveLength(0);
      expect(s.teams[0]!.goals + s.teams[1]!.goals).toBe(0);
      const awards = ofType(ev, EventType.RESTART_AWARDED);
      expect(awards.length).toBeGreaterThanOrEqual(1);
      if (team === 0) expect([awards[0]!.a, awards[0]!.b]).toEqual([RestartKind.GOAL_KICK, 1]);
      else expect([awards[0]!.a, awards[0]!.b]).toEqual([RestartKind.CORNER, 0]);
    });
  }

  it('glitch "ball out of play during a restart": while waiting the held ball never goes out, nor after a knock', () => {
    const s = scene({ humans: [{ side: 0 }] });
    award(s, 0, 10, HALF_WIDTH);
    toReady(s);
    const t = s.match.restart.taker;
    const ev = run(s, 300, undefined, (st) => {
      expect(st.ball.owner).toBe(t);
      expect(st.ball.cross).toBe(CrossKind.NONE);
      expect(st.match.phase).toBe(MatchPhase.THROW_IN);
      return false;
    });
    expect(ofType(ev, EventType.RESTART_AWARDED)).toHaveLength(0);
    expect(ofType(ev, EventType.WATCHDOG)).toHaveLength(0);
    // A stray knock sends the ball away (as a bad contact would): it is back in his hands at once.
    const b = s.ball;
    b.owner = -1; b.x = 16; b.y = 0.5; b.z = 30; b.vx = 4; b.vy = 2; b.vz = 3;
    const ev2 = run(s, 3);
    expect(s.ball.owner).toBe(t);
    expect(s.ball.y).toBeCloseTo(throwHandsHeight(s, t), 9);
    expect(ofType(ev2, EventType.RESTART_AWARDED)).toHaveLength(0);
    expect(s.match.phase).toBe(MatchPhase.THROW_IN);
  });

  it('glitch "ball out of play during a restart": RUL-11\'s forced safety-net kick while he holds the ball starts in play', () => {
    const s = scene({ humans: [{ side: 0 }] });
    award(s, 0, 10, HALF_WIDTH);
    toReady(s);
    const t = s.match.restart.taker;
    const ev = createEventBuffer();
    ev.begin(s.tick);
    expect(forceRestartKick(s, ev)).toBe(1);
    expect(Math.abs(s.ball.z)).toBeLessThanOrEqual(BALL_OUT_Z);
    const after = run(s, 90);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(ofType(after, EventType.WATCHDOG)).toHaveLength(0);
    expect(ofType(after, EventType.RESTART_AWARDED)).toHaveLength(0);
    expect(s.players[t]!.act === ActionKind.NONE || s.players[t]!.actA === ThrowState.RECOVER).toBe(true);
  });

  it('the half ends during a throw-in: the taker\'s throw is abandoned cleanly (ball dropped, action ended)', () => {
    const s = scene({ humans: [{ side: 0 }] });
    s.match.periodT = s.match.periodLen - 100; // the half runs out ~50 ticks after the throw-in is ready
    award(s, 0, 10, HALF_WIDTH);
    toReady(s);
    const t = s.match.restart.taker;
    expect(s.ball.owner).toBe(t);
    run(s, 600, undefined, (st) => st.match.phase === MatchPhase.HALF_TIME);
    expect(s.match.phase).toBe(MatchPhase.HALF_TIME);
    expect(s.players[t]!.act).not.toBe(ActionKind.THROW_IN);
    expect(s.ball.owner).not.toBe(t);
    for (const p of s.players) expect(p.act === ActionKind.THROW_IN && p.actA !== ThrowState.RECOVER).toBe(false);
  });

  it('glitch "ball out of play during a restart": thrown along the line it still enters the field and stays in play', () => {
    const s = scene({ humans: [{ side: 0 }], place: [[2, 30, 32]] });
    award(s, 0, 10, HALF_WIDTH);
    const ready = toReady(s);
    const res = untilThrow(s, (tick, st, out) => {
      if (tick === ready + 2) { stickTo(st, out[0]!, 30, 32); out[0]!.buttons = Btn.PASS; }
    });
    expect(s.ball.passTarget).toBe(2);
    expect(Math.abs(s.ball.z)).toBeLessThanOrEqual(BALL_OUT_Z);
    const ev = run(s, 60, undefined, (st) => { expect(Math.abs(st.ball.z)).toBeLessThanOrEqual(BALL_OUT_Z); return false; });
    expect(ofType(ev, EventType.RESTART_AWARDED)).toHaveLength(0);
    expect(ofType(ev, EventType.WATCHDOG)).toHaveLength(0);
    expect(ofType(res.events, EventType.WATCHDOG)).toHaveLength(0);
  });

  for (const human of [true, false]) {
    it(`glitch "players stay off the pitch after a throw-in": the ${human ? 'human' : 'CPU'} thrower steps back onto the pitch and is free`, () => {
      for (const side of [1, -1]) {
        const s = scene({ humans: human ? [{ side: 0 }] : [], side });
        award(s, 0, 10, side * HALF_WIDTH);
        const ready = toReady(s);
        const t = s.match.restart.taker;
        const res = untilThrow(s, (tick, _st, out) => { if (human && tick === ready + 2) out[0]!.buttons = Btn.PASS; });
        expect(res.kick.a).toBe(t);
        run(s, T.recoveryTicks + 30);
        const p = s.players[t]!;
        expect(Math.abs(p.z)).toBeLessThanOrEqual(HALF_WIDTH - 0.3);
        expect(p.act).toBe(ActionKind.NONE);
        run(s, 120);
        expect(Math.abs(p.z)).toBeLessThanOrEqual(HALF_WIDTH);
      }
    });
  }

  it('glitch "taker missing or sent off": sent off while holding the ball -> another taker takes it, the throw completes', () => {
    const s = scene();
    award(s, 0, 10, HALF_WIDTH);
    toReady(s);
    const old = s.match.restart.taker;
    expect(s.ball.owner).toBe(old);
    // Sent off (as RUL-09 / RUL-10 do it: slot inactive, roster status, one fewer on the pitch).
    const op = s.players[old]!;
    op.active = 0;
    s.teams[0]!.roster[op.rosterIdx] = RosterStatus.SENT_OFF;
    s.teams[0]!.onPitch--;
    run(s, 2);
    const t = s.match.restart.taker;
    expect(t).not.toBe(old);
    expect(s.players[t]!.team).toBe(0);
    expect(s.players[t]!.isKeeper).toBe(0);
    expect(s.players[t]!.active).toBe(1);
    expect(s.ball.owner).toBe(t);
    expect(op.act).toBe(ActionKind.NONE);
    const res = untilThrow(s, undefined, 300);
    expect(res.kick.a).toBe(t);
    expect(ofType(res.events, EventType.WATCHDOG)).toHaveLength(0);
  });

  it('glitch "taker missing": a taker who becomes the keeper is replaced', () => {
    const s = scene();
    award(s, 0, 10, HALF_WIDTH);
    toReady(s);
    const old = s.match.restart.taker;
    // The keeper was sent off and this player went in goal (RUL-10).
    s.players[0]!.active = 0;
    s.players[0]!.isKeeper = 0;
    s.teams[0]!.roster[s.players[0]!.rosterIdx] = RosterStatus.SENT_OFF;
    s.teams[0]!.onPitch--;
    s.players[old]!.isKeeper = 1;
    s.teams[0]!.keeperSlot = old;
    run(s, 2);
    const t = s.match.restart.taker;
    expect(t).not.toBe(old);
    expect(s.players[t]!.isKeeper).toBe(0);
    expect(s.ball.owner).toBe(t);
    const oa = s.players[old]!;
    expect(oa.act === ActionKind.NONE || (oa.act === ActionKind.THROW_IN && oa.actA === ThrowState.RECOVER)).toBe(true);
    const res = untilThrow(s, undefined, 300);
    expect(res.kick.a).toBe(t);
  });
});

// ================================================================ determinism

describe('RUL-02 determinism', () => {
  it('same scene and inputs -> same state hash', () => {
    const hashes: number[] = [];
    for (let k = 0; k < 2; k++) {
      const s = scene({ humans: [{ side: 0 }] });
      award(s, 0, 10, HALF_WIDTH);
      const ready = toReady(s);
      run(s, 200, (tick, st, out) => {
        if (tick > ready && tick < ready + 40) out[0]!.mx = 90;
        if (tick >= ready + 40 && tick < ready + 60) { out[0]!.buttons = Btn.LOB; stickTo(st, out[0]!, 31, 20); }
      });
      hashes.push(hashState(s));
    }
    expect(hashes[0]).toBe(hashes[1]);
  });
});
